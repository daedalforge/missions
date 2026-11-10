import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { forgetToken, list } from '../lib/trackers/github.js'

const PROJECT = {
  id: 'missions',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'missions' },
  map: {
    states: { 'to-refine': 'to-refine', ready: 'ready', 'in-progress': 'in-progress', 'in-review': 'in-review', done: null },
    types: { bug: 'Bug', story: 'Feature' },
  },
}

function response(body, { status = 200, link = null, remaining = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase()
        if (key === 'link') return link
        if (key === 'x-ratelimit-remaining') return remaining
        return null
      },
    },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function issue(number, { labels = [], pr = false, milestone = null, type = 'Feature' } = {}) {
  return {
    number,
    title: `Mission ${number}`,
    labels: labels.map((name) => ({ name })),
    milestone,
    type: type ? { name: type } : null,
    html_url: `https://github.com/daedalforge/missions/issues/${number}`,
    updated_at: '2026-11-10T10:00:00Z',
    ...(pr ? { pull_request: { url: 'https://api.github.com/pulls/1' } } : {}),
  }
}

/** Route /user (compte courant) puis délègue au faux fetch d'issues. */
function route(issues) {
  return async (url) =>
    String(url).endsWith('/user')
      ? response({ login: 'slucienvauthier-so' })
      : issues(url)
}

beforeEach(() => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
})

test('issues are normalized and pull requests dropped', async () => {
  const fetchImpl = route(async () =>
    response([
      issue(2, { labels: ['ready'], milestone: { title: 'Workspace' }, type: 'Feature' }),
      issue(9, { labels: [], type: 'Bug', pr: true }),
    ]))

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(missions.length, 1)
  assert.deepEqual(missions[0], {
    project: 'missions',
    key: 'daedalforge/missions#2',
    number: 2,
    title: 'Mission 2',
    state: 'ready',
    type: 'story',
    epic: 'Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    updatedAt: '2026-11-10T10:00:00Z',
  })
})

test('pagination follows the Link header', async () => {
  const calls = []
  const fetchImpl = route(async (url) => {
    calls.push(url)
    if (calls.length === 1) {
      return response([issue(1, { labels: ['to-refine'] })], {
        link: '<https://api.github.com/repos/daedalforge/missions/issues?page=2>; rel="next"',
      })
    }
    return response([issue(2, { labels: ['in-review'], type: 'Bug' })])
  })

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(calls.length, 2)
  assert.deepEqual(missions.map((m) => m.number), [1, 2])
  assert.deepEqual(missions.map((m) => m.state), ['to-refine', 'in-review'])
})

test('the query is scoped to the current assignee', async () => {
  const calls = []
  const fetchImpl = route(async (url) => {
    calls.push(url)
    return response([])
  })

  await list(PROJECT, { fetchImpl })

  assert.match(calls[0], /assignee=slucienvauthier-so/)
})

test('a 401 names the GitHub token', async () => {
  const fetchImpl = async () => response({ message: 'Bad credentials' }, { status: 401 })

  await assert.rejects(() => list(PROJECT, { fetchImpl }), /GitHub token missing or invalid/)
})

test('an exhausted rate limit gives the retry time', async () => {
  const fetchImpl = async () => response({ message: 'API rate limit exceeded' }, { status: 403, remaining: '0' })

  await assert.rejects(() => list(PROJECT, { fetchImpl }), /GitHub rate limit exhausted/)
})

test('a project without owner or repo is rejected', async () => {
  const withoutRepo = { ...PROJECT, github: {} }
  await assert.rejects(() => list(withoutRepo, { fetchImpl: async () => response([]) }), /owner and repo/)
})
