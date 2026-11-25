import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import {
  create,
  forgetOrgFields,
  forgetToken,
  list,
  listDone,
  pointsOf,
  setPoints,
  setPriority,
} from '../lib/trackers/github.js'

const GRAPHQL = 'https://api.github.com/graphql'

/**
 * A board whose state, priority and estimation live in the organization
 * fields: the `map` names the field options, and only `blocked` stays a label.
 */
const PROJECT = {
  id: 'config',
  name: 'Config',
  reference: 'CFG',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'config' },
  fields: { state: 'Workflow stage', priority: 'Priority', points: 'Story point' },
  map: {
    states: {
      'to-refine': 'To refine',
      ready: 'Ready',
      'in-progress': 'In progress',
      'in-review': 'In review',
      'ready-for-prod': 'Ready for prod',
      done: null,
    },
    types: { bug: 'Bug', story: 'Feature' },
    priorities: { urgent: 'Urgent', high: 'High', normal: 'Medium', low: 'Low' },
    points: null,
  },
}

const ORG_FIELDS = {
  data: {
    organization: {
      issueFields: {
        nodes: [
          {
            __typename: 'IssueFieldSingleSelect',
            id: 'IFSS_STAGE',
            name: 'Workflow stage',
            dataType: 'SINGLE_SELECT',
            options: [
              { id: 'OPT_TOREFINE', name: 'To refine' },
              { id: 'OPT_INPROGRESS', name: 'In progress' },
            ],
          },
          {
            __typename: 'IssueFieldSingleSelect',
            id: 'IFSS_PRIORITY',
            name: 'Priority',
            dataType: 'SINGLE_SELECT',
            options: [
              { id: 'OPT_HIGH', name: 'High' },
              { id: 'OPT_MEDIUM', name: 'Medium' },
            ],
          },
          { __typename: 'IssueFieldNumber', id: 'IFN_POINTS', name: 'Story point', dataType: 'NUMBER' },
        ],
      },
    },
  },
}

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function fieldValue(name, value) {
  return typeof value === 'number'
    ? { __typename: 'IssueFieldNumberValue', value, field: { name } }
    : { __typename: 'IssueFieldSingleSelectValue', value, field: { name } }
}

function node(number, { state = 'OPEN', labels = [], fields = {}, type = 'Feature', milestone = null } = {}) {
  return {
    __typename: 'Issue',
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/daedalforge/config/issues/${number}`,
    state,
    updatedAt: '2026-11-11T10:00:00Z',
    labels: { nodes: labels.map((name) => ({ name })) },
    milestone,
    issueType: type ? { name: type } : null,
    issueFieldValues: { nodes: Object.entries(fields).map(([name, value]) => fieldValue(name, value)) },
  }
}

function pullRequest(number) {
  return {
    __typename: 'PullRequest',
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/daedalforge/config/pull/${number}`,
    state: 'OPEN',
    updatedAt: '2026-11-11T10:00:00Z',
    labels: { nodes: [] },
    milestone: null,
  }
}

/** Route `/user`, the GraphQL endpoint and the REST fallback by call shape. */
function fakeFetch({ graphql = {}, rest = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    calls.push({ url: href, method, body: init.body ? JSON.parse(init.body) : null })
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (href === GRAPHQL) {
      const query = calls.at(-1).body?.query ?? ''
      if (query.includes('organization(login')) return response(ORG_FIELDS)
      if (query.includes('setIssueFieldValue')) {
        return response(graphql.mutation ?? { data: { setIssueFieldValue: { issue: { number: 1 } } } })
      }
      if (query.includes('issue(number: $n')) {
        return response(graphql.byNumber ?? { data: { repository: {} } })
      }
      return response(graphql.list ?? { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } })
    }
    const key = `${method} ${href}`
    if (rest[key]) return response(rest[key])
    if (href.includes('/issues/') && method === 'GET') return response({ node_id: 'I_REST', number: 1 })
    throw new Error(`unexpected call: ${key}`)
  }
  return { fetchImpl, calls }
}

beforeEach(() => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  forgetOrgFields()
})

test('une board à champs lit la priorité, l’état et l’estimation dans les champs, pas dans les labels', async () => {
  const { fetchImpl } = fakeFetch({
    graphql: {
      list: {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                // Des labels de l'ancien monde restent : ils ne doivent plus rien décider.
                node(7, {
                  labels: ['blocked', 'in-progress', 'priority:high', 'sp:3'],
                  fields: { 'Workflow stage': 'In progress', Priority: 'High', 'Story point': 3 },
                  milestone: { number: 2, title: 'Dotfiles' },
                }),
                pullRequest(8),
              ],
            },
          },
        },
      },
    },
  })

  const missions = await list(PROJECT, { fetchImpl })

  assert.equal(missions.length, 1)
  const [mission] = missions
  assert.equal(mission.key, 'CFG-7')
  assert.equal(mission.state, 'in-progress')
  assert.deepEqual(mission.stateConflict, [])
  assert.equal(mission.priority, 'high')
  assert.equal(mission.points, 3)
  // `blocked` est le seul label que la board garde.
  assert.equal(mission.blocked, true)
  assert.equal(mission.blockedByLabel, true)
  assert.equal(mission.type, 'story')
  assert.equal(mission.epic, 'CFG-2 · Dotfiles')
})

test('un champ vide ne retombe pas sur le label resté sur l’issue', async () => {
  const { fetchImpl } = fakeFetch({
    graphql: {
      list: {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node(9, { labels: ['ready', 'priority:urgent', 'sp:8'], fields: {} })],
            },
          },
        },
      },
    },
  })

  const [mission] = await list(PROJECT, { fetchImpl })

  assert.equal(mission.state, null)
  assert.equal(mission.priority, null)
  assert.equal(mission.points, null)
})

test('l’historique fermé se lit par numéro, champs compris', async () => {
  const { fetchImpl, calls } = fakeFetch({
    graphql: {
      byNumber: {
        data: {
          repository: {
            i0: node(7, { state: 'CLOSED', fields: { 'Workflow stage': 'In progress', 'Story point': 5 } }),
            i1: node(8, { state: 'CLOSED', fields: {} }),
          },
        },
      },
    },
  })

  const missions = await listDone(PROJECT, ['CFG-7', 'CFG-8'], { fetchImpl })

  assert.deepEqual(missions.map((mission) => mission.key), ['CFG-7', 'CFG-8'])
  // Une issue fermée est `done`, quel que soit le champ resté dessus.
  assert.deepEqual(missions.map((mission) => mission.state), ['done', 'done'])
  assert.equal(missions[0].points, 5)
  const query = calls.find((call) => call.url === GRAPHQL && call.body.query.includes('issue(number: $n')).body.query
  assert.match(query, /i1: issue\(number: \$n1\)/)
})

test('la création écrit les champs et ne pose aucun label d’état ni de priorité', async () => {
  const { fetchImpl, calls } = fakeFetch({
    rest: {
      'POST https://api.github.com/repos/daedalforge/config/issues': {
        number: 12,
        title: 'Nouvelle mission',
        html_url: 'https://github.com/daedalforge/config/issues/12',
        node_id: 'I_12',
        state: 'open',
        labels: [],
        type: { name: 'Feature' },
      },
    },
  })

  const result = await create(PROJECT, {
    title: 'Nouvelle mission',
    description: 'Corps',
    type: 'story',
    priority: 'high',
    state: 'to-refine',
  }, { fetchImpl })

  const posted = calls.find((call) => call.method === 'POST' && call.url.endsWith('/repos/daedalforge/config/issues'))
  assert.deepEqual(posted.body.labels, [])
  assert.deepEqual(posted.body.assignees, ['slucienvauthier-so'])
  assert.equal(posted.body.type, 'Feature')

  const mutation = calls.find((call) => call.body?.query?.includes('setIssueFieldValue'))
  assert.deepEqual(mutation.body.variables.input.issueId, 'I_12')
  assert.deepEqual(mutation.body.variables.input.issueFields, [
    { fieldId: 'IFSS_STAGE', singleSelectOptionId: 'OPT_TOREFINE' },
    { fieldId: 'IFSS_PRIORITY', singleSelectOptionId: 'OPT_HIGH' },
  ])

  assert.equal(result.key, 'CFG-12')
  assert.equal(result.mission.state, 'to-refine')
  assert.equal(result.mission.priority, 'high')
})

test('la priorité s’écrit par la mutation du champ', async () => {
  const { fetchImpl, calls } = fakeFetch()

  const result = await setPriority(PROJECT, 'CFG-7', { value: 'High', fetchImpl })

  assert.deepEqual(result, { key: 'CFG-7', value: 'High' })
  const mutation = calls.find((call) => call.body?.query?.includes('setIssueFieldValue'))
  assert.deepEqual(mutation.body.variables.input.issueFields, [
    { fieldId: 'IFSS_PRIORITY', singleSelectOptionId: 'OPT_HIGH' },
  ])
})

test('l’estimation s’écrit comme un nombre, sans label sp:', async () => {
  const { fetchImpl, calls } = fakeFetch()

  const result = await setPoints(PROJECT, 'CFG-7', { points: 5, fetchImpl })

  assert.deepEqual(result, { key: 'CFG-7', value: 5 })
  const mutation = calls.find((call) => call.body?.query?.includes('setIssueFieldValue'))
  assert.deepEqual(mutation.body.variables.input.issueFields, [{ fieldId: 'IFN_POINTS', numberValue: 5 }])
  assert.equal(pointsOf(PROJECT), 'Story point')
})

test('un champ déclaré mais absent de l’organisation est nommé', async () => {
  const { fetchImpl } = fakeFetch()
  await assert.rejects(
    () => setPriority({ ...PROJECT, fields: { ...PROJECT.fields, priority: 'Priority v2' } }, 'CFG-7', { value: 'High', fetchImpl }),
    /has no issue field "Priority v2"/,
  )
})

test('l’état s’écrit par le même chemin, et refuse une board sans champ', async () => {
  const { setField } = await import('../lib/trackers/github.js')
  const { fetchImpl, calls } = fakeFetch()

  const result = await setField(PROJECT, 'CFG-7', { role: 'state', value: 'In progress', fetchImpl })

  assert.deepEqual(result, { key: 'CFG-7', value: 'In progress' })
  const mutation = calls.find((call) => call.body?.query?.includes('setIssueFieldValue'))
  assert.deepEqual(mutation.body.variables.input.issueFields, [
    { fieldId: 'IFSS_STAGE', singleSelectOptionId: 'OPT_INPROGRESS' },
  ])

  await assert.rejects(
    () => setField({ ...PROJECT, fields: { ...PROJECT.fields, state: undefined } }, 'CFG-7', { role: 'state', value: 'In progress', fetchImpl }),
    /fields\.state is not declared/,
  )
  await assert.rejects(
    () => setField(PROJECT, 'CFG-7', { role: 'epic', value: 'x', fetchImpl }),
    /unknown field role epic/,
  )
})
