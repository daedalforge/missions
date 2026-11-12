import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { HttpError, requestJson } from '../http.js'
import { BLOCKED_LABEL, invertMap, normalizeIssue } from '../mission.js'

const execFileAsync = promisify(execFile)
const BASE_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'updated', 'priority', 'labels']
const MAX_PAGES = 5
const PAGE_SIZE = 100

/**
 * Scoped API tokens (`ATATT…`) authenticate only through the Atlassian
 * gateway, never against `https://<site>.atlassian.net/rest/api/3/…` (401).
 */
const GATEWAY = 'https://api.atlassian.com/ex/jira'

export const id = 'jira'

let tokenCache = null
const cloudIds = new Map()

/**
 * Jira token, never written to disk.
 *
 * Order: `JIRA_API_TOKEN`, then the machine keychain — the same service as
 * `config/tools/atlassian/jira.sh` (`atlassian-token`).
 */
export async function token() {
  if (tokenCache) return tokenCache
  const fromEnv = process.env.JIRA_API_TOKEN
  if (fromEnv && fromEnv.trim()) {
    tokenCache = fromEnv.trim()
    return tokenCache
  }
  const service = process.env.ATLASSIAN_KEYCHAIN_SERVICE || 'atlassian-token'
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 10000,
    })
    const value = String(stdout ?? '').trim()
    if (!value) throw new Error('empty')
    tokenCache = value
    return tokenCache
  } catch {
    throw new Error(`Jira token not found: keychain "${service}" or JIRA_API_TOKEN`)
  }
}

export function forgetToken() {
  tokenCache = null
  cloudIds.clear()
}

/** Account address: the project's `jira.email`, else the environment. */
export function accountEmail(project) {
  return project?.jira?.email || process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL || null
}

/** Site URL without trailing slash; it stays the human-facing browse base. */
function siteOf(project) {
  const site = project?.jira?.site
  if (!site) throw new Error(`project ${project?.id}: jira.site is required`)
  return String(site).replace(/\/+$/, '')
}

/**
 * API base for the project: the gateway, keyed by the tenant cloudId.
 *
 * `jira.cloud_id` skips the lookup; otherwise `GET /_edge/tenant_info` gives it,
 * once per site.
 */
async function apiBase(project, { signal, fetchImpl }) {
  const declared = project?.jira?.cloud_id
  if (declared) return `${GATEWAY}/${declared}`

  const site = siteOf(project)
  const known = cloudIds.get(site)
  if (known) return `${GATEWAY}/${known}`

  const { body } = await requestJson(`${site}/_edge/tenant_info`, { signal, fetchImpl, label: 'Jira' })
  const cloudId = body?.cloudId
  if (!cloudId) {
    throw new Error(`project ${project.id}: Jira cloudId not resolved; set jira.cloud_id in projects.yml`)
  }
  cloudIds.set(site, String(cloudId))
  return `${GATEWAY}/${cloudId}`
}

/**
 * Prove the identity before reading.
 *
 * This site answers anonymous JQL searches with `200 {"issues": []}`, so a dead
 * token would show an empty list. `/myself` is the one call that needs an
 * identity, and its 401 already reads `Jira token missing or invalid`; a 403
 * keeps its own message, which is about permissions, not a dead token.
 */
async function ensureIdentity(base, options) {
  await requestJson(`${base}/rest/api/3/myself`, { ...options, label: 'Jira' })
}

/**
 * An epic is a container, not a mission.
 *
 * Jira types it above the standard issues (`hierarchyLevel` 1; higher levels
 * exist on Premium), which is the type's nature, not its name: no `Epic`
 * string enters the code, and the project's `map.types` keeps deciding what a
 * mission type is. Epics are still read — the JQL does not filter them — then
 * dropped here; each mission's `epic` label keeps feeding the Epic filter.
 */
function isEpic(fields) {
  return Number(fields?.issuetype?.hierarchyLevel) >= 1
}

/** List the unresolved missions of a Jira project. */
export async function list(project, { signal, fetchImpl = fetch } = {}) {
  const prefix = project.reference
  const site = siteOf(project)
  if (!prefix) throw new Error(`project ${project.id}: reference is required`)

  const user = accountEmail(project)
  if (!user) throw new Error(`project ${project.id}: jira.email is required (or JIRA_EMAIL)`)

  const password = await token()
  const headers = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  }

  const base = await apiBase(project, { signal, fetchImpl })
  await ensureIdentity(base, { headers, signal, fetchImpl })

  const pointsField = project.jira?.story_points_field || 'customfield_10016'
  const fields = [...BASE_FIELDS, pointsField].join(',')
  const jql = `project = "${prefix}" AND resolution = Unresolved AND assignee = currentUser() ORDER BY updated DESC`
  const issues = await search(base, jql, { fields, headers, signal, fetchImpl })

  const inverse = invertMap(project.map)
  return toMissions(project, issues, { site, pointsField, inverse })
}

/**
 * List the declared missions of a Jira project, closed ones included.
 *
 * The keys are the whole question: one JQL per batch, whatever the resolution.
 * The caller keeps what the project maps on `done`, so an issue still open
 * under a declared key (a folder kept for a reopened mission) comes back
 * untouched by this filter. The batch size keeps the query short on every
 * site; the declared folders are local and counted in tens.
 */
export async function listDone(project, keys, { signal, fetchImpl = fetch } = {}) {
  const prefix = project.reference
  const site = siteOf(project)
  if (!prefix) throw new Error(`project ${project.id}: reference is required`)

  const user = accountEmail(project)
  if (!user) throw new Error(`project ${project.id}: jira.email is required (or JIRA_EMAIL)`)

  const password = await token()
  const headers = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  }

  const base = await apiBase(project, { signal, fetchImpl })
  await ensureIdentity(base, { headers, signal, fetchImpl })

  const pointsField = project.jira?.story_points_field || 'customfield_10016'
  const fields = [...BASE_FIELDS, pointsField].join(',')
  const issues = []
  for (let index = 0; index < keys.length; index += 40) {
    const batch = keys.slice(index, index + 40)
    const jql = `key in (${batch.map((key) => `"${key}"`).join(', ')})`
    issues.push(...(await search(base, jql, { fields, headers, signal, fetchImpl })))
  }

  const inverse = invertMap(project.map)
  return toMissions(project, issues, { site, pointsField, inverse }).filter((mission) => mission.state === 'done')
}

/** Normalize the issues of one read; an epic container is dropped like anywhere else. */
function toMissions(project, issues, { site, pointsField, inverse }) {
  return issues.filter((issue) => !isEpic(issue.fields)).map((issue) => {
    const champs = issue.fields ?? {}
    return normalizeIssue({
      project,
      key: issue.key,
      number: null,
      title: champs.summary ?? '',
      rawState: champs.status?.name ?? null,
      rawType: champs.issuetype?.name ?? null,
      rawPriority: champs.priority?.name ?? null,
      rawPoints: champs[pointsField] ?? null,
      rawLabels: champs.labels ?? [],
      epic: champs.parent?.key
        ? `${champs.parent.key}${champs.parent.fields?.summary ? ` · ${champs.parent.fields.summary}` : ''}`
        : null,
      url: `${site}/browse/${issue.key}`,
      updatedAt: champs.updated ?? null,
      inverse,
    })
  })
}

/**
 * Set or clear the blocked label on one issue, and post the reason.
 *
 * Labels live in `fields.labels`; `update.labels` adds or removes one without
 * echoing the others back. A comment body must be ADF on v3 — a plain string is
 * refused, so the reason becomes one paragraph per line.
 */
export async function setBlocked(project, key, { blocked, message = '', signal, fetchImpl = fetch } = {}) {
  const user = accountEmail(project)
  if (!user) throw new Error(`project ${project.id}: jira.email is required (or JIRA_EMAIL)`)

  const password = await token()
  const headers = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  }
  const base = await apiBase(project, { signal, fetchImpl })
  const issue = `${base}/rest/api/3/issue/${encodeURIComponent(key)}`
  const options = { headers, signal, fetchImpl, label: 'Jira' }

  await requestJson(issue, {
    ...options,
    method: 'PUT',
    body: { update: { labels: [blocked ? { add: BLOCKED_LABEL } : { remove: BLOCKED_LABEL }] } },
  })
  if (!blocked) return { key, blocked: false, comment: null }

  const reason = String(message ?? '').trim()
  if (!reason) return { key, blocked: true, comment: null }
  const { body } = await requestJson(`${issue}/comment`, { ...options, method: 'POST', body: { body: adf(reason) } })
  return { key, blocked: true, comment: body?.self ?? body?.id ?? null }
}

/**
 * Move one issue to another priority.
 *
 * Jira holds the priority in `fields.priority`; the project map declares the
 * tracker's own name for each canonical word. One PUT replaces it — there is no
 * label to remove first, and no comment to post.
 */
export async function setPriority(project, key, { value, signal, fetchImpl = fetch } = {}) {
  const user = accountEmail(project)
  if (!user) throw new Error(`project ${project.id}: jira.email is required (or JIRA_EMAIL)`)
  const target = String(value ?? '').trim()
  if (!target) throw new Error(`project ${project.id}: priority value is missing`)

  const password = await token()
  const headers = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  }
  const base = await apiBase(project, { signal, fetchImpl })
  await requestJson(`${base}/rest/api/3/issue/${encodeURIComponent(key)}`, {
    headers,
    signal,
    fetchImpl,
    label: 'Jira',
    method: 'PUT',
    body: { fields: { priority: { name: target } } },
  })
  return { key, value: target }
}

/** A comment body as ADF: one paragraph per non-empty line. */
function adf(text) {
  const content = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
  return {
    type: 'doc',
    version: 1,
    content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }],
  }
}

async function search(base, jql, { fields, headers, signal, fetchImpl }) {
  try {
    return await searchJql(base, jql, { fields, headers, signal, fetchImpl })
  } catch (error) {
    // Some Cloud sites still refuse `/search/jql`: fall back to the historical
    // endpoint, paginated with `startAt`.
    if (error instanceof HttpError && (error.status === 404 || error.status === 410)) {
      return searchLegacy(base, jql, { fields, headers, signal, fetchImpl })
    }
    throw error
  }
}

async function searchJql(base, jql, { fields, headers, signal, fetchImpl }) {
  const collected = []
  let nextPageToken = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${base}/rest/api/3/search/jql`)
    url.searchParams.set('jql', jql)
    url.searchParams.set('fields', fields)
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken)

    const { body } = await requestJson(url.toString(), { headers, signal, fetchImpl, label: 'Jira' })
    collected.push(...(body?.issues ?? []))
    nextPageToken = body?.nextPageToken ?? null
    if (!nextPageToken) break
  }
  return collected
}

async function searchLegacy(base, jql, { fields, headers, signal, fetchImpl }) {
  const collected = []
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${base}/rest/api/3/search`)
    url.searchParams.set('jql', jql)
    url.searchParams.set('fields', fields)
    url.searchParams.set('startAt', String(page * PAGE_SIZE))
    url.searchParams.set('maxResults', String(PAGE_SIZE))

    const { body } = await requestJson(url.toString(), { headers, signal, fetchImpl, label: 'Jira' })
    const issues = body?.issues ?? []
    collected.push(...issues)
    const total = Number(body?.total ?? 0)
    if (issues.length < PAGE_SIZE || collected.length >= total) break
  }
  return collected
}
