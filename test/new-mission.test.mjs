import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  }),
  cloneElement: (element, extra) => ({ type: element.type, props: { ...element.props, ...(extra ?? {}) } }),
}
const primitives = { MarkdownText: (props) => react.createElement('div', { className: 'markdown' }, props.text) }
const theme = createPanelComponents(react.createElement)
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const previousWindow = globalThis.window
let client = null

globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      client = factory((id) => {
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        if (id === 'dsh-theme-konoha/client') return theme
        return react
      })
    },
  },
}
try {
  new Function(source)()
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}

const render = (node) =>
  node && typeof node === 'object' && !Array.isArray(node) && typeof node.type === 'function'
    ? render(node.type(node.props ?? {}))
    : node

const text = (node) => {
  const tree = render(node)
  if (tree === null || tree === undefined || tree === false) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return text(tree.props?.children)
}

const byClass = (node, className) => {
  const found = []
  const walk = (tree) => {
    if (!tree || typeof tree !== 'object') return
    if (Array.isArray(tree)) {
      tree.forEach(walk)
      return
    }
    const node = render(tree)
    const classes = String(node.props?.className ?? '').split(/\s+/)
    if (classes.includes(className)) found.push(node)
    walk(node.props?.children)
  }
  walk(node)
  return found
}

test('newMissionTypes : les trois types du standard, chacun avec sa nature', () => {
  assert.deepEqual(client.newMissionTypes.map((entry) => entry.key), ['produit', 'conteneur', 'poc'])
  assert.deepEqual(client.newMissionTypes.map((entry) => entry.label), ['Produit', 'Conteneur', 'POC'])
  for (const entry of client.newMissionTypes) assert.ok(entry.hint.length > 0, entry.key)
  assert.match(client.newMissionTypes[0].hint, /Jira/)
  assert.match(client.newMissionTypes[1].hint, /konoha/)
  assert.match(client.newMissionTypes[2].hint, /hypothèse/)
})

test('newMissionPrompt conteneur : identifiant calculé, gabarit, journal, arrêt', () => {
  const prompt = client.newMissionPrompt('conteneur')
  assert.match(prompt, /^Nouvelle mission Conteneur — le cadrage commence maintenant\./)
  assert.match(prompt, /demande-la en une phrase — pas d’interview/)
  assert.match(prompt, /max \+ 1 sur `missions\/` et `missions\/archives`/)
  assert.match(prompt, /repo: ~\/konoha/)
  assert.match(prompt, /templates\/mission-conteneur\.md/)
  assert.match(prompt, /`status: draft`, aucune section ajoutée ni retirée/)
  assert.match(prompt, /missions\/<id>\/journal\.md/)
  assert.match(prompt, /au plus trois points ouverts, un par un/)
  assert.match(prompt, /aucune branche, aucun fichier hors `missions\/<id>\/`, aucun go/)
})

test('newMissionPrompt produit : la clé Jira se demande dans la session', () => {
  const prompt = client.newMissionPrompt('produit')
  assert.match(prompt, /^Nouvelle mission Produit/)
  assert.match(prompt, /la clé Jira du ticket que le principal a créé/)
  assert.match(prompt, /demande-la/)
  assert.match(prompt, /base_branch/)
  assert.match(prompt, /pas de `created`/)
  assert.match(prompt, /templates\/mission-produit\.md/)
  assert.doesNotMatch(prompt, /repo: ~\/konoha/)
})

test('newMissionPrompt poc : hypothèse réfutable, timebox et note de décision', () => {
  const prompt = client.newMissionPrompt('poc')
  assert.match(prompt, /^Nouvelle mission POC/)
  assert.match(prompt, /POC-NN, le prochain rang libre/)
  assert.match(prompt, /hypothèse réfutable et la timebox/)
  assert.match(prompt, /renseigne `repos` et `created`/)
  assert.match(prompt, /templates\/mission-poc\.md/)
})

test('newMissionPrompt : un type inconnu retombe sur le conteneur', () => {
  assert.equal(client.newMissionPrompt('inconnu'), client.newMissionPrompt('conteneur'))
})

test('NewMissionMenu : fermé, un seul bouton ; ouvert, les trois types', () => {
  const closed = client.NewMissionMenu({ open: false, busy: false, onToggle: () => {}, onPick: () => {} })
  assert.equal(byClass(closed, 'dm-nm-btn').length, 1)
  assert.match(text(byClass(closed, 'dm-nm-btn')[0]), /Nouvelle mission/)
  assert.equal(byClass(closed, 'dm-nm-item').length, 0)

  const open = client.NewMissionMenu({ open: true, busy: false, onToggle: () => {}, onPick: () => {} })
  const items = byClass(open, 'dm-nm-item')
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => text(byClass(item, 'dm-nm-label')[0])), ['Produit', 'Conteneur', 'POC'])
  for (const item of items) assert.ok(text(byClass(item, 'dm-nm-hint')[0]).length > 0)
})

test('NewMissionMenu : le bouton ouvre, un type part au clic', () => {
  const toggles = []
  const picks = []
  const tree = client.NewMissionMenu({
    open: true,
    busy: false,
    onToggle: (next) => toggles.push(next),
    onPick: (key) => picks.push(key),
  })
  byClass(tree, 'dm-nm-btn')[0].props.onClick()
  assert.deepEqual(toggles, [false])
  byClass(tree, 'dm-nm-item')[0].props.onClick()
  assert.deepEqual(picks, ['produit'])
})

test('NewMissionMenu : la session en cours d’ouverture désarme le bouton', () => {
  const tree = client.NewMissionMenu({ open: false, busy: true, onToggle: () => {}, onPick: () => {} })
  const button = byClass(tree, 'dm-nm-btn')[0]
  assert.equal(button.props.disabled, true)
  assert.match(text(button), /Ouverture de la session…/)
})

test('MissionListFooter : le bouton vit sous la ligne des clôturées', () => {
  const tree = client.MissionListFooter({
    archived: 93,
    root: '/Users/…/konoha/missions',
    open: false,
    busy: false,
    onToggle: () => {},
    onPick: () => {},
  })
  assert.equal(byClass(tree, 'dm-foot').length, 1)
  assert.match(text(byClass(tree, 'dm-foot')[0]), /93 clôturées dans \/Users\/…\/konoha\/missions\/archives/)
  assert.match(text(byClass(tree, 'dm-nm-btn')[0]), /Nouvelle mission/)
})

test('la vue Missions rend le pied nouveau, la file garde le sien', () => {
  const list = source.indexOf("vueTabs('list')")
  const footer = source.indexOf('h(MissionListFooter')
  assert.ok(list >= 0 && footer > list)
  const queueStart = source.indexOf("if (view === 'queue') {")
  const queueEnd = source.indexOf("if (view === 'plan') {")
  const queueBlock = source.slice(queueStart, queueEnd)
  assert.ok(queueStart >= 0 && queueEnd > queueStart)
  assert.doesNotMatch(queueBlock, /MissionListFooter/)
})

test('startNewMission : ouvre une session dans le workspace des missions, sans lien', () => {
  const body = source.match(/const startNewMission = React.useCallback\([\s\S]*?\n      \)\n/)?.[0] ?? ''
  assert.ok(body.length > 0)
  assert.match(body, /missionsWorkspace\(workspaces\?\.list\?\.getSnapshot\?\.\(\), state\.data\)/)
  assert.match(body, /ui\.startSession\(workspace\.workspaceId, \{ prompt: newMissionPrompt\(type\) \}\)/)
  assert.match(body, /setNewMissionOpen\(false\)/)
  assert.doesNotMatch(body, /LINK_URL/)
})
