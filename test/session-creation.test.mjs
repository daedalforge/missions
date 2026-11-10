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

const snapshot = (items) => ({ items, archivedSessionIds: [], pinnedSessionIds: [], state: 'ready', phase: 'ready', error: null })
const workspace = (workspaceId, path) => ({ workspaceId, path, title: workspaceId, sessionIds: [] })
const missions = (workspacePath) => ({ sessions: { workspacePath } })

test('missionsWorkspace : vise le workspace qui porte les missions, pas le dépôt produit', () => {
  const connect = workspace('w-connect', '/Users/…/projects/atelier')
  const konoha = workspace('w-konoha', '/Users/…/konoha')
  const fallback = workspace('w-default', '/Users/…/Documents/default-workspace')
  assert.equal(
    client.missionsWorkspace(snapshot([connect, konoha, fallback]), missions('/Users/…/konoha')).workspaceId,
    'w-konoha',
  )
})

test('missionsWorkspace : ignore la barre finale des deux côtés', () => {
  const konoha = workspace('w-konoha', '/Users/…/konoha/')
  assert.equal(client.missionsWorkspace(snapshot([konoha]), missions('/Users/…/konoha')).workspaceId, 'w-konoha')
})

test('missionsWorkspace : échoue fermé quand konoha n’est pas ouverte', () => {
  const connect = workspace('w-connect', '/Users/…/projects/atelier')
  assert.equal(client.missionsWorkspace(snapshot([connect]), missions('/Users/…/konoha')), null)
})

test('missionsWorkspace : reconnaît konoha sous sa forme brute et sa forme résolue', () => {
  const items = snapshot([workspace('w-konoha', '/Volumes/…/konoha')])
  const data = { sessions: { workspacePaths: ['/Users/…/konoha', '/Volumes/…/konoha'], workspaceLabel: '~/konoha' } }
  assert.equal(client.missionsWorkspace(items, data).workspaceId, 'w-konoha')
})

test('missionsWorkspace : aucun workspace avant le chargement de la liste', () => {
  assert.equal(client.missionsWorkspace(undefined, missions('/Users/…/konoha')), null)
  assert.equal(client.missionsWorkspace({ items: [] }, missions('/Users/…/konoha')), null)
  assert.equal(client.missionsWorkspace(snapshot([workspace('w-konoha', '/Users/…/konoha')]), undefined), null)
})

test('la création de session suit le type de la mission, le cadrage reste sur konoha', () => {
  assert.match(source, /executionWorkspace\(workspaces\?\.list\?\.getSnapshot\?\.\(\), state\.data, mission\.type\)/)
  assert.match(source, /const startNewMission = React\.useCallback\([\s\S]*?missionsWorkspace\(workspaces\?\.list\?\.getSnapshot\?\.\(\), state\.data\)/)
  assert.doesNotMatch(source, /workspaces\.create/)
})

const sessions = (workspacePath, productWorkspacePath, productWorkspaceLabel) => ({
  sessions: {
    workspacePath,
    productWorkspacePath,
    productWorkspacePaths: [productWorkspacePath],
    productWorkspaceLabel,
  },
})

test('executionWorkspace : une mission produit prend le workspace de la racine produit', () => {
  const items = snapshot([workspace('w-konoha', '/Users/…/konoha'), workspace('w-projects', '/Users/…/projects')])
  const data = sessions('/Users/…/konoha', '/Users/…/projects', '~/projects')
  assert.equal(client.executionWorkspace(items, data, 'produit').workspaceId, 'w-projects')
  assert.equal(client.executionWorkspace(items, data, 'conteneur').workspaceId, 'w-konoha')
  assert.equal(client.executionWorkspace(items, data, 'poc').workspaceId, 'w-konoha')
})

test('executionWorkspace : échoue fermé quand la racine produit n’est pas ouverte', () => {
  const items = snapshot([workspace('w-konoha', '/Users/…/konoha')])
  const data = sessions('/Users/…/konoha', '/Users/…/projects', '~/projects')
  assert.equal(client.executionWorkspace(items, data, 'produit'), null)
  assert.equal(client.executionWorkspace(items, undefined, 'produit'), null)
})

test('executionWorkspace : reconnaît la racine produit sous sa forme brute et sa forme résolue', () => {
  const items = snapshot([workspace('w-projects', '/Volumes/…/projects')])
  const data = { sessions: { workspacePath: '/Users/…/konoha', productWorkspacePaths: ['/Users/…/projects', '/Volumes/…/projects'] } }
  assert.equal(client.executionWorkspace(items, data, 'produit').workspaceId, 'w-projects')
})

test('executionWorkspace : ignore la barre finale des deux côtés', () => {
  const items = snapshot([workspace('w-projects', '/Users/…/projects/')])
  assert.equal(client.executionWorkspace(items, sessions('/a', '/Users/…/projects'), 'produit').workspaceId, 'w-projects')
})

test('missingWorkspaceMessage : nomme le workspace produit absent', () => {
  assert.equal(
    client.missingWorkspaceMessage('produit', sessions('/a', '/Users/…/projects', '~/projects')),
    'Le workspace ~/projects n’est pas ouvert.',
  )
  assert.equal(client.missingWorkspaceMessage('conteneur', sessions('/a', '/Users/…/projects', '~/projects')), 'Le workspace ~/konoha n’est pas ouvert.')
  assert.equal(client.missingWorkspaceMessage('missions', { sessions: { workspaceLabel: '~/konoha' } }), 'Le workspace ~/konoha n’est pas ouvert.')
  assert.equal(client.missingWorkspaceMessage('missions', undefined), 'Le workspace ~/konoha n’est pas ouvert.')
})

test('le lancement de la file résout le workspace par mission', () => {
  assert.match(
    source,
    /executionWorkspace\(services\?\.getService\?\.\('workspaces'\)\?\.list\?\.getSnapshot\?\.\(\), data, mission\.type\)/,
  )
})

test('l’hôte rend la racine produit à côté du workspace des missions', async () => {
  const server = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(server, /productWorkspaceRoot: Schema\.string\(\)/)
  assert.match(server, /workspacePaths,/)
  assert.match(server, /workspaceLabel,/)
  assert.match(server, /productWorkspacePaths,/)
  assert.match(server, /productWorkspaceLabel,/)
})

test('la création de session n’appelle que des setters déclarés', () => {
  const declared = new Set([...source.matchAll(/const\s*\[[^\]]*,\s*(set[A-Z]\w*)\]/g)].map((match) => match[1]))
  const globals = new Set(['setTimeout', 'setInterval', 'setImmediate'])
  const called = new Set([...source.matchAll(/(?<![.\w])(set[A-Z]\w*)\s*\(/g)].map((match) => match[1]))
  const missing = [...called].filter((name) => !declared.has(name) && !globals.has(name))
  assert.deepEqual(missing, [])
})
