import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  GIT_TIMEOUT_MS,
  SCAN_CONCURRENCY,
  isValidRepositoryName,
  listRepositories,
  parseLog,
  parseStatus,
  readRepository,
  readRepositoryNames,
} from '../lib/repositories.js'

/**
 * Le scan du dossier de travail, sans jamais lancer git.
 *
 * Chaque test passe son propre lanceur : il voit exactement les commandes que
 * le module voulait lancer, et répond comme git l'aurait fait. Un test qui
 * toucherait un vrai dépôt serait un test qui dépend de la machine.
 */

/** Un dossier racine jetable, avec les entrées demandées. */
async function root(t, entries) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-repos-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.kind === 'file') {
      await writeFile(path, '')
      continue
    }
    await mkdir(path, { recursive: true })
    if (entry.git === 'dir') await mkdir(join(path, '.git'), { recursive: true })
    if (entry.git === 'file') await writeFile(join(path, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
  }
  return dir
}

/**
 * Un lanceur qui répond par une table. La clé est `<nom du dépôt> <commande>` :
 * le test écrit ce que git aurait répondu, ligne pour ligne.
 */
function fauxGit(answers = {}, { delay = 0 } = {}) {
  const calls = []
  let active = 0
  let peak = 0
  const run = async (file, args, options) => {
    assert.equal(file, 'git', 'le lanceur ne lance que git')
    assert.ok(Array.isArray(args), 'les arguments sont une liste, jamais une ligne de shell')
    const at = args.indexOf('-C')
    assert.ok(at >= 0, 'chaque commande porte son -C')
    const dir = args[at + 1]
    const name = dir.split('/').pop()
    const command = args.slice(at + 2).join(' ')
    calls.push({ name, command, dir, options })

    active += 1
    peak = Math.max(peak, active)
    try {
      if (delay > 0) await new Promise((done) => setTimeout(done, delay))
      const answer = answers[`${name} ${command}`]
      if (answer === undefined) throw Object.assign(new Error(`commande imprévue : ${name} ${command}`), { stderr: '' })
      if (answer instanceof Error) throw Object.assign(answer, { stderr: answer.stderr ?? answer.message })
      return { stdout: answer, stderr: '' }
    } finally {
      active -= 1
    }
  }
  return { run, calls, peak: () => peak }
}

const STATUS_CLEAN = [
  '# branch.oid 1a2b3c4d',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +0 -0',
].join('\n')

const STATUS_BUSY = [
  '# branch.oid 1a2b3c4d',
  '# branch.head feat/mis-116',
  '# branch.upstream origin/feat/mis-116',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/index.js',
  '1 .M N... 100644 100644 100644 ccc ddd src/client.template.js',
].join('\n')

const log = (...lines) => lines.join('\n')
const commit = (hash, at, subject) => `${hash}\x1f${at}\x1f${subject}`

test('le scan ne retient que les enfants directs qui portent un .git', async (t) => {
  // Un dossier sans `.git` n'est pas un dépôt, un enfant cacheté non plus, et
  // un dépôt imbriqué est un dossier de son propriétaire, pas un dépôt de la
  // racine : le scan ne descend jamais.
  const dir = await root(t, [
    { name: 'alpha', git: 'dir' },
    { name: 'beta', git: 'file' },
    { name: 'plain' },
    { name: '.cache', git: 'dir' },
    { name: 'notes.txt', kind: 'file' },
  ])
  await mkdir(join(dir, 'alpha', 'nested', '.git'), { recursive: true })

  assert.deepEqual(await readRepositoryNames(dir), [
    { name: 'alpha', kind: 'clone' },
    { name: 'beta', kind: 'worktree' },
  ], 'un clone et un worktree, dans l’ordre des noms')

  const { run, calls } = fauxGit({
    'alpha status --porcelain=v2 --branch': STATUS_CLEAN,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('a1b2c3d', 1794468058, 'MIS-114: la liste'),
    'beta status --porcelain=v2 --branch': STATUS_BUSY,
    'beta log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('d4e5f6a', 1794000000, 'gh-20: le survol'),
  })
  const scan = await listRepositories(dir, { run })

  assert.equal(scan.count, 2)
  assert.equal(scan.root, dir)
  assert.equal(scan.errors.length, 0)
  assert.ok(Number.isFinite(scan.durationMs) && scan.durationMs >= 0)
  // Deux appels par dépôt : le statut, puis le dernier commit.
  assert.equal(calls.length, 4)
  assert.ok(calls.every((call) => call.options?.timeout === GIT_TIMEOUT_MS))

  const beta = scan.repositories.find((row) => row.name === 'beta')
  assert.equal(beta.kind, 'worktree')
  assert.equal(beta.branch, 'feat/mis-116')
  assert.equal(beta.upstream, 'origin/feat/mis-116')
  assert.equal(beta.ahead, 2)
  assert.equal(beta.behind, 1)
  assert.equal(beta.dirty, 2)
  assert.equal(beta.error, null)

  // Le plus récent d'abord : c'est l'ordre que le widget annonce.
  assert.deepEqual(scan.repositories.map((row) => row.name), ['alpha', 'beta'])
})

test('la ligne porte exactement les champs nommés par la fiche', async (t) => {
  // La fiche promet `name`, `path`, `branch`, `dirty`, `lastCommit`
  // (`sha`, `subject`, `date`) : un renommage silencieux casserait le client
  // sans qu'aucun autre test ne bouge. Ce test tient le contrat de la route.
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run } = fauxGit({
    'alpha status --porcelain=v2 --branch': STATUS_CLEAN,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('a1b2c3d', 1794468058, 'MIS-114: la liste'),
  })
  const [row] = (await listRepositories(dir, { run })).repositories

  assert.deepEqual(Object.keys(row).sort(), [
    'ahead', 'behind', 'branch', 'detached', 'dirty', 'error', 'head', 'kind', 'lastCommit', 'name', 'path', 'upstream',
  ])
  assert.deepEqual(Object.keys(row.lastCommit).sort(), ['date', 'sha', 'subject'])
  assert.equal(row.lastCommit.sha, 'a1b2c3d')
  assert.equal(row.lastCommit.date, 1794468058 * 1000, 'la date est l’instant du commit, en millisecondes')
  assert.equal(row.lastCommit.subject, 'MIS-114: la liste')
})

test('un dépôt que git refuse est une ligne, pas un scan raté', async (t) => {
  const dir = await root(t, [
    { name: 'alpha', git: 'dir' },
    { name: 'beta', git: 'dir' },
  ])
  const { run } = fauxGit({
    'alpha status --porcelain=v2 --branch': Object.assign(new Error('refus'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }),
    'beta status --porcelain=v2 --branch': STATUS_CLEAN,
    'beta log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('a1b2c3d', 1794468058, 'MIS-114: la liste'),
  })
  const scan = await listRepositories(dir, { run })

  assert.equal(scan.count, 2, 'les deux dépôts restent listés')
  assert.deepEqual(scan.errors.map((row) => row.name), ['alpha'])
  assert.equal(scan.errors[0].message, 'not a git repository (or any of the parent directories): .git')
  const alpha = scan.repositories.find((row) => row.name === 'alpha')
  assert.equal(alpha.error, 'not a git repository (or any of the parent directories): .git')
  assert.equal(alpha.lastCommit, null)

  // En fin de liste : une ligne sans commit n'a pas de date à annoncer.
  assert.deepEqual(scan.repositories.map((row) => row.name), ['beta', 'alpha'])
})

test('un dépôt sans commit n’est pas une erreur', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run } = fauxGit({
    'alpha status --porcelain=v2 --branch': '# branch.oid (initial)\n# branch.head main\n',
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': Object.assign(new Error('no commits'), { stderr: 'fatal: your current branch \'main\' does not have any commits yet\n' }),
  })
  const scan = await listRepositories(dir, { run })

  assert.equal(scan.count, 1)
  assert.equal(scan.errors.length, 0, 'pas de commit n’est pas un dépôt illisible')
  assert.equal(scan.repositories[0].lastCommit, null)
  assert.equal(scan.repositories[0].branch, 'main')
})

test('le scan tient un plafond de processus, et le respecte', async (t) => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ name: `repo${index}`, git: 'dir' }))
  const dir = await root(t, entries)
  const answers = {}
  for (const entry of entries) {
    answers[`${entry.name} status --porcelain=v2 --branch`] = STATUS_CLEAN
    answers[`${entry.name} log -1 --no-decorate --format=%h%x1f%ct%x1f%s`] = commit('a1b2c3d', 1000, 'sujet')
  }
  const { run, calls, peak } = fauxGit(answers, { delay: 2 })
  const scan = await listRepositories(dir, { run })

  assert.equal(scan.count, 12)
  assert.equal(calls.length, 24)
  assert.ok(peak() <= SCAN_CONCURRENCY, `au plus ${SCAN_CONCURRENCY} git à la fois, vu ${peak()}`)
  assert.ok(peak() > 1, 'le scan lance bien plusieurs git en parallèle')
})

test('les noms passent en arguments, jamais dans un shell', async (t) => {
  // Un nom de dossier peut contenir un espace ou une substitution : il reste
  // un seul argument après `-C`, et rien n'est interprété.
  const tricky = 'repo $(touch pwned) `whoami`'
  const dir = await root(t, [{ name: tricky, git: 'dir' }])
  const { run, calls } = fauxGit({
    [`${tricky} status --porcelain=v2 --branch`]: STATUS_CLEAN,
    [`${tricky} log -1 --no-decorate --format=%h%x1f%ct%x1f%s`]: commit('a1b2c3d', 1000, 'sujet'),
  })
  await listRepositories(dir, { run })

  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.equal(call.dir, join(dir, tricky), 'le nom arrive entier, dans un seul argument')
  }
})

test('un nom de dépôt reçu du client est vérifié avant tout', async () => {
  const refused = ['', '.', '..', '.git', ' a', 'a ', 'a/b', 'a\\b', 'a\0b', null, 42, 'a\u0000']
  for (const name of refused) {
    assert.equal(isValidRepositoryName(name), false, `refusé : ${JSON.stringify(name)}`)
  }
  assert.equal(isValidRepositoryName('missions'), true)
  assert.equal(isValidRepositoryName('so.dash-sdk'), true)

  const dir = await mkdtemp(join(tmpdir(), 'missions-repos-'))
  try {
    for (const name of refused) {
      await assert.rejects(readRepository(dir, name, { run: async () => assert.fail('git ne doit pas être lancé') }), (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /invalid repository name/)
        return true
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('le détail d’un dépôt : remote, upstream, avance/retard et dix commits', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const commits = Array.from({ length: 12 }, (_, index) => commit(`h${index}`, 1794000000 + index, `commit ${index}`))
  const { run, calls } = fauxGit({
    'alpha status --porcelain=v2 --branch': STATUS_BUSY,
    'alpha remote get-url origin': 'https://github.com/daedalforge/missions.git\n',
    'alpha log -n 10 --no-decorate --format=%h%x1f%ct%x1f%s': log(...commits),
  })
  const detail = await readRepository(dir, 'alpha', { run })

  assert.equal(detail.name, 'alpha')
  assert.equal(detail.path, join(dir, 'alpha'))
  assert.equal(detail.kind, 'clone')
  assert.equal(detail.branch, 'feat/mis-116')
  assert.equal(detail.upstream, 'origin/feat/mis-116')
  assert.equal(detail.ahead, 2)
  assert.equal(detail.behind, 1)
  assert.equal(detail.dirty, 2)
  assert.equal(detail.remote, 'https://github.com/daedalforge/missions.git')
  assert.equal(detail.commits.length, 10, 'dix commits, pas douze : la route borne la lecture')
  assert.equal(detail.commits[0].sha, 'h0')
  assert.equal(detail.commits[0].date, 1794000000 * 1000)
  assert.equal(detail.commits[0].subject, 'commit 0')
  assert.deepEqual(calls.map((call) => call.command).sort(), [
    'log -n 10 --no-decorate --format=%h%x1f%ct%x1f%s',
    'remote get-url origin',
    'status --porcelain=v2 --branch',
  ])
})

test('un dépôt inconnu est un 404, un git qui refuse un 502', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }, { name: 'plain' }])

  await assert.rejects(readRepository(dir, 'plain', { run: async () => assert.fail('git ne doit pas être lancé') }), (error) => {
    assert.equal(error.status, 404)
    assert.match(error.message, /no git repository named plain/)
    return true
  })

  const { run } = fauxGit({
    'alpha status --porcelain=v2 --branch': Object.assign(new Error('refus'), { stderr: 'fatal: unable to read config\n' }),
  })
  await assert.rejects(readRepository(dir, 'alpha', { run }), (error) => {
    assert.equal(error.status, 502)
    assert.equal(error.message, 'unable to read config')
    return true
  })
})

test('un dépôt sans remote ni commit reste lisible', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run } = fauxGit({
    'alpha status --porcelain=v2 --branch': '# branch.head main\n',
    'alpha remote get-url origin': Object.assign(new Error('no remote'), { stderr: "error: No such remote 'origin'\n" }),
    'alpha log -n 10 --no-decorate --format=%h%x1f%ct%x1f%s': Object.assign(new Error('no commits'), { stderr: 'fatal: your current branch \'main\' does not have any commits yet\n' }),
  })
  const detail = await readRepository(dir, 'alpha', { run })

  assert.equal(detail.remote, null, 'pas de remote est un état, pas un échec')
  assert.deepEqual(detail.commits, [])
})

test('un HEAD détaché se lit par son commit, et le statut parses ses en-têtes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'missions-repos-'))
  try {
    await mkdir(join(dir, 'alpha', '.git'), { recursive: true })
    const { run, calls } = fauxGit({
      'alpha status --porcelain=v2 --branch': '# branch.oid 1a2b3c4d\n# branch.head (detached)\n',
      'alpha rev-parse --short HEAD': '1a2b3c4\n',
      'alpha remote get-url origin': '\n',
      'alpha log -n 10 --no-decorate --format=%h%x1f%ct%x1f%s': commit('1a2b3c4', 100, 'détaché'),
    })
    const detail = await readRepository(dir, 'alpha', { run })

    assert.equal(detail.detached, true)
    assert.equal(detail.branch, null)
    assert.equal(detail.head, '1a2b3c4')
    assert.equal(detail.remote, null)
    assert.ok(calls.some((call) => call.command === 'rev-parse --short HEAD'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('le statut et le journal se relisent sans perdre une ligne', () => {
  assert.deepEqual(parseStatus(''), { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, dirty: 0 })
  assert.deepEqual(parseStatus(STATUS_BUSY), {
    branch: 'feat/mis-116', detached: false, upstream: 'origin/feat/mis-116', ahead: 2, behind: 1, dirty: 2,
  })
  assert.deepEqual(parseStatus('# branch.head (detached)\n# branch.ab +0 -0\n'), {
    branch: null, detached: true, upstream: null, ahead: 0, behind: 0, dirty: 0,
  })

  // Un sujet peut contenir le séparateur : seul le hash et la date sont fixes.
  const parsed = parseLog(log(commit('abc1234', 1794468058, 'sujet\u001favec un séparateur'), commit('def5678', 0, 'date illisible')))
  assert.deepEqual(parsed, [
    { sha: 'abc1234', date: 1794468058 * 1000, subject: 'sujet\u001favec un séparateur' },
    { sha: 'def5678', date: null, subject: 'date illisible' },
  ])
  assert.deepEqual(parseLog(''), [])
})
