import assert from 'node:assert/strict'
import test from 'node:test'

import { firstKnown, invertMap, normalizeIssue } from '../lib/mission.js'

const PROJECT = {
  id: 'missions',
  map: {
    states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
    types: { bug: 'bug', story: 'story' },
  },
}

test('the map is inverted and null values are ignored', () => {
  const inverse = invertMap(PROJECT.map)
  assert.equal(inverse.states.get('in-review'), 'in-review')
  assert.equal(inverse.states.has('done'), false)
  assert.equal(inverse.types.get('story'), 'story')
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
    key: 'daedalforge/missions#2',
    number: 2,
    title: 'The panel reads every project independently',
    rawState: 'ready',
    rawType: 'story',
    epic: 'Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    updatedAt: '2026-11-10T15:56:47Z',
    inverse,
  })

  assert.equal(mission.key, 'daedalforge/missions#2')
  assert.equal(mission.state, 'ready')
  assert.equal(mission.type, 'story')
  assert.equal(mission.epic, 'Workspace')
  assert.equal(mission.project, 'missions')
})

test('an unknown state stays null instead of being guessed', () => {
  const inverse = invertMap(PROJECT.map)
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'daedalforge/missions#3',
    title: 'no state',
    rawState: 'urgent',
    rawType: null,
    inverse,
  })

  assert.equal(mission.state, null)
  assert.equal(mission.type, null)
  assert.equal(mission.epic, null)
})
