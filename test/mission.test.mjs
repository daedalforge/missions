import assert from 'node:assert/strict'
import test from 'node:test'

import { firstKnown, invertMap, normalizeIssue, onlyKnown, stateBeforeReview } from '../lib/mission.js'

const PROJECT = {
  id: 'missions',
  name: 'Workspace missions',
  map: {
    states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
    types: { bug: 'Bug', story: 'Feature' },
    labels: { alpha: 'Alpha', shop: 'Shop' },
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
    key: 'EX-483',
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
    rawLabels: ['shop', 'feature-x'],
    epic: 'Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    updatedAt: '2026-11-10T15:56:47Z',
    inverse,
  })

  assert.equal(mission.key, 'MIS-2')
  assert.equal(mission.state, 'ready')
  assert.equal(mission.type, 'story')
  assert.equal(mission.epic, 'Workspace')
  assert.equal(mission.project, 'shop')
  assert.equal(mission.projectName, 'Shop')
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
    key: 'EX-1',
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

/** Les noms de statut du tracker, tels que la map inverse les lit. */
const WORKFLOW_NAMES = {
  'to-refine': 'To Refine',
  ready: 'Ready',
  'in-progress': 'In Progress',
  'in-review': 'Code Review',
  'ready-for-prod': 'Ready for Prod',
  done: 'Released',
}

const HOLDING_STATES = ['to-refine', 'ready', 'in-progress']
const RELEASING_STATES = ['in-review', 'ready-for-prod', 'done']

test('la revue sépare les états qui retiennent une mission de ceux qui la libèrent', () => {
  // Given les six états du workflow et la frontière de la revue.

  // When la frontière les lit un par un.

  // Then les états d'avant la revue retiennent, les suivants libèrent, et un
  // état absent ou inconnu ne retient rien.
  assert.deepEqual(HOLDING_STATES.map(stateBeforeReview), [true, true, true])
  assert.deepEqual(RELEASING_STATES.map(stateBeforeReview), [false, false, false])
  assert.equal(stateBeforeReview(null), false)
  assert.equal(stateBeforeReview('unknown'), false)
})

test('un lien entrant vers un état antérieur à la revue retient la mission', () => {
  // Given une mission in-progress, liée à une dépendance à raffiner et à une
  // dépendance déjà en revue.
  const inverse = invertMap({ states: WORKFLOW_NAMES, types: {}, labels: {} })
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-200',
    rawState: 'In Progress',
    rawBlockers: [
      { key: 'MIS-201', title: 'À raffiner', rawState: 'To Refine', url: 'https://jira.example/browse/MIS-201' },
      { key: 'MIS-202', title: 'En revue', rawState: 'Code Review', url: 'https://jira.example/browse/MIS-202' },
    ],
    inverse,
  })

  // Then seule la dépendance d'avant la revue retient, et l'état de la
  // mission ne bouge pas.
  assert.deepEqual(mission.blockers, [{
    key: 'MIS-201',
    title: 'À raffiner',
    state: 'to-refine',
    url: 'https://jira.example/browse/MIS-201',
  }])
  assert.equal(mission.blockedByLabel, false)
  assert.equal(mission.blocked, true)
  assert.equal(mission.state, 'in-progress')
})

test('les dépendances sont dédoublonnées, ordonnées et lues par la map', () => {
  // Given deux liens vers la même dépendance, une seconde et un statut hors
  // de la map, dans le désordre.
  const inverse = invertMap({ states: WORKFLOW_NAMES, types: {}, labels: {} })
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-210',
    rawState: 'In Progress',
    rawBlockers: [
      { key: 'MIS-212', title: 'Trois', rawState: 'In Progress', url: 'https://jira.example/browse/MIS-212' },
      { key: 'MIS-211', title: 'Un', rawState: 'To Refine', url: 'https://jira.example/browse/MIS-211' },
      { key: 'MIS-211', title: 'Un', rawState: 'To Refine', url: 'https://jira.example/browse/MIS-211' },
      { key: 'MIS-213', title: 'Hors map', rawState: 'Unknown Status', url: 'https://jira.example/browse/MIS-213' },
    ],
    inverse,
  })

  // Then chaque dépendance ne compte qu'une fois, dans l'ordre du workflow,
  // et le statut hors map est écarté.
  assert.deepEqual(mission.blockers.map((blocker) => blocker.key), ['MIS-211', 'MIS-212'])
  assert.deepEqual(mission.blockers.map((blocker) => blocker.state), ['to-refine', 'in-progress'])
})

test('le label et la dépendance s’additionnent sans doubler le blocage', () => {
  // Given une mission qui porte le label et qu'une dépendance retient.
  const inverse = invertMap({ states: WORKFLOW_NAMES, types: {}, labels: {} })
  const mission = normalizeIssue({
    project: PROJECT,
    key: 'MIS-220',
    rawState: 'In Progress',
    rawLabels: ['blocked'],
    rawBlockers: [{ key: 'MIS-221', title: 'Bloqueuse', rawState: 'Ready', url: 'https://jira.example/browse/MIS-221' }],
    inverse,
  })

  // Then les deux causes restent lisibles, et le blocage n'est dit qu'une fois.
  assert.equal(mission.blockedByLabel, true)
  assert.deepEqual(mission.blockers.map((blocker) => blocker.key), ['MIS-221'])
  assert.equal(mission.blocked, true)
})
