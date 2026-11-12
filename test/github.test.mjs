import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { lastLink } from '../lib/http.js'
import { forgetToken, latestComment, list, setBlocked, setPriority } from '../lib/trackers/github.js'

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
    blocked: false,
    type: 'story',
    priority: 'high',
    points: 3,
    repo: null,
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

test('blocking adds the label, then the reason as a comment', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    return response({ html_url: 'https://github.com/daedalforge/missions/issues/110#issuecomment-1' })
  }

  const result = await setBlocked(PROJECT, 'MIS-110', {
    blocked: true,
    message: 'En attente du ticket de données.',
    fetchImpl,
  })

  assert.deepEqual(result, {
    key: 'MIS-110',
    blocked: true,
    comment: 'https://github.com/daedalforge/missions/issues/110#issuecomment-1',
  })
  // Two writes, in this order: the label, then the reason.
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels',
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/comments',
  ])
  assert.deepEqual(JSON.parse(calls[0].body), { labels: ['blocked'] })
  assert.deepEqual(JSON.parse(calls[1].body), { body: 'En attente du ticket de données.' })
})

test('unblocking removes the label and writes nothing else', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${String(url)}`)
    return response({})
  }

  const result = await setBlocked(PROJECT, 'MIS-110', { blocked: false, fetchImpl })

  assert.deepEqual(result, { key: 'MIS-110', blocked: false, comment: null })
  assert.deepEqual(calls, ['DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/blocked'])
})

test('unblocking a label that is already absent is a success, not a failure', async () => {
  const fetchImpl = async () => response({ message: 'Label does not exist' }, { status: 404 })

  const result = await setBlocked(PROJECT, 'MIS-110', { blocked: false, fetchImpl })

  assert.deepEqual(result, { key: 'MIS-110', blocked: false, comment: null })
})

test('unblocking keeps a real refusal: only a 404 means "already gone"', async () => {
  const fetchImpl = async () => response({ message: 'Bad credentials' }, { status: 401 })

  await assert.rejects(() => setBlocked(PROJECT, 'MIS-110', { blocked: false, fetchImpl }), /GitHub token missing or invalid/)
})

test('a blocked write needs a project with owner and repo', async () => {
  await assert.rejects(
    () => setBlocked({ ...PROJECT, github: {} }, 'MIS-110', { blocked: true, message: 'x', fetchImpl: async () => response({}) }),
    /owner and repo/,
  )
})

test('a blocked write needs an issue key, not a folder name', async () => {
  await assert.rejects(
    () => setBlocked(PROJECT, 'MIS-blocked', { blocked: true, message: 'x', fetchImpl: async () => response({}) }),
    /not an issue key/,
  )
})

test('the blocked label comes back as a flag, without touching the state', async () => {
  // The regression the real mission found: the adapter normalized without its
  // raw labels, so `blocked` was written on GitHub but never read back.
  const fetchImpl = route(async () => response([issue(110, { labels: ['ready', 'blocked'] })]))

  const [mission] = await list(PROJECT, { fetchImpl })

  assert.equal(mission.blocked, true)
  assert.equal(mission.state, 'ready')
})

test('changing the priority removes the other labels, then adds the target', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    return response({})
  }

  const result = await setPriority(PROJECT, 'MIS-110', { value: 'priority:high', fetchImpl })

  assert.deepEqual(result, { key: 'MIS-110', value: 'priority:high' })
  // The three other labels go first, in declaration order; the target is last.
  assert.deepEqual(calls.map((call) => `${call.method} ${decodeURIComponent(call.url)}`), [
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/priority:urgent',
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/priority:normal',
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/priority:low',
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels',
  ])
  assert.deepEqual(JSON.parse(calls[3].body), { labels: ['priority:high'] })
})

test('removing a priority label that is already absent is a success, not a failure', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${String(url)}`)
    return init.method === 'DELETE'
      ? response({ message: 'Label does not exist' }, { status: 404 })
      : response({})
  }

  const result = await setPriority(PROJECT, 'MIS-110', { value: 'priority:low', fetchImpl })

  assert.deepEqual(result, { key: 'MIS-110', value: 'priority:low' })
  assert.equal(calls.at(-1), 'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels')
})

test('a priority write keeps a real refusal: only a 404 means "already gone"', async () => {
  const fetchImpl = async (url, init = {}) =>
    init.method === 'DELETE' ? response({ message: 'Bad credentials' }, { status: 401 }) : response({})

  await assert.rejects(
    () => setPriority(PROJECT, 'MIS-110', { value: 'priority:high', fetchImpl }),
    /GitHub token missing or invalid/,
  )
})

test('a priority write needs an issue key and a value', async () => {
  await assert.rejects(
    () => setPriority(PROJECT, 'MIS-priority', { value: 'priority:high', fetchImpl: async () => response({}) }),
    /not an issue key/,
  )
  await assert.rejects(
    () => setPriority(PROJECT, 'MIS-110', { value: '  ', fetchImpl: async () => response({}) }),
    /priority value is missing/,
  )
})

const COMMENTS = 'https://api.github.com/repos/daedalforge/missions/issues/144/comments?per_page=100'

test('the latest comment is the newest one of the issue, trimmed', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return response([
      { user: { login: 'someone' }, body: 'Ancienne raison', created_at: '2026-11-01T09:00:00Z', html_url: 'https://github.com/daedalforge/missions/issues/144#issuecomment-1' },
      {
        user: { login: 'slucienvauthier-so' },
        body: '  Attente du ticket de données.\n',
        created_at: '2026-11-11T09:00:00Z',
        html_url: 'https://github.com/daedalforge/missions/issues/144#issuecomment-2',
      },
    ])
  }

  const comment = await latestComment(PROJECT, 'MIS-144', { fetchImpl })

  assert.deepEqual(comment, {
    author: 'slucienvauthier-so',
    body: 'Attente du ticket de données.',
    createdAt: '2026-11-11T09:00:00Z',
    url: 'https://github.com/daedalforge/missions/issues/144#issuecomment-2',
  })
  assert.deepEqual(calls, [COMMENTS])
})

test('an issue whose comments span several pages reads the last page only', async () => {
  const calls = []
  const last = 'https://api.github.com/repos/daedalforge/missions/issues/144/comments?page=4'
  const link = [
    '<https://api.github.com/repos/daedalforge/missions/issues/144/comments?page=2>; rel="next"',
    `<${last}>; rel="last"`,
  ].join(', ')
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url) === last) {
      return response([{ user: { login: 'slucienvauthier-so' }, body: 'Raison la plus récente', created_at: '2026-11-12T10:00:00Z', html_url: 'https://github.com/daedalforge/missions/issues/144#issuecomment-400' }])
    }
    return response([{ user: { login: 'someone' }, body: 'Raison ancienne', created_at: '2026-10-01T09:00:00Z' }], { link })
  }

  const comment = await latestComment(PROJECT, 'MIS-144', { fetchImpl })

  assert.deepEqual(calls, [COMMENTS, last])
  assert.equal(comment.body, 'Raison la plus récente')
  assert.equal(comment.url, 'https://github.com/daedalforge/missions/issues/144#issuecomment-400')
})

test('an issue with no comment, or an empty one, has no reason to show', async () => {
  const none = await latestComment(PROJECT, 'MIS-144', { fetchImpl: async () => response([]) })
  assert.equal(none, null)

  const blank = await latestComment(PROJECT, 'MIS-144', {
    fetchImpl: async () => response([{ user: { login: 'slucienvauthier-so' }, body: '   \n', created_at: '2026-11-11T09:00:00Z' }]),
  })
  assert.equal(blank, null)
})

test('a comment read needs an issue key', async () => {
  await assert.rejects(
    () => latestComment(PROJECT, 'MIS-blocked', { fetchImpl: async () => response([]) }),
    /not an issue key/,
  )
})

test('lastLink extracts the last page and ignores the other relations', () => {
  const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last", <https://api.github.com/x?page=1>; rel="first"'
  assert.equal(lastLink(link), 'https://api.github.com/x?page=9')
  assert.equal(lastLink('<https://api.github.com/x?page=2>; rel="next"'), null)
  assert.equal(lastLink(null), null)
})

test('a comment read keeps the tracker refusal message', async () => {
  await assert.rejects(
    () => latestComment(PROJECT, 'MIS-144', {
      fetchImpl: async () => response({ message: 'Server Error' }, { status: 500 }),
    }),
    /GitHub: HTTP 500/,
  )
})

test('a comment read needs a project with owner and repo', async () => {
  await assert.rejects(
    () => latestComment({ id: 'broken', tracker: 'github', github: {} }, 'MIS-144', {
      fetchImpl: async () => response([]),
    }),
    /owner and repo/,
  )
})
