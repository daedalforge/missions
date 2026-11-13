import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * The repositories of the workspace root.
 *
 * Read-only except for two gestures: `adoptWorktree`, which brings a worktree's
 * branch back into its main checkout, and `removeWorktree`, which deletes a
 * worktree's folder and keeps its branch. Everything else runs only `status`,
 * `log`, `rev-list`, `for-each-ref`, `worktree list`, `rev-parse` and
 * `remote get-url`. The writes run `switch` and `worktree remove`, each behind
 * a clean-tree refusal, so a click never hides work. Every
 * command carries `-C <repository>`, and no `git machete` process is ever
 * spawned — the layout is read from its file. The scan walks the direct
 * children of the root — a worktree is a child like any other, its `.git`
 * being a file instead of a folder — and never goes deeper: a repository
 * nested inside another one is not a repository of the root, it is a folder of
 * its owner.
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

/**
 * How long a summary answers without scanning again.
 *
 * The scan costs two git processes per entry, and the dashboard ticks every
 * minute: five minutes makes a minute of ticks one scan, while a checkout the
 * user just pushed shows on the next read after the window.
 */
export const SUMMARY_TTL_MS = 5 * 60_000

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
  // Compared the way git names folders (`/var` and `/private/var` are one), so
  // a root reached through a symlink still offers its worktrees a target.
  const names = new Map(repositories.map((row) => [canonical(row.path), row.name]))
  for (const row of repositories) {
    if (row.main?.path) row.main.name = names.get(canonical(row.main.path)) ?? null
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

// A summary answers the dashboard for `SUMMARY_TTL_MS`: `?refresh=1` pays a
// new scan, so a retry is never answered by the number it wanted replaced.
const summaryCache = new Map()

// The reads in flight, keyed like the cache. Two callers that ask for the same
// root at the same instant — the dashboard mounting and its first tick — share
// one scan instead of both missing a cache that only holds finished reads.
const summaryReads = new Map()

/**
 * The repositories of the root, plus the age of the reading.
 *
 * Same rows as `listRepositories`, and `scannedAt` so the panel says how old
 * the digest is: a five-minute answer is not a silent promise. The root is
 * resolved before it keys the cache, so a path reached through a symlink shares
 * the entry of the path it names.
 */
export async function summarizeRepositories(root, { run = execGit, refresh = false } = {}) {
  const key = canonical(root)
  const memo = summaryCache.get(key)
  if (!refresh && memo && Date.now() - memo.at < SUMMARY_TTL_MS) return memo.summary

  const pending = summaryReads.get(key)
  if (!refresh && pending) return pending

  const reading = (async () => {
    const summary = {
      ...(await listRepositories(root, { run })),
      scannedAt: new Date().toISOString(),
    }
    summaryCache.set(key, { at: Date.now(), summary })
    return summary
  })()
  summaryReads.set(key, reading)
  try {
    return await reading
  } finally {
    if (summaryReads.get(key) === reading) summaryReads.delete(key)
  }
}

/** Forget every memoized summary: the door the tests open between two scales. */
export function resetRepositorySummary() {
  summaryCache.clear()
  summaryReads.clear()
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
 * A worktree row says whether it is the principal (`main`) and carries the
 * name of its folder when that folder is a direct child of the root — the two
 * facts the drawer needs to offer the removal of a checkout, and only those.
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
    // The principal is the first block git prints. A worktree is removable only
    // when its folder is a direct child of the root — compared the way git names
    // folders, so a root reached through a symlink still names its own children.
    const realRoot = canonical(resolve(root))
    const worktreeRows = worktrees.map((worktree, index) => ({
      ...worktree,
      main: index === 0,
      name: dirname(canonical(worktree.path)) === realRoot ? folderName(worktree.path) : null,
    }))

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
    return { layout: entries.length > 0, branches: rows, worktrees: worktreeRows }
  } catch (error) {
    throw Object.assign(new Error(messageOf(error)), { status: 502 })
  }
}

/** A refusal born of the machine's state, never of a read that failed. */
function conflict(message, extra = {}) {
  return Object.assign(new Error(message), { status: 409, ...extra })
}

/** The first `limit` paths `git status --porcelain` names, for a refusal. */
export function parseDirtyPaths(text, limit = 3) {
  const paths = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const rest = line.slice(3)
    const arrow = rest.lastIndexOf(' -> ')
    const path = (arrow === -1 ? rest : rest.slice(arrow + 4)).replace(/^"|"$/g, '')
    if (path) paths.push(path)
    if (paths.length >= limit) break
  }
  return paths
}

/** The sentence of a dirty side: how many files, and which ones. */
function dirtyMessage(label, dirty, files) {
  const which = files.length > 0 ? `: ${files.join(', ')}` : ''
  const count = dirty === 1 ? 'one file' : `${dirty} files`
  return `${label} has uncommitted changes (${count}${which}) — commit or stash them first`
}

/**
 * Bring a worktree's branch back into its main checkout — the module's one
 * write, and the only way a checkout ever moves.
 *
 * The order is the safety: the worktree is detached first, which frees the
 * branch without touching a byte of either tree; the main checkout then takes
 * the branch, and only then does the worktree folder go. Every step before the
 * `switch` is a refusal, and a `switch` git itself refuses puts the worktree
 * back on its branch — a failed click leaves the two repositories as it found
 * them. The one state that can differ is a `worktree remove` that git declines
 * after the switch: the answer says `removed: false` with git's own reason, and
 * the leftover worktree sits detached at the commit the main checkout holds.
 */
export async function adoptWorktree(root, name, { run = execGit, acceptIgnored = false } = {}) {
  const worktree = await openRepository(root, name)
  if (worktree.kind !== 'worktree') {
    throw Object.assign(new Error(`${name} is not a worktree: it has no branch to bring back`), { status: 400 })
  }

  let main = null
  try {
    main = await readMainWorktree(run, worktree.path)
  } catch {
    main = null
  }
  if (!main?.path) throw conflict(`the main worktree of ${name} is unknown: there is nothing to switch into`)

  // The main checkout must be a *direct child* of the root, and the checkout
  // this module touches must be that same folder. Lexical checks first (good
  // messages), then the physical ones — a symlinked child may point anywhere.
  const rootPath = resolve(root)
  const mainPath = resolve(main.path)
  const outside = (why = '') =>
    conflict(`the main worktree of ${name} lives outside the workspace root (${main.path})${why}`)
  const realRoot = canonical(rootPath)
  const realMain = canonical(mainPath)
  if (realMain !== realRoot && !realMain.startsWith(`${realRoot}${sep}`)) throw outside()
  if (dirname(realMain) !== realRoot) {
    throw conflict(
      `the main worktree of ${name} is not a direct child of the workspace root (${main.path}): the panel only switches into a row it shows`,
    )
  }
  let target = null
  try {
    target = await openRepository(root, folderName(mainPath))
  } catch {
    target = null
  }
  if (!target || canonical(target.path) !== canonical(mainPath)) throw outside()
  if (dirname(canonical(mainPath)) !== realRoot) {
    throw conflict(
      `the main worktree of ${name} is not a direct child of the workspace root (${main.path}): the panel only switches into a row it shows`,
    )
  }
  const targetName = folderName(target.path)
  if (canonical(target.path) === canonical(worktree.path)) {
    throw Object.assign(new Error(`${name} is its own main worktree`), { status: 400 })
  }

  const source = await stateOf(run, worktree.path)
  const dest = await stateOf(run, target.path)
  if (!source || !dest) throw Object.assign(new Error(`git cannot read ${name} or ${targetName}`), { status: 502 })
  if (source.detached || !source.branch) {
    throw conflict(`the worktree ${name} is detached: it has no branch to bring back`)
  }
  if (!isValidBranchName(source.branch)) {
    throw conflict(`the branch of ${name} (${source.branch}) is not a name git will accept`)
  }
  if (dest.branch === source.branch) {
    throw conflict(`${targetName} already holds ${source.branch}`)
  }

  if (dest.dirty > 0) {
    const files = await dirtyPaths(run, target.path)
    throw conflict(dirtyMessage(targetName, dest.dirty, files), { side: 'main', files })
  }
  if (source.dirty > 0) {
    const files = await dirtyPaths(run, worktree.path)
    throw conflict(dirtyMessage(`the worktree ${name}`, source.dirty, files), { side: 'worktree', files })
  }

  const branch = source.branch
  // `git worktree remove` deletes ignored entries without a word: name them
  // first, and delete them only when the client says so. Nothing has moved yet.
  if (!acceptIgnored) {
    const ignored = await ignoredEntries(run, worktree.path)
    if (ignored.count > 0) {
      const noun = ignored.count === 1 ? 'entry' : 'entries'
      const listed = ignored.names.join(', ') + (ignored.count > ignored.names.length ? ', …' : '')
      throw conflict(
        `the worktree ${name} holds ${ignored.count} ignored ${noun} (${listed}) that git deletes with the folder — send acceptIgnored to remove them with it`,
        { side: 'worktree', ignored: true, files: ignored.names },
      )
    }
  }

  // 1. Free the branch: the worktree keeps its commit, still clean, still there.
  try {
    await gitWrite(run, worktree.path, ['switch', '--detach'])
  } catch (error) {
    // A post-checkout hook can fail after git moved HEAD. Believe the tree,
    // not the exit code: a detached worktree means the step did happen.
    const now = await stateOf(run, worktree.path)
    if (!now?.detached) {
      throw Object.assign(new Error(`git refused to detach ${name}: ${messageOf(error)}`), { status: 502 })
    }
  }

  // 2. Hand the branch to the main checkout. git can still fail without having
  //    written, or fail after writing: the state is read, never assumed.
  try {
    await gitWrite(run, target.path, ['switch', branch])
  } catch (error) {
    const [sourceNow, destNow] = await Promise.all([stateOf(run, worktree.path), stateOf(run, target.path)])
    const held = destNow && !destNow.detached && destNow.branch === branch
    if (!held) {
      // Put the worktree back on its branch, then read where it really is.
      let back = sourceNow
      const moved = Boolean(sourceNow?.detached)
      let restored = Boolean(sourceNow && !sourceNow.detached && sourceNow.branch === branch)
      if (moved) {
        try {
          await gitWrite(run, worktree.path, ['switch', branch])
        } catch {
          // Read below: the message says what the checkouts hold, not what was attempted.
        }
        back = await stateOf(run, worktree.path)
        restored = Boolean(back && !back.detached && back.branch === branch)
      }
      const tail = restored
        ? ` — ${name} ${moved ? 'was put back' : 'stayed'} on ${branch}`
        : ` — ${name} is still detached and ${branch} is checked out nowhere: fix the cause, then run git -C ${target.path} switch ${branch}`
      throw Object.assign(new Error(`git refused to switch ${targetName} to ${branch}: ${messageOf(error)}${tail}`), {
        status: 502,
      })
    }
    // The branch is in the main checkout despite the exit code: carry on.
  }

  // 3. The worktree folder goes, its branch already on the main checkout.
  let removed = true
  let reason = null
  try {
    await gitWrite(run, target.path, ['worktree', 'remove', worktree.path])
  } catch (error) {
    // A refusal before the deletion leaves the folder; a failure after it does
    // not. The disk answers, not the exit code.
    if (exists(worktree.path)) {
      removed = false
      reason = messageOf(error)
    }
  }
  return { ok: true, source: name, branch, main: { name: targetName, path: target.path }, removed, reason }
}

/**
 * Remove a worktree's folder and keep its branch — the module's other write.
 *
 * `git worktree remove` without `--force` is the whole gesture: git refuses a
 * checkout it would lose work from. The refusals are read before the command so
 * the answer names the files, and the ignored entries are named before the
 * folder takes them along. The branch and its commits are never touched:
 * removing a checkout is not deleting work.
 */
export async function removeWorktree(root, name, { run = execGit, acceptIgnored = false } = {}) {
  const worktree = await openRepository(root, name)
  if (worktree.kind !== 'worktree') {
    throw Object.assign(new Error(`${name} is not a worktree: it has no folder to remove`), { status: 400 })
  }

  const state = await stateOf(run, worktree.path)
  if (!state) throw Object.assign(new Error(`git cannot read ${name}`), { status: 502 })
  if (state.dirty > 0) {
    const files = await dirtyPaths(run, worktree.path)
    throw conflict(dirtyMessage(`the worktree ${name}`, state.dirty, files), { side: 'worktree', files })
  }

  // `git worktree remove` deletes ignored entries without a word: name them
  // first, and delete them only when the client says so.
  if (!acceptIgnored) {
    const ignored = await ignoredEntries(run, worktree.path)
    if (ignored.count > 0) {
      const noun = ignored.count === 1 ? 'entry' : 'entries'
      const listed = ignored.names.join(', ') + (ignored.count > ignored.names.length ? ', …' : '')
      throw conflict(
        `the worktree ${name} holds ${ignored.count} ignored ${noun} (${listed}) that git deletes with the folder — send acceptIgnored to remove them with it`,
        { side: 'worktree', ignored: true, files: ignored.names },
      )
    }
  }

  try {
    await gitWrite(run, worktree.path, ['worktree', 'remove', worktree.path])
  } catch (error) {
    // A refusal before the deletion leaves the folder, a failure after it does
    // not. The disk answers, not the exit code.
    if (exists(worktree.path)) {
      throw Object.assign(new Error(`git refused to remove ${name}: ${messageOf(error)}`), { status: 502 })
    }
  }
  return { name, removed: true }
}

/**
 * A path as git reports it: `worktree list` prints the real path, so a root
 * reached through a symlink (macOS `/var` → `/private/var`) still matches its
 * own repositories. A path git named but that no longer exists keeps its
 * resolved form.
 */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The paths a dirty side names in its refusal: a read, on the error path only. */
async function dirtyPaths(run, path) {
  try {
    return parseDirtyPaths(await git(run, path, ['status', '--porcelain']))
  } catch {
    return []
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

async function git(run, dir, args, options = {}) {
  const { stdout } = await run('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, ...options })
  return String(stdout ?? '')
}

/**
 * A command that writes. The read timeout is a scan's budget; a checkout that
 * moves a large tree can honestly take longer, and killing it midway leaves the
 * shared clone half switched. Writes get their own, much larger ceiling.
 */
const WRITE_TIMEOUT_MS = 120_000
const gitWrite = (run, dir, args) => git(run, dir, args, { timeout: WRITE_TIMEOUT_MS })

/** What git reports for one checkout, or null when git cannot answer. */
async function stateOf(run, dir) {
  try {
    return parseStatus(await git(run, dir, ['status', '--porcelain=v2', '--branch']))
  } catch {
    return null
  }
}

/**
 * The ignored entries `git worktree remove` takes with the folder without
 * asking: `node_modules/` is regenerable, `.env` is not. The panel names them
 * before deleting, and only deletes them when the client accepts.
 */
async function ignoredEntries(run, dir, limit = 4) {
  try {
    const lines = String(await git(run, dir, ['status', '--porcelain', '--ignored=matching'])).split('\n')
    const entries = lines
      .filter((line) => line.startsWith('!! '))
      .map((line) => line.slice(3).replace(/\/$/, ''))
    return { count: entries.length, names: entries.slice(0, limit) }
  } catch {
    return { count: 0, names: [] }
  }
}

/** Does the folder still exist? Used after a refused removal. */
function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
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
