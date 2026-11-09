import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = { createElement: () => null }
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

const { filterMissions, epicOptions, emptyNotice } = client
const ids = (missions) => missions.map((mission) => mission.id)

const missions = [
  { id: 'XYZ-1', priority: 'urgent', epic: 'XYZ-1309' },
  { id: 'XYZ-2', priority: 'important', epic: 'XYZ-1309' },
  { id: 'XYZ-3', priority: 'urgent', epic: 'UV-483' },
  { id: 'XYZ-4', priority: '', epic: '' },
  { id: 'XYZ-5', priority: 'urgent', epic: '' },
  { id: 'XYZ-6', priority: 'urgent', epic: 'XYZ-1494' },
]

test("sans epic choisi, le filtre de priorité garde son comportement", () => {
  assert.deepEqual(ids(filterMissions(missions, '')), ['XYZ-1', 'XYZ-2', 'XYZ-3', 'XYZ-4', 'XYZ-5', 'XYZ-6'])
  assert.deepEqual(ids(filterMissions(missions, 'urgent')), ['XYZ-1', 'XYZ-3', 'XYZ-5', 'XYZ-6'])
  assert.deepEqual(ids(filterMissions(missions, 'none')), ['XYZ-4'])
})

test('un epic ne retient que ses missions', () => {
  assert.deepEqual(ids(filterMissions(missions, '', 'XYZ-1309')), ['XYZ-1', 'XYZ-2'])
  assert.deepEqual(ids(filterMissions(missions, '', 'XYZ-1494')), ['XYZ-6'])
})

test('sans epic retient les missions sans epic', () => {
  assert.deepEqual(ids(filterMissions(missions, '', 'none')), ['XYZ-4', 'XYZ-5'])
})

test('priorité et epic se combinent en intersection', () => {
  assert.deepEqual(ids(filterMissions(missions, 'urgent', 'XYZ-1309')), ['XYZ-1'])
  assert.deepEqual(ids(filterMissions(missions, 'important', 'XYZ-1309')), ['XYZ-2'])
  assert.deepEqual(ids(filterMissions(missions, 'urgent', 'none')), ['XYZ-5'])
  assert.deepEqual(ids(filterMissions(missions, 'none', 'XYZ-1309')), [])
})

const withSession = (sessionIds) => (mission) => sessionIds.includes(mission.id)

test('Session active ne garde que les missions rattachées à une session', () => {
  assert.deepEqual(ids(filterMissions(missions, '', undefined, 'active', withSession(['XYZ-1', 'XYZ-4']))), ['XYZ-1', 'XYZ-4'])
})

test('Sans session garde les missions sans session', () => {
  assert.deepEqual(ids(filterMissions(missions, '', '', 'none', withSession(['XYZ-1', 'XYZ-4']))), ['XYZ-2', 'XYZ-3', 'XYZ-5', 'XYZ-6'])
})

test('session, priorité et epic se combinent en intersection', () => {
  assert.deepEqual(ids(filterMissions(missions, 'urgent', 'XYZ-1309', 'none', withSession(['XYZ-1']))), [])
  assert.deepEqual(ids(filterMissions(missions, '', 'XYZ-1309', 'active', withSession(['XYZ-1']))), ['XYZ-1'])
  assert.deepEqual(ids(filterMissions(missions, 'urgent', '', 'active', withSession(['XYZ-5']))), ['XYZ-5'])
  assert.deepEqual(ids(filterMissions(missions, 'urgent', 'none', 'none', withSession(['XYZ-1']))), ['XYZ-5'])
})

test('Toutes ou un prédicat absent ne filtrent pas la session', () => {
  assert.equal(filterMissions(missions, '', '', '', withSession(['XYZ-1'])).length, 6)
  assert.equal(filterMissions(missions, '', '', 'active').length, 6)
  assert.equal(filterMissions(missions, '', '', 'none').length, 6)
})

test("l'état vide nomme le filtre de session", () => {
  assert.equal(emptyNotice('', '', '', 'active'), 'Aucune mission ouverte avec une session.')
  assert.equal(emptyNotice('', '', '', 'none'), 'Toutes les missions ont une session.')
  assert.equal(emptyNotice('urgent', '', 'tarif', 'active'), 'Aucune mission ne correspond à « tarif » avec ces filtres.')
  assert.equal(emptyNotice('urgent', '', '', 'active'), 'Aucune mission avec ces filtres.')
})

test('une sélection vide ou absente ne filtre pas', () => {
  assert.equal(filterMissions(missions, '', undefined).length, 6)
  assert.equal(filterMissions(missions, '', '').length, 6)
})

test('le filtre ne modifie pas la liste reçue', () => {
  filterMissions(missions, 'urgent', 'XYZ-1309')
  assert.equal(missions.length, 6)
})

test('les entrées du menu viennent des missions, triées, Toutes en tête', () => {
  assert.deepEqual(epicOptions(missions), [
    { key: '', label: 'Toutes' },
    { key: 'UV-483', label: 'UV-483' },
    { key: 'XYZ-1309', label: 'XYZ-1309' },
    { key: 'XYZ-1494', label: 'XYZ-1494' },
    { key: 'none', label: 'Sans epic' },
  ])
})

test('la clé seule suffit, même sans fiche d’epic', () => {
  assert.deepEqual(epicOptions([{ id: 'ABC-1', epic: 'XYZ-1494' }]), [
    { key: '', label: 'Toutes' },
    { key: 'XYZ-1494', label: 'XYZ-1494' },
  ])
})

test("Sans epic n'apparaît que s'il reste une mission sans epic", () => {
  const options = epicOptions([{ id: 'ABC-1', epic: 'UV-483' }])
  assert.deepEqual(options.map((entry) => entry.key), ['', 'UV-483'])
})

test('une liste sans mission ne propose que Toutes', () => {
  assert.deepEqual(epicOptions([]), [{ key: '', label: 'Toutes' }])
})

test('aucune entrée du menu ne porte de titre', () => {
  for (const entry of epicOptions(missions)) assert.ok(!('title' in entry), entry.key)
})
