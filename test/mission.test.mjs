import assert from 'node:assert/strict'
import test from 'node:test'

import { inverser, normaliserIssue, premierConnu } from '../lib/mission.js'

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

test('premierConnu retient la première valeur connue', () => {
  const inverses = inverser(PROJET.map)
  assert.equal(premierConnu(['urgent', 'ready', 'in-review'], inverses.etats), 'ready')
  assert.equal(premierConnu(['urgent'], inverses.etats), null)
})

test('une issue prend son état et son type dans le vocabulaire du tracker', () => {
  const inverses = inverser(PROJET.map)
  const mission = normaliserIssue({
    projet: PROJET,
    cle: 'daedalforge/missions#2',
    numero: 2,
    titre: 'Le panneau lit chaque projet indépendamment',
    etatBrut: 'ready',
    typeBrut: 'story',
    epic: 'Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    maj: '2026-11-10T15:56:47Z',
    inverses,
  })

  assert.equal(mission.cle, 'daedalforge/missions#2')
  assert.equal(mission.etat, 'ready')
  assert.equal(mission.type, 'story')
  assert.equal(mission.epic, 'Workspace')
  assert.equal(mission.projet, 'missions')
})

test('un état inconnu reste null plutôt que d’être deviné', () => {
  const inverses = inverser(PROJET.map)
  const mission = normaliserIssue({
    projet: PROJET,
    cle: 'daedalforge/missions#3',
    titre: 'sans état',
    etatBrut: 'urgent',
    typeBrut: null,
    inverses,
  })

  assert.equal(mission.etat, null)
  assert.equal(mission.type, null)
  assert.equal(mission.epic, null)
})
