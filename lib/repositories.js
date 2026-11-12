import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * The repositories of the workspace root.
 *
 * Read-only by construction: only `status`, `log`, `rev-list`, `for-each-ref`,
 * `worktree list`, `rev-parse` and `remote get-url` are ever run, every command
 * carries `-C <repository>`, and no `git machete` process is ever spawned — the
 * layout is read from its file. The scan walks the direct children of the root
 * — a worktree is a child like any other, its `.git` being a file instead of a
 * folder — and never goes deeper: a repository nested inside another one is not
 * a repository of the root, it is a folder of its owner.
 */

/** How many git processes run at once. Eight measured 1.6 s over 40 repos. */
export const SCAN_CONCURRENCY = 8

/** Commits per page of a branch history: a bound, never the whole log. */
export const HISTORY_PAGE = 50

/** Commits a branch shows as introduced on its parent, before the `+` mark. */
export const TREE_COMMITS = 10

/** The machete layout, relative to the git common directory. */
const MACHETE_FILE = 'machete'

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
 * How many repositories the root holds: the clones alone.
 *
 * A worktree's `.git` is a file pointing at a repository declared elsewhere, so
 * a worktree is a checkout, not a repository of the root; the badge counts what
 * the root owns, and a worktree whose main repository lives outside the root is
 * undercounted by one, never overcounted. Nothing here runs git.
 */
export async function countRepositories(root) {
  const entries = await readRepositoryNames(root)
  return entries.filter((entry) => entry.kind === 'clone').length
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
export function parseLog(text, { limit = 10 } = {}) {
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

/** The branches of a `for-each-ref --format=%(refname:short)` listing. */
export function parseBranches(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The layout of `git machete` (the `machete` file), in the order it declares.
 *
 * A line is `name  annotation…`, and its position is its leading whitespace:
 * a branch is a child of the last branch declared at a smaller indentation.
 * Depth is counted in the indentation levels the file actually uses, so a
 * layout indented by two, four or a tab reads the same tree. Comments (`#`)
 * and blank lines are skipped — the file is data, not commands.
 */
export function parseMacheteLayout(text) {
  const rows = []
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    const [name, ...rest] = raw.trim().split(/\s+/)
    if (!name) continue
    rows.push({ name, indent, annotation: rest.join(' ') || null })
  }
  const levels = [...new Set(rows.map((row) => row.indent))].sort((left, right) => left - right)
  return rows.map((row) => ({
    name: row.name,
    depth: levels.indexOf(row.indent),
    annotation: row.annotation,
  }))
}

/**
 * Depth-first rows carrying their parent: one flat list the drawer can walk.
 *
 * A depth that jumps (a child with no declared parent) is clamped to the
 * deepest branch actually open, so a malformed file still reads as a tree.
 */
export function flattenLayout(entries = []) {
  const rows = []
  const parents = []
  for (const entry of entries) {
    const depth = Math.max(0, Math.min(Number(entry?.depth) || 0, parents.length))
    parents[depth] = entry.name
    parents.length = depth + 1
    rows.push({
      name: entry.name,
      depth,
      parent: depth === 0 ? null : (parents[depth - 1] ?? null),
      annotation: entry?.annotation ?? null,
    })
  }
  return rows
}

/**
 * `git worktree list --porcelain`, one row per worktree.
 *
 * A detached worktree carries no branch; the current one is the folder the
 * read was made from, compared on the resolved path, never on a name.
 */
export function parseWorktreeList(text, { current = null } = {}) {
  const worktrees = []
  let row = null
  const close = () => {
    if (row) worktrees.push(row)
    row = null
  }
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) {
      close()
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      close()
      row = { path: value, branch: null, head: null, current: false }
    } else if (!row) {
      continue
    } else if (key === 'HEAD') {
      row.head = value
    } else if (key === 'branch') {
      row.branch = value.replace(/^refs\/heads\//, '')
    }
  }
  close()
  if (current !== null) {
    const wanted = resolve(String(current))
    for (const worktree of worktrees) worktree.current = resolve(worktree.path) === wanted
  }
  return worktrees
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
  // A principal is a target only when the very same resolved path is a row of
  // this scan: a bare repository, a folder without `.git` or a checkout outside
  // the root has no row, so its name stays null and no switch can lead nowhere.
  const names = new Map(repositories.map((row) => [resolve(row.path), row.name]))
  for (const row of repositories) {
    if (row.main?.path) row.main.name = names.get(resolve(row.main.path)) ?? null
  }
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
 * One repository in full: its remote, its upstream, and its working tree.
 *
 * The name comes from the request, so it is validated before anything runs and
 * the resolved path is checked to be a direct child of the root.
 */
export async function readRepository(root, name, { run = execGit } = {}) {
  const { path, kind } = await openRepository(root, name)

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
    return { name, path, kind, ...status, head, remote }
  } catch (error) {
    // git refused: that is the repository's problem, not a bad request.
    throw Object.assign(new Error(messageOf(error)), { status: 502 })
  }
}

/**
 * One page of a branch's history, newest first.
 *
 * The branch is the one asked for, the default branch otherwise; a name is
 * checked against the local branches before it reaches git, so an option
 * (`--all`) is refused as a branch instead of being executed. A page holds
 * `HISTORY_PAGE` commits at most: the total is read, never the whole log.
 */
export async function readHistory(root, name, { branch = null, skip = 0, run = execGit } = {}) {
  const { path } = await openRepository(root, name)
  const wanted = typeof branch === 'string' ? branch.trim() : ''
  if (wanted && !isValidBranchName(wanted)) {
    throw Object.assign(new Error(`invalid branch name: ${wanted}`), { status: 400 })
  }
  const page = skip === null || skip === '' || skip === undefined ? 0 : Number(skip)
  if (!Number.isInteger(page) || page < 0) {
    throw Object.assign(new Error('skip must be a whole number of commits'), { status: 400 })
  }

  try {
    const branches = parseBranches(await git(run, path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    const target = wanted || (await defaultBranch(run, path, branches))
    if (!target) throw Object.assign(new Error('no local branch to read'), { status: 400 })
    if (!branches.includes(target)) {
      throw Object.assign(new Error(`unknown branch: ${target}`), { status: 400 })
    }
    const ref = `refs/heads/${target}`
    const total = Number((await git(run, path, ['rev-list', '--count', ref])).trim())
    const commits = parseLog(
      await git(run, path, ['log', `--format=%h${FIELD}%ct${FIELD}%s`, '-n', String(HISTORY_PAGE), `--skip=${page}`, ref]),
      { limit: HISTORY_PAGE },
    )
    return { branch: target, branches, commits, hasMore: page + commits.length < total, total }
  } catch (error) {
    if (error?.status) throw error
    throw Object.assign(new Error(messageOf(error)), { status: 502 })
  }
}

/**
 * The declared layout of the repository, its branches and the worktrees.
 *
 * The layout is read from the `machete` file of the git common directory —
 * the file git machete itself reads — and never by running `git machete`.
 * Each branch carries the commits it introduces on its parent, `TREE_COMMITS`
 * at most; between branches the logs run in parallel. A branch of the layout
 * that is not local is marked rather than failing the tab, and a parent that
 * is not local leaves its children's commits unread instead of failing them.
 */
export async function readTree(root, name, { run = execGit, concurrency = SCAN_CONCURRENCY } = {}) {
  const { path } = await openRepository(root, name)

  try {
    const common = (await git(run, path, ['rev-parse', '--git-common-dir'])).trim()
    const commonDir = resolve(path, common || '.git')
    const layoutText = await readFile(join(commonDir, MACHETE_FILE), 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    const entries = layoutText ? flattenLayout(parseMacheteLayout(layoutText)) : []
    const worktrees = parseWorktreeList(await git(run, path, ['worktree', 'list', '--porcelain']), { current: path })
    const branches = parseBranches(await git(run, path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    const labels = new Map()
    for (const worktree of worktrees) {
      if (worktree.branch) labels.set(worktree.branch, folderName(worktree.path))
    }

    const rows = await mapLimit(entries, concurrency, async (entry) => {
      const present = branches.includes(entry.name)
      let commits = []
      let truncated = false
      if (present && entry.parent && branches.includes(entry.parent)) {
        const text = await git(run, path, [
          'log',
          `--format=%h${FIELD}%ct${FIELD}%s`,
          '-n',
          String(TREE_COMMITS + 1),
          `${entry.parent}..refs/heads/${entry.name}`,
        ])
        const read = parseLog(text, { limit: TREE_COMMITS + 1 })
        truncated = read.length > TREE_COMMITS
        commits = read.slice(0, TREE_COMMITS)
      }
      return { ...entry, worktree: labels.get(entry.name) ?? null, commits, truncated, missing: !present }
    })
    return { layout: entries.length > 0, branches: rows, worktrees }
  } catch (error) {
    throw Object.assign(new Error(messageOf(error)), { status: 502 })
  }
}

/**
 * A branch name git may be handed as a ref.
 *
 * Refused before git sees it: an option (`--all`), a revision expression
 * (`..`, `@{`), or anything a shell or git would read as more than a name.
 */
export function isValidBranchName(name) {
  if (typeof name !== 'string') return false
  if (!name || name !== name.trim()) return false
  if (name.startsWith('-')) return false
  if (name.endsWith('/') || name.endsWith('.') || name.startsWith('/')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  if (name === 'HEAD' || name === '@') return false
  if (!/^[A-Za-z0-9._\-/]+$/.test(name)) return false
  return true
}

/** The resolved path and kind of a repository of the root, or a refusal. */
async function openRepository(root, name) {
  if (!isValidRepositoryName(name)) {
    throw Object.assign(new Error('invalid repository name'), { status: 400 })
  }
  const path = resolve(root, name)
  if (resolve(path, '..') !== resolve(root)) {
    throw Object.assign(new Error('repository is not a child of the workspace root'), { status: 400 })
  }
  try {
    const kind = (await stat(join(path, '.git'))).isDirectory() ? 'clone' : 'worktree'
    return { path, kind }
  } catch {
    throw Object.assign(new Error(`no git repository named ${name}`), { status: 404 })
  }
}

/**
 * The branch a history opens on: `main` when it exists, the current branch
 * otherwise — a repository that renamed its trunk still answers with a page.
 */
async function defaultBranch(run, path, branches) {
  if (branches.includes('main')) return 'main'
  try {
    const current = (await git(run, path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (current && current !== 'HEAD' && branches.includes(current)) return current
  } catch {
    // A detached HEAD names no branch: the first local branch answers.
  }
  return branches[0] ?? null
}

/** The folder that carries a worktree, for the row's label. */
function folderName(path) {
  return String(path ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
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
    main: null,
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

  // A linked checkout knows the principal it was created from; a clone is its
  // own principal, and the field says so rather than leaving the key out.
  if (entry.kind === 'worktree') row.main = await readMainWorktree(run, row.path)
  return row
}

/**
 * The worktree a linked checkout was created from. `git worktree list`
 * answers with the principal in its first block; the name is not guessed
 * here — `listRepositories` resolves it against the scanned rows, on resolved
 * paths, so a principal with no row keeps its path and a null name.
 */
async function readMainWorktree(run, path) {
  try {
    const rows = parseWorktreeList(await git(run, path, ['worktree', 'list', '--porcelain']), { current: path })
    const first = rows[0]
    return { name: null, path: first?.path ? resolve(first.path) : null }
  } catch {
    // A worktree git cannot read still shows as a row: the path is null,
    // which reads as an unknown principal rather than a missing row.
    return { name: null, path: null }
  }
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
