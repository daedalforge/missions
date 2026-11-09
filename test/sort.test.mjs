import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = { createElement: () => null }
const primitives = { MarkdownText: (props) => react.createElement('div', { className: 'markdown' }, props.text) }
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const theme = createPanelComponents(react.createElement)
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

const { sortMissions } = client
const ids = (missions) => missions.map((mission) => mission.id)

test('la priorité reste le premier critère, devant le statut', () => {
  const missions = [
    { id: 'ABC-1', priority: 'un_jour', status: 'active' },
    { id: 'ABC-2', priority: 'urgent', status: 'draft' },
    { id: 'ABC-3', priority: 'important', status: 'in_review' },
  ]
  assert.deepEqual(ids(sortMissions(missions)), ['ABC-2', 'ABC-3', 'ABC-1'])
})

test('à priorité égale, le statut ordonne en cours, en review, en cadrage', () => {
  const missions = [
    { id: 'ABC-10', priority: '', status: 'draft' },
    { id: 'ABC-11', priority: '', status: 'in_review' },
    { id: 'ABC-12', priority: '', status: 'active' },
  ]
  assert.deepEqual(ids(sortMissions(missions)), ['ABC-12', 'ABC-11', 'ABC-10'])
})

test('le statut ordonne les états ajoutés entre la review et le cadrage', () => {
  const missions = [
    { id: 'ABC-13', priority: '', status: 'draft' },
    { id: 'ABC-14', priority: '', status: 'ready' },
    { id: 'ABC-18', priority: '', status: 'awaiting_validation' },
    { id: 'ABC-15', priority: '', status: 'in_peer_review' },
    { id: 'ABC-16', priority: '', status: 'in_review' },
    { id: 'ABC-17', priority: '', status: 'active' },
  ]
  assert.deepEqual(ids(sortMissions(missions)), ['ABC-17', 'ABC-16', 'ABC-15', 'ABC-18', 'ABC-14', 'ABC-13'])
})

test('une priorité ou un statut inconnus ne cassent pas l’ordre', () => {
  const missions = [
    { id: 'ABC-20', priority: '', status: 'draft' },
    { id: 'ABC-21', priority: '', status: 'archive' },
    { id: 'ABC-22', priority: '', status: 'active' },
    { id: 'ABC-23', priority: 'bloquee', status: 'active' },
    { id: 'ABC-24', priority: 'un_jour', status: '' },
  ]
  assert.deepEqual(ids(sortMissions(missions)), ['ABC-24', 'ABC-22', 'ABC-23', 'ABC-20', 'ABC-21'])
})

test('à priorité et statut égaux, les identifiants suivent l’ordre naturel', () => {
  const missions = [
    { id: 'XYZ-1000', status: 'active' },
    { id: 'XYZ-999', status: 'active' },
    { id: 'XYZ-1493', status: 'active' },
  ]
  assert.deepEqual(ids(sortMissions(missions)), ['XYZ-999', 'XYZ-1000', 'XYZ-1493'])
})

test('dans le bloc sans priorité, les missions en cours passent devant les fiches en cadrage', () => {
  const missions = [
    { id: 'XYZ-1402', priority: '', status: 'draft' },
    { id: 'XYZ-1491', priority: '', status: 'active' },
    { id: 'MGR-SESSIONS-INDIVIDUELLES', priority: '', status: 'draft' },
    { id: 'XYZ-1493', priority: '', status: 'active' },
    { id: 'ABC-38', priority: '', status: 'active' },
    { id: 'ABC-39', priority: '', status: 'active' },
    { id: 'MGR-INTERVENANTS', priority: '', status: 'draft' },
  ]
  assert.deepEqual(ids(sortMissions(missions)), [
    'ABC-38',
    'ABC-39',
    'XYZ-1491',
    'XYZ-1493',
    'MGR-INTERVENANTS',
    'MGR-SESSIONS-INDIVIDUELLES',
    'XYZ-1402',
  ])
})

test('sortMissions ne modifie pas la liste reçue', () => {
  const missions = [
    { id: 'ABC-30', status: 'draft' },
    { id: 'ABC-31', status: 'active' },
  ]
  const sorted = sortMissions(missions)
  assert.deepEqual(ids(missions), ['ABC-30', 'ABC-31'])
  assert.deepEqual(ids(sorted), ['ABC-31', 'ABC-30'])
  assert.notEqual(sorted, missions)
})
