import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { requestJson } from './http.js'
import { invertMap, onlyKnown } from './mission.js'
import { execGit, parseWorktreeList } from './repositories.js'
import { token } from './trackers/github.js'

/**
 * Closing the local checkout of a mission, once the work is on the base.
 *
 * The panel's gesture touches the machine, never the tracker: it deletes the
 * mission branch, removes the worktrees that hold it, switches the clone back
 * to the base, removes the branch from `.git/machete` and appends one section
 * to the mission journal. The tracker is only read — the merge stays the
 * requester's gesture.
 *
 * The proof is a pull request, merged into the declared base, whose merge
 * commit (or head commit) is an ancestor of `origin/<base>`. Everything the
 * plan needs is read first; a refusal therefore reaches the client before any
 * writing command runs.
 *
 * The project squash-merges, so the local branch is never an ancestor of the
 * base: the proof starts from the PR's head, not from the local tip. What may
 * sit between the two is only a synchronisation merge — a merge whose other
 * parents are all on the base. Any other commit is work that was never
 * delivered, and refuses with its sha.
 */

/** Bound of `git fetch`, which legitimately outlives the other git calls. */
export const CLOSE_TIMEOUT_MS = 60_000

const API = 'https://api.github.com'

/** A refusal the panel can show: the request was fine, the state was not. */
export class LocalCloseError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.name = 'LocalCloseError'
    this.status = status
  }
}

/** `MIS-136` -> `136`, the number the GitHub API expects. */
export function issueNumber(key) {
  const number = Number(String(key ?? '').split('-').pop())
  if (!Number.isInteger(number) || number <= 0) {
    throw new LocalCloseError(`${key}: the key has no issue number`)
  }
  return number
}

/**
 * Read the proof that the branch's work is on the base.
 *
 * Two GETs, no write: the issue (its current state must still be
 * `ready-for-prod`) and the pull requests whose head is the mission branch.
 * A PR is preferred over its absence, a merge over an open PR, the declared
 * base over another one — each refusal names what it saw.
 */
export async function readProof({ project, key, branch, base, fetchImpl = fetch, githubToken, signal } = {}) {
  const { owner, repo } = project?.github ?? {}
  if (!owner || !repo) throw new LocalCloseError(`project ${project?.id}: owner and repo are required`)
  if (!branch) throw new LocalCloseError(`${key} declares no branch`)
  if (!base) throw new LocalCloseError(`${key} declares no base`)

  const number = issueNumber(key)
  let accessToken
  try {
    accessToken = githubToken ?? (await token())
  } catch (error) {
    throw new LocalCloseError(error instanceof Error ? error.message : 'GitHub token not found', 502)
  }

  let issue
  let pulls
  try {
    const issueResponse = await requestJson(`${API}/repos/${owner}/${repo}/issues/${number}`, {
      token: accessToken,
      signal,
      fetchImpl,
      label: 'GitHub',
    })
    issue = issueResponse.body
    const pullResponse = await requestJson(
      `${API}/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all`,
      { token: accessToken, signal, fetchImpl, label: 'GitHub' },
    )
    pulls = Array.isArray(pullResponse.body) ? pullResponse.body : []
  } catch (error) {
    throw new LocalCloseError(error instanceof Error ? error.message : 'GitHub read failed', 502)
  }

  if (!issue || issue.pull_request) throw new LocalCloseError(`${key} is not an issue on ${owner}/${repo}`)

  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean)
  const inverse = invertMap(project.map)
  const state = onlyKnown(labels, inverse.states)
  if (issue.state === 'closed') {
    throw new LocalCloseError(`${key} is closed, not ready-for-prod`)
  }
  if (state.conflict.length > 0) {
    throw new LocalCloseError(`${key} has conflicting state labels (${state.conflict.join(', ')})`)
  }
  if (state.value !== 'ready-for-prod') {
    throw new LocalCloseError(`${key} is ${state.value ?? 'in an unknown state'}, not ready-for-prod`)
  }

  const candidates = pulls.filter((pull) => pull?.head?.ref === branch)
  if (candidates.length === 0) {
    throw new LocalCloseError(`no pull request for ${branch} into ${base}`)
  }
  const targeted = candidates.filter((pull) => pull?.base?.ref === base)
  if (targeted.length === 0) {
    const bases = [...new Set(candidates.map((pull) => pull?.base?.ref).filter(Boolean))].sort()
    throw new LocalCloseError(`pull request for ${branch} targets ${bases.join(', ') || 'no base'}, not ${base}`)
  }

  const pull = [...targeted].sort((left, right) => (Number(right.number) || 0) - (Number(left.number) || 0))[0]
  if (!pull?.merged_at) {
    throw new LocalCloseError(`pull request #${pull?.number ?? '?'} is not merged`)
  }
  const mergeCommit = pull.merge_commit_sha || pull.head?.sha
  if (!mergeCommit) throw new LocalCloseError(`pull request #${pull?.number ?? '?'} has no merge commit`)

  return {
    state: 'ready-for-prod',
    issue: { number, title: issue.title ?? '', state: issue.state ?? null },
    pull: {
      number: pull.number ?? null,
      url: pull.html_url ?? null,
      mergedAt: pull.merged_at,
      mergeCommit,
      mergeCommitSha: pull.merge_commit_sha ?? null,
      headSha: pull.head?.sha ?? null,
      base: pull.base?.ref ?? null,
    },
  }
}

/**
 * Read the local state and decide what closing would do, without writing.
 *
 * Every read happens here: the clone, the branch, the worktrees and their
 * dirtiness, the ancestry of both the PR's commit and the local branch. A
 * refusal is thrown before `closeLocal` runs a single writing command.
 */
export async function planClose({ key, repo, branch, base, proof, run = execGit, journalPath = null } = {}) {
  if (!repo) throw new LocalCloseError(`${key}: the project declares no local checkout`)
  const root = expandHome(repo)
  if (!branch) throw new LocalCloseError(`${key} declares no branch`)
  if (!base) throw new LocalCloseError(`${key} declares no base`)
  const mergeCommit = mergeCommitOf(proof)
  if (!mergeCommit) throw new LocalCloseError(`${key}: no merge commit to prove`)

  let commonDirText
  try {
    const { stdout } = await git(run, root, ['rev-parse', '--git-common-dir'])
    commonDirText = stdout.trim()
  } catch {
    throw new LocalCloseError(`${root}: not a local checkout`)
  }
  if (!commonDirText) throw new LocalCloseError(`${root}: not a local checkout`)
  const commonDir = isAbsolute(commonDirText) ? commonDirText : resolve(root, commonDirText)

  // The branch may already be gone: closing twice is not an error.
  let tip = null
  try {
    tip = await readRef(run, root, `refs/heads/${branch}`)
  } catch (error) {
    if (error?.code !== 1 && error?.status !== 1) {
      throw new LocalCloseError(`${root}: ${messageOf(error)}`)
    }
  }
  try {
    await readRef(run, root, `origin/${base}`)
  } catch {
    throw new LocalCloseError(`origin/${base} is missing in ${root}`)
  }

  const worktrees = parseWorktreeList((await git(run, root, ['worktree', 'list', '--porcelain'])).stdout, {
    current: root,
  })
  const clone = worktrees.find((worktree) => worktree.path && resolve(worktree.path) === resolve(root))
  if (!clone) throw new LocalCloseError(`${root}: not a local checkout`)

  const foreignBase = worktrees.find(
    (worktree) => worktree.branch === base && resolve(worktree.path) !== resolve(root),
  )
  if (foreignBase) {
    throw new LocalCloseError(`base branch ${base} is checked out in ${foreignBase.path}`)
  }

  const linked = worktrees
    .filter((worktree) => worktree.branch === branch && resolve(worktree.path) !== resolve(root))
    .map((worktree) => worktree.path)

  // The clone is switched to the base, so its own tree must be clean too.
  for (const path of [root, ...linked]) {
    const status = await git(run, path, ['status', '--porcelain'])
    if (String(status.stdout ?? '').trim() !== '') {
      throw new LocalCloseError(`worktree ${path} has uncommitted changes`)
    }
  }

  // The local tip is normally ahead of the PR's head — a squash leaves the
  // branch untouched. Only synchronisation merges may sit in between: anything
  // else is work that never reached the base, and deleting it would lose it.
  if (tip) {
    const prHead = proof?.pull?.headSha ?? null
    if (prHead) {
      if (!(await isAncestor(run, root, prHead, tip))) {
        throw new LocalCloseError(`local branch ${branch} does not contain pull request head ${short(prHead)}`)
      }
      for (const sha of await firstParentRange(run, root, prHead, tip)) {
        const parents = await readParents(run, root, sha)
        const synced = parents.length > 1 && (await allAncestors(run, root, parents.slice(1), `origin/${base}`))
        if (!synced) {
          throw new LocalCloseError(`local commit ${short(sha)} is not on origin/${base}`)
        }
      }
    } else if (!(await isAncestor(run, root, tip, `origin/${base}`))) {
      throw new LocalCloseError(`local commit ${short(tip)} is not on origin/${base}`)
    }
  }

  if (!(await isAncestor(run, root, mergeCommit, `origin/${base}`))) {
    throw new LocalCloseError(`commit ${short(mergeCommit)} is not on origin/${base}`)
  }

  const machetePath = join(commonDir, 'machete')
  let machete = null
  try {
    machete = await readFile(machetePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new LocalCloseError(`${machetePath}: ${error.message}`, 500)
  }

  return {
    key,
    repo: root,
    commonDir,
    branch,
    base,
    tip,
    proof,
    clonePath: root,
    linkedWorktrees: linked,
    machetePath,
    machete,
    journalPath,
  }
}

/**
 * Execute the plan: fetch, remove worktrees, switch the clone, delete the
 * branch, rewrite the machete layout, append the journal section.
 *
 * No `--force` anywhere: a worktree or a branch git refuses to remove stops
 * the gesture with git's own sentence.
 */
export async function closeLocal(plan, { run = execGit, now = new Date(), writeFileImpl = writeFile } = {}) {
  const { repo, branch, base } = plan

  // Refresh the remote-tracking ref before trusting the ancestry again: the
  // plan was read before the network, and the merge proof must still hold.
  await git(run, repo, ['fetch', 'origin', base], { timeout: CLOSE_TIMEOUT_MS })
  const mergeCommit = mergeCommitOf(plan.proof)
  if (!(await isAncestor(run, repo, mergeCommit, `origin/${base}`))) {
    throw new LocalCloseError(`commit ${short(mergeCommit)} is not on origin/${base}`, 502)
  }

  const worktreesRemoved = []
  for (const path of plan.linkedWorktrees) {
    await command(run, repo, ['worktree', 'remove', path])
    worktreesRemoved.push(path)
  }

  // The clone cannot be removed: it is switched back to the base, which also
  // frees the mission branch before it is deleted.
  await command(run, repo, ['checkout', base])
  await command(run, repo, ['merge', '--ff-only', `origin/${base}`])
  const cloneSha = short((await git(run, repo, ['rev-parse', 'HEAD'])).stdout.trim())

  const branchRemoved = Boolean(plan.tip)
  if (branchRemoved) await command(run, repo, ['branch', '-D', branch])

  let macheteUpdated = false
  if (plan.machete !== null) {
    const rewritten = rewriteMachete(plan.machete, branch)
    if (rewritten !== plan.machete) {
      await writeFileImpl(plan.machetePath, rewritten, 'utf8')
      macheteUpdated = true
    }
  }

  let journalPath = null
  if (plan.journalPath) {
    journalPath = String(plan.journalPath)
    await appendJournal(writeFileImpl, journalPath, {
      key: plan.key,
      branch,
      base,
      proof: plan.proof,
      worktreesRemoved,
      branchRemoved,
      cloneSha,
      macheteUpdated,
      machetePresent: plan.machete !== null,
      date: isoDate(now),
    })
  }

  return {
    key: plan.key,
    branch,
    base,
    pr: {
      number: plan.proof.pull?.number ?? null,
      url: plan.proof.pull?.url ?? null,
      mergeCommit: mergeCommitOf(plan.proof),
    },
    worktreesRemoved,
    branchRemoved,
    cloneSha,
    macheteUpdated,
    journalPath,
  }
}

/**
 * Remove one branch from a machete layout, keeping its children.
 *
 * The removed branch's children rise one level — they become its siblings —
 * with their annotations and their own subtree. Every other line is returned
 * untouched, so a branch that is not in the file leaves it identical.
 */
export function rewriteMachete(text, branch) {
  const source = String(text ?? '')
  if (source === '') return source
  const lines = source.split('\n')
  const isBranchLine = (line) => Boolean(line.trim()) && !/^\s*#/.test(line)
  const indentOf = (line) => line.length - line.trimStart().length
  const nameOf = (line) => line.trim().split(/\s+/)[0]

  const removed = lines.findIndex((line) => isBranchLine(line) && nameOf(line) === branch)
  if (removed === -1) return source
  const removedIndent = indentOf(lines[removed])

  // One level is the indent of the removed branch's first child, relative to
  // the branch itself: the file's own step, not a hard-coded two spaces.
  let step = 0
  for (let index = removed + 1; index < lines.length; index += 1) {
    if (!isBranchLine(lines[index])) continue
    const indent = indentOf(lines[index])
    if (indent <= removedIndent) break
    step = indent - removedIndent
    break
  }

  const kept = lines.slice(removed + 1).map((line) => {
    if (!isBranchLine(line)) return line
    const indent = indentOf(line)
    if (indent <= removedIndent) return line
    return line.slice(Math.min(step, indent - removedIndent))
  })

  return [...lines.slice(0, removed), ...kept].join('\n')
}

/** Append the closure section, creating the journal header if the file is new. */
async function appendJournal(writeFileImpl, path, entry) {
  let existing = ''
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new LocalCloseError(`${path}: ${error.message}`, 500)
  }

  let text = existing
  if (text === '') text = `# Journal — ${entry.key}\n`
  if (!text.endsWith('\n')) text += '\n'
  if (!text.endsWith('\n\n')) text += '\n'
  await writeFileImpl(path, `${text}${journalSection(entry)}`, 'utf8')
}

/** The section itself, in the journal's own French and its bullet shape. */
export function journalSection(entry) {
  const { proof, worktreesRemoved = [], branchRemoved, cloneSha, macheteUpdated, machetePresent, date } = entry
  const pull = proof?.pull ?? {}
  const lines = [
    `## ${date} — Clôture`,
    '',
    'Clôture locale du checkout, après merge de la PR.',
    '',
    `- PR : #${pull.number ?? '?'} ${pull.url ?? ''} — merge commit \`${short(mergeCommitOf(proof)) || '?'}\`, base \`${entry.base}\`.`,
    worktreesRemoved.length > 0
      ? `- Worktrees retirés : ${worktreesRemoved.map((path) => `\`${path}\``).join(', ')}.`
      : '- Worktrees retirés : aucun.',
    branchRemoved
      ? `- Branche : \`${entry.branch}\` supprimée (\`git branch -D\`).`
      : `- Branche : \`${entry.branch}\` déjà absente.`,
    `- Clone : passé sur \`${entry.base}\` (\`${cloneSha}\`) par \`checkout\` puis \`merge --ff-only\`.`,
    macheteUpdated
      ? '- Machete : entrée retirée du fichier `.git/machete` ; aucun processus `git machete` lancé.'
      : machetePresent
        ? '- Machete : la branche n’y figurait pas, fichier inchangé.'
        : '- Machete : pas de fichier `.git/machete`, rien à réécrire.',
    '- Tracker : lecture seule, aucun écrit.',
    '',
  ]
  return lines.join('\n')
}

/** The merge commit of a proof, whichever shape it was read in. */
function mergeCommitOf(proof) {
  return proof?.pull?.mergeCommit ?? proof?.mergeCommit ?? null
}

function expandHome(value) {
  const text = String(value ?? '')
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

function git(run, dir, args, options) {
  return run('git', ['-C', dir, ...args], options)
}

async function command(run, dir, args) {
  try {
    return await git(run, dir, args)
  } catch (error) {
    throw new LocalCloseError(messageOf(error), 502)
  }
}

async function readRef(run, dir, ref) {
  const { stdout } = await git(run, dir, ['rev-parse', '--verify', '--quiet', ref])
  return stdout.trim()
}

async function isAncestor(run, dir, sha, ref) {
  try {
    await git(run, dir, ['merge-base', '--is-ancestor', sha, ref])
    return true
  } catch (error) {
    // 1 is git's ordinary answer for "no"; anything else is a real failure.
    if (error?.code === 1 || error?.status === 1) return false
    throw error
  }
}

/** Every one of `shas` must be an ancestor of `ref`. */
async function allAncestors(run, dir, shas, ref) {
  for (const sha of shas) {
    if (!(await isAncestor(run, dir, sha, ref))) return false
  }
  return true
}

/** The first-parent commits of `tip` that are not reachable from `from`. */
async function firstParentRange(run, dir, from, tip) {
  const { stdout } = await git(run, dir, ['rev-list', '--first-parent', `${from}..${tip}`])
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function readParents(run, dir, sha) {
  const { stdout } = await git(run, dir, ['rev-list', '--parents', '-n', '1', sha])
  return stdout.trim().split(/\s+/).slice(1).filter(Boolean)
}

function isoDate(now) {
  return new Date(now).toISOString().slice(0, 10)
}

function short(sha) {
  return String(sha ?? '').slice(0, 7)
}

function messageOf(error) {
  const text = String(error?.stderr ?? error?.message ?? error ?? '').trim()
  const last = text.split('\n').filter(Boolean).at(-1) ?? text
  return last.replace(/^fatal:\s*/, '')
}
