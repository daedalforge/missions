import assert from 'node:assert/strict'
import test from 'node:test'

import {
  epicOptions,
  executionBlocker,
  filterMissions,
  groupByState,
  hasActiveFilters,
  priorityOptions,
  projectOptions,
  relativeAge,
  sortMissions,
  stateOptions,
} from '../lib/view.js'

const MISSIONS = [
  {
    key: 'a#1',
    title: 'Panneau vide',
    project: 'missions',
    projectName: 'Workspace missions',
    epic: 'Workspace',
    state: 'in-review',
    type: 'bug',
    priority: 'urgent',
    points: 3,
  },
  {
    key: 'a#2',
    title: 'Lecture Jira',
    project: 'manager',
    projectName: 'Manager',
    epic: null,
    state: 'to-refine',
    type: 'story',
    priority: 'normal',
    points: 5,
  },
  {
    key: 'a#3',
    title: 'Cartes et filtres',
    project: 'missions',
    projectName: 'Workspace missions',
    epic: 'Workspace',
    state: 'ready',
    type: 'story',
    priority: 'low',
    points: 2,
  },
]

test('la recherche porte sur le titre, la clé, le projet et l’epic', () => {
  assert.deepEqual(filterMissions(MISSIONS, { query: 'panneau' }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'A#3' }).map((m) => m.key), ['a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'manager' }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'workspace' }).map((m) => m.key), ['a#1', 'a#3'])
})

test('le filtre de type se combine avec la recherche', () => {
  assert.deepEqual(filterMissions(MISSIONS, { type: 'story' }).map((m) => m.key), ['a#2', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { type: 'bug', query: 'cartes' }), [])
})

test('les filtres epic, priorité et projet se combinent en ET', () => {
  assert.deepEqual(filterMissions(MISSIONS, { epic: 'Workspace' }).map((m) => m.key), ['a#1', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { priority: 'normal' }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(MISSIONS, { project: 'missions' }).map((m) => m.key), ['a#1', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { project: 'missions', type: 'story' }).map((m) => m.key), ['a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { epic: 'Workspace', priority: 'urgent' }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'cartes', project: 'missions' }).map((m) => m.key), ['a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { project: 'manager', type: 'bug' }), [])
})

test('le filtre de statut isole un groupe et distingue unknown', () => {
  assert.deepEqual(filterMissions(MISSIONS, { state: 'in-review' }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { state: 'to-refine' }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(MISSIONS, { state: 'ready' }).map((m) => m.key), ['a#3'])

  const withUnknown = [...MISSIONS, { key: 'a#4', state: null, type: 'story', priority: null, points: null }]
  assert.deepEqual(filterMissions(withUnknown, { state: 'unknown' }).map((m) => m.key), ['a#4'])
  assert.deepEqual(filterMissions(withUnknown, { state: 'ready' }).map((m) => m.key), ['a#3'])
})

test('les statuts proposés suivent l’ordre du workflow, unknown en dernier', () => {
  assert.deepEqual(stateOptions(MISSIONS), ['to-refine', 'ready', 'in-review'])
  const withMore = [
    ...MISSIONS,
    { key: 'a#6', state: null },
  ]
  assert.deepEqual(stateOptions(withMore), ['to-refine', 'ready', 'in-review', 'unknown'])
  assert.deepEqual(
    stateOptions([...withMore, { key: 'a#7', state: 'ready-for-prod' }]),
    ['to-refine', 'ready', 'in-review', 'ready-for-prod', 'unknown'],
  )
  assert.deepEqual(stateOptions([]), [])
})

test('done n’est plus un état du panneau : ni groupe, ni option de filtre', () => {
  const done = [{ key: 'a#5', state: 'done' }]
  assert.deepEqual(groupByState(done).map((g) => g.state), ['unknown'])
  assert.deepEqual(stateOptions(done), ['unknown'])
})

test('le tri priorité va du plus haut au plus bas, les sans-priorité en fin', () => {
  assert.deepEqual(sortMissions(MISSIONS, 'priority').map((m) => m.key), ['a#1', 'a#2', 'a#3'])
  const extra = [...MISSIONS, { key: 'a#0', priority: null, points: null }]
  assert.deepEqual(sortMissions(extra, 'priority').map((m) => m.key), ['a#1', 'a#2', 'a#3', 'a#0'])
  const tie = [
    { key: 'b#2', priority: 'normal', points: 2 },
    { key: 'b#1', priority: 'normal', points: 2 },
  ]
  assert.deepEqual(sortMissions(tie, 'priority').map((m) => m.key), ['b#1', 'b#2'])
})

test('le tri story points va du plus petit au plus grand, les sans-SP en fin', () => {
  assert.deepEqual(sortMissions(MISSIONS, 'points').map((m) => m.key), ['a#3', 'a#1', 'a#2'])
  const extra = [...MISSIONS, { key: 'a#0', priority: null, points: null }]
  assert.deepEqual(sortMissions(extra, 'points').map((m) => m.key), ['a#3', 'a#1', 'a#2', 'a#0'])
  assert.deepEqual(sortMissions(MISSIONS, null).map((m) => m.key), ['a#1', 'a#2', 'a#3'])
})

test('le filtre Missing ne garde que les tickets à qui il manque un champ', () => {
  assert.deepEqual(filterMissions(MISSIONS, { missing: 'any' }).map((m) => m.key), ['a#2'])

  const complete = [
    ...MISSIONS,
    { key: 'a#4', points: 0, priority: 'urgent', epic: 'Workspace', type: 'bug' },
    { key: 'a#6', points: 0.5, priority: 'low', epic: 'Workspace', type: 'story' },
  ]
  assert.deepEqual(filterMissions(complete, { missing: 'any' }).map((m) => m.key), ['a#2'])

  const sparse = [...MISSIONS, { key: 'a#5', points: null, priority: null, epic: null, type: null }]
  assert.deepEqual(filterMissions(sparse, { missing: 'any' }).map((m) => m.key), ['a#2', 'a#5'])
  assert.equal(filterMissions(complete, { missing: null }).length, complete.length)
})

test('une recherche vide ne filtre rien', () => {
  assert.equal(filterMissions(MISSIONS).length, 3)
  assert.equal(filterMissions(MISSIONS, { query: '   ' }).length, 3)
})

test('les options viennent des missions chargées, sans doublon et triées', () => {
  assert.deepEqual(epicOptions(MISSIONS), ['Workspace'])
  assert.deepEqual(priorityOptions(MISSIONS), ['urgent', 'normal', 'low'])
  assert.deepEqual(projectOptions(MISSIONS), [
    { id: 'manager', name: 'Manager' },
    { id: 'missions', name: 'Workspace missions' },
  ])
  assert.deepEqual(epicOptions([]), [])
  assert.deepEqual(priorityOptions([]), [])
  assert.deepEqual(projectOptions([]), [])
})

test('un filtre actif est détecté, le type et le statut compris', () => {
  assert.equal(
    hasActiveFilters({ type: null, state: null, epic: null, priority: null, project: null }),
    false,
  )
  assert.equal(hasActiveFilters({ type: 'bug', state: null, epic: null, priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: 'ready', epic: null, priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: 'Workspace', priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: null, priority: 'normal', project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: null, priority: null, project: 'missions' }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: null, priority: null, project: null, missing: 'any' }), true)
})

test('les groupes suivent l’ordre du workflow, l’attente de prod après la revue', () => {
  const groupes = groupByState([
    ...MISSIONS,
    { key: 'a#6', state: 'ready-for-prod' },
    { key: 'a#4', state: null },
  ])
  assert.deepEqual(groupes.map((g) => g.state), ['in-review', 'ready-for-prod', 'ready', 'to-refine', 'unknown'])
  assert.equal(groupes[0].missions.length, 1)
  assert.deepEqual(groupes[1].missions.map((m) => m.key), ['a#6'])
})

test('l’âge relatif reste court et lisible', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  assert.equal(relativeAge('2026-11-10T11:59:40Z', now), 'now')
  assert.equal(relativeAge('2026-11-10T11:30:00Z', now), '30 min')
  assert.equal(relativeAge('2026-11-10T08:00:00Z', now), '4 h')
  assert.equal(relativeAge('2026-11-08T12:00:00Z', now), '2 d')
  assert.equal(relativeAge(null, now), '')
})

test('une session exige une branche et une base déclarées', () => {
  assert.equal(executionBlocker({ branch: 'gh-41', base: 'main' }), null)
  assert.equal(executionBlocker({ branch: 'gh-41' }), 'base branch is not declared')
  assert.equal(executionBlocker({ base: 'main' }), 'branch is not declared')
  assert.equal(executionBlocker({}), 'branch is not declared')
  assert.equal(executionBlocker({ branch: null, base: null }), 'branch is not declared')
  assert.equal(executionBlocker(), 'branch is not declared')
})
