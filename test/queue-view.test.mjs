import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
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

const mission = (id, status, extra = {}) => ({
  id,
  status,
  priority: '',
  title: id,
  repo: '~/konoha',
  queue: 0,
  suite: '',
  ...extra,
})

test('queueCandidates ne garde que les fiches prêtes, même sur un dépôt occupé', () => {
  const missions = [
    mission('XYZ-1380', 'active', { repo: '~/projects/atelier' }),
    mission('XYZ-1491', 'ready', { repo: '~/projects/atelier' }),
    mission('UV-1184', 'ready', { repo: '~/projects/registre' }),
    mission('UV-1185', 'draft', { repo: '~/projects/registre' }),
    mission('UV-1186', 'ready', { repo: '~/projects/registre', priority: 'important' }),
    mission('UV-1187', 'awaiting_validation', { repo: '~/projects/portail' }),
    mission('UV-1188', 'in_review', { repo: '~/projects/marche' }),
  ]
  assert.deepEqual(
    client.queueCandidates(missions).map((entry) => entry.id),
    ['XYZ-1491', 'UV-1184', 'UV-1186'],
  )
})

test('queueCandidates écarte une fiche déjà en file', () => {
  assert.deepEqual(client.queueCandidates([mission('UV-1184', 'ready', { queue: 1 })]), [])
})

test('queueCandidates garde une fiche dont la suite n’est pas close', () => {
  const missions = [
    mission('ABC-74', 'awaiting_validation'),
    mission('ABC-77', 'ready', { repo: '~/projects/registre', suite: 'ABC-74' }),
  ]
  assert.deepEqual(
    client.queueCandidates(missions).map((entry) => entry.id),
    ['ABC-77'],
  )
})

test('queueFile ne garde que les rangs tenus par une fiche prête', () => {
  const missions = [
    mission('UV-1185', 'ready', { queue: 2 }),
    mission('UV-760', 'in_review', { queue: 3 }),
    mission('UV-1184', 'ready', { queue: 1 }),
    mission('UV-1186', 'ready'),
  ]
  assert.deepEqual(
    client.queueFile(missions).map((entry) => entry.id),
    ['UV-1184', 'UV-1185'],
  )
})

test('queueFile ignore le rang d’une fiche hors attente d’exécution', () => {
  assert.deepEqual(
    client
      .queueFile([
        mission('UV-1185', 'draft', { queue: 1 }),
        mission('UV-760', 'in_review', { queue: 2 }),
        mission('XYZ-1380', 'active', { queue: 3 }),
      ])
      .map((entry) => entry.id),
    [],
  )
})

test('queueCandidates conserve l’ordre, priorité comprise', () => {
  const missions = [mission('UV-1190', 'ready'), mission('UV-1189', 'ready', { priority: 'important' })]
  const groups = client.groupMissions(client.queueCandidates(missions))
  assert.deepEqual(groups.map((group) => group.status), ['ready'])
  assert.deepEqual(groups[0].missions.map((entry) => entry.id), ['UV-1189', 'UV-1190'])
})

test('queueCandidates d’une liste vide reste vide', () => {
  assert.deepEqual(client.queueCandidates([]), [])
})
