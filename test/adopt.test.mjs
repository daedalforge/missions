import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { adoptWorktree, listRepositories } from '../lib/repositories.js'

/**
 * La bascule contre un vrai git : un clone, un worktree lié, et le geste.
 *
 * Les autres tests de `repositories.test.mjs` répondent par une table, ce qui
 * fixe l'ordre des commandes sans dépendre de la machine. Ici c'est l'inverse :
 * seul git peut dire si le dossier disparaît et où la branche atterrit — un
 * `switch` que personne ne simule. Sans git, les tests s'annoncent ignorés
 * plutôt que rouges.
 */
const exec = promisify(execFile)
const git = async (cwd, ...args) =>
  (await exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

let disponible = true
try {
  await exec('git', ['--version'])
} catch {
  disponible = false
}

/** Un test réel : annoncé ignoré quand git n'est pas là. */
const gitTest = (name, fn) => test(name, async (t) => {
  if (!disponible) return t.skip('git absent de la machine')
  await fn(t)
})

/** Un dépôt neuf, un commit sur `branche`, et son dossier. */
async function depot(t, root, nom, branche = 'main') {
  const dir = join(root, nom)
  await mkdir(dir, { recursive: true })
  await git(dir, 'init', '-q', '-b', branche)
  await git(dir, 'config', 'user.email', 'test@example.com')
  await git(dir, 'config', 'user.name', 'test')
  await writeFile(join(dir, 'README.md'), 'one\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'one')
  return dir
}

/** La racine jetable et le worktree lié, sur une branche à lui. */
async function duo(t, { sale = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'missions-adopt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const principal = await depot(t, root, 'repo')
  const worktree = join(root, 'repo-feat')
  await git(principal, 'worktree', 'add', '-q', '-b', 'feat/x', worktree)
  if (sale) await writeFile(join(sale === 'main' ? principal : worktree, 'README.md'), 'dirty\n')
  return { root, principal, worktree }
}

const branche = async (cwd) => (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
const tete = async (cwd) => (await git(cwd, 'rev-parse', 'HEAD')).trim()
const worktrees = async (cwd) => (await git(cwd, 'worktree', 'list', '--porcelain')).trim().split('\n\n').length

gitTest('la branche du worktree passe dans le principal, et le dossier disparaît', async (t) => {
  const { root, principal, worktree } = await duo(t)
  await writeFile(join(worktree, 'x.txt'), 'x\n')
  await git(worktree, 'add', '.')
  await git(worktree, 'commit', '-q', '-m', 'x')
  const commit = await tete(worktree)

  const result = await adoptWorktree(root, 'repo-feat')

  assert.equal(await branche(principal), 'feat/x', 'le principal tient la branche')
  assert.equal(await tete(principal), commit, 'et le commit du worktree')
  assert.equal(existsSync(worktree), false, 'le dossier du worktree est parti')
  assert.equal(await worktrees(principal), 1, 'git ne liste plus qu’un worktree')
  assert.deepEqual(result, {
    ok: true,
    source: 'repo-feat',
    branch: 'feat/x',
    main: { name: 'repo', path: principal },
    removed: true,
    reason: null,
  })
})

gitTest('un principal sale : refus, rien ne bouge, le fichier est nommé', async (t) => {
  const { root, principal, worktree } = await duo(t, { sale: 'main' })

  const error = await adoptWorktree(root, 'repo-feat').then(() => null, (refusal) => refusal)

  assert.equal(error.status, 409)
  assert.equal(error.side, 'main')
  assert.deepEqual(error.files, ['README.md'])
  assert.equal(error.message, 'repo has uncommitted changes (one file: README.md) — commit or stash them first')
  assert.equal(await branche(principal), 'main', 'le principal n’a pas bougé')
  assert.equal(await branche(worktree), 'feat/x', 'le worktree n’a pas bougé')
  assert.equal(existsSync(worktree), true)
})

gitTest('un worktree sale : refus, même avec un principal propre', async (t) => {
  const { root, principal, worktree } = await duo(t, { sale: 'worktree' })

  const error = await adoptWorktree(root, 'repo-feat').then(() => null, (refusal) => refusal)

  assert.equal(error.side, 'worktree')
  assert.match(error.message, /^the worktree repo-feat has uncommitted changes \(one file: README\.md\)/)
  assert.equal(await branche(principal), 'main')
  assert.equal(await branche(worktree), 'feat/x')
})

gitTest('un switch que git refuse remet le worktree sur sa branche', async (t) => {
  const { root, principal, worktree } = await duo(t)
  await writeFile(join(worktree, 'x.txt'), 'x\n')
  await git(worktree, 'add', '.')
  await git(worktree, 'commit', '-q', '-m', 'x')
  // Un verrou d'index fait échouer le `switch` du principal, arbres propres.
  await writeFile(join(principal, '.git', 'index.lock'), '')

  const error = await adoptWorktree(root, 'repo-feat').then(() => null, (refusal) => refusal)

  assert.equal(error.status, 502)
  assert.match(error.message, /^git refused to switch repo to feat\/x: /)
  assert.match(error.message, /— repo-feat was put back on feat\/x$/)
  assert.equal(await branche(worktree), 'feat/x', 'le worktree est revenu sur sa branche')
  assert.equal(await branche(principal), 'main', 'le principal n’a pas pris la branche')
  assert.equal(existsSync(worktree), true)
})

gitTest('un principal hors racine est refusé, sans écriture', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'missions-adopt-'))
  const ailleurs = await mkdtemp(join(tmpdir(), 'missions-ailleurs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(ailleurs, { recursive: true, force: true }))
  const principal = await depot(t, ailleurs, 'repo')
  const worktree = join(root, 'repo-feat')
  await git(principal, 'worktree', 'add', '-q', '-b', 'feat/x', worktree)

  const error = await adoptWorktree(root, 'repo-feat').then(() => null, (refusal) => refusal)

  assert.equal(error.status, 409)
  assert.match(error.message, /lives outside the workspace root/)
  assert.equal(await branche(principal), 'main')
  assert.equal(await branche(worktree), 'feat/x')
})

gitTest('le scan d’après ne compte plus qu’un dépôt, sur la branche reprise', async (t) => {
  const { root } = await duo(t)
  const avant = await listRepositories(root)
  await adoptWorktree(root, 'repo-feat')
  const apres = await listRepositories(root)

  assert.equal(avant.repositories.length, 2)
  assert.equal(apres.repositories.length, 1, 'le worktree n’est plus une ligne')
  assert.equal(apres.repositories[0].kind, 'clone')
  assert.equal(apres.repositories[0].branch, 'feat/x', 'le principal porte la branche reprise')
})
