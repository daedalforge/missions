import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { removeWorktree } from '../lib/repositories.js'

/**
 * MIS-179: removing a worktree deletes its folder and keeps its branch. These
 * tests run git for real: the behaviour under test is what git does with the
 * folder, which a fake would only repeat.
 */

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

let disponible = true
try {
  await exec('git', ['--version'])
} catch {
  disponible = false
}

const gitTest = (name, fn) => test(name, async (t) => {
  if (!disponible) return t.skip('git absent de la machine')
  await fn(t)
})

/** Un dépôt avec un commit, dans un dossier portant son nom. */
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

/** La racine d'un test : le principal `repo` et son worktree `repo-feat`. */
async function duo(t, { sale = null, ignore = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'missions-remove-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const principal = await depot(t, root, 'repo')
  // Les règles d'ignorés du principal valent pour ses worktrees : elles se
  // posent avant que `repo-feat` n'existe, sinon il naît sur un commit qui ne
  // les a pas et son dossier paraît sale.
  if (ignore) {
    await writeFile(join(principal, '.gitignore'), 'node_modules/\n')
    await git(principal, 'add', '.gitignore')
    await git(principal, 'commit', '-q', '-m', 'ignore node_modules')
  }
  const worktree = join(root, 'repo-feat')
  await git(principal, 'worktree', 'add', '-q', '-b', 'feat/x', worktree)
  if (sale === 'worktree') await writeFile(join(worktree, 'README.md'), 'dirty\n')
  if (sale === 'main') await writeFile(join(principal, 'README.md'), 'dirty\n')
  return { root, principal, worktree }
}

/** Une branche locale existe-t-elle encore, par son nom ? */
const aLaBranche = async (cwd, nom) => (await git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'))
  .split('\n')
  .map((line) => line.trim())
  .includes(nom)

/** Le nombre de worktrees enregistrés dans un dépôt. */
const worktrees = async (cwd) => (await git(cwd, 'worktree', 'list', '--porcelain')).trim().split('\n\n').length

gitTest('un worktree propre part, sa branche reste, et le principal se retrouve seul', async (t) => {
  // Given un dépôt et son worktree propres
  const { root, principal, worktree } = await duo(t)

  // When la suppression aboutit
  const resultat = await removeWorktree(root, 'repo-feat')

  // Then le dossier est parti, la branche et le principal restent
  assert.deepEqual(resultat, { name: 'repo-feat', removed: true })
  assert.equal(existsSync(worktree), false, 'le dossier du worktree a disparu')
  assert.equal(await aLaBranche(principal, 'feat/x'), true, 'la branche locale reste')
  assert.equal(await worktrees(principal), 1, 'git ne connaît plus que le principal')
})

gitTest('un worktree sale refuse et nomme ses fichiers, dossier et branche intacts', async (t) => {
  // Given une modification non commitée dans le worktree
  const { root, principal, worktree } = await duo(t, { sale: 'worktree' })

  // When la suppression est demandée
  const erreur = await removeWorktree(root, 'repo-feat').then(() => null, (cause) => cause)

  // Then le refus nomme le fichier et ne touche à rien
  assert.equal(erreur?.status, 409)
  assert.equal(erreur?.side, 'worktree')
  assert.deepEqual(erreur?.files, ['README.md'])
  assert.match(erreur?.message, /^the worktree repo-feat has uncommitted changes \(one file: README\.md\)/)
  assert.equal(existsSync(worktree), true, 'le dossier est toujours là')
  assert.equal(await aLaBranche(principal, 'feat/x'), true, 'la branche est toujours là')
})

gitTest('des fichiers ignorés demandent le consentement, puis partent avec le dossier', async (t) => {
  // Given un worktree propre qui contient un dossier ignoré
  const { root, principal, worktree } = await duo(t, { ignore: true })
  await mkdir(join(worktree, 'node_modules'))
  await writeFile(join(worktree, 'node_modules', 'junk.js'), 'x\n')

  // When la suppression est demandée sans consentement
  const refus = await removeWorktree(root, 'repo-feat').then(() => null, (cause) => cause)

  // Then le refus nomme l'entrée ignorée et laisse le dossier
  assert.equal(refus?.status, 409)
  assert.equal(refus?.side, 'worktree')
  assert.equal(refus?.ignored, true)
  assert.deepEqual(refus?.files, ['node_modules'])
  assert.match(refus?.message, /^the worktree repo-feat holds 1 ignored entry \(node_modules\)/)
  assert.equal(existsSync(worktree), true)

  // When le client consent
  const resultat = await removeWorktree(root, 'repo-feat', { acceptIgnored: true })

  // Then le dossier part avec ses ignorés, et la branche reste
  assert.deepEqual(resultat, { name: 'repo-feat', removed: true })
  assert.equal(existsSync(worktree), false)
  assert.equal(await aLaBranche(principal, 'feat/x'), true)
})

gitTest('un clone n’a pas de dossier à retirer : la demande est refusée en 400', async (t) => {
  // Given le principal, qui est un clone
  const { root } = await duo(t)

  // When on demande de le retirer
  const erreur = await removeWorktree(root, 'repo').then(() => null, (cause) => cause)

  // Then le refus dit qu'il n'y a pas de dossier de worktree
  assert.equal(erreur?.status, 400)
  assert.match(erreur?.message, /repo is not a worktree/)
})

gitTest('un nom inconnu est un 404, un nom invalide un 400', async (t) => {
  // Given une racine avec un seul dépôt
  const { root } = await duo(t)

  // When le nom ne désigne aucun dossier, ou sort de la racine
  const inconnu = await removeWorktree(root, 'ghost').then(() => null, (cause) => cause)
  const invalide = await removeWorktree(root, '../etc').then(() => null, (cause) => cause)

  // Then chacun reçoit le refus de son espèce
  assert.equal(inconnu?.status, 404)
  assert.match(inconnu?.message, /no git repository named ghost/)
  assert.equal(invalide?.status, 400)
  assert.match(invalide?.message, /invalid repository name/)
})
