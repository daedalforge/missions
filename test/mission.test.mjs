import assert from 'node:assert/strict'
import test from 'node:test'

import { firstKnown, invertMap, normalizeIssue, onlyKnown } from '../lib/mission.js'

const PROJECT = {
  id: 'missions',
  name: 'Workspace missions',
  map: {
    states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
    types: { bug: 'Bug', story: 'Feature' },
    labels: { manager: 'Manager', marketplace: 'Marketplace' },
  },
}

test('the map is inverted and null values are ignored', () => {
  const inverse = invertMap(PROJECT.map)
  assert.equal(inverse.states.get('in-review'), 'in-review')
  assert.equal(inverse.states.has('done'), false)
  assert.equal(inverse.types.get('Feature'), 'story')
})

test('a canonical state may name several tracker values', () => {
  const inverse = invertMap({
    states: { 'in-progress': ['In Progress', 'Local Testing'], done: 'Released' },
    types: {},
  })

  assert.equal(inverse.states.get('In Progress'), 'in-progress')
  assert.equal(inverse.states.get('Local Testing'), 'in-progress')
  assert.equal(inverse.states.get('Released'), 'done')
})

test('a canonical type may name several tracker values', () => {
  const inverse = invertMap({
    states: {},
    types: { bug: 'Bug', story: ['Story', 'Task'] },
  })

  assert.equal(inverse.types.get('Story'), 'story')
  assert.equal(inverse.types.get('Task'), 'story')
  assert.equal(inverse.types.get('Bug'), 'bug')
})

test('a type outside the map stays null instead of being guessed', () => {
  const inverse = invertMap({ ...PROJECT.map, types: { bug: 'Bug', story: ['Story', 'Task'] } })
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'SO-483',
    title: 'an epic is not a mission',
    rawState: 'ready',
    rawType: 'Epic',
    inverse,
  })

  assert.equal(mission.type, null)
  assert.equal(mission.state, 'ready')
})

test('firstKnown keeps the first known value', () => {
  const inverse = invertMap(PROJECT.map)
  assert.equal(firstKnown(['urgent', 'ready', 'in-review'], inverse.states), 'ready')
  assert.equal(firstKnown(['urgent'], inverse.states), null)
})

test('onlyKnown returns the one value, or names the conflict', () => {
  const inverse = invertMap(PROJECT.map)

  assert.deepEqual(onlyKnown(['urgent', 'ready', 'sp:2'], inverse.states), { value: 'ready', conflict: [] })
  assert.deepEqual(onlyKnown(['urgent', 'done'], inverse.states), { value: null, conflict: [] })
  assert.deepEqual(onlyKnown([], inverse.states), { value: null, conflict: [] })
  // The same label twice is not a conflict: only distinct states are.
  assert.deepEqual(onlyKnown(['ready', 'ready'], inverse.states), { value: 'ready', conflict: [] })
  assert.deepEqual(onlyKnown(['in-review', 'ready'], inverse.states), { value: null, conflict: ['in-review', 'ready'] })
  assert.deepEqual(onlyKnown(['ready', 'in-review'], inverse.states), { value: null, conflict: ['in-review', 'ready'] })
})

test('an issue takes its state and type from the tracker vocabulary', () => {
  const inverse = invertMap(PROJECT.map)
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-2',
    number: 2,
    title: 'The panel reads every project independently',
    rawState: 'ready',
    rawType: 'Feature',
    rawLabels: ['marketplace', 'services-residents'],
    epic: 'Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    updatedAt: '2026-11-10T15:56:47Z',
    inverse,
  })

  assert.equal(mission.key, 'MIS-2')
  assert.equal(mission.state, 'ready')
  assert.equal(mission.type, 'story')
  assert.equal(mission.epic, 'Workspace')
  assert.equal(mission.project, 'marketplace')
  assert.equal(mission.projectName, 'Marketplace')
})

test('a mission carries the project’s clone, or null when none is declared', () => {
  const inverse = invertMap(PROJECT.map)
  const withRepo = normalizeIssue({
    project: { ...PROJECT, repo: '~/projects/missions' },
    key: 'MIS-6',
    title: 'the prompt names the clone',
    rawState: 'in-review',
    inverse,
  })
  const withoutRepo = normalizeIssue({ project: PROJECT, key: 'MIS-7', title: 'no clone', inverse })

  assert.equal(withRepo.repo, '~/projects/missions')
  assert.equal(withoutRepo.repo, null)
})

test('le bloc translations du projet suit la mission, ou reste null', () => {
  const inverse = invertMap(PROJECT.map)
  const translations = { locales: ['fr', 'en'], languageFile: 'locales/{locale}.json', reference: 'fr' }
  const declared = normalizeIssue({
    project: { ...PROJECT, translations },
    key: 'SO-1',
    title: 'translated',
    rawState: 'in-review',
    inverse,
  })
  const plain = normalizeIssue({ project: PROJECT, key: 'MIS-8', title: 'not translated', inverse })

  assert.deepEqual(declared.translations, translations)
  assert.equal(plain.translations, null)
})

test('an unknown state stays null instead of being guessed', () => {
  const inverse = invertMap(PROJECT.map)
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-3',
    title: 'no state',
    rawState: 'urgent',
    rawType: null,
    inverse,
  })

  assert.equal(mission.state, null)
  assert.equal(mission.type, null)
  assert.equal(mission.epic, null)
})

test('the blocked label is read as a flag, never as a state', () => {
  const inverse = invertMap(PROJECT.map)
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-110',
    title: 'Label Bloqué',
    rawState: 'in-progress',
    rawType: 'Feature',
    rawLabels: ['blocked', 'priority:high'],
    inverse,
  })

  assert.equal(mission.blocked, true)
  // The label translates nothing: the state still comes from the project map.
  assert.equal(mission.state, 'in-progress')
  assert.deepEqual(mission.stateConflict, [])
})

test('a mission without the label is not blocked', () => {
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-111',
    rawLabels: ['ready', 'priority:normal'],
    inverse: invertMap(PROJECT.map),
  })

  assert.equal(mission.blocked, false)
})
