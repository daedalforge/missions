import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { listerTout, viderCache } from '../lib/trackers/index.js'

const MAP = {
  states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
  types: { bug: 'bug', story: 'story' },
}

const PROJET_OK = {
  id: 'missions',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'missions' },
  map: MAP,
}

const PROJET_CASSE = {
  id: 'casse',
  tracker: 'github',
  github: {},
  map: MAP,
}

function reponse(corps) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(corps),
  }
}

beforeEach(() => {
  process.env.GH_TOKEN = 'jeton-de-test'
  viderCache()
})

test('un projet en échec n’empêche pas les autres d’être lus', async () => {
  const fetchImpl = async () =>
    reponse([{ number: 2, title: 'Mission 2', labels: [{ name: 'story' }, { name: 'ready' }] }])

  const { missions, erreurs } = await listerTout([PROJET_CASSE, PROJET_OK], { fetchImpl })

  assert.equal(missions.length, 1)
  assert.equal(missions[0].cle, 'daedalforge/missions#2')
  assert.equal(erreurs.length, 1)
  assert.equal(erreurs[0].projet, 'casse')
  assert.match(erreurs[0].message, /owner et repo/)
})

test('la lecture est mise en cache, sauf demande fraîche', async () => {
  let appels = 0
  const fetchImpl = async () => {
    appels += 1
    return reponse([{ number: 2, title: 'Mission 2', labels: [{ name: 'ready' }] }])
  }

  await listerTout([PROJET_OK], { fetchImpl })
  await listerTout([PROJET_OK], { fetchImpl })
  assert.equal(appels, 1)

  await listerTout([PROJET_OK], { fetchImpl, frais: true })
  assert.equal(appels, 2)
})

test('les missions sont triées par état puis par clé', async () => {
  const fetchImpl = async () =>
    reponse([
      { number: 5, title: 'b', labels: [{ name: 'ready' }] },
      { number: 1, title: 'a', labels: [{ name: 'in-review' }] },
      { number: 3, title: 'c', labels: [{ name: 'ready' }] },
    ])

  const { missions } = await listerTout([PROJET_OK], { fetchImpl })

  assert.deepEqual(missions.map((m) => m.numero), [1, 3, 5])
})
