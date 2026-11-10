import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { clearCache, listAll } from '../lib/trackers/index.js'
import { forgetToken as forgetJiraToken } from '../lib/trackers/jira.js'

const MAP = {
  states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
  types: { bug: 'Bug', story: 'Feature' },
}

const PROJECT_OK = {
  id: 'missions',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'missions' },
  map: MAP,
}

const PROJECT_BROKEN = {
  id: 'broken',
  tracker: 'github',
  github: {},
  map: MAP,
}

const PROJECT_JIRA = {
  id: 'manager',
  tracker: 'jira',
  jira: { site: 'https://example.atlassian.net', key_prefix: 'SO', email: 'me@example.test' },
  map: {
    states: { 'to-refine': 'To Do', ready: 'Ready', 'in-progress': 'In Progress', 'in-review': 'In Review', done: 'Done' },
    types: { bug: 'Bug', story: 'Story' },
  },
}

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  }
}

/** Répond au compte courant, puis délègue aux issues données. */
function routeIssues(issues) {
  return async (url) =>
    String(url).endsWith('/user') ? response({ login: 'slucienvauthier-so' }) : response(issues)
}

beforeEach(() => {
  process.env.GH_TOKEN = 'test-token'
  process.env.JIRA_API_TOKEN = 'test-jira-token'
  process.env.JIRA_EMAIL = 'me@example.test'
  clearCache()
  forgetJiraToken()
})

test('a failing project does not prevent the others from being read', async () => {
  const fetchImpl = routeIssues([{ number: 2, title: 'Mission 2', labels: [{ name: 'ready' }], type: { name: 'Feature' } }])

  const { missions, errors } = await listAll([PROJECT_BROKEN, PROJECT_OK], { fetchImpl })

  assert.equal(missions.length, 1)
  assert.equal(missions[0].key, 'daedalforge/missions#2')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].project, 'broken')
  assert.match(errors[0].message, /owner and repo/)
})

test('the read is cached unless a fresh read is asked', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return response([{ number: 2, title: 'Mission 2', labels: [{ name: 'ready' }] }])
  }

  await listAll([PROJECT_OK], { fetchImpl })
  await listAll([PROJECT_OK], { fetchImpl })
  assert.equal(calls, 1)

  await listAll([PROJECT_OK], { fetchImpl, refresh: true })
  assert.equal(calls, 2)
})

test('missions are sorted by state then key', async () => {
  const fetchImpl = routeIssues([
    { number: 5, title: 'b', labels: [{ name: 'ready' }], type: { name: 'Feature' } },
    { number: 1, title: 'a', labels: [{ name: 'in-review' }], type: { name: 'Bug' } },
    { number: 3, title: 'c', labels: [{ name: 'ready' }], type: { name: 'Feature' } },
  ])

  const { missions } = await listAll([PROJECT_OK], { fetchImpl })

  assert.deepEqual(missions.map((m) => m.number), [1, 3, 5])
})

test('GitHub and Jira share the same list', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (String(url).includes('api.github.com')) {
      return response([{ number: 2, title: 'GitHub mission', labels: [{ name: 'ready' }], type: { name: 'Feature' } }])
    }
    return response({
      issues: [
        {
          key: 'SO-1207',
          fields: { summary: 'Jira mission', status: { name: 'In Progress' }, issuetype: { name: 'Story' } },
        },
      ],
    })
  }

  const { missions, errors } = await listAll([PROJECT_OK, PROJECT_JIRA], { fetchImpl })

  assert.equal(errors.length, 0)
  assert.deepEqual(missions.map((m) => m.key).sort(), ['SO-1207', 'daedalforge/missions#2'])
  assert.deepEqual(missions.map((m) => m.project).sort(), ['manager', 'missions'])
})
