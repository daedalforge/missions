import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { HttpError, lastLink, nextLink, requestJson } from '../http.js'
import { BLOCKED_LABEL, firstKnown, invertMap, normalizeIssue, onlyKnown } from '../mission.js'

const execFileAsync = promisify(execFile)
const API = 'https://api.github.com'
const GRAPHQL = `${API}/graphql`
const MAX_PAGES = 10

// A size is an integer or a decimal label (`sp:3`, `sp:0.5`): the family is the
// prefix plus that shape, so a hand-typed `sp:moyen` stays foreign.
const POINTS_SIZE = /^\d+(?:\.\d+)?$/

// The one canonical state GitHub has no native status for: it stays a label.
const READY_FOR_PROD = 'ready-for-prod'

export const id = 'github'

let tokenCache = null

/**
 * GitHub token, never written to disk.
 *
 * Order: `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token` (the token stays in
 * the machine's keychain).
 */
export async function token() {
  if (tokenCache) return tokenCache
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv && fromEnv.trim()) {
    tokenCache = fromEnv.trim()
    return tokenCache
  }
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10000 })
    const value = String(stdout ?? '').trim()
    if (!value) throw new Error('empty')
    tokenCache = value
    return tokenCache
  } catch {
    throw new Error('GitHub token not found: neither GH_TOKEN nor `gh auth token`')
  }
}

/** Drop the cached token (tests, or after a `gh auth login`). */
export function forgetToken() {
  tokenCache = null
  loginCache = null
  orgFieldsCache.clear()
  planningStatusesCache.clear()
}

let loginCache = null

/** Login of the account behind the token, resolved once per session. */
export async function currentLogin({ signal, fetchImpl = fetch } = {}) {
  if (loginCache) return loginCache
  const value = await token()
  const { body } = await requestJson(`${API}/user`, { token: value, signal, fetchImpl, label: 'GitHub' })
  const login = body?.login
  if (!login) throw new Error('GitHub: authenticated account unknown')
  loginCache = login
  return loginCache
}

// Organization fields, by owner login: their ids and options barely change,
// and every read and write would query them again otherwise.
const orgFieldsCache = new Map()

// Native statuses, by repository: their names and global ids barely change,
// and every state write would query them again otherwise.
const planningStatusesCache = new Map()

/** Drop the cached organization fields (tests, or after the org changed). */
export function forgetOrgFields() {
  orgFieldsCache.clear()
}

/**
 * One GraphQL call.
 *
 * The REST client is reused, so the token, the timeout and the errors are the
 * same; a 200 carrying `errors` is a failure all the same, and its message is
 * the one the panel shows. `tolerate` opts one call in to the errors its
 * reader may skip; the others stay fatal, and their messages are thrown.
 */
async function graphql({ query, variables = {} }, { token: value, signal, fetchImpl = fetch, tolerate = null } = {}) {
  const { body } = await requestJson(GRAPHQL, {
    token: value,
    signal,
    fetchImpl,
    label: 'GitHub',
    method: 'POST',
    body: { query, variables },
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  })
  const errors = Array.isArray(body?.errors) ? body.errors : []
  const fatal = errors.filter((error) => !tolerate?.(error))
  if (fatal.length > 0) {
    throw new Error(`GitHub: ${fatal.map((error) => error?.message ?? 'GraphQL error').join('; ')}`)
  }
  return body?.data ?? null
}

const ORG_FIELDS_QUERY = `
  query($login: String!) {
    organization(login: $login) {
      issueFields(first: 50) {
        nodes {
          __typename
          ... on IssueFieldSingleSelect { id name dataType options { id name } }
          ... on IssueFieldNumber { id name dataType }
        }
      }
    }
  }
`

/**
 * The organization's issue fields, by name: `{ id, dataType, options }`.
 *
 * Only the single-select and number fields are kept: they are the two shapes
 * the workflow writes. A field the token cannot read — another organization's,
 * or hidden by its visibility — simply is not in the table, and the write names
 * the missing field rather than guessing an id.
 */
async function orgFields(owner, { token: value, signal, fetchImpl = fetch } = {}) {
  const key = String(owner).toLowerCase()
  const cached = orgFieldsCache.get(key)
  if (cached) return cached
  const data = await graphql(
    { query: ORG_FIELDS_QUERY, variables: { login: owner } },
    { token: value, signal, fetchImpl },
  )
  const nodes = data?.organization?.issueFields?.nodes
  if (!Array.isArray(nodes)) {
    throw new Error(`GitHub: organization ${owner} fields are not readable`)
  }
  const fields = new Map()
  for (const node of nodes) {
    if (!node?.name || !node?.id) continue
    fields.set(node.name, {
      id: node.id,
      dataType: node.dataType,
      options: new Map((node.options ?? []).map((option) => [option.name, option.id])),
    })
  }
  orgFieldsCache.set(key, fields)
  return fields
}

/** The field a declaration names, or a named error. */
async function fieldByName(project, role, { token: value, signal, fetchImpl }) {
  const name = project.fields?.[role]
  if (!name) throw new Error(`project ${project.id}: fields.${role} is not declared`)
  const fields = await orgFields(project.github.owner, { token: value, signal, fetchImpl })
  const field = fields.get(name)
  if (!field) {
    throw new Error(`GitHub: ${project.github.owner} has no issue field "${name}" (fields.${role})`)
  }
  return field
}

/** Serialize one field write into the mutation's input. */
function fieldInput(field, role, value) {
  if (role === 'points') return { fieldId: field.id, numberValue: Number(value) }
  const optionId = field.options.get(String(value))
  if (!optionId) {
    throw new Error(`GitHub: field "${field.id}" has no option "${value}"`)
  }
  return { fieldId: field.id, singleSelectOptionId: optionId }
}

const SET_FIELDS_MUTATION = `
  mutation($input: SetIssueFieldValueInput!) {
    setIssueFieldValue(input: $input) { issue { number } }
  }
`

/** Write one or several field values on an issue, by node id. */
async function writeFields(project, issueId, entries, { token: value, signal, fetchImpl = fetch }) {
  if (entries.length === 0) return
  await graphql(
    { query: SET_FIELDS_MUTATION, variables: { input: { issueId, issueFields: entries } } },
    { token: value, signal, fetchImpl },
  )
}

/** The node id of one issue, needed by the field mutations. */
async function issueNodeId({ owner, repo, number }, { token: value, signal, fetchImpl = fetch }) {
  const { body } = await requestJson(`${API}/repos/${owner}/${repo}/issues/${number}`, {
    token: value,
    signal,
    fetchImpl,
    label: 'GitHub',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  })
  const id = body?.node_id
  if (!id) throw new Error(`GitHub: issue #${number} has no node id`)
  return id
}

const PLANNING_STATUSES_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      planningStatuses(first: 50) {
        nodes { id name }
      }
    }
  }
`

const SET_STATUS_MUTATION = `
  mutation($input: SetIssueStatusInput!) {
    setIssueStatus(input: $input) { issue { number status { name } } }
  }
`

/**
 * The repository's native statuses, by name: `Backlog` -> global node id.
 *
 * The REST `planning-statuses` ids are not the global ids the mutation expects
 * — it refuses `3` and accepts `IS_kgAD` — so the table comes from GraphQL.
 * It is cached by repository: the names and ids barely change, and every state
 * write would query them again otherwise.
 */
async function planningStatuses(project, { token: value, signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  const key = `${owner}/${repo}`.toLowerCase()
  const cached = planningStatusesCache.get(key)
  if (cached) return cached
  const data = await graphql(
    { query: PLANNING_STATUSES_QUERY, variables: { owner, repo } },
    { token: value, signal, fetchImpl },
  )
  const nodes = data?.repository?.planningStatuses?.nodes
  if (!Array.isArray(nodes)) {
    throw new Error(`GitHub: planning statuses of ${owner}/${repo} are not readable`)
  }
  const statuses = new Map(
    nodes.filter((node) => node?.id && node?.name).map((node) => [node.name, node.id]),
  )
  planningStatusesCache.set(key, statuses)
  return statuses
}

/** The global id of one native status, or a named error. */
async function statusIdByName(project, name, options) {
  const statuses = await planningStatuses(project, options)
  const id = statuses.get(String(name))
  if (!id) {
    const { owner, repo } = project.github ?? {}
    throw new Error(`GitHub: ${owner}/${repo} has no planning status "${name}"`)
  }
  return id
}

/** Write one native status on an issue, by node id. */
async function writeStatus(project, issueId, name, { token: value, signal, fetchImpl = fetch } = {}) {
  const statusId = await statusIdByName(project, name, { token: value, signal, fetchImpl })
  await graphql(
    { query: SET_STATUS_MUTATION, variables: { input: { issueId, statusId } } },
    { token: value, signal, fetchImpl },
  )
  return name
}

/** List the open missions of a GitHub project. */
export async function list(project, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!project.reference) throw new Error(`project ${project.id}: reference is required`)

  const githubToken = await token()
  const login = await currentLogin({ signal, fetchImpl })
  const issues = readsViaGraphql(project)
    ? await readFieldIssues({ owner, repo, login }, { token: githubToken, signal, fetchImpl })
    : await readIssues({ owner, repo, login }, { token: githubToken, signal, fetchImpl })
  return toMissions(project, issues)
}

/**
 * List the closed missions whose key is declared on the machine.
 *
 * Closed work is read by state, not by assignee: an issue may never have been
 * assigned, and the declared keys already select what is kept. The read stops
 * at MAX_PAGES like every list; a repository whose closed issues overflow it
 * may hide a declared one.
 */
export async function listDone(project, keys, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!project.reference) throw new Error(`project ${project.id}: reference is required`)

  const numbers = new Set(
    keys
      .map((key) => Number(String(key).split('-').pop()))
      .filter((number) => Number.isInteger(number) && number > 0),
  )
  if (numbers.size === 0) return []

  const githubToken = await token()
  if (readsViaGraphql(project)) {
    const issues = await readFieldIssuesByNumber({ owner, repo, numbers: [...numbers] }, { token: githubToken, signal, fetchImpl })
    return toMissions(project, issues.filter((issue) => numbers.has(issue.number)))
  }
  const issues = await readIssues({ owner, repo, state: 'closed' }, { token: githubToken, signal, fetchImpl })
  return toMissions(
    project,
    issues.filter((issue) => !issue.pull_request && numbers.has(issue.number)),
  )
}

/**
 * Read the newest comment of one issue.
 *
 * The reason of a block lives in a comment, and the newest one is the current
 * reason. `per_page=100` reads a normal history in one call; when the issue has
 * more pages, `Link: rel="last"` jumps straight to the end instead of walking
 * them, because only the last comment matters. No comment, or an empty body,
 * yields `null` — the caller says the reason is simply not written.
 */
export async function latestComment(project, key, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)

  const value = await token()
  const options = {
    token: value,
    signal,
    fetchImpl,
    label: 'GitHub',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  }

  const url = `${API}/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`
  const first = await requestJson(url, options)
  if (!Array.isArray(first.body)) throw new Error('GitHub: unexpected response (comments expected)')
  let comments = first.body
  const last = lastLink(first.headers?.get?.('link'))
  if (last) {
    const page = await requestJson(last, options)
    if (!Array.isArray(page.body)) throw new Error('GitHub: unexpected response (comments expected)')
    comments = page.body
  }

  const comment = comments[comments.length - 1]
  if (!comment) return null
  const text = String(comment.body ?? '').trim()
  if (!text) return null
  return {
    author: comment.user?.login ?? null,
    body: text,
    createdAt: comment.created_at ?? null,
    url: comment.html_url ?? null,
  }
}

/**
 * Create one issue as a mission.
 *
 * The state, the priority and the type are written through the project's own
 * map, so the issue is born readable by `list`: the state as the native status
 * when the board declares `statuses` (GitHub moves the assigned issue to
 * `Todo`, so the adapter rewrites `Backlog`), the priority in the organization
 * field when declared, the native type. A label board keeps its state and
 * priority labels. The issue starts assigned to the account behind the token —
 * a mission with no assignee would not appear in the panel's open list.
 */
export async function create(project, payload, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!project.reference) throw new Error(`project ${project.id}: reference is required`)

  const stateLabel =
    typeof project.map?.states?.[payload.state] === 'string' ? project.map.states[payload.state] : null
  const nativeStatus = project.statuses?.[payload.state] ?? null
  if (!stateLabel && !nativeStatus) {
    throw new Error(`project ${project.id}: no ${project.statuses ? 'native status' : 'label'} for state ${payload.state}`)
  }

  const githubToken = await token()
  const login = await currentLogin({ signal, fetchImpl })
  const priorityValue = project.map?.priorities?.[payload.priority] ?? null
  // The labels carry only what no field or native status carries: the state
  // and the priority on a label board, the priority alone when it has no field.
  const labels = stateLabel ? [stateLabel] : []
  if (!project.fields?.priority && priorityValue) labels.push(priorityValue)

  const body = { title: payload.title, body: payload.description || '', labels, assignees: [login] }
  const mappedType = project.map?.types?.[payload.type]
  const type = Array.isArray(mappedType) ? mappedType[0] : mappedType
  if (type) body.type = type
  if (payload.epic) {
    const milestone = Number(payload.epic)
    if (!Number.isInteger(milestone) || milestone <= 0) throw new Error('GitHub: the epic must be a milestone number')
    body.milestone = milestone
  }

  const { body: issue } = await requestJson(`${API}/repos/${owner}/${repo}/issues`, {
    token: githubToken,
    signal,
    fetchImpl,
    label: 'GitHub',
    method: 'POST',
    body,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  })
  if (!Number.isInteger(issue?.number)) throw new Error('GitHub: unexpected response (created issue expected)')

  if (readsViaGraphql(project)) {
    const entries = []
    const values = {}
    if (project.fields?.priority && priorityValue) {
      const field = await fieldByName(project, 'priority', { token: githubToken, signal, fetchImpl })
      entries.push(fieldInput(field, 'priority', priorityValue))
      values[project.fields.priority] = priorityValue
    }
    if (!issue.node_id) throw new Error('GitHub: created issue has no node id')
    await writeFields(project, issue.node_id, entries, { token: githubToken, signal, fetchImpl })
    issue.fieldValues = values
    if (nativeStatus) {
      await writeStatus(project, issue.node_id, nativeStatus, { token: githubToken, signal, fetchImpl })
      issue.status = { name: nativeStatus }
    }
  }

  return {
    key: `${project.reference}-${issue.number}`,
    tracker: 'github',
    reference: project.reference,
    number: issue.number,
    url: issue.html_url ?? null,
    // The 201 is the proof of the creation: its body carries the labels, type
    // and milestone GitHub stored (and the values just written), so the panel
    // can show the row before the listing catches up.
    mission: missionOf(project, { ...issue, title: issue.title ?? payload.title }, inverseOf(project)),
  }
}

/** The milestones a new mission can be attached to, as `{ id, label }` epics. */
export async function epics(project, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!project.reference) throw new Error(`project ${project.id}: reference is required`)

  const githubToken = await token()
  const collected = []
  let url = `${API}/repos/${owner}/${repo}/milestones?state=all&per_page=100`
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const { body, headers } = await requestJson(url, {
      token: githubToken,
      signal,
      fetchImpl,
      label: 'GitHub',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    })
    if (!Array.isArray(body)) throw new Error('GitHub: unexpected response (milestones expected)')
    collected.push(...body)
    url = nextLink(headers?.get?.('link'))
  }
  return collected
    .map((milestone) => ({ id: String(milestone.number), label: epicOf(project, milestone) }))
    .filter((epic) => epic.label)
}

/** Whether the board reads its issues through GraphQL: native status or fields. */
function readsViaGraphql(project) {
  return Boolean(project.statuses || project.fields)
}

/** Invert the board's state carriers: native statuses and state labels. */
function inverseOf(project) {
  const inverse = invertMap(project.map)
  for (const [state, name] of Object.entries(project.statuses ?? {})) {
    if (name) inverse.states.set(String(name), state)
  }
  return inverse
}

/** The `sp:N` label of a board that keeps its estimation as a label. */
function pointsFromLabels(project, labels) {
  const prefix = project.map?.points ?? 'sp:'
  const label = labels.find(
    (name) => name.startsWith(prefix) && POINTS_SIZE.test(name.slice(prefix.length)),
  )
  return label ? Number(label.slice(prefix.length)) : null
}

/** Normalize one issue: the panel's row, proved by a read or by a creation. */
function missionOf(project, issue, inverse) {
  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean)
  const values = issue.fieldValues ?? {}

  // The state comes from the native status when the board declares one, and
  // from the labels otherwise; the `ready-for-prod` label primes over it (only
  // GitHub has no native status for that step). The priority and the estimation
  // follow their own carrier: the organization field when declared, else the
  // label. `blocked` is a label in every case.
  let rawState
  let stateConflict = []
  if (project.statuses) {
    const readyLabel = project.map?.states?.[READY_FOR_PROD]
    const ready = typeof readyLabel === 'string' && labels.includes(readyLabel)
    rawState = ready ? readyLabel : (issue.status?.name ?? null)
  } else {
    const state = onlyKnown(labels, inverse.states)
    rawState = state.value
    stateConflict = state.conflict
  }
  const rawPriority = project.fields?.priority
    ? (values[project.fields.priority] ?? null)
    : firstKnown(labels, inverse.priorities)
  const rawPoints = project.fields?.points
    ? (values[project.fields.points] ?? null)
    : pointsFromLabels(project, labels)

  return normalizeIssue({
    project,
    key: `${project.reference}-${issue.number}`,
    number: issue.number ?? null,
    title: issue.title ?? '',
    rawState,
    stateConflict,
    // The raw labels carry `blocked`: the flag is read from them.
    rawLabels: labels,
    rawType: issue.type?.name ?? null,
    rawPriority,
    rawPoints,
    closed: issue.state === 'closed',
    epic: epicOf(project, issue.milestone),
    url: issue.html_url ?? null,
    updatedAt: issue.updated_at ?? null,
    inverse,
  })
}

/** Normalize the issues of one read; a closed issue is a done mission. */
function toMissions(project, issues) {
  const inverse = inverseOf(project)
  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => missionOf(project, issue, inverse))
}

/**
 * Set or clear the blocked label on one issue, and post the reason.
 *
 * GitHub creates an unknown label on first use, so the panel never has to
 * declare it. Blocking writes two things — the label and the comment; clearing
 * writes the label only, the tracker itself records the removal.
 */
export async function setBlocked(project, key, { blocked, message = '', signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)

  const value = await token()
  const base = `${API}/repos/${owner}/${repo}/issues/${number}`
  const options = { token: value, signal, fetchImpl, label: 'GitHub' }

  if (!blocked) {
    try {
      await requestJson(`${base}/labels/${encodeURIComponent(BLOCKED_LABEL)}`, { ...options, method: 'DELETE' })
    } catch (error) {
      // The label is already gone (removed by hand, or by a first click): the
      // wanted state is reached, so this is not a failure. Any other refusal
      // (401, 403, 5xx) still is.
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
    return { key, blocked: false, comment: null }
  }

  await requestJson(`${base}/labels`, { ...options, method: 'POST', body: { labels: [BLOCKED_LABEL] } })
  const reason = String(message ?? '').trim()
  if (!reason) return { key, blocked: true, comment: null }
  const { body } = await requestJson(`${base}/comments`, { ...options, method: 'POST', body: { body: reason } })
  return { key, blocked: true, comment: body?.html_url ?? null }
}

/**
 * Move one issue to another priority label.
 *
 * A GitHub priority is a plain label, so the move is two writes: remove the
 * project's other priority labels, then add the target. Removing a label that
 * is not there is not a failure (404 tolerated) — the wanted state is reached,
 * and any other refusal still is.
 */
export async function setPriority(project, key, { value, signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)
  const target = String(value ?? '').trim()
  if (!target) throw new Error(`project ${project.id}: priority value is missing`)

  if (project.fields?.priority) {
    return setField(project, key, { role: 'priority', value: target, signal, fetchImpl })
  }

  const githubToken = await token()

  const base = `${API}/repos/${owner}/${repo}/issues/${number}`
  const options = { token: githubToken, signal, fetchImpl, label: 'GitHub' }

  const others = [...new Set(Object.values(project.map?.priorities ?? {}))]
    .filter((label) => label && label !== target)
  for (const label of others) {
    try {
      await requestJson(`${base}/labels/${encodeURIComponent(label)}`, { ...options, method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
  }
  await requestJson(`${base}/labels`, { ...options, method: 'POST', body: { labels: [target] } })
  return { key, value: target }
}

/**
 * Write one organization field of one issue: the priority or the estimation,
 * whichever `fields` declares.
 *
 * The state is not a field any more: it is the issue's native status, written
 * by `setState`. `value` is the canonical word for the priority and the size
 * for the points; the `map` owns the field's own option names, so the caller
 * never learns them.
 */
export async function setField(project, key, { role, value, signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!['priority', 'points'].includes(role)) {
    throw new Error(`project ${project.id}: unknown field role ${role}`)
  }
  if (!project.fields?.[role]) {
    throw new Error(`project ${project.id}: fields.${role} is not declared`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)

  const target = role === 'points' ? Number(value) : String(value ?? '').trim()
  if (role === 'points' ? !Number.isFinite(target) || target <= 0 : !target) {
    throw new Error(`project ${project.id}: ${role} value is missing`)
  }

  const githubToken = await token()
  const field = await fieldByName(project, role, { token: githubToken, signal, fetchImpl })
  const issueId = await issueNodeId({ owner, repo, number }, { token: githubToken, signal, fetchImpl })
  await writeFields(project, issueId, [fieldInput(field, role, target)], {
    token: githubToken,
    signal,
    fetchImpl,
  })
  return { key, value: target }
}

/**
 * Write one native status on one issue.
 *
 * `state` is canonical: the declaration owns the native name, and the mutation
 * only receives the repository's global status id. The status table is cached
 * per repository by `planningStatuses`.
 */
export async function setIssueStatus(project, key, { state, signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)
  const name = project.statuses?.[state]
  if (!name) throw new Error(`project ${project.id}: no native status for state ${state}`)

  const githubToken = await token()
  const issueId = await issueNodeId({ owner, repo, number }, { token: githubToken, signal, fetchImpl })
  await writeStatus(project, issueId, name, { token: githubToken, signal, fetchImpl })
  return { key, value: name }
}

/**
 * Move one issue to another state: the native status, or the `ready-for-prod`
 * label for the one step GitHub has no status for.
 *
 * A label transition only adds the label; the status stays where it is, which
 * is GitHub's `In review` when the review poses it. Any other transition
 * removes the state labels the declaration still names, so one issue never
 * carries two states; a label already absent is not a failure (404 tolerated),
 * any other refusal still is.
 */
export async function setState(project, key, { state, signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!project.statuses) {
    throw new Error(`project ${project.id}: statuses is not declared`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)

  const target = String(state ?? '').trim()
  if (!target) throw new Error(`project ${project.id}: state value is missing`)
  const label = project.map?.states?.[target]
  const native = project.statuses[target]
  if (typeof label !== 'string' && !native) {
    throw new Error(`project ${project.id}: no native status for state ${target}`)
  }

  const githubToken = await token()
  const base = `${API}/repos/${owner}/${repo}/issues/${number}`
  const options = { token: githubToken, signal, fetchImpl, label: 'GitHub' }

  if (typeof label === 'string' && label) {
    await requestJson(`${base}/labels`, { ...options, method: 'POST', body: { labels: [label] } })
    return { key, value: label }
  }

  await setIssueStatus(project, key, { state: target, signal, fetchImpl })

  const stale = [...new Set(Object.values(project.map?.states ?? {}))].filter(
    (name) => typeof name === 'string' && name && name !== label,
  )
  for (const name of stale) {
    try {
      await requestJson(`${base}/labels/${encodeURIComponent(name)}`, { ...options, method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
  }
  return { key, value: native }
}

/**
 * Where a size goes on this project: the organization field's name when one
 * carries it, the label prefix otherwise, or null when it has no place.
 */
export function pointsOf(project) {
  return project.fields?.points ?? project.map?.points ?? null
}

/**
 * Set the story points of one issue: a number field when the board declares
 * one, the project's `sp:N` label otherwise.
 *
 * With a field, one mutation replaces the value — the field holds one number,
 * so nothing stale survives. Otherwise the estimation is a plain label: the
 * replace is a read, then the removal of every other size already there, then
 * the addition of the target. The read matters: a size the scale would not
 * produce (`sp:4` typed by hand) must go too, so the family is defined by the
 * prefix and a size label, not by `POINTS_SCALE`. A label that is already
 * absent is not a failure (404 tolerated) — the wanted state is reached, and
 * any other refusal still is.
 */
export async function setPoints(project, key, { points, signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  const number = Number(String(key).split('-').pop())
  if (!Number.isInteger(number) || number <= 0) throw new Error(`GitHub: ${key} is not an issue key`)
  const prefix = pointsOf(project)
  if (!prefix) throw new Error(`project ${project.id}: no points field or label prefix`)
  if (!Number.isFinite(points) || points <= 0) throw new Error('GitHub: points value is missing')

  if (project.fields?.points) {
    return setField(project, key, { role: 'points', value: points, signal, fetchImpl })
  }

  const githubToken = await token()

  const base = `${API}/repos/${owner}/${repo}/issues/${number}`
  const options = { token: githubToken, signal, fetchImpl, label: 'GitHub' }
  const target = `${prefix}${points}`

  const { body } = await requestJson(base, options)
  const labels = (Array.isArray(body?.labels) ? body.labels : [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean)
  const stale = labels.filter(
    (label) => label !== target && label.startsWith(prefix) && POINTS_SIZE.test(label.slice(prefix.length)),
  )

  for (const label of stale) {
    try {
      await requestJson(`${base}/labels/${encodeURIComponent(label)}`, { ...options, method: 'DELETE' })
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error
    }
  }
  await requestJson(`${base}/labels`, { ...options, method: 'POST', body: { labels: [target] } })
  return { key, value: target }
}

/** Epic label: the project reference makes a repo-scoped milestone global. */
function epicOf(project, milestone) {
  if (!milestone) return null
  const prefix = Number.isFinite(milestone.number) ? `${project.reference}-${milestone.number} · ` : ''
  return `${prefix}${milestone.title ?? ''}`.trim() || null
}

// One issue, with the native status and the fields the panel reads when the
// board declares them. `labels` stays: it carries `blocked` and the one state
// label GitHub has no status for (`ready-for-prod`).
const FIELD_ISSUE_NODE = `
  __typename
  id
  number
  title
  url
  state
  updatedAt
  labels(first: 50) { nodes { name } }
  milestone { number title }
  ... on Issue {
    status { name }
    issueType { name }
    issueFieldValues(first: 10) {
      nodes {
        __typename
        ... on IssueFieldSingleSelectValue { value field { ... on IssueFieldSingleSelect { id name } } }
        ... on IssueFieldNumberValue { value field { ... on IssueFieldNumber { id name } } }
      }
    }
  }
`

const FIELD_ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $login: String, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor, filterBy: { assignee: $login, states: OPEN }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${FIELD_ISSUE_NODE} }
      }
    }
  }
`

/** How many numbers one by-number query aliases; beyond, a new call. */
const FIELD_NUMBERS_PER_QUERY = 40

/** How the by-number query names the selects of its `issue(number:)` aliases. */
const ISSUE_ALIAS = /^i\d+$/

/**
 * Whether an error is a declared number that names no issue.
 *
 * GitHub resolves every other alias and reports each missing one as a
 * `NOT_FOUND` under its own alias: the number was deleted, or it names a pull
 * request, which shares the issue numbering. A declaration that drifted is not
 * a tracker outage, so the Done read skips it. A `NOT_FOUND` outside an alias
 * — the repository is gone or renamed — and every other error type stay fatal.
 */
function isMissingIssueNumber(error) {
  if (error?.type !== 'NOT_FOUND') {
    return false
  }
  const path = Array.isArray(error?.path) ? error.path : []
  if (path.length !== 2) {
    return false
  }
  const [root, alias] = path
  return root === 'repository' && typeof alias === 'string' && ISSUE_ALIAS.test(alias)
}

/** The declared fields of one issue, by field name. */
function fieldValuesOf(node) {
  const values = {}
  for (const entry of node?.issueFieldValues?.nodes ?? []) {
    const name = entry?.field?.name
    if (!name) continue
    if (entry.__typename === 'IssueFieldSingleSelectValue' || entry.__typename === 'IssueFieldNumberValue') {
      values[name] = entry.value ?? null
    }
  }
  return values
}

/** A GraphQL node in the shape the label path also produces. */
function issueFromNode(node) {
  return {
    number: node.number,
    title: node.title ?? '',
    labels: (node.labels?.nodes ?? []).map((label) => label?.name).filter(Boolean),
    milestone: node.milestone ?? null,
    type: node.issueType ?? null,
    status: node.status ?? null,
    html_url: node.url ?? null,
    updated_at: node.updatedAt ?? null,
    state: String(node.state ?? '').toLowerCase() === 'closed' ? 'closed' : 'open',
    node_id: node.id ?? null,
    fieldValues: fieldValuesOf(node),
  }
}

/**
 * The open issues assigned to the account, fields included.
 *
 * One GraphQL page carries what the REST read plus one call per field would
 * have cost: the issue, its type, its labels (for `blocked`), its milestone and
 * the values of the organization fields. Pull requests share the connection and
 * are dropped, exactly like the REST list drops them.
 */
async function readFieldIssues({ owner, repo, login = null }, { token: value, signal, fetchImpl = fetch }) {
  const collected = []
  let cursor = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await graphql(
      { query: FIELD_ISSUES_QUERY, variables: { owner, repo, login, cursor } },
      { token: value, signal, fetchImpl },
    )
    const connection = data?.repository?.issues
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error('GitHub: unexpected response (list expected)')
    }
    collected.push(...connection.nodes.filter((node) => node?.__typename === 'Issue').map(issueFromNode))
    if (!connection.pageInfo?.hasNextPage) break
    cursor = connection.pageInfo.endCursor ?? null
  }
  return collected
}

/**
 * The issues whose numbers are given, fields included.
 *
 * Reading the closed history by key keeps the panel's promise: only declared
 * missions are fetched. The numbers are aliased into one query (forty at a
 * time), so a declared history costs a couple of calls instead of one per
 * mission. A declared number that names no issue is skipped: the rest of the
 * batch still resolves.
 */
async function readFieldIssuesByNumber({ owner, repo, numbers }, { token: value, signal, fetchImpl = fetch }) {
  const collected = []
  for (let start = 0; start < numbers.length; start += FIELD_NUMBERS_PER_QUERY) {
    const slice = numbers.slice(start, start + FIELD_NUMBERS_PER_QUERY)
    const variables = { owner, repo }
    const declarations = ['$owner: String!', '$repo: String!']
    const aliases = slice.map((number, index) => {
      variables[`n${index}`] = number
      declarations.push(`$n${index}: Int!`)
      return `i${index}: issue(number: $n${index}) { ${FIELD_ISSUE_NODE} }`
    })
    const query = `query(${declarations.join(', ')}) {
      repository(owner: $owner, name: $repo) { ${aliases.join('\n')} }
    }`
    const data = await graphql(
      { query, variables },
      { token: value, signal, fetchImpl, tolerate: isMissingIssueNumber },
    )
    const repository = data?.repository
    if (!repository) throw new Error('GitHub: unexpected response (repository expected)')
    for (const node of Object.values(repository)) {
      if (node?.__typename === 'Issue') collected.push(issueFromNode(node))
    }
  }
  return collected
}

async function readIssues({ owner, repo, login = null, state = 'open' }, { token: value, signal, fetchImpl }) {
  const collected = []
  let url = `${API}/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=100`
  if (login) url += `&assignee=${encodeURIComponent(login)}`
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const { body, headers } = await requestJson(url, {
      token: value,
      signal,
      fetchImpl,
      label: 'GitHub',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    })
    if (!Array.isArray(body)) throw new Error('GitHub: unexpected response (list expected)')
    collected.push(...body)
    url = nextLink(headers?.get?.('link'))
  }
  return collected
}
