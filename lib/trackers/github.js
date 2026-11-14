import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { HttpError, lastLink, nextLink, requestJson } from '../http.js'
import { BLOCKED_LABEL, firstKnown, invertMap, normalizeIssue, onlyKnown } from '../mission.js'

const execFileAsync = promisify(execFile)
const API = 'https://api.github.com'
const MAX_PAGES = 10

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

/** List the open missions of a GitHub project. */
export async function list(project, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = project.github ?? {}
  if (!owner || !repo) {
    throw new Error(`project ${project.id}: owner and repo are required for a GitHub tracker`)
  }
  if (!project.reference) throw new Error(`project ${project.id}: reference is required`)

  const githubToken = await token()
  const login = await currentLogin({ signal, fetchImpl })
  const issues = await readIssues({ owner, repo, login }, { token: githubToken, signal, fetchImpl })
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

/** Normalize the issues of one read; a closed issue is a done mission. */
function toMissions(project, issues) {
  const inverse = invertMap(project.map)
  const pointsPrefix = project.map?.points ?? 'sp:'
  return issues.filter((issue) => !issue.pull_request).map((issue) => {
    const labels = (issue.labels ?? [])
      .map((label) => (typeof label === 'string' ? label : label?.name))
      .filter(Boolean)
    const state = onlyKnown(labels, inverse.states)
    const pointsLabel = labels.find((label) => label.startsWith(pointsPrefix) && /^\d+$/.test(label.slice(pointsPrefix.length)))
    return normalizeIssue({
      project,
      key: `${project.reference}-${issue.number}`,
      number: issue.number ?? null,
      title: issue.title ?? '',
      rawState: state.value,
      stateConflict: state.conflict,
      // The raw labels carry `blocked`: the flag is read from them.
      rawLabels: labels,
      rawType: issue.type?.name ?? null,
      rawPriority: firstKnown(labels, inverse.priorities),
      rawPoints: pointsLabel ? Number(pointsLabel.slice(pointsPrefix.length)) : null,
      closed: issue.state === 'closed',
      epic: epicOf(project, issue.milestone),
      url: issue.html_url ?? null,
      updatedAt: issue.updated_at ?? null,
      inverse,
    })
  })
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

/** Epic label: the project reference makes a repo-scoped milestone global. */
function epicOf(project, milestone) {
  if (!milestone) return null
  const prefix = Number.isFinite(milestone.number) ? `${project.reference}-${milestone.number} · ` : ''
  return `${prefix}${milestone.title ?? ''}`.trim() || null
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
