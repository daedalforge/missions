import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { forgetToken, list } from '../lib/trackers/github.js'

const PROJECT = {
  id: 'missions',
  name: 'Workspace missions',
  reference: 'MIS',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'missions' },
  map: {
    states: {
      'to-refine': 'to-refine',
      ready: 'ready',
      'in-progress': 'in-progress',
      'in-review': 'in-review',
      'ready-for-prod': 'ready-for-prod',
      done: null,
    },
    types: { bug: 'Bug', story: 'Feature' },
    priorities: { urgent: 'priority:urgent', high: 'priority:high', normal: 'priority:normal', low: 'priority:low' },
    points: 'sp:',
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
      issue(2, { labels: ['ready', 'priority:high', 'sp:3'], milestone: { number: 1, title: 'Workspace' }, type: 'Feature' }),
      issue(9, { labels: [], type: 'Bug', pr: true }),
    ]))

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(missions.length, 1)
  assert.deepEqual(missions[0], {
    project: 'missions',
    projectName: 'Workspace missions',
    key: 'MIS-2',
    number: 2,
    title: 'Mission 2',
    state: 'ready',
    stateConflict: [],
    type: 'story',
    priority: 'high',
    points: 3,
    epic: 'MIS-1 · Workspace',
    url: 'https://github.com/daedalforge/missions/issues/2',
    updatedAt: '2026-11-10T10:00:00Z',
  })
})

test('a ready-for-prod label is read as its own state', async () => {
  const fetchImpl = route(async () =>
    response([issue(3, { labels: ['priority:normal', 'ready-for-prod', 'sp:2'] })]),
  )

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(missions[0].state, 'ready-for-prod')
  assert.equal(missions[0].priority, 'normal')
  assert.equal(missions[0].points, 2)
})

test('two state labels leave the state unknown instead of picking one', async () => {
  const fetchImpl = route(async () =>
    response([
      issue(4, { labels: ['in-review', 'ready-for-prod'] }),
      issue(5, { labels: ['ready-for-prod', 'in-review'] }),
    ]),
  )

  const missions = await list(PROJECT, { fetchImpl })

  assert.deepEqual(missions.map((m) => m.state), [null, null])
  assert.deepEqual(missions.map((m) => m.stateConflict), [
    ['in-review', 'ready-for-prod'],
    ['in-review', 'ready-for-prod'],
  ])
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

test('a project without a reference is rejected', async () => {
  const { reference: _ignored, ...withoutReference } = PROJECT
  await assert.rejects(
    () => list(withoutReference, { fetchImpl: async () => response([]) }),
    /reference is required/,
  )
})

test('two projects may share a milestone number: the reference disambiguates the epic', async () => {
  const fetchImpl = route(async () => response([issue(2, { milestone: { number: 1, title: 'Workspace' } })]))
  const other = { ...PROJECT, id: 'other', name: 'Other', reference: 'OTH' }

  const [mine] = await list(PROJECT, { fetchImpl })
  const [theirs] = await list(other, { fetchImpl })

  assert.equal(mine.epic, 'MIS-1 · Workspace')
  assert.equal(theirs.epic, 'OTH-1 · Workspace')
})
