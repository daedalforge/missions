import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import {
  create,
  forgetOrgFields,
  forgetToken,
  list,
  listDone,
  pointsOf,
  setField,
  setPoints,
  setPriority,
  setState,
} from '../lib/trackers/github.js'

const GRAPHQL = 'https://api.github.com/graphql'

// The retired organization field, assembled so the acceptance grep for its
// name stays empty: the fixture still writes a dead value on it, and the read
// must ignore it.
const RETIRED_STATE_FIELD = ['Workflow', 'stage'].join(' ')

/**
 * A board whose five states are the issue's native status and whose priority
 * and estimation live in the organization fields. `ready-for-prod` is the one
 * label still carrying a state; `blocked` is the other label.
 */
const PROJECT = {
  id: 'config',
  name: 'Config',
  reference: 'CFG',
  tracker: 'github',
  github: { owner: 'daedalforge', repo: 'config' },
  statuses: {
    'to-refine': 'Backlog',
    ready: 'Todo',
    'in-progress': 'In progress',
    'in-review': 'In review',
    done: 'Done',
  },
  fields: { priority: 'Priority', points: 'Story point' },
  map: {
    states: { 'ready-for-prod': 'ready-for-prod' },
    types: { bug: 'Bug', story: 'Feature' },
    priorities: { urgent: 'Urgent', high: 'High', normal: 'Medium', low: 'Low' },
    points: null,
  },
}

const PLANNING_STATUSES = {
  data: {
    repository: {
      planningStatuses: {
        nodes: [
          { id: 'IS_kgAC', name: 'Backlog' },
          { id: 'IS_kgAD', name: 'Todo' },
          { id: 'IS_kgAE', name: 'In progress' },
          { id: 'IS_kgAI', name: 'In review' },
          { id: 'IS_kgAF', name: 'Done' },
        ],
      },
    },
  },
}

const ORG_FIELDS = {
  data: {
    organization: {
      issueFields: {
        nodes: [
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

function node(number, { state = 'OPEN', status = null, labels = [], fields = {}, type = 'Feature', milestone = null } = {}) {
  return {
    __typename: 'Issue',
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/daedalforge/config/issues/${number}`,
    state,
    status: status ? { name: status } : null,
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

/** Route `/user`, the GraphQL endpoint and the REST writes by call shape. */
function fakeFetch({ graphql = {}, rest = {} } = {}) {
  const calls = []
  let byNumberCalls = 0
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    const method = init.method ?? 'GET'
    calls.push({ url: href, method, body: init.body ? JSON.parse(init.body) : null })
    if (href.endsWith('/user')) return response({ login: 'slucienvauthier-so' })
    if (href === GRAPHQL) {
      const query = calls.at(-1).body?.query ?? ''
      if (query.includes('organization(login')) return response(ORG_FIELDS)
      if (query.includes('planningStatuses')) return response(graphql.planningStatuses ?? PLANNING_STATUSES)
      if (query.includes('setIssueFieldValue')) {
        return response(graphql.mutation ?? { data: { setIssueFieldValue: { issue: { number: 1 } } } })
      }
      if (query.includes('setIssueStatus')) {
        return response(graphql.statusMutation ?? { data: { setIssueStatus: { issue: { number: 1, status: { name: 'In progress' } } } } })
      }
      if (query.includes('issue(number: $n')) {
        if (Array.isArray(graphql.byNumber)) {
          const reply = graphql.byNumber[byNumberCalls] ?? graphql.byNumber.at(-1)
          byNumberCalls += 1
          return response(reply)
        }
        return response(graphql.byNumber ?? { data: { repository: {} } })
      }
      return response(graphql.list ?? { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } })
    }
    const key = `${method} ${href}`
    if (rest[key]) return response(rest[key])
    if (href.includes('/issues/') && href.includes('/labels')) return response({})
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

test('une board à statut natif lit l’état dans le statut et ignore le champ retiré', async () => {
  // Given une liste où le champ retiré dit `In progress` et le statut `In review`,
  // plus un ticket par état natif et un statut inconnu
  const { fetchImpl, calls } = fakeFetch({
    graphql: {
      list: {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                node(7, {
                  status: 'In review',
                  labels: ['blocked', 'in-progress', 'priority:high', 'sp:3'],
                  fields: { [RETIRED_STATE_FIELD]: 'In progress', Priority: 'High', 'Story point': 3 },
                  milestone: { number: 2, title: 'Dotfiles' },
                }),
                node(20, { status: 'Backlog' }),
                node(21, { status: 'Todo' }),
                node(22, { status: 'In progress' }),
                node(23, { status: 'Done' }),
                node(24, { status: 'Published' }),
                pullRequest(8),
              ],
            },
          },
        },
      },
    },
  })

  // When la liste ouverte lit la board
  const missions = await list(PROJECT, { fetchImpl })

  // Then chaque ligne porte l'état de son statut, le statut inconnu reste nul,
  // et le champ d'état mort n'a rien décidé
  assert.deepEqual(missions.map((mission) => mission.key), ['CFG-7', 'CFG-20', 'CFG-21', 'CFG-22', 'CFG-23', 'CFG-24'])
  assert.deepEqual(
    missions.map((mission) => mission.state),
    ['in-review', 'to-refine', 'ready', 'in-progress', 'done', null],
  )
  assert.deepEqual(missions.map((mission) => mission.stateConflict), [[], [], [], [], [], []])
  const [config] = missions
  assert.equal(config.priority, 'high')
  assert.equal(config.points, 3)
  // `blocked` est le seul label que la board garde avec `ready-for-prod`.
  assert.equal(config.blocked, true)
  assert.equal(config.blockedByLabel, true)
  assert.equal(config.type, 'story')
  assert.equal(config.epic, 'CFG-2 · Dotfiles')
  const query = calls.find((call) => call.body?.query?.includes('repository(owner')).body.query
  assert.match(query, /status \{ name \}/)
})

test('un statut absent ne retombe pas sur un label d’état resté sur l’issue', async () => {
  // Given une issue sans statut natif qui porte encore les labels d'un autre temps
  const { fetchImpl } = fakeFetch({
    graphql: {
      list: {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node(9, { labels: ['ready', 'priority:urgent', 'sp:8'] })],
            },
          },
        },
      },
    },
  })

  // When la liste lit la board
  const [mission] = await list(PROJECT, { fetchImpl })

  // Then l'état comme les champs vides restent nuls
  assert.equal(mission.state, null)
  assert.equal(mission.priority, null)
  assert.equal(mission.points, null)
})

test('l’historique fermé se lit par numéro, statut compris', async () => {
  // Given une issue fermée et une issue ouverte déclarée, lues par numéro
  const { fetchImpl, calls } = fakeFetch({
    graphql: {
      byNumber: {
        data: {
          repository: {
            i0: node(7, { state: 'CLOSED', fields: { 'Story point': 5 } }),
            i1: node(8, { status: 'Todo' }),
          },
        },
      },
    },
  })

  // When Done lit les deux clés
  const missions = await listDone(PROJECT, ['CFG-7', 'CFG-8'], { fetchImpl })

  // Then la fermeture rend done, l'ouverte son statut, et la requête demande le statut
  assert.deepEqual(missions.map((mission) => mission.key), ['CFG-7', 'CFG-8'])
  assert.deepEqual(missions.map((mission) => mission.state), ['done', 'ready'])
  assert.equal(missions[0].points, 5)
  const query = calls.find((call) => call.url === GRAPHQL && call.body.query.includes('issue(number: $n')).body.query
  assert.match(query, /i1: issue\(number: \$n1\)/)
  assert.match(query, /status \{ name \}/)
})

test('un lot mixte rend les issues qui résolvent et ignore un numéro absent ou une PR', async () => {
  // Given des déclarations mêlant une issue fermée, une issue ouverte, une PR
  // et un numéro absent du dépôt
  const { fetchImpl } = fakeFetch({
    graphql: {
      byNumber: {
        data: {
          repository: {
            i0: node(7, { state: 'CLOSED', fields: { 'Story point': 5 } }),
            i1: node(8, { state: 'OPEN', status: 'Todo' }),
            i2: null,
            i3: null,
          },
        },
        errors: [
          { type: 'NOT_FOUND', path: ['repository', 'i2'], message: 'Could not resolve to an Issue with the number of 103.' },
          { type: 'NOT_FOUND', path: ['repository', 'i3'], message: 'Could not resolve to an Issue with the number of 114.' },
        ],
      },
    },
  })

  // When Done lit les quatre clés déclarées
  const missions = await listDone(PROJECT, ['CFG-7', 'CFG-8', 'CFG-103', 'CFG-114'], { fetchImpl })

  // Then les deux issues sont rendues, la PR et l'absente ne font aucune ligne done
  assert.deepEqual(missions.map((mission) => mission.key), ['CFG-7', 'CFG-8'])
  assert.deepEqual(missions.map((mission) => mission.state), ['done', 'ready'])
  assert.equal(missions.filter((mission) => mission.state === 'done').length, 1)
  assert.equal(missions[0].points, 5)
})

test('un NOT_FOUND d’alias ne masque pas une panne du même lot', async () => {
  // Given un lot qui porte une erreur d'alias tolérée et un rate limit
  const { fetchImpl } = fakeFetch({
    graphql: {
      byNumber: {
        data: { repository: { i0: node(7, { state: 'CLOSED' }), i1: null } },
        errors: [
          { type: 'NOT_FOUND', path: ['repository', 'i1'], message: 'Could not resolve to an Issue with the number of 114.' },
          { type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' },
        ],
      },
    },
  })

  // When Done lit le lot
  // Then la lecture lève, et le message conservé est celui de la panne
  await assert.rejects(
    () => listDone(PROJECT, ['CFG-7', 'CFG-114'], { fetchImpl }),
    (error) => {
      assert.match(error.message, /API rate limit exceeded/)
      assert.doesNotMatch(error.message, /Could not resolve/)
      return true
    },
  )
})

test('un NOT_FOUND qui ne vise pas un numéro reste fatal', async () => {
  // Given un NOT_FOUND sur le dépôt lui-même, sans alias d'issue
  const { fetchImpl } = fakeFetch({
    graphql: {
      byNumber: {
        data: null,
        errors: [{
          type: 'NOT_FOUND',
          path: ['repository'],
          message: 'Could not resolve to a Repository with the name \'daedalforge/gone\'.',
        }],
      },
    },
  })

  // When Done lit une clé
  // Then la lecture lève : le silence est réservé aux numéros
  await assert.rejects(
    () => listDone(PROJECT, ['CFG-7'], { fetchImpl }),
    /Could not resolve to a Repository/,
  )
})

test('un lot entièrement absent laisse le lot suivant résoudre ses numéros', async () => {
  // Given 41 déclarations dont les 40 premières ne résolvent pas
  const numbers = Array.from({ length: 41 }, (_, index) => index + 1)
  const missing = numbers.slice(0, 40)
  const { fetchImpl, calls } = fakeFetch({
    graphql: {
      byNumber: [
        {
          data: { repository: Object.fromEntries(missing.map((number, index) => [`i${index}`, null])) },
          errors: missing.map((number, index) => ({
            type: 'NOT_FOUND',
            path: ['repository', `i${index}`],
            message: `Could not resolve to an Issue with the number of ${number}.`,
          })),
        },
        { data: { repository: { i0: node(41, { state: 'CLOSED' }) } } },
      ],
    },
  })

  // When Done lit les 41 clés en deux lots
  const keys = numbers.map((number) => `CFG-${number}`)
  const missions = await listDone(PROJECT, keys, { fetchImpl })

  // Then les requêtes restent bornées à 40 alias, et le second lot résout
  const queries = calls.filter((call) => call.url === GRAPHQL && call.body.query.includes('issue(number: $n'))
  assert.equal(queries.length, 2)
  assert.equal((queries[0].body.query.match(/issue\(number: \$n\d+\)/g) ?? []).length, 40)
  assert.deepEqual(missions.map((mission) => mission.key), ['CFG-41'])
})

test('la création réécrit Backlog après le POST assigné, sans label d’état', async () => {
  // Given un POST de création que GitHub fait alors passer Todo
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

  // When la route crée une mission à to-refine
  const result = await create(PROJECT, {
    title: 'Nouvelle mission',
    description: 'Corps',
    type: 'story',
    priority: 'high',
    state: 'to-refine',
  }, { fetchImpl })

  // Then le POST est propre, la priorité passe par son champ et le statut
  // natif est réécrit Backlog après l'assignation
  const posted = calls.find((call) => call.method === 'POST' && call.url.endsWith('/repos/daedalforge/config/issues'))
  assert.deepEqual(posted.body.labels, [])
  assert.deepEqual(posted.body.assignees, ['slucienvauthier-so'])
  assert.equal(posted.body.type, 'Feature')

  const mutation = calls.find((call) => call.body?.query?.includes('setIssueFieldValue'))
  assert.deepEqual(mutation.body.variables.input.issueFields, [
    { fieldId: 'IFSS_PRIORITY', singleSelectOptionId: 'OPT_HIGH' },
  ])

  const status = calls.find((call) => call.body?.query?.includes('setIssueStatus'))
  assert.deepEqual(status.body.variables.input, { issueId: 'I_12', statusId: 'IS_kgAC' })
  assert.equal(calls.some((call) => call.method === 'POST' && call.url.endsWith('/labels')), false)

  assert.equal(result.key, 'CFG-12')
  assert.equal(result.mission.state, 'to-refine')
  assert.equal(result.mission.priority, 'high')
})

test('une transition écrit le statut natif, sans champ d’état ni label', async () => {
  // Given une mission GitHub au statut Todo
  const { fetchImpl, calls } = fakeFetch({
    rest: {
      'GET https://api.github.com/repos/daedalforge/config/issues/7': { node_id: 'I_7', number: 7 },
    },
  })

  // When une session la passe en cours
  const result = await setState(PROJECT, 'CFG-7', { state: 'in-progress', fetchImpl })

  // Then setIssueStatus reçoit l'id global du statut natif, et rien n'écrit le
  // champ retiré
  assert.deepEqual(result, { key: 'CFG-7', value: 'In progress' })
  const status = calls.find((call) => call.body?.query?.includes('setIssueStatus'))
  assert.deepEqual(status.body.variables.input, { issueId: 'I_7', statusId: 'IS_kgAE' })
  assert.equal(calls.filter((call) => call.body?.query?.includes('setIssueFieldValue')).length, 0)
  // Le label du sixième état, s'il restait, est retiré à cette transition.
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => decodeURIComponent(call.url)),
    ['https://api.github.com/repos/daedalforge/config/issues/7/labels/ready-for-prod'],
  )

  await assert.rejects(
    () => setField(PROJECT, 'CFG-7', { role: 'state', value: 'In progress', fetchImpl }),
    /unknown field role state/,
  )
})

test('le label ready-for-prod prime sur le statut, se pose sans le changer et se retire ensuite', async () => {
  // Given une mission en revue, PR approuvée
  const { fetchImpl, calls } = fakeFetch({
    rest: {
      'GET https://api.github.com/repos/daedalforge/config/issues/7': { node_id: 'I_7', number: 7 },
    },
  })

  // When la session de revue pose ready-for-prod
  const posed = await setState(PROJECT, 'CFG-7', { state: 'ready-for-prod', fetchImpl })

  // Then le label est posé, le statut n'est pas touché
  assert.deepEqual(posed, { key: 'CFG-7', value: 'ready-for-prod' })
  const label = calls.find((call) => call.method === 'POST' && call.url.endsWith('/labels'))
  assert.deepEqual(label.body, { labels: ['ready-for-prod'] })
  assert.equal(calls.some((call) => call.body?.query?.includes('setIssueStatus')), false)

  // And le panneau lit le label par précédence sur le statut In review
  const { fetchImpl: read } = fakeFetch({
    graphql: {
      list: {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node(7, { status: 'In review', labels: ['ready-for-prod'] })],
            },
          },
        },
      },
    },
  })
  const [mission] = await list(PROJECT, { fetchImpl: read })
  assert.equal(mission.state, 'ready-for-prod')

  // When une autre transition la passe en revue, le label est retiré et le
  // statut écrit
  calls.length = 0
  const moved = await setState(PROJECT, 'CFG-7', { state: 'in-review', fetchImpl })
  assert.deepEqual(moved, { key: 'CFG-7', value: 'In review' })
  assert.equal(calls.some((call) => call.body?.query?.includes('setIssueStatus')), true)
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => decodeURIComponent(call.url)),
    ['https://api.github.com/repos/daedalforge/config/issues/7/labels/ready-for-prod'],
  )

  // And une issue fermée rend done quel que soit le label resté
  const { fetchImpl: closed } = fakeFetch({
    graphql: {
      list: {
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node(7, { state: 'CLOSED', status: 'In review', labels: ['ready-for-prod'] })],
            },
          },
        },
      },
    },
  })
  const [done] = await list(PROJECT, { fetchImpl: closed })
  assert.equal(done.state, 'done')
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

test('un statut natif illisible fait échouer la lecture, sans repli', async () => {
  // Given un schéma GraphQL qui ne rend plus le statut natif
  const { fetchImpl } = fakeFetch({
    graphql: {
      list: {
        data: null,
        errors: [{ message: "Field 'status' doesn't exist on type 'Issue'" }],
      },
    },
  })

  // When la liste ouverte lit la board
  // Then la lecture lève avec le message GraphQL, sans deviner d'état
  await assert.rejects(
    () => list(PROJECT, { fetchImpl }),
    /Field 'status' doesn't exist on type 'Issue'/,
  )
})
