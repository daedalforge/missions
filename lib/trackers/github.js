import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { nextLink, requestJson } from '../http.js'
import { firstKnown, invertMap, normalizeIssue } from '../mission.js'

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

  const githubToken = await token()
  const login = await currentLogin({ signal, fetchImpl })
  const issues = await readIssues({ owner, repo, login }, { token: githubToken, signal, fetchImpl })
  const inverse = invertMap(project.map)

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => {
      const labels = (issue.labels ?? [])
        .map((label) => (typeof label === 'string' ? label : label?.name))
        .filter(Boolean)
      const pointsPrefix = project.map?.points ?? 'sp:'
      const pointsLabel = labels.find((label) => label.startsWith(pointsPrefix) && /^\d+$/.test(label.slice(pointsPrefix.length)))
      return normalizeIssue({
        project,
        key: `${owner}/${repo}#${issue.number}`,
        number: issue.number ?? null,
        title: issue.title ?? '',
        rawState: firstKnown(labels, inverse.states),
        rawType: issue.type?.name ?? null,
        rawPriority: firstKnown(labels, inverse.priorities),
        rawPoints: pointsLabel ? Number(pointsLabel.slice(pointsPrefix.length)) : null,
        epic: issue.milestone
          ? `${Number.isFinite(issue.milestone.number) ? `#${issue.milestone.number} · ` : ''}${issue.milestone.title ?? ''}`.trim() || null
          : null,
        url: issue.html_url ?? null,
        updatedAt: issue.updated_at ?? null,
        inverse,
      })
    })
}

async function readIssues({ owner, repo, login }, { token: value, signal, fetchImpl }) {
  const collected = []
  const assignee = encodeURIComponent(login)
  let url = `${API}/repos/${owner}/${repo}/issues?state=open&per_page=100&assignee=${assignee}`
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
