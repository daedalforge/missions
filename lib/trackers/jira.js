import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { HttpError, requestJson } from '../http.js'
import { invertMap, normalizeIssue } from '../mission.js'

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
  return issues.map((issue) => {
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
