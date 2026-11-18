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
 * The proof is a pull request, merged into its declared base, whose merge
 * commit (or head commit) is an ancestor of `origin/<base>` — for a mission
 * split into several PRs, every pair's PR must have reached the mission's base.
 * Everything the plan needs is read first; a refusal therefore reaches the
 * client before any writing command runs.
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
 * Every read happens here: the clone, each declared pair's branch, the
 * worktrees and their dirtiness, the ancestry of every PR's commit and every
 * local branch. A split mission proves each pair and checks each merge commit
 * against the mission's base; a single pair is the same list of one. A refusal
 * is thrown before `closeLocal` runs a single writing command.
 */
export async function planClose({ key, repo, branch, base, proof, pairs = null, run = execGit, journalPath = null } = {}) {
  if (!repo) throw new LocalCloseError(`${key}: the project declares no local checkout`)
  const root = expandHome(repo)
  const declared = declaredPairs({ key, branch, base, proof, pairs })
  const several = declared.length > 1
  const missionBase = declared[0].base

  // A split mission names the pair in every refusal and checks every merge
  // commit against the mission's base; a single pair keeps its old sentences.
  const refuse = (pair, message) => {
    throw new LocalCloseError(several ? `${key} (${pair.branch} sur ${pair.base}): ${message}` : message)
  }

  let commonDirText
  try {
    const { stdout } = await git(run, root, ['rev-parse', '--git-common-dir'])
    commonDirText = stdout.trim()
  } catch {
    throw new LocalCloseError(`${root}: not a local checkout`)
  }
  if (!commonDirText) throw new LocalCloseError(`${root}: not a local checkout`)
  const commonDir = isAbsolute(commonDirText) ? commonDirText : resolve(root, commonDirText)

  try {
    await readRef(run, root, `origin/${missionBase}`)
  } catch {
    throw new LocalCloseError(`origin/${missionBase} is missing in ${root}`)
  }

  const worktrees = parseWorktreeList((await git(run, root, ['worktree', 'list', '--porcelain'])).stdout, {
    current: root,
  })
  const clone = worktrees.find((worktree) => worktree.path && resolve(worktree.path) === resolve(root))
  if (!clone) throw new LocalCloseError(`${root}: not a local checkout`)

  const foreignBase = worktrees.find(
    (worktree) => worktree.branch === missionBase && resolve(worktree.path) !== resolve(root),
  )
  if (foreignBase) {
    throw new LocalCloseError(`base branch ${missionBase} is checked out in ${foreignBase.path}`)
  }

  const planned = declared.map((pair) => ({
    ...pair,
    // The branch may already be gone: closing twice is not an error.
    tip: null,
    linkedWorktrees: worktrees
      .filter((worktree) => worktree.branch === pair.branch && resolve(worktree.path) !== resolve(root))
      .map((worktree) => worktree.path),
  }))

  // The clone is switched to the base, so its own tree must be clean too.
  for (const path of [root, ...planned.flatMap((pair) => pair.linkedWorktrees)]) {
    const status = await git(run, path, ['status', '--porcelain'])
    if (String(status.stdout ?? '').trim() !== '') {
      throw new LocalCloseError(`worktree ${path} has uncommitted changes`)
    }
  }

  for (const pair of planned) {
    try {
      pair.tip = await readRef(run, root, `refs/heads/${pair.branch}`)
    } catch (error) {
      if (error?.code !== 1 && error?.status !== 1) refuse(pair, `${root}: ${messageOf(error)}`)
    }

    if (!pair.tip) continue
    // The local tip is normally ahead of the PR's head — a squash leaves the
    // branch untouched. Only synchronisation merges may sit in between:
    // anything else is work that never reached the base.
    const prHead = pair.proof?.pull?.headSha ?? null
    if (prHead) {
      if (!(await isAncestor(run, root, prHead, pair.tip))) {
        refuse(pair, `local branch ${pair.branch} does not contain pull request head ${short(prHead)}`)
      }
      for (const sha of await firstParentRange(run, root, prHead, pair.tip)) {
        const parents = await readParents(run, root, sha)
        const synced = parents.length > 1 && (await allAncestors(run, root, parents.slice(1), `origin/${missionBase}`))
        if (!synced) {
          refuse(pair, `local commit ${short(sha)} is not on origin/${missionBase}`)
        }
      }
    } else if (!(await isAncestor(run, root, pair.tip, `origin/${missionBase}`))) {
      refuse(pair, `local commit ${short(pair.tip)} is not on origin/${missionBase}`)
    }
  }

  // Every pull request's merge commit must have reached the mission's base —
  // the first declared pair's base — whatever the pair's own target was.
  for (const pair of planned) {
    const mergeCommit = mergeCommitOf(pair.proof)
    if (!(await isAncestor(run, root, mergeCommit, `origin/${missionBase}`))) {
      refuse(pair, `commit ${short(mergeCommit)} is not on origin/${missionBase}`)
    }
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
    branch: planned[0].branch,
    base: missionBase,
    tip: planned[0].tip,
    proof: planned[0].proof,
    clonePath: root,
    linkedWorktrees: [...new Set(planned.flatMap((pair) => pair.linkedWorktrees))],
    pairs: planned.map((pair) => ({
      branch: pair.branch,
      base: pair.base,
      tip: pair.tip,
      proof: pair.proof,
      linkedWorktrees: pair.linkedWorktrees,
    })),
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
  const { repo, base } = plan
  const declared = Array.isArray(plan.pairs) && plan.pairs.length > 0
    ? plan.pairs
    : [{ branch: plan.branch, base, tip: plan.tip, proof: plan.proof, linkedWorktrees: plan.linkedWorktrees ?? [] }]
  const several = declared.length > 1

  // Refresh the remote-tracking ref before trusting the ancestry again: the
  // plan was read before the network, and every merge proof must still hold.
  await git(run, repo, ['fetch', 'origin', base], { timeout: CLOSE_TIMEOUT_MS })
  for (const pair of declared) {
    const mergeCommit = mergeCommitOf(pair.proof)
    if (!(await isAncestor(run, repo, mergeCommit, `origin/${base}`))) {
      const message = `commit ${short(mergeCommit)} is not on origin/${base}`
      throw new LocalCloseError(several ? `${plan.key} (${pair.branch} sur ${pair.base}): ${message}` : message, 502)
    }
  }

  const worktreesRemoved = []
  for (const pair of declared) {
    for (const path of pair.linkedWorktrees ?? []) {
      await command(run, repo, ['worktree', 'remove', path])
      worktreesRemoved.push(path)
    }
  }

  // The clone cannot be removed: it is switched back to the base, which also
  // frees the mission's branches before they are deleted.
  await command(run, repo, ['checkout', base])
  await command(run, repo, ['merge', '--ff-only', `origin/${base}`])
  const cloneSha = short((await git(run, repo, ['rev-parse', 'HEAD'])).stdout.trim())

  const branchesRemoved = []
  for (const pair of declared) {
    if (!pair.tip) continue
    await command(run, repo, ['branch', '-D', pair.branch])
    branchesRemoved.push(pair.branch)
  }

  let macheteUpdated = false
  if (plan.machete !== null) {
    const rewritten = rewriteMachete(plan.machete, declared.map((pair) => pair.branch))
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
      branch: plan.branch,
      base,
      proof: plan.proof,
      pairs: declared.map((pair) => ({
        branch: pair.branch,
        base: pair.base,
        proof: pair.proof,
        branchRemoved: Boolean(pair.tip),
      })),
      worktreesRemoved,
      cloneSha,
      macheteUpdated,
      machetePresent: plan.machete !== null,
      date: isoDate(now),
    })
  }

  const first = declared[0]
  return {
    key: plan.key,
    branch: first.branch,
    base,
    pr: {
      number: first.proof?.pull?.number ?? null,
      url: first.proof?.pull?.url ?? null,
      mergeCommit: mergeCommitOf(first.proof),
    },
    pulls: declared.map((pair) => ({
      number: pair.proof?.pull?.number ?? null,
      url: pair.proof?.pull?.url ?? null,
      mergeCommit: mergeCommitOf(pair.proof),
      branch: pair.branch,
      base: pair.base,
    })),
    worktreesRemoved,
    branchesRemoved,
    branchRemoved: branchesRemoved.length > 0,
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
  const sources = String(text ?? '')
  if (sources === '') return sources
  const names = Array.isArray(branch) ? branch.filter(Boolean) : [branch]
  return names.reduce((source, name) => removeMacheteBranch(source, name), sources)
}

/** Remove one branch line from a machete layout; its children rise one level. */
function removeMacheteBranch(text, branch) {
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
  const pairs = Array.isArray(entry.pairs) && entry.pairs.length > 0
    ? entry.pairs
    : [{ branch: entry.branch, base: entry.base, proof, branchRemoved }]
  const branchBullet = (pair) => (
    pair.branchRemoved
      ? `- Branche : \`${pair.branch}\` supprimée (\`git branch -D\`).`
      : `- Branche : \`${pair.branch}\` déjà absente.`
  )
  const lines = [
    `## ${date} — Clôture`,
    '',
    'Clôture locale du checkout, après merge de la PR.',
    '',
    ...pairs.map((pair) => {
      const pull = pair.proof?.pull ?? {}
      return `- PR : #${pull.number ?? '?'} ${pull.url ?? ''} — merge commit \`${short(mergeCommitOf(pair.proof)) || '?'}\`, base \`${pair.base}\`.`
    }),
    worktreesRemoved.length > 0
      ? `- Worktrees retirés : ${worktreesRemoved.map((path) => `\`${path}\``).join(', ')}.`
      : '- Worktrees retirés : aucun.',
    ...pairs.map(branchBullet),
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

/** The pairs a close proves: the declared list, or the single legacy pair. */
function declaredPairs({ key, branch, base, proof, pairs }) {
  const listed = Array.isArray(pairs) && pairs.length > 0 ? pairs : null
  if (!listed) {
    if (!branch) throw new LocalCloseError(`${key} declares no branch`)
    if (!base) throw new LocalCloseError(`${key} declares no base`)
    if (!mergeCommitOf(proof)) throw new LocalCloseError(`${key}: no merge commit to prove`)
    return [{ branch, base, proof }]
  }
  return listed.map((pair) => {
    if (!pair?.branch) throw new LocalCloseError(`${key} (${pair?.base ?? '?'}): a pair declares no branch`)
    if (!pair?.base) throw new LocalCloseError(`${key} (${pair.branch}): a pair declares no base`)
    if (!mergeCommitOf(pair.proof)) {
      throw new LocalCloseError(`${key} (${pair.branch} sur ${pair.base}): no merge commit to prove`)
    }
    return { branch: pair.branch, base: pair.base, proof: pair.proof }
  })
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
