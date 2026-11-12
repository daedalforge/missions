import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CLOSE_TIMEOUT_MS,
  LocalCloseError,
  closeLocal,
  issueNumber,
  journalSection,
  planClose,
  readProof,
  rewriteMachete,
} from '../lib/local-close.js'

const SHA = {
  tip: 'a'.repeat(40),
  base: 'b'.repeat(40),
  merge: 'c'.repeat(40),
  sync: 'd'.repeat(40),
  head: 'e'.repeat(40),
}

const PROJECT = {
  id: 'missions',
  name: 'Missions',
  reference: 'MIS',
  repo: '/repo',
  github: { owner: 'daedalforge', repo: 'missions' },
  map: {
    states: {
      'to-refine': 'to-refine',
      ready: 'ready',
      'in-progress': 'in-progress',
      'in-review': 'in-review',
      'ready-for-prod': 'ready-for-prod',
    },
    types: { bug: 'Bug', story: 'Feature' },
    priorities: { high: 'priority:high' },
  },
}

function issue({ labels = ['ready-for-prod'], state = 'open' } = {}) {
  return { number: 42, title: 'Cloturer proprement le local', state, labels: labels.map((name) => ({ name })) }
}

function pull({ base = 'main', merged = '2026-11-12T10:00:00Z', number = 7 } = {}) {
  return {
    number,
    html_url: `https://github.com/daedalforge/missions/pull/${number}`,
    merged_at: merged,
    merge_commit_sha: SHA.merge,
    head: { ref: 'feat/mis-42', sha: SHA.head },
    base: { ref: base },
  }
}

function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  }
}

/** A `fetch` that answers the issue route and the pulls route, and counts. */
function tracker({ issueBody, pullBody, status = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' })
    return reply(url.includes('/pulls') ? pullBody : issueBody, status)
  }
  return { fetchImpl, calls }
}

function proofOptions(overrides = {}) {
  return {
    project: PROJECT,
    key: 'MIS-42',
    branch: 'feat/mis-42',
    base: 'main',
    fetchImpl: tracker({ issueBody: issue(), pullBody: [pull()] }).fetchImpl,
    githubToken: 'test-token',
    ...overrides,
  }
}

/** A `git` runner answering a table, recording every command. */
function createRun(table = {}) {
  const calls = []
  const run = async (file, args, options = {}) => {
    const at = args.indexOf('-C')
    const dir = at === -1 ? '' : args[at + 1]
    const command = args.slice(at === -1 ? 0 : at + 2).join(' ')
    calls.push({ file, dir, command, options })
    const answer = table[`${dir} :: ${command}`] ?? table[command]
    if (answer === undefined) {
      throw Object.assign(new Error(`unexpected command: ${command} in ${dir || '(none)'}`), {
        code: 128,
        stderr: `fatal: unexpected command: ${command}`,
      })
    }
    const value = typeof answer === 'function' ? await answer({ dir, command, calls }) : answer
    if (value instanceof Error) throw value
    return { stdout: String(value ?? ''), stderr: '' }
  }
  return { run, calls }
}

function notAncestor() {
  return Object.assign(new Error('git merge-base exited with 1'), { code: 1 })
}

function planTable(overrides = {}) {
  return {
    'rev-parse --git-common-dir': '.git',
    'rev-parse --verify --quiet refs/heads/feat/mis-42': SHA.tip,
    'rev-parse --verify --quiet origin/main': SHA.base,
    'worktree list --porcelain': [
      'worktree /repo',
      `HEAD ${SHA.tip}`,
      'branch refs/heads/feat/mis-42',
      '',
      'worktree /wt/mis-42',
      `HEAD ${SHA.tip}`,
      'branch refs/heads/feat/mis-42',
      '',
    ].join('\n'),
    '/repo :: status --porcelain': '',
    '/wt/mis-42 :: status --porcelain': '',
    [`merge-base --is-ancestor ${SHA.tip} origin/main`]: '',
    [`merge-base --is-ancestor ${SHA.merge} origin/main`]: '',
    ...overrides,
  }
}

const PROOF = {
  state: 'ready-for-prod',
  issue: { number: 42, title: 'Cloturer proprement le local', state: 'open' },
  pull: {
    number: 7,
    url: 'https://github.com/daedalforge/missions/pull/7',
    mergedAt: '2026-11-12T10:00:00Z',
    mergeCommit: SHA.merge,
    mergeCommitSha: SHA.merge,
    headSha: SHA.head,
    base: 'main',
  },
}

test('issueNumber reads the number a key ends with', () => {
  assert.equal(issueNumber('MIS-136'), 136)
  assert.throws(() => issueNumber('MIS'), { name: 'LocalCloseError', message: /no issue number/ })
})

test('readProof asks the tracker twice, in GET, and returns the merged pull', async () => {
  const { fetchImpl, calls } = tracker({ issueBody: issue(), pullBody: [pull()] })
  const proof = await readProof({ ...proofOptions(), fetchImpl })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET'])
  assert.match(calls[0].url, /\/repos\/daedalforge\/missions\/issues\/42$/)
  assert.match(calls[1].url, /\/pulls\?head=daedalforge:feat%2Fmis-42&state=all$/)
  assert.equal(proof.state, 'ready-for-prod')
  assert.equal(proof.pull.number, 7)
  assert.equal(proof.pull.mergeCommit, SHA.merge)
  assert.equal(proof.pull.base, 'main')
})

test('readProof refuses every state that is not ready-for-prod', async () => {
  const cases = [
    [{ issueBody: issue({ labels: ['ready'] }), pullBody: [pull()] }, /is ready, not ready-for-prod/],
    [{ issueBody: issue({ labels: ['ready', 'in-review'] }), pullBody: [pull()] }, /conflicting state labels/],
    [{ issueBody: issue({ state: 'closed' }), pullBody: [pull()] }, /is closed, not ready-for-prod/],
    [{ issueBody: issue(), pullBody: [] }, /no pull request for feat\/mis-42 into main/],
    [{ issueBody: issue(), pullBody: [pull({ base: 'develop' })] }, /targets develop, not main/],
    [{ issueBody: issue(), pullBody: [pull({ merged: null })] }, /pull request #7 is not merged/],
  ]

  for (const [answer, message] of cases) {
    const { fetchImpl } = tracker(answer)
    await assert.rejects(readProof({ ...proofOptions(), fetchImpl }), (error) => {
      assert.ok(error instanceof LocalCloseError)
      assert.equal(error.status, 409)
      assert.match(error.message, message)
      return true
    })
  }
})

test('readProof refuses an issue that is not an issue, or a tracker that fails', async () => {
  const notIssue = tracker({ issueBody: { pull_request: {} }, pullBody: [pull()] }).fetchImpl
  await assert.rejects(readProof({ ...proofOptions(), fetchImpl: notIssue }), { status: 409 })

  const down = async () => {
    throw new Error('network down')
  }
  await assert.rejects(readProof({ ...proofOptions(), fetchImpl: down }), {
    status: 502,
    message: /network down/,
  })
  await assert.rejects(readProof({ ...proofOptions(), project: { id: 'x' } }), { status: 409 })
})

test('planClose reads the clone and finds nothing to write', async () => {
  const { run, calls } = createRun(planTable())
  const plan = await planClose({
    key: 'MIS-42',
    repo: '/repo',
    branch: 'feat/mis-42',
    base: 'main',
    proof: PROOF,
    run,
    journalPath: '/repo/missions/MIS-42/journal.md',
  })

  assert.equal(plan.tip, SHA.tip)
  assert.deepEqual(plan.linkedWorktrees, ['/wt/mis-42'])
  const writing = calls.filter((call) => /^(fetch |worktree remove |checkout |merge |branch |push |reset |clean )/.test(call.command))
  assert.deepEqual(writing, [])
})

test('planClose refuses before any write when the checkout is not one', async () => {
  const { run } = createRun({ 'rev-parse --git-common-dir': Object.assign(new Error('boom'), { stderr: 'fatal: no' }) })
  await assert.rejects(
    planClose({ key: 'MIS-42', repo: '/repo', branch: 'feat/mis-42', base: 'main', proof: PROOF, run }),
    { status: 409, message: /not a local checkout/ },
  )
  await assert.rejects(
    planClose({ key: 'MIS-42', repo: null, branch: 'feat/mis-42', base: 'main', proof: PROOF, run }),
    { status: 409, message: /no local checkout/ },
  )
})

test('planClose refuses a dirty worktree, and the base checked out elsewhere', async () => {
  const dirty = createRun(planTable({ '/wt/mis-42 :: status --porcelain': ' M src/app.js\n' }))
  await assert.rejects(
    planClose({ key: 'MIS-42', repo: '/repo', branch: 'feat/mis-42', base: 'main', proof: PROOF, run: dirty.run }),
    { status: 409, message: /worktree \/wt\/mis-42 has uncommitted changes/ },
  )

  const cloned = createRun(
    planTable({
      'worktree list --porcelain': [
        'worktree /repo',
        `HEAD ${SHA.tip}`,
        'branch refs/heads/feat/mis-42',
        '',
        'worktree /wt/main',
        `HEAD ${SHA.base}`,
        'branch refs/heads/main',
        '',
      ].join('\n'),
    }),
  )
  await assert.rejects(
    planClose({ key: 'MIS-42', repo: '/repo', branch: 'feat/mis-42', base: 'main', proof: PROOF, run: cloned.run }),
    { status: 409, message: /base branch main is checked out in \/wt\/main/ },
  )
})

test('planClose accepts a local sync merge, refuses a work commit', async () => {
  const syncTable = planTable({
    [`merge-base --is-ancestor ${SHA.tip} origin/main`]: notAncestor(),
    [`rev-list --parents -n 1 ${SHA.tip}`]: `${SHA.tip} ${SHA.base} ${SHA.sync}`,
    [`merge-base --is-ancestor ${SHA.sync} origin/main`]: '',
  })
  const sync = await planClose({
    key: 'MIS-42',
    repo: '/repo',
    branch: 'feat/mis-42',
    base: 'main',
    proof: PROOF,
    run: createRun(syncTable).run,
  })
  assert.equal(sync.tip, SHA.tip)

  const workTable = planTable({
    [`merge-base --is-ancestor ${SHA.tip} origin/main`]: notAncestor(),
    [`rev-list --parents -n 1 ${SHA.tip}`]: `${SHA.tip} ${SHA.sync}`,
    [`merge-base --is-ancestor ${SHA.sync} origin/main`]: notAncestor(),
  })
  await assert.rejects(
    planClose({
      key: 'MIS-42',
      repo: '/repo',
      branch: 'feat/mis-42',
      base: 'main',
      proof: PROOF,
      run: createRun(workTable).run,
    }),
    { status: 409, message: /local commit aaaaaaa is not on origin\/main/ },
  )
  // The proof's commit must be on the base too: a merge commit the branch has
  // but the base does not is not a delivery.
  const absent = planTable({ [`merge-base --is-ancestor ${SHA.merge} origin/main`]: notAncestor() })
  await assert.rejects(
    planClose({
      key: 'MIS-42',
      repo: '/repo',
      branch: 'feat/mis-42',
      base: 'main',
      proof: PROOF,
      run: createRun(absent).run,
    }),
    { status: 409, message: /commit ccccccc is not on origin\/main/ },
  )
})

test('planClose accepts an already deleted branch and an absent machete', async () => {
  const table = planTable({
    'rev-parse --verify --quiet refs/heads/feat/mis-42': notAncestor(),
    'worktree list --porcelain': `worktree /repo\nHEAD ${SHA.base}\nbranch refs/heads/main\n`,
    '/repo :: status --porcelain': '',
  })
  const plan = await planClose({
    key: 'MIS-42',
    repo: '/repo',
    branch: 'feat/mis-42',
    base: 'main',
    proof: PROOF,
    run: createRun(table).run,
    journalPath: '/repo/missions/MIS-42/journal.md',
  })
  assert.equal(plan.tip, null)
  assert.equal(plan.machete, null)
})

test('closeLocal runs the writes in order, then rewrites machete and journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'missions-close-'))
  const machetePath = join(dir, 'machete')
  const journalPath = join(dir, 'MIS-42', 'journal.md')
  await writeFile(machetePath, 'main\n  feat/mis-42\n    fix/one\n  feat/other\n')
  await mkdir(join(dir, 'MIS-42'))

  const { run, calls } = createRun({
    'fetch origin main': '',
    [`merge-base --is-ancestor ${SHA.merge} origin/main`]: '',
    'worktree remove /wt/mis-42': '',
    'checkout main': '',
    'merge --ff-only origin/main': '',
    'rev-parse HEAD': `${SHA.base}\n`,
    'branch -D feat/mis-42': '',
  })

  const result = await closeLocal(
    {
      key: 'MIS-42',
      repo: '/repo',
      commonDir: '/repo/.git',
      branch: 'feat/mis-42',
      base: 'main',
      tip: SHA.tip,
      proof: PROOF,
      clonePath: '/repo',
      linkedWorktrees: ['/wt/mis-42'],
      machetePath,
      machete: 'main\n  feat/mis-42\n    fix/one\n  feat/other\n',
      journalPath,
    },
    { run, now: new Date('2026-11-12T15:00:00Z') },
  )

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      'fetch origin main',
      `merge-base --is-ancestor ${SHA.merge} origin/main`,
      'worktree remove /wt/mis-42',
      'checkout main',
      'merge --ff-only origin/main',
      'rev-parse HEAD',
      'branch -D feat/mis-42',
    ],
  )
  assert.deepEqual(calls[0].options, { timeout: CLOSE_TIMEOUT_MS })
  assert.equal(await readFile(machetePath, 'utf8'), 'main\n  fix/one\n  feat/other\n')

  const journal = await readFile(journalPath, 'utf8')
  assert.match(journal, /^# Journal — MIS-42/)
  assert.match(journal, /## 2026-11-12 — Clôture/)
  assert.match(journal, /PR : #7/)
  assert.match(journal, /`feat\/mis-42` supprimée/)
  assert.match(journal, /`main` \(`bbbbbbb`\)/)

  assert.equal(result.branchRemoved, true)
  assert.equal(result.worktreesRemoved.length, 1)
  assert.equal(result.cloneSha, 'bbbbbbb')
  assert.equal(result.macheteUpdated, true)
})

test('closeLocal appends to an existing journal without rewriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'missions-close-'))
  const journalPath = join(dir, 'journal.md')
  const before = '# Journal — MIS-42\n\n## 2026-11-01 — Cadrage\n\n- fait\n'
  await writeFile(journalPath, before)

  const { run } = createRun({
    'fetch origin main': '',
    [`merge-base --is-ancestor ${SHA.merge} origin/main`]: '',
    'checkout main': '',
    'merge --ff-only origin/main': '',
    'rev-parse HEAD': SHA.base,
    'branch -D feat/mis-42': '',
  })
  await closeLocal(
    {
      key: 'MIS-42',
      repo: '/repo',
      branch: 'feat/mis-42',
      base: 'main',
      tip: SHA.tip,
      proof: PROOF,
      linkedWorktrees: [],
      machetePath: join(dir, 'machete'),
      machete: null,
      journalPath,
    },
    { run, now: new Date('2026-11-12T15:00:00Z') },
  )
  const after = await readFile(journalPath, 'utf8')
  assert.ok(after.startsWith(before))
  assert.equal(after.match(/^## .* — Clôture$/gm).length, 1)
})

test('closeLocal refetches and refuses when the merge proof left the base', async () => {
  const { run, calls } = createRun({
    'fetch origin main': '',
    [`merge-base --is-ancestor ${SHA.merge} origin/main`]: notAncestor(),
  })
  await assert.rejects(
    closeLocal(
      {
        key: 'MIS-42',
        repo: '/repo',
        branch: 'feat/mis-42',
        base: 'main',
        tip: SHA.tip,
        proof: PROOF,
        linkedWorktrees: ['/wt/mis-42'],
        machetePath: '/repo/.git/machete',
        machete: null,
        journalPath: null,
      },
      { run },
    ),
    { status: 502, message: /not on origin\/main/ },
  )
  assert.deepEqual(calls.map((call) => call.command).slice(1), [`merge-base --is-ancestor ${SHA.merge} origin/main`])
})

test('rewriteMachete removes one line and lifts its children with annotations', () => {
  const before = [
    'main',
    '  feat/mis-42',
    '    fix/one',
    '    fix/two  annotation',
    '      fix/two-deep',
    '  feat/other keep me',
    '',
  ].join('\n')
  assert.equal(
    rewriteMachete(before, 'feat/mis-42'),
    ['main', '  fix/one', '  fix/two  annotation', '    fix/two-deep', '  feat/other keep me', ''].join('\n'),
  )
  // A branch that is not in the layout leaves the file identical.
  assert.equal(rewriteMachete(before, 'feat/absent'), before)
  assert.equal(rewriteMachete('', 'feat/mis-42'), '')
})

test('journalSection names the proof and the gestures', () => {
  const section = journalSection({
    key: 'MIS-42',
    branch: 'feat/mis-42',
    base: 'main',
    proof: PROOF,
    worktreesRemoved: ['/wt/mis-42'],
    branchRemoved: true,
    cloneSha: 'bbbbbbb',
    macheteUpdated: true,
    machetePresent: true,
    date: '2026-11-12',
  })
  assert.match(section, /^## 2026-11-12 — Clôture/)
  assert.match(section, /merge commit `ccccccc`/)
  assert.match(section, /Worktrees retirés : `\/wt\/mis-42`/)
  assert.match(section, /aucun processus `git machete` lancé/)
  assert.match(section, /Tracker : lecture seule/)
})
