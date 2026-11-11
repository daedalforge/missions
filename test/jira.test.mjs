import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { forgetToken, list, setBlocked } from '../lib/trackers/jira.js'

const PROJECT = {
  id: 'manager',
  name: 'Manager',
  reference: 'SO',
  tracker: 'jira',
  jira: {
    site: 'https://example.atlassian.net',
    cloud_id: 'cloud-1',
    email: 'me@example.test',
  },
  map: {
    states: {
      'to-refine': 'To Refine',
      ready: 'Ready to Dev',
      'in-progress': 'In Progress',
      'in-review': 'Code review',
      done: 'Released',
    },
    types: { bug: 'Bug', story: 'Story' },
    priorities: { urgent: 'Highest', high: 'High', normal: 'Medium', low: 'Low' },
    labels: { manager: 'Manager', marketplace: 'Marketplace' },
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

function issue(key, { status = 'In Progress', type = 'Story', hierarchyLevel = 0, parent = null, labels = [] } = {}) {
  return {
    key,
    fields: {
      summary: `Mission ${key}`,
      status: { name: status },
      issuetype: { name: type, hierarchyLevel },
      priority: { name: 'High' },
      customfield_10016: 5,
      parent: parent ? { key: parent, fields: { summary: `Épic ${parent}` } } : undefined,
      labels,
      updated: '2026-11-10T10:00:00.000+0000',
    },
  }
}

/** Answer the identity check apart, so each test only sees the search calls. */
function reading(handler) {
  return async (url, init) =>
    String(url).includes('/myself') ? response({ accountId: 'me' }) : handler(String(url), init)
}

beforeEach(() => {
  process.env.JIRA_API_TOKEN = 'test-token'
  process.env.JIRA_EMAIL = 'me@example.test'
  forgetToken()
})

test('the JQL is scoped to the current assignee', async () => {
  const calls = []
  const fetchImpl = reading(async (url) => {
    calls.push(url)
    return response({ issues: [] })
  })

  await list(PROJECT, { fetchImpl })

  const jql = decodeURIComponent(calls[0]).replaceAll('+', ' ')
  assert.match(jql, /project = "SO"/)
  assert.match(jql, /assignee = currentUser\(\)/)
})

test('reads go through the Atlassian gateway, never the site', async () => {
  const calls = []
  const fetchImpl = reading(async (url) => {
    calls.push(url)
    return response({ issues: [] })
  })

  await list(PROJECT, { fetchImpl })

  assert.equal(calls.length, 1)
  assert.ok(calls.every((url) => url.startsWith('https://api.atlassian.com/ex/jira/cloud-1/')))
})

test('the cloudId is discovered from the site when the project does not declare one', async () => {
  const calls = []
  const { cloud_id: _ignored, ...jira } = PROJECT.jira
  const project = { ...PROJECT, jira }
  const fetchImpl = reading(async (url) => {
    calls.push(url)
    if (url.includes('/_edge/tenant_info')) return response({ cloudId: 'cloud-9' })
    return response({ issues: [] })
  })

  await list(project, { fetchImpl })

  assert.match(calls[0], /^https:\/\/example\.atlassian\.net\/_edge\/tenant_info$/)
  assert.match(calls[1], /^https:\/\/api\.atlassian\.com\/ex\/jira\/cloud-9\/rest\/api\/3\/search\/jql/)
})

test('Jira issues are normalized through the project map', async () => {
  const fetchImpl = reading(async () => response({ issues: [issue('SO-1207', { parent: 'SO-1000', labels: ['marketplace', 'services-residents'] })] }))

  const missions = await list(PROJECT, { fetchImpl })

  assert.deepEqual(missions[0], {
    project: 'marketplace',
    projectName: 'Marketplace',
    key: 'SO-1207',
    number: null,
    title: 'Mission SO-1207',
    state: 'in-progress',
    stateConflict: [],
    blocked: false,
    type: 'story',
    priority: 'high',
    points: 5,
    epic: 'SO-1000 · Épic SO-1000',
    url: 'https://example.atlassian.net/browse/SO-1207',
    updatedAt: '2026-11-10T10:00:00.000+0000',
  })
})

test('a Task issue is read as a story', async () => {
  const project = {
    ...PROJECT,
    map: { ...PROJECT.map, types: { bug: 'Bug', story: ['Story', 'Task'] } },
  }
  const fetchImpl = reading(async () => response({ issues: [issue('SO-1208', { type: 'Task' })] }))

  const missions = await list(project, { fetchImpl })

  assert.equal(missions[0].type, 'story')
})

test('an epic is not a mission', async () => {
  const fetchImpl = reading(async () =>
    response({
      issues: [
        issue('SO-483', { type: 'Epic', hierarchyLevel: 1 }),
        issue('SO-1208'),
        issue('SO-1209', { type: 'Epic', hierarchyLevel: 2 }),
      ],
    }),
  )

  const missions = await list(PROJECT, { fetchImpl })

  assert.deepEqual(missions.map((m) => m.key), ['SO-1208'])
})

test('a ticket without hierarchyLevel stays a mission', async () => {
  const fetchImpl = reading(async () =>
    response({
      issues: [
        {
          key: 'SO-1',
          fields: {
            summary: 'Mission sans niveau',
            status: { name: 'In Progress' },
            issuetype: { name: 'Story' },
          },
        },
      ],
    }),
  )

  const missions = await list(PROJECT, { fetchImpl })

  assert.deepEqual(missions.map((m) => m.key), ['SO-1'])
  assert.equal(missions[0].type, 'story')
})

test('epics stay in the JQL: they are read, then dropped', async () => {
  const calls = []
  const fetchImpl = reading(async (url) => {
    calls.push(String(url))
    return response({ issues: [] })
  })

  await list(PROJECT, { fetchImpl })

  assert.doesNotMatch(new URL(calls[0]).searchParams.get('jql'), /issuetype/)
})

test('a status outside the mapping leaves the state null', async () => {
  const fetchImpl = reading(async () => response({ issues: [issue('SO-1', { status: 'Waiting for client' })] }))

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(missions[0].state, null)
})

test('pagination follows nextPageToken', async () => {
  let searches = 0
  const calls = []
  const fetchImpl = reading(async (url) => {
    calls.push(url)
    searches += 1
    if (searches === 1) return response({ issues: [issue('SO-1')], nextPageToken: 'page-2' })
    return response({ issues: [issue('SO-2')] })
  })

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(searches, 2)
  assert.match(calls[1], /nextPageToken=page-2/)
  assert.deepEqual(missions.map((m) => m.key), ['SO-1', 'SO-2'])
})

test('a 404 on /search/jql falls back to the legacy endpoint', async () => {
  let searches = 0
  const calls = []
  const fetchImpl = reading(async (url) => {
    calls.push(url)
    searches += 1
    if (searches === 1) return response({ errorMessages: ['gone'] }, { status: 404 })
    return response({ issues: [issue('SO-3')], total: 1 })
  })

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(searches, 2)
  assert.match(calls[1], /\/rest\/api\/3\/search\?/)
  assert.equal(missions[0].key, 'SO-3')
})

test('an invalid token raises before any search, naming the token', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return response({ message: 'Unauthorized' }, { status: 401 })
  }

  await assert.rejects(() => list(PROJECT, { fetchImpl }), /Jira token missing or invalid/)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/myself$/)
})

test('a project without site or reference is rejected', async () => {
  await assert.rejects(
    () => list({ ...PROJECT, jira: {} }, { fetchImpl: async () => response({}) }),
    /jira\.site/,
  )
  const { reference: _ignored, ...withoutReference } = PROJECT
  await assert.rejects(
    () => list({ ...withoutReference, jira: { site: 'https://x' } }, { fetchImpl: async () => response({}) }),
    /reference is required/,
  )
})

test('a 403 keeps its own message: permissions are not a dead token', async () => {
  const fetchImpl = async () => response({ message: 'Forbidden' }, { status: 403 })

  await assert.rejects(() => list(PROJECT, { fetchImpl }), /Jira access denied/)
})

test('blocking updates the labels and posts the reason as ADF', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null, auth: init.headers?.authorization })
    return String(url).endsWith('/comment')
      ? response({ id: '10001', self: 'https://example.atlassian.net/rest/api/3/issue/SO-1/comment/10001' })
      : response(undefined, { status: 204 })
  }

  const result = await setBlocked(PROJECT, 'SO-1', {
    blocked: true,
    message: 'Attente du contrat.\nDépend de l’API.',
    fetchImpl,
  })

  assert.equal(result.key, 'SO-1')
  assert.equal(result.blocked, true)
  assert.match(result.comment, /comment\/10001$/)
  assert.equal(calls.length, 2)
  // `update.labels` ajoute ou retire un label sans renvoyer les autres.
  assert.equal(calls[0].method, 'PUT')
  assert.match(calls[0].url, /\/rest\/api\/3\/issue\/SO-1$/)
  assert.deepEqual(JSON.parse(calls[0].body), { update: { labels: [{ add: 'blocked' }] } })
  // Un commentaire v3 est de l'ADF : un paragraphe par ligne, jamais une chaîne.
  assert.equal(calls[1].method, 'POST')
  assert.match(calls[1].url, /\/issue\/SO-1\/comment$/)
  const body = JSON.parse(calls[1].body)
  assert.equal(body.body.type, 'doc')
  assert.equal(body.body.content.length, 2)
  assert.deepEqual(body.body.content[0], { type: 'paragraph', content: [{ type: 'text', text: 'Attente du contrat.' }] })
  assert.match(calls[1].auth, /^Basic /)
})

test('unblocking removes the label without a comment', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${String(url)}`)
    return response(undefined, { status: 204 })
  }

  const result = await setBlocked(PROJECT, 'SO-1', { blocked: false, fetchImpl })

  assert.deepEqual(result, { key: 'SO-1', blocked: false, comment: null })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^PUT /)
})

test('le libellé bloqué revient en drapeau, sans toucher à l’état', async () => {
  const fetchImpl = reading(async () => response({ issues: [issue('SO-1', { labels: ['blocked'] })] }))

  const [mission] = await list(PROJECT, { fetchImpl })

  assert.equal(mission.blocked, true)
  assert.equal(mission.state, 'in-progress')
})
