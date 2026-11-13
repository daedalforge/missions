import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  GIT_TIMEOUT_MS,
  SCAN_CONCURRENCY,
  SUMMARY_TTL_MS,
  adoptWorktree,
  countRepositories,
  flattenLayout,
  isValidBranchName,
  isValidRepositoryName,
  listRepositories,
  parseBranches,
  parseLog,
  parseMacheteLayout,
  parseStatus,
  parseWorktreeList,
  readHistory,
  readRepository,
  readRepositoryNames,
  readTree,
  resetRepositorySummary,
  summarizeRepositories,
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
      // Une réponse peut être une file : un test qui fait échouer git *après*
      // qu'il a écrit a besoin de deux réponses différentes pour la même commande.
      const queue = answers[`${name} ${command}`]
      const answer = Array.isArray(queue) ? queue.shift() : queue
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
    'beta worktree list --porcelain': [
      `worktree ${join(dir, 'alpha')}`,
      'HEAD 1a2b3c4d',
      'branch refs/heads/main',
      '',
      `worktree ${join(dir, 'beta')}`,
      'HEAD d4e5f6a',
      'branch refs/heads/gh-20-hover',
      '',
    ].join('\n'),
  })
  const scan = await listRepositories(dir, { run })

  assert.equal(scan.count, 2)
  assert.equal(scan.root, dir)
  assert.equal(scan.errors.length, 0)
  assert.ok(Number.isFinite(scan.durationMs) && scan.durationMs >= 0)
  // Deux appels par dépôt — le statut, puis le dernier commit — et un de plus
  // pour un worktree, qui lit le principal d'où il vient.
  assert.equal(calls.length, 5)
  assert.ok(calls.every((call) => call.options?.timeout === GIT_TIMEOUT_MS))

  const beta = scan.repositories.find((row) => row.name === 'beta')
  assert.equal(beta.kind, 'worktree')
  assert.equal(beta.branch, 'feat/mis-116')
  assert.equal(beta.upstream, 'origin/feat/mis-116')
  assert.equal(beta.ahead, 2)
  assert.equal(beta.behind, 1)
  assert.equal(beta.dirty, 2)
  assert.equal(beta.error, null)
  assert.deepEqual(beta.main, { name: 'alpha', path: join(dir, 'alpha') }, 'le principal est un voisin de la racine')

  // Le plus récent d'abord : c'est l'ordre que le widget annonce.
  assert.deepEqual(scan.repositories.map((row) => row.name), ['alpha', 'beta'])
})

test('un worktree nomme le principal, ou dit qu’il ne peut pas', async (t) => {
  const dir = await root(t, [
    { name: 'alpha', git: 'dir' },
    { name: 'beta', git: 'file' },
    { name: 'gamma', git: 'file' },
    { name: 'delta', git: 'file' },
  ])
  const { run } = fauxGit({
    'alpha status --porcelain=v2 --branch': STATUS_CLEAN,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('a1b2c3d', 1000, 'alpha'),
    'beta status --porcelain=v2 --branch': STATUS_CLEAN,
    'beta log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('b1b2c3d', 900, 'beta'),
    'gamma status --porcelain=v2 --branch': STATUS_CLEAN,
    'gamma log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('c1b2c3d', 800, 'gamma'),
    'delta status --porcelain=v2 --branch': STATUS_CLEAN,
    'delta log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('d1b2c3d', 700, 'delta'),
    // Le principal est un autre enfant de la racine.
    'beta worktree list --porcelain': `worktree ${join(dir, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
    // Le principal vit hors de la racine scannée : un chemin, pas de ligne.
    'gamma worktree list --porcelain': 'worktree /Users/moi/elsewhere/missions\nHEAD 2a2b3c4d\nbranch refs/heads/main\n',
    // git refuse de lister : le principal est inconnu, pas deviné.
    'delta worktree list --porcelain': Object.assign(new Error('refus'), { stderr: 'fatal: not a git repository\n' }),
  })
  const scan = await listRepositories(dir, { run })
  const par = (name) => scan.repositories.find((row) => row.name === name)

  assert.equal(par('alpha').main, null, 'un clone est son propre principal')
  assert.deepEqual(par('beta').main, { name: 'alpha', path: join(dir, 'alpha') })
  assert.deepEqual(par('gamma').main, { name: null, path: '/Users/moi/elsewhere/missions' }, 'hors racine : pas de nom à ouvrir')
  assert.deepEqual(par('delta').main, { name: null, path: null }, 'un refus laisse le chemin nul, pas la ligne')
})

test('un principal dans la racine mais hors du scan ne reçoit pas de nom', async (t) => {
  // Un dépôt bare (`principal.git`, pas de sous-dossier `.git`) peut être le
  // principal d'un worktree sans être une ligne du scan : le chemin reste, le
  // nom non — sinon le client proposerait une bascule vers une ligne absente.
  const dir = await root(t, [
    { name: 'principal.git' },
    { name: 'linked', git: 'file' },
  ])
  const { run } = fauxGit({
    'linked status --porcelain=v2 --branch': STATUS_CLEAN,
    'linked log -1 --no-decorate --format=%h%x1f%ct%x1f%s': commit('a1b2c3d', 1000, 'linked'),
    'linked worktree list --porcelain': `worktree ${join(dir, 'principal.git')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
  })
  const scan = await listRepositories(dir, { run })

  assert.deepEqual(scan.repositories.map((row) => row.name), ['linked'], 'le principal bare n’est pas une ligne')
  assert.deepEqual(scan.repositories[0].main, { name: null, path: join(dir, 'principal.git') }, 'le chemin reste, le nom non')
})

test('le compte de la pastille retient les clones, pas les worktrees', async (t) => {
  // Le badge annonce des dépôts : un worktree est le checkout d'un dépôt
  // déclaré ailleurs, et un dossier sans `.git` n'est rien. La fonction ne
  // reçoit même pas de lanceur — elle ne peut pas lancer git.
  const dir = await root(t, [
    { name: 'alpha', git: 'dir' },
    { name: 'zeta', git: 'dir' },
    { name: 'beta', git: 'file' },
    { name: 'plain' },
    { name: '.cache', git: 'dir' },
    { name: 'notes.txt', kind: 'file' },
  ])
  assert.equal(await countRepositories(dir), 2)

  const vide = await root(t, [])
  assert.equal(await countRepositories(vide), 0)

  // Une racine illisible rejette : c'est la route qui la traduit en 500 nommé.
  await assert.rejects(countRepositories(join(dir, 'absent')), /ENOENT/)
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
    'ahead', 'behind', 'branch', 'detached', 'dirty', 'error', 'head', 'kind', 'lastCommit', 'main', 'name', 'path', 'upstream',
  ])
  assert.equal(row.main, null, 'un clone est son propre principal')
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

test('le détail d’un dépôt : remote, upstream, avance/retard, sans clé commits', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run, calls } = fauxGit({
    'alpha status --porcelain=v2 --branch': STATUS_BUSY,
    'alpha remote get-url origin': 'https://github.com/daedalforge/missions.git\n',
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
  assert.equal('commits' in detail, false, 'la liste des commits a quitté le détail pour History')
  assert.deepEqual(calls.map((call) => call.command).sort(), [
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
  })
  const detail = await readRepository(dir, 'alpha', { run })

  assert.equal(detail.remote, null, 'pas de remote est un état, pas un échec')
  assert.equal('commits' in detail, false)
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

test('une branche se vérifie avant d’atteindre git', () => {
  for (const good of ['main', 'feat/mis-125', 'release/1.2', 'a_b.c-d']) {
    assert.equal(isValidBranchName(good), true, good)
  }
  for (const bad of ['', ' main', 'main ', '-x', '--all', 'a..b', 'a@{1}', 'a b', 'a//b', 'a/', 'HEAD', '@', 'a\\b', null, 12]) {
    assert.equal(isValidBranchName(bad), false, String(bad))
  }
})

test('un layout machete se lit par ses indentations, annotations comprises', () => {
  const entries = parseMacheteLayout([
    '# commentaire',
    'main',
    '    feat/a  PR #12',
    '        feat/a/fix',
    '    hotfix/24',
  ].join('\n'))
  assert.deepEqual(entries, [
    { name: 'main', depth: 0, annotation: null },
    { name: 'feat/a', depth: 1, annotation: 'PR #12' },
    { name: 'feat/a/fix', depth: 2, annotation: null },
    { name: 'hotfix/24', depth: 1, annotation: null },
  ])

  assert.deepEqual(flattenLayout(entries).map((row) => [row.name, row.parent]), [
    ['main', null],
    ['feat/a', 'main'],
    ['feat/a/fix', 'feat/a'],
    ['hotfix/24', 'main'],
  ])
  // Une profondeur qui saute est ramenée au niveau atteignable.
  assert.deepEqual(flattenLayout([{ name: 'seul', depth: 4 }]).map((row) => [row.name, row.depth, row.parent]), [['seul', 0, null]])
  assert.deepEqual(parseMacheteLayout(''), [])
  assert.deepEqual(parseBranches('main\n  feat/a  \n\n'), ['main', 'feat/a'], 'une ligne par réf, sans blancs')
})

test('le layout réel de Manager donne ses seize branches, profondeurs et parents', () => {
  const text = [
    'main',
    '    epic/so-483',
    '        feat/so-752',
    '            feat/so-539',
    '                feat/so-755',
    '                    feat/so-758',
    '                        feat/so-761',
    '                            feat/so-783',
    '                                feat/so-765',
    '                                feat/so-768',
    '        feat/so-1185',
    '        feat/so-1186',
    '        feat/so-1184',
    '    epic/soc-1309 slide-out=no',
    '        fix/soc-1503',
    '            feat/soc-1439',
  ].join('\n')
  const rows = flattenLayout(parseMacheteLayout(text))
  assert.equal(rows.length, 16)
  assert.deepEqual(rows.map((row) => [row.name, row.depth, row.parent]), [
    ['main', 0, null],
    ['epic/so-483', 1, 'main'],
    ['feat/so-752', 2, 'epic/so-483'],
    ['feat/so-539', 3, 'feat/so-752'],
    ['feat/so-755', 4, 'feat/so-539'],
    ['feat/so-758', 5, 'feat/so-755'],
    ['feat/so-761', 6, 'feat/so-758'],
    ['feat/so-783', 7, 'feat/so-761'],
    ['feat/so-765', 8, 'feat/so-783'],
    ['feat/so-768', 8, 'feat/so-783'],
    ['feat/so-1185', 2, 'epic/so-483'],
    ['feat/so-1186', 2, 'epic/so-483'],
    ['feat/so-1184', 2, 'epic/so-483'],
    ['epic/soc-1309', 1, 'main'],
    ['fix/soc-1503', 2, 'epic/soc-1309'],
    ['feat/soc-1439', 3, 'fix/soc-1503'],
  ])
  assert.equal(rows.find((row) => row.name === 'epic/soc-1309').annotation, 'slide-out=no')
})

test('worktree list se lit en lignes, avec le worktree d’ici', () => {
  const text = [
    'worktree /Users/moi/projects/alpha',
    'HEAD 1a2b3c4d',
    'branch refs/heads/main',
    '',
    'worktree /Users/moi/projects/beta',
    'HEAD 5e6f7a8b',
    'detached',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(text, { current: '/Users/moi/projects/alpha' }), [
    { path: '/Users/moi/projects/alpha', branch: 'main', head: '1a2b3c4d', current: true },
    { path: '/Users/moi/projects/beta', branch: null, head: '5e6f7a8b', current: false },
  ])
})

test('une page d’historique dit sa branche, son total et sa suite', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run, calls } = fauxGit({
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\nfeat/a\n',
    'alpha rev-list --count refs/heads/main': '3094\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 50 --skip=0 refs/heads/main': log(
      commit('a1b2c3d', 1794468058, 'MIS-116: ajoute l’onglet'),
      commit('5de99bc', 1794467058, 'MIS-114: empile les étiquettes'),
    ),
    'alpha rev-list --count refs/heads/feat/a': '51\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 50 --skip=50 refs/heads/feat/a': commit('d00d1e0', 1794460000, 'fin'),
  })

  const page = await readHistory(dir, 'alpha', { run })
  assert.equal(page.branch, 'main', 'sans branche demandée, main est lue')
  assert.deepEqual(page.branches, ['main', 'feat/a'], 'le sélecteur a ses choix dans la réponse')
  assert.equal(page.total, 3094)
  assert.equal(page.hasMore, true, 'la page 1 sur 3 094 commits en a d’autres')
  assert.deepEqual(page.commits.map((row) => row.sha), ['a1b2c3d', '5de99bc'])
  assert.equal(page.commits[0].date, 1794468058000)

  const second = await readHistory(dir, 'alpha', { run, branch: 'feat/a', skip: 50 })
  assert.equal(second.branch, 'feat/a')
  assert.equal(second.hasMore, false, 'la page 2 sur 51 commits est la dernière')
  assert.deepEqual(second.commits.map((row) => row.sha), ['d00d1e0'])
  assert.equal(calls.filter((call) => /--skip=50/.test(call.command)).length, 1)
  assert.ok(calls.some((call) => /refs\/heads\/feat\/a/.test(call.command)), 'la branche est passée en réf, pas en nom nu')
})

test('sans main, l’historique s’ouvre sur la branche courante', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run } = fauxGit({
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'dev\nfeat/x\n',
    'alpha rev-parse --abbrev-ref HEAD': 'dev\n',
    'alpha rev-list --count refs/heads/dev': '2\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 50 --skip=0 refs/heads/dev': log(
      commit('a1b2c3d', 1794468058, 'un'),
      commit('5de99bc', 1794467058, 'deux'),
    ),
  })

  const page = await readHistory(dir, 'alpha', { run })
  assert.equal(page.branch, 'dev', 'main manque : la branche courante prend sa place')
  assert.deepEqual(page.branches, ['dev', 'feat/x'])
  assert.equal(page.total, 2)
  assert.equal(page.hasMore, false)
})

test('une branche refusée ou inconnue est une erreur de demande', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run, calls } = fauxGit({
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\n',
  })

  await assert.rejects(readHistory(dir, 'alpha', { run, branch: '--all' }), (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /invalid branch name/)
    return true
  })
  await assert.rejects(readHistory(dir, 'alpha', { run, branch: 'feature/zzz' }), (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /unknown branch/)
    return true
  })
  await assert.rejects(readHistory(dir, 'alpha', { run, skip: -3 }), (error) => {
    assert.equal(error.status, 400)
    return true
  })

  assert.equal(calls.some((call) => /--all/.test(call.command)), false, 'le nom refusé n’atteint jamais git')
  assert.equal(calls.some((call) => /feature\/zzz/.test(call.command)), false)
})

test('l’arbre d’un dépôt : layout, commits par branche, worktrees', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  await writeFile(join(dir, 'alpha', '.git', 'machete'), 'main\n    feat/a  PR #12\n    ghost\n')
  // Le worktree existe sur le disque : c'est son chemin réel que la ligne
  // compare à la racine pour décider si elle reçoit un nom.
  await mkdir(join(dir, 'alpha-12'), { recursive: true })
  const worktrees = [
    `worktree ${join(dir, 'alpha')}`, 'HEAD abc1234', 'branch refs/heads/main', '',
    `worktree ${join(dir, 'alpha-12')}`, 'HEAD def5678', 'branch refs/heads/feat/a', '',
  ].join('\n')
  const { run, calls } = fauxGit({
    'alpha rev-parse --git-common-dir': '.git\n',
    'alpha worktree list --porcelain': worktrees,
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\nfeat/a\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 11 main..refs/heads/feat/a': log(
      ...Array.from({ length: 11 }, (_, i) => commit(`c0ffee${i}`, 1794468058 - i, `commit ${i}`)),
    ),
  })

  const tree = await readTree(dir, 'alpha', { run })
  assert.equal(tree.layout, true)
  assert.deepEqual(tree.branches.map((row) => [row.name, row.depth, row.parent, row.worktree, row.missing]), [
    ['main', 0, null, 'alpha', false],
    ['feat/a', 1, 'main', 'alpha-12', false],
    ['ghost', 1, 'main', null, true],
  ])
  assert.equal(tree.branches[1].annotation, 'PR #12')
  assert.equal(tree.branches[1].commits.length, 10, 'dix commits, pas onze')
  assert.equal(tree.branches[1].truncated, true, 'la onzième ligne est le marqueur')
  assert.deepEqual(tree.branches[2].commits, [], 'une branche absente ne lance pas de log')
  assert.equal(tree.worktrees.find((row) => row.path === join(dir, 'alpha')).current, true)
  // Chaque ligne dit si elle est la souche, et le nom de son dossier quand il
  // est un enfant direct de la racine : c'est ce nom que le geste envoie.
  assert.deepEqual(tree.worktrees.map((row) => [row.path, row.main, row.name]), [
    [join(dir, 'alpha'), true, 'alpha'],
    [join(dir, 'alpha-12'), false, 'alpha-12'],
  ])
  assert.equal(calls.filter((call) => /^log /.test(call.command)).length, 1, 'seule une branche locale et rattachée lance un log')
  assert.deepEqual(
    [...new Set(calls.map((call) => call.command.split(' ')[0]))].sort(),
    ['for-each-ref', 'log', 'rev-parse', 'worktree'],
    'l’onglet ne lance que les lectures autorisées',
  )
})

test('un layout vide est un layout absent, pas une branche fantôme', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  await writeFile(join(dir, 'alpha', '.git', 'machete'), '   \n\n')
  const { run, calls } = fauxGit({
    'alpha rev-parse --git-common-dir': '.git\n',
    'alpha worktree list --porcelain': `worktree ${join(dir, 'alpha')}\nHEAD abc1234\nbranch refs/heads/main\n`,
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\n',
  })

  const tree = await readTree(dir, 'alpha', { run })
  assert.equal(tree.layout, false)
  assert.deepEqual(tree.branches, [])
  assert.equal(calls.some((call) => /^log /.test(call.command)), false)
})

test('un worktree hors de la racine n’a pas de nom, donc pas de geste', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const ailleurs = join(tmpdir(), 'missions-away', 'wt')
  const worktrees = [
    `worktree ${join(dir, 'alpha')}`, 'HEAD abc1234', 'branch refs/heads/main', '',
    `worktree ${ailleurs}`, 'HEAD def5678', 'branch refs/heads/hot', '',
  ].join('\n')
  const { run } = fauxGit({
    'alpha rev-parse --git-common-dir': '.git\n',
    'alpha worktree list --porcelain': worktrees,
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\nhot\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 11 main..refs/heads/hot': '',
  })

  const tree = await readTree(dir, 'alpha', { run })
  assert.deepEqual(tree.worktrees.map((row) => [row.path, row.main, row.name]), [
    [join(dir, 'alpha'), true, 'alpha'],
    [ailleurs, false, null],
  ])
})

test('sans fichier machete, l’arbre est plat mais les worktrees restent', async (t) => {
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const { run } = fauxGit({
    'alpha rev-parse --git-common-dir': '.git\n',
    'alpha worktree list --porcelain': `worktree ${join(dir, 'alpha')}\nHEAD abc1234\nbranch refs/heads/main\n`,
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\n',
  })

  const tree = await readTree(dir, 'alpha', { run })
  assert.equal(tree.layout, false)
  assert.deepEqual(tree.branches, [])
  assert.deepEqual(tree.worktrees.map((row) => [row.path, row.branch, row.current]), [[join(dir, 'alpha'), 'main', true]])
  assert.deepEqual(tree.worktrees.map((row) => [row.main, row.name]), [[true, 'alpha']])
})

/**
 * La bascule : le seul geste qui écrit. Chaque test monte deux dossiers
 * jetables — un clone et son worktree — et répond à git par une table, pour
 * voir non seulement la réponse mais l'ordre exact des commandes.
 */
async function paire(t) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-adopt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'repo', '.git'), { recursive: true })
  await mkdir(join(dir, 'repo-feat'), { recursive: true })
  await writeFile(join(dir, 'repo-feat', '.git'), `gitdir: ${join(dir, 'repo', '.git', 'worktrees', 'repo-feat')}\n`)
  return dir
}

const branche = (name) => `# branch.oid 1a2b3c4d\n# branch.head ${name}\n`
const principal = (dir) => `worktree ${join(dir, 'repo')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`

test('la bascule détache, met la branche dans le principal, puis retire le dossier', async (t) => {
  const dir = await paire(t)
  const { run, calls } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat status --porcelain --ignored=matching': '',
    'repo-feat switch --detach': '',
    'repo switch feat/x': '',
    [`repo worktree remove ${join(dir, 'repo-feat')}`]: '',
  })

  const result = await adoptWorktree(dir, 'repo-feat', { run })

  assert.deepEqual(calls.map((call) => `${call.name} ${call.command}`), [
    'repo-feat worktree list --porcelain',
    'repo-feat status --porcelain=v2 --branch',
    'repo status --porcelain=v2 --branch',
    'repo-feat status --porcelain --ignored=matching',
    'repo-feat switch --detach',
    'repo switch feat/x',
    `repo worktree remove ${join(dir, 'repo-feat')}`,
  ], 'l’ordre est la sécurité : détacher, basculer, retirer')
  assert.deepEqual(result, {
    ok: true,
    source: 'repo-feat',
    branch: 'feat/x',
    main: { name: 'repo', path: join(dir, 'repo') },
    removed: true,
    reason: null,
  })
})

test('un principal sale refuse la bascule avant d’écrire quoi que ce soit', async (t) => {
  const dir = await paire(t)
  const { run, calls } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': `${branche('main')}1 .M N... 100644 100644 100644 aaa bbb yarn.lock\n`,
    'repo status --porcelain': ' M yarn.lock\n',
  })

  const error = await adoptWorktree(dir, 'repo-feat', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.status, 409)
  assert.equal(error.side, 'main')
  assert.deepEqual(error.files, ['yarn.lock'])
  assert.equal(error.message, 'repo has uncommitted changes (one file: yarn.lock) — commit or stash them first')
  assert.equal(calls.some((call) => / switch /.test(` ${call.command} `)), false, 'aucun switch, aucun retrait')
  assert.equal(calls.some((call) => call.command.startsWith('worktree remove')), false)
})

test('un worktree sale refuse aussi, même avec un principal propre', async (t) => {
  const dir = await paire(t)
  const { run } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': `${branche('feat/x')}1 .M N... 100644 100644 100644 aaa bbb src/a.js\n1 .M N... 100644 100644 100644 ccc ddd src/b.js\n`,
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat status --porcelain': ' M src/a.js\n M src/b.js\n',
  })

  const error = await adoptWorktree(dir, 'repo-feat', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.side, 'worktree')
  assert.deepEqual(error.files, ['src/a.js', 'src/b.js'])
  assert.match(error.message, /^the worktree repo-feat has uncommitted changes \(2 files: src\/a\.js, src\/b\.js\)/)
})

test('un worktree détaché n’a aucune branche à reprendre', async (t) => {
  const dir = await paire(t)
  const { run, calls } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': '# branch.oid 1a2b3c4d\n# branch.head (detached)\n',
    'repo status --porcelain=v2 --branch': branche('main'),
  })

  const error = await adoptWorktree(dir, 'repo-feat', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.status, 409)
  assert.equal(error.message, 'the worktree repo-feat is detached: it has no branch to bring back')
  assert.equal(calls.some((call) => call.command.includes('switch')), false, 'aucune commande n’est lancée')
})

test('un switch que git refuse remet le worktree sur sa branche', async (t) => {
  const dir = await paire(t)
  const { run, calls } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    // Le détachement a eu lieu, git bouge donc HEAD avant de refuser : la
    // même commande de lecture répond trois fois, dans l'ordre du réel.
    'repo-feat status --porcelain=v2 --branch': [branche('feat/x'), '# branch.head (detached)\n', branche('feat/x')],
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat status --porcelain --ignored=matching': '',
    'repo-feat switch --detach': '',
    'repo switch feat/x': Object.assign(new Error('refus'), { stderr: 'fatal: Unable to create index.lock\n' }),
    'repo-feat switch feat/x': '',
  })

  const error = await adoptWorktree(dir, 'repo-feat', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.status, 502)
  assert.match(error.message, /^git refused to switch repo to feat\/x: Unable to create index\.lock/)
  assert.match(error.message, /— repo-feat was put back on feat\/x$/)
  const order = calls.map((call) => `${call.name} ${call.command}`)
  assert.ok(
    order.indexOf('repo-feat switch feat/x') > order.indexOf('repo switch feat/x'),
    'le retour en arrière vient après le refus, pas avant',
  )
  assert.equal(calls.some((call) => call.command.startsWith('worktree remove')), false)
})

test('un worktree que git garde est un retrait partiel, pas un échec', async (t) => {
  const dir = await paire(t)
  const { run } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat switch --detach': '',
    'repo switch feat/x': '',
    [`repo worktree remove ${join(dir, 'repo-feat')}`]: Object.assign(new Error('refus'), { stderr: 'fatal: cannot remove: locked\n' }),
  })

  const result = await adoptWorktree(dir, 'repo-feat', { run })

  assert.equal(result.removed, false)
  assert.match(result.reason, /locked/)
  assert.equal(result.branch, 'feat/x', 'la branche a bien bougé : le retrait seul a manqué')
})

test('hors racine, un clone, un principal déjà sur la branche : refus avant écriture', async (t) => {
  const dir = await paire(t)
  const refus = async (answers, name = 'repo-feat') =>
    adoptWorktree(dir, name, { run: fauxGit(answers).run }).then(() => null, (refusal) => refusal)

  const ailleurs = await refus({ 'repo-feat worktree list --porcelain': 'worktree /Users/moi/ailleurs/repo\nHEAD 1a2b3c4d\nbranch refs/heads/main\n' })
  assert.equal(ailleurs.status, 409)
  assert.match(ailleurs.message, /lives outside the workspace root/)

  const clone = await refus({}, 'repo')
  assert.equal(clone.status, 400)
  assert.match(clone.message, /is not a worktree/)

  const meme = await refus({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': branche('feat/x'),
  })
  assert.equal(meme.status, 409)
  assert.match(meme.message, /^repo already holds feat\/x$/)
})

test('les fichiers ignorés sont nommés avant d’être supprimés', async (t) => {
  // `git worktree remove` les prend sans rien dire : node_modules est
  // régénérable, .env ne l'est pas. Rien ne bouge tant qu'ils ne sont pas dits.
  const dir = await paire(t)
  const { run, calls } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat status --porcelain --ignored=matching': '!! node_modules/\n!! .env\n!! .cache/\n!! dist/\n!! build/\n',
  })

  const error = await adoptWorktree(dir, 'repo-feat', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.status, 409)
  assert.equal(error.ignored, true)
  assert.equal(error.side, 'worktree')
  assert.deepEqual(error.files, ['node_modules', '.env', '.cache', 'dist'], 'quatre noms, pas un flot')
  assert.equal(
    error.message,
    'the worktree repo-feat holds 5 ignored entries (node_modules, .env, .cache, dist, …) that git deletes with the folder — send acceptIgnored to remove them with it',
  )
  assert.equal(calls.some((call) => call.command.startsWith('switch')), false, 'rien n’a bougé')
})

test('une seconde réponse accepte les ignorés, et le dossier part avec eux', async (t) => {
  const dir = await paire(t)
  // Pas de réponse pour `--ignored=matching` : le test prouverait un appel de trop.
  const { run } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat switch --detach': '',
    'repo switch feat/x': '',
    [`repo worktree remove ${join(dir, 'repo-feat')}`]: '',
  })

  const result = await adoptWorktree(dir, 'repo-feat', { run, acceptIgnored: true })

  assert.equal(result.ok, true)
  assert.equal(result.removed, true)
})

test('un hook qui échoue après avoir détaché ne bloque pas la reprise', async (t) => {
  // Un hook post-checkout sort en 1 *après* que git a bougé HEAD : le code ne
  // peut pas croire le code de sortie, il relit l'arbre.
  const dir = await paire(t)
  const { run } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': [branche('feat/x'), '# branch.head (detached)\n'],
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat status --porcelain --ignored=matching': '',
    'repo-feat switch --detach': Object.assign(new Error('hook'), { stderr: 'fatal: hook refused\n' }),
    'repo switch feat/x': '',
    [`repo worktree remove ${join(dir, 'repo-feat')}`]: '',
  })

  const result = await adoptWorktree(dir, 'repo-feat', { run })

  assert.equal(result.ok, true)
  assert.equal(result.branch, 'feat/x')
})

test('un hook qui échoue après le switch du principal ne fait pas échouer la reprise', async (t) => {
  const dir = await paire(t)
  const { run } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': branche('feat/x'),
    'repo status --porcelain=v2 --branch': [branche('main'), branche('feat/x')],
    'repo-feat status --porcelain --ignored=matching': '',
    'repo-feat switch --detach': '',
    'repo switch feat/x': Object.assign(new Error('hook'), { stderr: 'fatal: hook refused\n' }),
    [`repo worktree remove ${join(dir, 'repo-feat')}`]: '',
  })

  const result = await adoptWorktree(dir, 'repo-feat', { run })

  assert.equal(result.ok, true)
  assert.equal(result.removed, true, 'la branche est bien dans le principal : le retrait suit')
})

test('quand le retour en arrière est impossible, le message dit où sont les arbres', async (t) => {
  const dir = await paire(t)
  const { run } = fauxGit({
    'repo-feat worktree list --porcelain': principal(dir),
    'repo-feat status --porcelain=v2 --branch': [
      branche('feat/x'),
      '# branch.head (detached)\n',
      '# branch.head (detached)\n',
    ],
    'repo status --porcelain=v2 --branch': branche('main'),
    'repo-feat status --porcelain --ignored=matching': '',
    'repo-feat switch --detach': '',
    'repo switch feat/x': Object.assign(new Error('refus'), { stderr: 'fatal: index.lock\n' }),
    'repo-feat switch feat/x': Object.assign(new Error('refus'), { stderr: 'fatal: index.lock\n' }),
  })

  const error = await adoptWorktree(dir, 'repo-feat', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.status, 502)
  assert.match(error.message, /— repo-feat is still detached and feat\/x is checked out nowhere: fix the cause, then run git -C /)
})

test('un principal atteint par un lien symbolique hors racine est refusé', async (t) => {
  // Le scan ne liste que des enfants directs ; un enfant qui est un lien vers
  // l'extérieur resterait une ligne. Le follow-up réel ne doit pas le toucher.
  const dir = await mkdtemp(join(tmpdir(), 'missions-adopt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const outside = join(dir, 'ailleurs')
  const root = join(dir, 'racine')
  await mkdir(join(outside, 'repo', '.git'), { recursive: true })
  await mkdir(root, { recursive: true })
  await symlink(join(outside, 'repo'), join(root, 'repo'))
  await mkdir(join(root, 'wt'), { recursive: true })
  await writeFile(join(root, 'wt', '.git'), `gitdir: ${join(outside, 'repo', '.git', 'worktrees', 'wt')}\n`)
  // git nomme le principal par le chemin qu'on lui a donné : le symlink sous la
  // racine, dont la cible réelle est ailleurs.
  const { run, calls } = fauxGit({
    'wt worktree list --porcelain': `worktree ${join(root, 'repo')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
  })

  const error = await adoptWorktree(root, 'wt', { run }).then(() => null, (refusal) => refusal)

  assert.equal(error.status, 409)
  assert.match(error.message, /^the main worktree of wt lives outside the workspace root/)
  assert.deepEqual(calls.map((call) => `${call.name} ${call.command}`), [
    'wt worktree list --porcelain',
  ], 'le refus tombe avant la moindre lecture d’état, et avant toute écriture')
})

/** Les réponses du scan pour une entrée propre, nommée. */
function scanAnswers(name, { status = STATUS_CLEAN, commitLine = commit('a1b2c3d', 1794468058, 'MIS-192: le résumé') } = {}) {
  return {
    [`${name} status --porcelain=v2 --branch`]: status,
    [`${name} log -1 --no-decorate --format=%h%x1f%ct%x1f%s`]: log(commitLine),
  }
}

test('le résumé d’une racine paie le scan une fois, puis le tient five minutes', async (t) => {
  resetRepositorySummary()
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }, { name: 'beta', git: 'dir' }])
  const git = fauxGit({ ...scanAnswers('alpha'), ...scanAnswers('beta') })

  const first = await summarizeRepositories(dir, { run: git.run })
  // Une entrée, un `status`, un `log` : le résumé ne paie rien de plus que la
  // liste, il ajoute la date de lecture.
  assert.equal(git.calls.length, 4)
  assert.deepEqual(Object.keys(first).sort(), ['count', 'durationMs', 'errors', 'repositories', 'root', 'scannedAt'])
  assert.equal(first.count, 2)
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.repositories.map((row) => row.name), ['alpha', 'beta'])
  assert.equal(Number.isFinite(Date.parse(first.scannedAt)), true)

  // Deux appels rapprochés, un seul scan : le second rend le premier, tel quel.
  const second = await summarizeRepositories(dir, { run: git.run })
  assert.equal(second, first)
  assert.equal(git.calls.length, 4)

  // `refresh` force la relecture, et le résumé est nouveau.
  const forced = await summarizeRepositories(dir, { run: git.run, refresh: true })
  assert.equal(git.calls.length, 8)
  assert.notEqual(forced, first)
  assert.equal(SUMMARY_TTL_MS, 5 * 60_000)
})

test('deux lectures simultanées partagent le même scan', async (t) => {
  resetRepositorySummary()
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const git = fauxGit(scanAnswers('alpha'), { delay: 20 })

  const [one, two] = await Promise.all([
    summarizeRepositories(dir, { run: git.run }),
    summarizeRepositories(dir, { run: git.run }),
  ])
  // La promesse en vol est rendue aux deux appelants : une seule paire de
  // commandes, un seul `log`.
  assert.equal(one, two)
  assert.equal(git.calls.length, 2)

  // Une lecture qui force ne s'invite pas dans la promesse en vol : elle paie
  // la sienne, et le cache garde la plus récente réponse.
  const forced = await summarizeRepositories(dir, { run: git.run, refresh: true })
  assert.equal(git.calls.length, 4)
  assert.notEqual(forced, one)
})

test('une entrée illisible laisse son erreur, le reste du résumé tient', async (t) => {
  resetRepositorySummary()
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }, { name: 'beta', git: 'dir' }])
  const git = fauxGit({
    ...scanAnswers('alpha'),
    ...scanAnswers('beta', { status: Object.assign(new Error('fatal: not a git repository'), { stderr: 'fatal: not a git repository' }) }),
  })

  const summary = await summarizeRepositories(dir, { run: git.run })
  // La ligne fautive reste dans le scan, avec son erreur : un zéro serait un
  // mensonge, le résumé dit ce qu'il n'a pas pu lire.
  const beta = summary.repositories.find((row) => row.name === 'beta')
  assert.ok(beta)
  assert.match(beta.error, /not a git repository/)
  assert.deepEqual(summary.errors, [{ name: 'beta', message: 'not a git repository' }])
  assert.equal(summary.count, 2)
})

test('le cache se vide : la racine suivante se relit', async (t) => {
  resetRepositorySummary()
  const dir = await root(t, [{ name: 'alpha', git: 'dir' }])
  const git = fauxGit(scanAnswers('alpha'))

  await summarizeRepositories(dir, { run: git.run })
  assert.equal(git.calls.length, 2)
  await summarizeRepositories(dir, { run: git.run })
  assert.equal(git.calls.length, 2)

  resetRepositorySummary()
  await summarizeRepositories(dir, { run: git.run })
  assert.equal(git.calls.length, 4)
})
