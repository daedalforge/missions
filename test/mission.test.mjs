import assert from 'node:assert/strict'
import test from 'node:test'

import { firstKnown, invertMap, normalizeIssue } from '../lib/mission.js'

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

test('firstKnown keeps the first known value', () => {
  const inverse = invertMap(PROJECT.map)
  assert.equal(firstKnown(['urgent', 'ready', 'in-review'], inverse.states), 'ready')
  assert.equal(firstKnown(['urgent'], inverse.states), null)
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
