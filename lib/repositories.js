import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The repositories of the workspace root.
 *
 * Read-only by construction: only `status`, `log`, `rev-parse` and
 * `remote get-url` are ever run, and every command carries `-C <repository>`.
 * The scan walks the direct children of the root — a worktree is a child like
 * any other, its `.git` being a file instead of a folder — and never goes
 * deeper: a repository nested inside another one is not a repository of the
 * root, it is a folder of its owner.
 */

/** How many git processes run at once. Eight measured 1.6 s over 40 repos. */
export const SCAN_CONCURRENCY = 8

/** Commit lines handed to the drawer. */
export const DETAIL_COMMITS = 10

/** A single git call that takes longer is stuck, not slow. */
export const GIT_TIMEOUT_MS = 5000

/** How git reports a HEAD that is on no branch. */
const DETACHED = '(detached)'

/** Field separator of a log line: a subject may contain anything else. */
const FIELD = '%x1f'

/** The refusal git prints for a repository that has no commit yet. */
const NO_COMMITS = /does not have any commits yet|bad default revision|unknown revision/i

/**
 * Run one command. The default runner is the only place that spawns a
 * process: every test injects its own, so no test touches a real repository.
 */
export function execGit(file, args, options = {}) {
  return new Promise((done, fail) => {
    execFile(file, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        // git explains itself on stderr: keep it, that is the message shown.
        fail(Object.assign(error, { stderr: String(stderr ?? '') }))
        return
      }
      done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * A repository name the panel may ask about: one direct child, nothing else.
 *
 * The name arrives from the client, so it is checked here rather than trusted:
 * a separator, a NUL, `.`, `..` or a padded name never reaches git.
 */
export function isValidRepositoryName(name) {
  if (typeof name !== 'string') return false
  if (!name || name !== name.trim()) return false
  if (name === '.' || name === '..' || name === '.git') return false
  if (/[\\/\0]/.test(name)) return false
  return true
}

/**
 * The direct children of `root` that carry a `.git`, with the kind of entry.
 *
 * `stat` follows a symlinked `.git`, so a folder and a worktree file are told
 * apart by what they point to, not by how they are named.
 */
export async function readRepositoryNames(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    try {
      const git = await stat(join(root, entry.name, '.git'))
      found.push({ name: entry.name, kind: git.isDirectory() ? 'clone' : 'worktree' })
    } catch {
      // No `.git`: a plain folder, not a repository of the root.
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * What `git status --porcelain=v2 --branch` says, in the panel's terms.
 *
 * `dirty` counts files, not lines of porcelain: a rename prints one line and
 * is one file, which is the number the row shows.
 */
export function parseStatus(text) {
  const parsed = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, dirty: 0 }
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      if (value === DETACHED) parsed.detached = true
      else parsed.branch = value || null
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      parsed.upstream = line.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = /^\+(\d+)\s+-(\d+)$/.exec(line.slice('# branch.ab '.length).trim())
      if (match) {
        parsed.ahead = Number(match[1])
        parsed.behind = Number(match[2])
      }
      continue
    }
    // Every other `#` line is a header the panel does not show.
    if (line.startsWith('#')) continue
    parsed.dirty += 1
  }
  return parsed
}

/** The commits of a `--format=%h%x1f%ct%x1f%s` log, newest first. */
export function parseLog(text, { limit = DETAIL_COMMITS } = {}) {
  const commits = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    const parts = line.split('\x1f')
    const sha = parts.shift()
    if (!sha) continue
    const seconds = Number(parts.shift())
    commits.push({
      sha,
      date: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
      subject: parts.join('\x1f'),
    })
    if (commits.length >= limit) break
  }
  return commits
}

/** Newest commit first; a repository with no commit goes last. */
export function compareRepositories(left, right) {
  const a = left?.lastCommit?.date ?? 0
  const b = right?.lastCommit?.date ?? 0
  if (a !== b) return b - a
  return String(left?.name ?? '').localeCompare(String(right?.name ?? ''))
}

/**
 * Scan the root: one row per repository, in the order the widget shows them.
 *
 * A repository git cannot read is a row carrying its reason, never a failed
 * scan: the other 39 stay listed.
 */
export async function listRepositories(root, { run = execGit, concurrency = SCAN_CONCURRENCY } = {}) {
  const started = Date.now()
  const entries = await readRepositoryNames(root)
  const repositories = await mapLimit(entries, concurrency, (entry) => scanRepository(run, root, entry))
  repositories.sort(compareRepositories)
  return {
    root,
    repositories,
    errors: repositories.filter((row) => row.error).map((row) => ({ name: row.name, message: row.error })),
    count: repositories.length,
    durationMs: Date.now() - started,
  }
}

/**
 * One repository in full: its remote, its upstream, and the last ten commits.
 *
 * The name comes from the request, so it is validated before anything runs and
 * the resolved path is checked to be a direct child of the root.
 */
export async function readRepository(root, name, { run = execGit } = {}) {
  if (!isValidRepositoryName(name)) {
    throw Object.assign(new Error('invalid repository name'), { status: 400 })
  }
  const path = resolve(root, name)
  if (resolve(path, '..') !== resolve(root)) {
    throw Object.assign(new Error('repository is not a child of the workspace root'), { status: 400 })
  }

  let kind
  try {
    kind = (await stat(join(path, '.git'))).isDirectory() ? 'clone' : 'worktree'
  } catch {
    throw Object.assign(new Error(`no git repository named ${name}`), { status: 404 })
  }

  try {
    const status = parseStatus(await git(run, path, ['status', '--porcelain=v2', '--branch']))
    let head = null
    if (status.detached) head = await shortHead(run, path)
    // A repository without a remote is a state, not a failure: the drawer says
    // "no remote" instead of failing the whole read.
    let remote = null
    try {
      remote = (await git(run, path, ['remote', 'get-url', 'origin'])).trim() || null
    } catch {
      remote = null
    }
    let commits = []
    try {
      commits = parseLog(await git(run, path, ['log', '-n', String(DETAIL_COMMITS), '--no-decorate', `--format=%h${FIELD}%ct${FIELD}%s`]))
    } catch (error) {
      if (!NO_COMMITS.test(messageOf(error))) throw error
    }
    return { name, path, kind, ...status, head, remote, commits }
  } catch (error) {
    // git refused: that is the repository's problem, not a bad request.
    throw Object.assign(new Error(messageOf(error)), { status: 502 })
  }
}

async function scanRepository(run, root, entry) {
  const row = {
    name: entry.name,
    path: join(root, entry.name),
    kind: entry.kind,
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: 0,
    lastCommit: null,
    error: null,
  }

  try {
    Object.assign(row, parseStatus(await git(run, row.path, ['status', '--porcelain=v2', '--branch'])))
    // Only a detached HEAD needs a second read: the branch field cannot name
    // the commit it sits on, and that is what the row has to show.
    if (row.detached) row.head = await shortHead(run, row.path)
  } catch (error) {
    row.error = messageOf(error)
    return row
  }

  try {
    const commits = parseLog(await git(run, row.path, ['log', '-1', '--no-decorate', `--format=%h${FIELD}%ct${FIELD}%s`]), { limit: 1 })
    row.lastCommit = commits[0] ?? null
  } catch (error) {
    // A repository with no commit has no log: that is a state, not a failure.
    if (!NO_COMMITS.test(messageOf(error))) row.error = messageOf(error)
  }
  return row
}

async function shortHead(run, path) {
  try {
    return (await git(run, path, ['rev-parse', '--short', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

async function git(run, dir, args) {
  const { stdout } = await run('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS })
  return String(stdout ?? '')
}

/** The one line of a git refusal the panel shows. */
function messageOf(error) {
  const stderr = String(error?.stderr ?? '').trim()
  if (stderr) {
    const lines = stderr.split('\n').filter((line) => line.trim())
    return lines[lines.length - 1].replace(/^fatal:\s*/i, '').trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/** Run `worker` over `items`, at most `limit` at a time, in order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0
  const lanes = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(lanes)
  return results
}
