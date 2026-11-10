import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { lister, oublierJeton } from '../lib/trackers/jira.js'

const PROJET = {
  id: 'manager',
  tracker: 'jira',
  jira: { site: 'https://exemple.atlassian.net', key_prefix: 'SO', email: 'moi@exemple.test' },
  map: {
    states: {
      'to-refine': 'To Do',
      ready: 'Ready',
      'in-progress': 'In Progress',
      'in-review': 'In Review',
      done: 'Done',
    },
    types: { bug: 'Bug', story: 'Story' },
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

function issue(cle, { statut = 'In Progress', type = 'Story', parent = null } = {}) {
  return {
    key: cle,
    fields: {
      summary: `Mission ${cle}`,
      status: { name: statut },
      issuetype: { name: type },
      parent: parent ? { key: parent } : undefined,
      updated: '2026-11-10T10:00:00.000+0000',
    },
  }
}

beforeEach(() => {
  process.env.JIRA_API_TOKEN = 'jeton-de-test'
  process.env.JIRA_EMAIL = 'moi@exemple.test'
  oublierJeton()
})

test('les issues Jira sont normalisées par le map du projet', async () => {
  const fetchImpl = async () => reponse({ issues: [issue('SO-1207', { parent: 'SO-1000' })] })

  const missions = await lister(PROJET, { fetchImpl })

  assert.deepEqual(missions[0], {
    projet: 'manager',
    cle: 'SO-1207',
    numero: null,
    titre: 'Mission SO-1207',
    etat: 'in-progress',
    type: 'story',
    epic: 'SO-1000',
    url: 'https://exemple.atlassian.net/browse/SO-1207',
    maj: '2026-11-10T10:00:00.000+0000',
  })
})

test('un statut hors correspondance laisse l’état à null', async () => {
  const fetchImpl = async () => reponse({ issues: [issue('SO-1', { statut: 'En attente client' })] })

  const missions = await lister(PROJET, { fetchImpl })

  assert.equal(missions[0].etat, null)
})

test('la pagination suit nextPageToken', async () => {
  const appels = []
  const fetchImpl = async (url) => {
    appels.push(url)
    if (appels.length === 1) return reponse({ issues: [issue('SO-1')], nextPageToken: 'page-2' })
    return reponse({ issues: [issue('SO-2')] })
  }

  const missions = await lister(PROJET, { fetchImpl })

  assert.equal(appels.length, 2)
  assert.match(appels[1], /nextPageToken=page-2/)
  assert.deepEqual(missions.map((m) => m.cle), ['SO-1', 'SO-2'])
})

test('un 404 sur /search/jql retombe sur l’endpoint historique', async () => {
  const appels = []
  const fetchImpl = async (url) => {
    appels.push(url)
    if (appels.length === 1) return reponse({ errorMessages: ['gone'] }, { status: 404 })
    return reponse({ issues: [issue('SO-3')], total: 1 })
  }

  const missions = await lister(PROJET, { fetchImpl })

  assert.equal(appels.length, 2)
  assert.match(appels[1], /\/rest\/api\/3\/search\?/)
  assert.equal(missions[0].cle, 'SO-3')
})

test('un 401 nomme le jeton Jira', async () => {
  const fetchImpl = async () => reponse({ message: 'Unauthorized' }, { status: 401 })

  await assert.rejects(() => lister(PROJET, { fetchImpl }), /jeton Jira absent ou invalide/)
})

test('un projet sans site ou sans préfixe est refusé', async () => {
  await assert.rejects(() => lister({ ...PROJET, jira: { key_prefix: 'SO' } }, { fetchImpl: async () => reponse({}) }), /jira\.site/)
  await assert.rejects(() => lister({ ...PROJET, jira: { site: 'https://x' } }, { fetchImpl: async () => reponse({}) }), /key_prefix/)
})
