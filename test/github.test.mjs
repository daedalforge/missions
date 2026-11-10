import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { lister, oublierJeton } from '../lib/trackers/github.js'

const PROJET = {
  id: 'missions',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'missions' },
  map: {
    states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
    types: { bug: 'bug', story: 'story' },
  },
}

function reponse(corps, { status = 200, link = null, reste = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (nom) => {
        const cle = String(nom).toLowerCase()
        if (cle === 'link') return link
        if (cle === 'x-ratelimit-remaining') return reste
        return null
      },
    },
    text: async () => (corps === undefined ? '' : JSON.stringify(corps)),
  }
}

function issue(numero, { labels = [], pr = false, milestone = null } = {}) {
  return {
    number: numero,
    title: `Mission ${numero}`,
    labels: labels.map((name) => ({ name })),
    milestone,
    html_url: `https://github.com/daedalforge/missions/issues/${numero}`,
    updated_at: '2026-11-10T10:00:00Z',
    ...(pr ? { pull_request: { url: 'https://api.github.com/pulls/1' } } : {}),
  }
}

beforeEach(() => {
  process.env.GH_TOKEN = 'jeton-de-test'
  oublierJeton()
})

test('les issues sont normalisées, les pull requests écartées', async () => {
  const fetchImpl = async () =>
    reponse([
      issue(2, { labels: ['story', 'ready'], milestone: { title: 'Workspace' } }),
      issue(9, { labels: ['bug'], pr: true }),
    ])

  const missions = await lister(PROJET, { fetchImpl })

  assert.equal(missions.length, 1)
  assert.deepEqual(missions[0], {
    projet: 'missions',
    cle: 'daedalforge/missions#2',
    numero: 2,
    titre: 'Mission 2',
    etat: 'ready',
    type: 'story',
    epic: 'Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    maj: '2026-11-10T10:00:00Z',
  })
})

test('la pagination suit l’en-tête Link', async () => {
  const appels = []
  const fetchImpl = async (url) => {
    appels.push(url)
    if (appels.length === 1) {
      return reponse([issue(1, { labels: ['story', 'to-refine'] })], {
        link: '<https://api.github.com/repos/daedalforge/missions/issues?page=2>; rel="next"',
      })
    }
    return reponse([issue(2, { labels: ['bug', 'in-review'] })])
  }

  const missions = await lister(PROJET, { fetchImpl })

  assert.equal(appels.length, 2)
  assert.deepEqual(missions.map((m) => m.numero), [1, 2])
  assert.deepEqual(missions.map((m) => m.etat), ['to-refine', 'in-review'])
})

test('un 401 nomme le jeton GitHub', async () => {
  const fetchImpl = async () => reponse({ message: 'Bad credentials' }, { status: 401 })

  await assert.rejects(() => lister(PROJET, { fetchImpl }), /jeton GitHub absent ou invalide/)
})

test('un quota épuisé donne l’heure de reprise', async () => {
  const fetchImpl = async () =>
    reponse({ message: 'API rate limit exceeded' }, { status: 403, reste: '0' })

  await assert.rejects(() => lister(PROJET, { fetchImpl }), /quota GitHub épuisé/)
})

test('un projet sans owner ni repo est refusé', async () => {
  const sansRepo = { ...PROJET, github: {} }
  await assert.rejects(() => lister(sansRepo, { fetchImpl: async () => reponse([]) }), /owner et repo/)
})
