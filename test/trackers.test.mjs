import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { clearCache, listAll, setPriority } from '../lib/trackers/index.js'
import { forgetToken as forgetJiraToken } from '../lib/trackers/jira.js'

const MAP = {
  states: {
    'to-refine': 'to-refine',
    ready: 'ready',
    'in-progress': 'in-progress',
    'in-review': 'in-review',
    'ready-for-prod': 'ready-for-prod',
    done: null,
  },
  types: { bug: 'Bug', story: 'Feature' },
}

const PROJECT_OK = {
  id: 'missions',
  reference: 'MIS',
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
  reference: 'SO',
  tracker: 'jira',
  jira: { site: 'https://example.atlassian.net', cloud_id: 'cloud-1', email: 'me@example.test' },
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
  assert.equal(missions[0].key, 'MIS-2')
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

test('une mission done sans dossier déclaré n’est pas listée', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/myself')) return response({ accountId: 'me' })
    return response({
      issues: [
        { key: 'SO-1', fields: { summary: 'Terminée', status: { name: 'Done' }, issuetype: { name: 'Story' } } },
        { key: 'SO-2', fields: { summary: 'En cours', status: { name: 'In Progress' }, issuetype: { name: 'Story' } } },
      ],
    })
  }

  const { missions } = await listAll([PROJECT_JIRA], { fetchImpl })

  assert.deepEqual(missions.map((m) => m.key), ['SO-2'])
})

test('le périmètre ouvert et le périmètre done ont chacun leur cache', async () => {
  let ouvertes = 0
  let closes = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (href.includes('state=closed')) {
      closes += 1
      return response([{ number: 9, state: 'closed', title: 'Close', labels: [] }])
    }
    ouvertes += 1
    return response([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }

  const ouvert = await listAll([PROJECT_OK], { fetchImpl })
  assert.deepEqual(ouvert.missions.map((m) => m.key), ['MIS-2'])

  // Entrer dans Done ne relit pas l'ouvert et ne le sert pas non plus.
  const done = await listAll([PROJECT_OK], { fetchImpl, declaredKeys: new Set(['MIS-9']), scope: 'done' })
  assert.deepEqual(done.missions.map((m) => m.key), ['MIS-9'])
  assert.deepEqual([ouvertes, closes], [1, 1])

  // Rejouer chaque périmètre lit son propre cache : aucun troisième appel.
  await listAll([PROJECT_OK], { fetchImpl })
  await listAll([PROJECT_OK], { fetchImpl, declaredKeys: new Set(['MIS-9']), scope: 'done' })
  assert.deepEqual([ouvertes, closes], [1, 1])
})

test('un périmètre inconnu est refusé, pas deviné', async () => {
  await assert.rejects(
    () => listAll([PROJECT_OK], { fetchImpl: routeIssues([]), scope: 'closed' }),
    /unknown scope: closed/,
  )
})

test('une mission done déclarée se lit sur le périmètre done, les autres restent closes', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    requested.push(href)
    if (href.includes('state=closed')) {
      return response([
        // Une issue fermée garde ses labels : c'est la fermeture qui la rend
        // done, et ses deux états connus ne sont plus un conflit.
        { number: 9, state: 'closed', title: 'Close déclarée', labels: [{ name: 'in-review' }, { name: 'ready-for-prod' }] },
        { number: 8, state: 'closed', title: 'Close non déclarée', labels: [] },
      ])
    }
    return response([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }

  // Le périmètre ouvert ne lit jamais done, même avec des clés déclarées.
  const ouvert = await listAll([PROJECT_OK], { fetchImpl, declaredKeys: new Set(['MIS-9']) })
  assert.deepEqual(ouvert.errors, [])
  assert.deepEqual(ouvert.missions.map((m) => m.key), ['MIS-2'])
  assert.equal(requested.filter((href) => href.includes('state=closed')).length, 0)

  // Le périmètre done rend la close déclarée, et elle seule.
  const done = await listAll([PROJECT_OK], { fetchImpl, declaredKeys: new Set(['MIS-9']), scope: 'done' })
  assert.deepEqual(done.errors, [])
  assert.deepEqual(done.missions.map((m) => m.key), ['MIS-9'])
  const closed = done.missions.find((m) => m.key === 'MIS-9')
  assert.equal(closed.state, 'done')
  assert.deepEqual(closed.stateConflict, [])
  assert.equal(requested.filter((href) => href.includes('state=closed')).length, 1)
})

test('sans dossier déclaré, les missions closes ne sont jamais lues', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    requested.push(href)
    return response([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }

  const ouvert = await listAll([PROJECT_OK], { fetchImpl })
  assert.deepEqual(ouvert.missions.map((m) => m.key), ['MIS-2'])

  const done = await listAll([PROJECT_OK], { fetchImpl, scope: 'done' })
  assert.deepEqual(done.missions, [])
  assert.deepEqual(done.errors, [])
  assert.equal(requested.filter((href) => href.includes('state=closed')).length, 0)
})

test('un échec de la lecture des done reste sur son périmètre, la liste ouverte survit', async () => {
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (href.includes('state=closed')) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' }
    }
    return response([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }

  const ouvert = await listAll([PROJECT_OK], { fetchImpl })
  assert.deepEqual(ouvert.missions.map((m) => m.key), ['MIS-2'])
  assert.deepEqual(ouvert.errors, [])

  const done = await listAll([PROJECT_OK], { fetchImpl, declaredKeys: new Set(['MIS-9']), scope: 'done' })
  assert.deepEqual(done.missions, [])
  assert.equal(done.errors.length, 1)
  assert.match(done.errors[0].message, /done missions/)

  // L'échec n'empoisonne pas le cache ouvert : on le relit intact.
  const encore = await listAll([PROJECT_OK], { fetchImpl })
  assert.deepEqual(encore.missions.map((m) => m.key), ['MIS-2'])
})

test('une mission Jira done déclarée est relue par sa clé, sur le périmètre done', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/myself')) return response({ accountId: 'me' })
    return response({
      issues: [
        { key: 'SO-1', fields: { summary: 'Terminée', status: { name: 'Done' }, issuetype: { name: 'Story' } } },
        { key: 'SO-3', fields: { summary: 'En cours', status: { name: 'In Progress' }, issuetype: { name: 'Story' } } },
      ],
    })
  }

  const ouvert = await listAll([PROJECT_JIRA], { fetchImpl })
  assert.deepEqual(ouvert.missions.map((m) => m.key), ['SO-3'])

  const done = await listAll([PROJECT_JIRA], { fetchImpl, declaredKeys: new Set(['SO-1', 'SO-77']), scope: 'done' })
  assert.deepEqual(done.errors, [])
  assert.deepEqual(done.missions.map((m) => m.key), ['SO-1'])
  assert.equal(done.missions.find((m) => m.key === 'SO-1').state, 'done')
})

test('two state labels leave the state unknown and raise a project error', async () => {
  const fetchImpl = routeIssues([
    {
      number: 7,
      title: 'Ambiguous',
      labels: [{ name: 'in-review' }, { name: 'ready-for-prod' }],
      type: { name: 'Feature' },
    },
  ])

  const { missions, errors } = await listAll([PROJECT_OK], { fetchImpl })

  assert.equal(missions[0].state, null)
  assert.deepEqual(missions[0].stateConflict, ['in-review', 'ready-for-prod'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].project, 'missions')
  assert.match(errors[0].message, /MIS-7/)
  assert.match(errors[0].message, /in-review/)
  assert.match(errors[0].message, /ready-for-prod/)
})

test('GitHub and Jira share the same list', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (String(url).endsWith('/myself')) return response({ accountId: 'me' })
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
  assert.deepEqual(missions.map((m) => m.key).sort(), ['MIS-2', 'SO-1207'])
  assert.deepEqual(missions.map((m) => m.project).sort(), ['manager', 'missions'])
})

test('a priority write drops the cached read for its project', async () => {
  const PRIORITIES = { urgent: 'priority:urgent', high: 'priority:high', normal: 'priority:normal', low: 'priority:low' }
  const project = { ...PROJECT_OK, map: { ...MAP, priorities: PRIORITIES } }
  let label = 'priority:high'
  let reads = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (href.includes('/labels')) return response({})
    reads += 1
    return response([{ number: 2, title: 'Mission 2', labels: [{ name: 'ready' }, { name: label }], type: { name: 'Feature' } }])
  }

  const first = await listAll([project], { fetchImpl })
  assert.equal(first.missions[0].priority, 'high')
  assert.equal(reads, 1)

  // The write itself does not read; the next list must, and see the new label.
  await setPriority(project, 'MIS-2', { value: 'priority:urgent', fetchImpl })
  assert.equal(reads, 1)
  label = 'priority:urgent'

  const second = await listAll([project], { fetchImpl })
  assert.equal(reads, 2)
  assert.equal(second.missions[0].priority, 'urgent')
})

test('a tracker without a priority writer refuses instead of pretending', async () => {
  await assert.rejects(
    () => setPriority({ id: 'x', tracker: 'notion', map: MAP }, 'MIS-2', { value: 'high' }),
    /unknown tracker: notion/,
  )
})
