import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { listerTout, viderCache } from '../lib/trackers/index.js'
import { oublierJeton } from '../lib/trackers/jira.js'

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

const PROJET_JIRA = {
  id: 'manager',
  tracker: 'jira',
  jira: { site: 'https://exemple.atlassian.net', key_prefix: 'SO', email: 'moi@exemple.test' },
  map: {
    states: { 'to-refine': 'To Do', ready: 'Ready', 'in-progress': 'In Progress', 'in-review': 'In Review', done: 'Done' },
    types: { bug: 'Bug', story: 'Story' },
  },
}

beforeEach(() => {
  process.env.GH_TOKEN = 'jeton-de-test'
  process.env.JIRA_API_TOKEN = 'jeton-jira-de-test'
  process.env.JIRA_EMAIL = 'moi@exemple.test'
  oublierJeton()
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

test('GitHub et Jira cohabitent dans la même liste', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) {
      return reponse([{ number: 2, title: 'Mission GitHub', labels: [{ name: 'story' }, { name: 'ready' }] }])
    }
    return reponse({
      issues: [
        {
          key: 'SO-1207',
          fields: { summary: 'Mission Jira', status: { name: 'In Progress' }, issuetype: { name: 'Story' } },
        },
      ],
    })
  }

  const { missions, erreurs } = await listerTout([PROJET_OK, PROJET_JIRA], { fetchImpl })

  assert.equal(erreurs.length, 0)
  assert.deepEqual(missions.map((m) => m.cle).sort(), ['SO-1207', 'daedalforge/missions#2'])
  assert.deepEqual(missions.map((m) => m.projet).sort(), ['manager', 'missions'])
})
