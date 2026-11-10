import assert from 'node:assert/strict'
import test from 'node:test'

import { inverser, normaliserIssue } from '../lib/mission.js'

const PROJET = {
  id: 'missions',
  map: {
    states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
    types: { bug: 'bug', story: 'story' },
  },
}

test('le map est inversé, les valeurs nulles ignorées', () => {
  const inverses = inverser(PROJET.map)
  assert.equal(inverses.etats.get('in-review'), 'in-review')
  assert.equal(inverses.etats.has('done'), false)
  assert.equal(inverses.types.get('story'), 'story')
})

test('une issue prend son état et son type dans ses libellés', () => {
  const inverses = inverser(PROJET.map)
  const mission = normaliserIssue({
    issue: {
      number: 2,
      title: 'Le panneau lit chaque projet indépendamment',
      labels: [{ name: 'story' }, { name: 'ready' }, { name: 'other' }],
      milestone: { title: 'Workspace' },
      html_url: 'https://github.com/daedalforge/missions/issues/2',
      updated_at: '2026-11-10T15:56:47Z',
    },
    projet: PROJET,
    inverses,
    cle: 'daedalforge/missions#2',
  })

  assert.equal(mission.cle, 'daedalforge/missions#2')
  assert.equal(mission.etat, 'ready')
  assert.equal(mission.type, 'story')
  assert.equal(mission.epic, 'Workspace')
  assert.equal(mission.projet, 'missions')
})

test('un libellé inconnu laisse l’état à null plutôt que de deviner', () => {
  const inverses = inverser(PROJET.map)
  const mission = normaliserIssue({
    issue: { number: 3, title: 'sans libellé', labels: [{ name: 'urgent' }] },
    projet: PROJET,
    inverses,
    cle: 'daedalforge/missions#3',
  })

  assert.equal(mission.etat, null)
  assert.equal(mission.type, null)
  assert.equal(mission.epic, null)
})
