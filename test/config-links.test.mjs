import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  LINK_BLOCKED,
  LINK_DRIFT,
  LINK_MISSING,
  LINK_OK,
  classifyTarget,
  missingSources,
  parseManifest,
  planLinks,
} from '../lib/config-links.js'

/**
 * Les liens de la configuration du poste : un manifeste, un calcul pur, une
 * pose.
 *
 * Ces tests lisent le vrai manifeste du dépôt et le vrai fichier de config
 * Ghostty ; la pose, elle, se joue dans un `$HOME` temporaire, jamais dans le
 * dossier personnel de qui lance la suite.
 */
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../config/links-home.yml', import.meta.url))
const COMMAND = fileURLToPath(new URL('../tools/link-config.mjs', import.meta.url))
const run = promisify(execFile)

async function manifestText() {
  return readFile(MANIFEST, 'utf8')
}

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'missions-links-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

/** Lance la commande et rend son code de sortie, sans lever d'exception. */
async function command(...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [COMMAND, ...args], { cwd: ROOT })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const DARWIN_TARGET = 'Library/Application Support/com.mitchellh.ghostty/config'
const LINUX_TARGET = '.config/ghostty/config'

test('le manifeste du dépôt est valide et déclare les deux variantes', async () => {
  const manifest = parseManifest(await manifestText())

  assert.deepEqual(
    manifest.links.map((link) => [link.platform, link.source]),
    [
      ['darwin', 'config/tools/ghostty/config-darwin'],
      ['linux', 'config/tools/ghostty/config-linux'],
    ],
  )
  assert.ok(manifest.links.every((link) => link.target.startsWith('~/')))
})

test('une plateforme inconnue est refusée, celle du poste ouvre les bons liens', async () => {
  const manifest = parseManifest(await manifestText())

  assert.throws(() => parseManifest('links:\n  - {source: a, target: ~/a, platform: solaris}\n'), /unknown platform/)
  assert.throws(() => planLinks(manifest, { platform: 'freebsd', home: '/tmp', repoRoot: ROOT }), /unknown platform/)

  const darwin = planLinks(manifest, { platform: 'darwin', home: '/home/test', repoRoot: ROOT })
  const linux = planLinks(manifest, { platform: 'linux', home: '/home/test', repoRoot: ROOT })
  assert.equal(darwin.length, 1)
  assert.equal(linux.length, 1)
  assert.equal(darwin[0].target, join('/home/test', DARWIN_TARGET))
  assert.equal(linux[0].target, join('/home/test', LINUX_TARGET))
  assert.equal(darwin[0].source, join(ROOT, 'config/tools/ghostty/config-darwin'))
})

test('une source absente du dépôt est signalée', async () => {
  const manifest = parseManifest(await manifestText())
  const present = new Set(manifest.links.map((link) => join(ROOT, link.source)))

  assert.deepEqual(missingSources(manifest, { repoRoot: ROOT, exists: (path) => present.has(path) }), [])
  assert.deepEqual(
    missingSources(manifest, { repoRoot: ROOT, exists: (path) => path.endsWith('config-darwin') }),
    ['config/tools/ghostty/config-linux'],
  )
})

test('une source qui sort du dépôt et une cible qui sort de $HOME sont refusées', () => {
  assert.throws(() => parseManifest('links:\n  - {source: ../konoha/config, target: ~/a}\n'), /inside the repository/)
  assert.throws(() => parseManifest('links:\n  - {source: /etc/passwd, target: ~/a}\n'), /inside the repository/)
  assert.throws(() => parseManifest('links:\n  - {source: config/a, target: ~/../b}\n'), /inside \$HOME/)
  assert.throws(() => parseManifest('links:\n  - {source: config/a, target: /etc/a}\n'), /must start with "~\/"/)
})

test('un manifeste incomplet ou une cible déclarée deux fois sont refusés', () => {
  assert.throws(() => parseManifest('links:\n  - {target: ~/a}\n'), /"source" is missing/)
  assert.throws(() => parseManifest('links:\n  - {source: config/a}\n'), /"target" is missing/)
  assert.throws(() => parseManifest('links: []\n'), /non-empty list/)
  assert.throws(() => parseManifest('links: [\n'), /invalid YAML/)
  assert.throws(
    () => parseManifest('links:\n  - {source: config/a, target: ~/a}\n  - {source: config/b, target: ~/a}\n'),
    /declared twice/,
  )
})

test('un lien bon, en dérive, absent ou bloqué sont distingués', () => {
  const source = join(ROOT, 'config/tools/ghostty/config-darwin')

  assert.equal(classifyTarget({ kind: 'link', linkTarget: source, source }), LINK_OK)
  assert.equal(classifyTarget({ kind: 'link', linkTarget: '/tmp/konoha/config', source }), LINK_DRIFT)
  assert.equal(classifyTarget({ kind: 'missing', source }), LINK_MISSING)
  assert.equal(classifyTarget({ kind: 'file', source }), LINK_BLOCKED)
  assert.equal(classifyTarget({ kind: 'directory', source }), LINK_BLOCKED)
})

test('--check sort en 1 avant la pose et en 0 après, --apply pose les deux liens', async (t) => {
  const home = await temporaryHome(t)
  const darwin = join(home, DARWIN_TARGET)
  const linux = join(home, LINUX_TARGET)

  const before = await command('--check', '--home', home, '--platform', 'darwin')
  assert.equal(before.code, 1)
  assert.match(before.stdout, /absent/)

  assert.equal((await command('--apply', '--home', home, '--platform', 'darwin')).code, 0)
  assert.equal((await command('--apply', '--home', home, '--platform', 'linux')).code, 0)
  assert.equal((await readFile(darwin, 'utf8')).includes('config-file = ~/projects/missions'), true)
  assert.equal((await readFile(linux, 'utf8')).includes('config-file = ~/projects/missions'), true)

  const after = await command('--check', '--home', home, '--platform', 'darwin')
  assert.equal(after.code, 0)
  assert.equal((await command('--check', '--home', home, '--platform', 'linux')).code, 0)
})

test('un fichier régulier à la place d’une cible n’est pas écrasé sans --force', async (t) => {
  const home = await temporaryHome(t)
  const target = join(home, DARWIN_TARGET)
  await mkdir(join(home, 'Library/Application Support/com.mitchellh.ghostty'), { recursive: true })
  await writeFile(target, 'real file\n')

  const blocked = await command('--apply', '--home', home, '--platform', 'darwin')
  assert.equal(blocked.code, 1)
  assert.match(blocked.stdout, /--force/)
  assert.equal(await readFile(target, 'utf8'), 'real file\n')

  const forced = await command('--apply', '--home', home, '--platform', 'darwin', '--force')
  assert.equal(forced.code, 0)
  assert.equal(await readlink(target), join(ROOT, 'config/tools/ghostty/config-darwin'))
})

test('un lien qui pointe ailleurs est repoointé par --apply', async (t) => {
  const home = await temporaryHome(t)
  const target = join(home, DARWIN_TARGET)
  await mkdir(join(home, 'Library/Application Support/com.mitchellh.ghostty'), { recursive: true })
  await symlink(join(ROOT, 'config/tools/ghostty/config-linux'), target)

  const check = await command('--check', '--home', home, '--platform', 'darwin')
  assert.equal(check.code, 1)
  assert.match(check.stdout, /en dérive/)

  assert.equal((await command('--apply', '--home', home, '--platform', 'darwin')).code, 0)
  assert.equal((await command('--check', '--home', home, '--platform', 'darwin')).code, 0)
})

test('la commande refuse un argument inconnu', async () => {
  const unknown = await command('--nope')
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /argument inconnu/)
})

test('une option sans valeur est refusée, --help sort en 0', async () => {
  const orphan = await command('--home', '--force')
  assert.equal(orphan.code, 2)
  assert.match(orphan.stderr, /--home attend une valeur/)

  assert.equal((await command('--platform')).code, 2)

  const help = await command('--help')
  assert.equal(help.code, 0)
  assert.match(help.stdout, /Usage/)
})
