import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { forgetToken, list } from '../lib/trackers/jira.js'

const PROJECT = {
  id: 'manager',
  tracker: 'jira',
  jira: { site: 'https://example.atlassian.net', key_prefix: 'SO', email: 'me@example.test' },
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

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase()
        if (key === 'x-ratelimit-remaining') return null
        return null
      },
    },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function issue(key, { status = 'In Progress', type = 'Story', parent = null } = {}) {
  return {
    key,
    fields: {
      summary: `Mission ${key}`,
      status: { name: status },
      issuetype: { name: type },
      parent: parent ? { key: parent } : undefined,
      updated: '2026-11-10T10:00:00.000+0000',
    },
  }
}

beforeEach(() => {
  process.env.JIRA_API_TOKEN = 'test-token'
  process.env.JIRA_EMAIL = 'me@example.test'
  forgetToken()
})

test('Jira issues are normalized through the project map', async () => {
  const fetchImpl = async () => response({ issues: [issue('SO-1207', { parent: 'SO-1000' })] })

  const missions = await list(PROJECT, { fetchImpl })

  assert.deepEqual(missions[0], {
    project: 'manager',
    key: 'SO-1207',
    number: null,
    title: 'Mission SO-1207',
    state: 'in-progress',
    type: 'story',
    epic: 'SO-1000',
    url: 'https://example.atlassian.net/browse/SO-1207',
    updatedAt: '2026-11-10T10:00:00.000+0000',
  })
})

test('a status outside the mapping leaves the state null', async () => {
  const fetchImpl = async () => response({ issues: [issue('SO-1', { status: 'Waiting for client' })] })

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(missions[0].state, null)
})

test('pagination follows nextPageToken', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (calls.length === 1) return response({ issues: [issue('SO-1')], nextPageToken: 'page-2' })
    return response({ issues: [issue('SO-2')] })
  }

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(calls.length, 2)
  assert.match(calls[1], /nextPageToken=page-2/)
  assert.deepEqual(missions.map((m) => m.key), ['SO-1', 'SO-2'])
})

test('a 404 on /search/jql falls back to the legacy endpoint', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (calls.length === 1) return response({ errorMessages: ['gone'] }, { status: 404 })
    return response({ issues: [issue('SO-3')], total: 1 })
  }

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(calls.length, 2)
  assert.match(calls[1], /\/rest\/api\/3\/search\?/)
  assert.equal(missions[0].key, 'SO-3')
})

test('a 401 names the Jira token', async () => {
  const fetchImpl = async () => response({ message: 'Unauthorized' }, { status: 401 })

  await assert.rejects(() => list(PROJECT, { fetchImpl }), /Jira token missing or invalid/)
})

test('a project without site or prefix is rejected', async () => {
  await assert.rejects(
    () => list({ ...PROJECT, jira: { key_prefix: 'SO' } }, { fetchImpl: async () => response({}) }),
    /jira\.site/,
  )
  await assert.rejects(
    () => list({ ...PROJECT, jira: { site: 'https://x' } }, { fetchImpl: async () => response({}) }),
    /key_prefix/,
  )
})
