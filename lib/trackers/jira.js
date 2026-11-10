import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { HttpError, requestJson } from '../http.js'
import { invertMap, normalizeIssue } from '../mission.js'

const execFileAsync = promisify(execFile)
const BASE_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'updated', 'priority']
const MAX_PAGES = 5
const PAGE_SIZE = 100

export const id = 'jira'

let tokenCache = null

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
}

/** Account address: the project's `jira.email`, else the environment. */
export function accountEmail(project) {
  return project?.jira?.email || process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL || null
}

/** List the unresolved missions of a Jira project. */
export async function list(project, { signal, fetchImpl = fetch } = {}) {
  const { site, key_prefix: prefix } = project.jira ?? {}
  if (!site) throw new Error(`project ${project.id}: jira.site is required`)
  if (!prefix) throw new Error(`project ${project.id}: jira.key_prefix is required`)

  const user = accountEmail(project)
  if (!user) throw new Error(`project ${project.id}: jira.email is required (or JIRA_EMAIL)`)

  const password = await token()
  const headers = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  }

  const base = site.replace(/\/+$/, '')
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
      epic: champs.parent?.key ?? null,
      url: `${base}/browse/${issue.key}`,
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
