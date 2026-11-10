import assert from 'node:assert/strict'
import test from 'node:test'

import { filterMissions, groupByState, relativeAge } from '../lib/view.js'

const MISSIONS = [
  { key: 'a#1', title: 'Panneau vide', project: 'missions', epic: 'Workspace', state: 'in-review', type: 'bug' },
  { key: 'a#2', title: 'Lecture Jira', project: 'manager', epic: null, state: 'to-refine', type: 'story' },
  { key: 'a#3', title: 'Cartes et filtres', project: 'missions', epic: 'Workspace', state: 'ready', type: 'story' },
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

test('une recherche vide ne filtre rien', () => {
  assert.equal(filterMissions(MISSIONS).length, 3)
  assert.equal(filterMissions(MISSIONS, { query: '   ' }).length, 3)
})

test('les groupes suivent l’ordre du workflow, l’inconnu en dernier', () => {
  const groupes = groupByState([...MISSIONS, { key: 'a#4', state: null }])
  assert.deepEqual(groupes.map((g) => g.state), ['in-review', 'ready', 'to-refine', 'unknown'])
  assert.equal(groupes[0].missions.length, 1)
})

test('l’âge relatif reste court et lisible', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  assert.equal(relativeAge('2026-11-10T11:59:40Z', now), 'now')
  assert.equal(relativeAge('2026-11-10T11:30:00Z', now), '30 min')
  assert.equal(relativeAge('2026-11-10T08:00:00Z', now), '4 h')
  assert.equal(relativeAge('2026-11-08T12:00:00Z', now), '2 d')
  assert.equal(relativeAge(null, now), '')
})
