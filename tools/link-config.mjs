#!/usr/bin/env node
/**
 * link-config.mjs — pose les liens de la configuration du poste.
 *
 * Le manifeste `config/links-home.yml` déclare chaque lien : source dans ce
 * dépôt, cible réelle, plateforme. Le mode par défaut, `--check`, n'écrit rien
 * et sort en 1 dès qu'un lien manque, dérive ou qu'une cible est occupée par un
 * fichier régulier. `--apply` pose les liens.
 *
 *   node tools/link-config.mjs [--check | --apply] [--platform <name>] [--home <dir>] [--force]
 *
 * `--platform` vaut `uname -s` sur le poste (`darwin`, `linux`) ; `--home` vaut
 * `$HOME` et sert à éprouver la pose dans un dossier temporaire. Un fichier
 * régulier n'est jamais écrasé sans `--force` ; un dossier ne l'est jamais.
 *
 * Codes de sortie : 0 tout est en place, 1 un lien manque ou dérive, 2 usage ou
 * manifeste invalide.
 */
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LINK_BLOCKED,
  LINK_DRIFT,
  LINK_MISSING,
  LINK_OK,
  PLATFORMS,
  classifyTarget,
  missingSources,
  parseManifest,
  planLinks,
} from '../lib/config-links.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const MANIFEST = join(REPO_ROOT, 'config/links-home.yml')

const USAGE = `Usage : node tools/link-config.mjs [--check | --apply] [--platform <name>] [--home <dir>] [--force]

  --check            (défaut) vérifie sans rien écrire, sort en 1 en dérive
  --apply            pose les liens déclarés par config/links-home.yml
  --platform <name>  plateforme visée : ${PLATFORMS.join(', ')} (défaut : le poste)
  --home <dir>       dossier racine des cibles (défaut : $HOME)
  --force            remplace un fichier régulier à la place d'une cible
  -h, --help         affiche cette aide`

function die(message, code = 2) {
  console.error(`erreur  ${message}`)
  if (code === 2) console.error(`\n${USAGE}`)
  process.exit(code)
}

const args = process.argv.slice(2)
let mode = 'check'
let platform = process.platform
let home = process.env.HOME ?? homedir()
let force = false

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--check') mode = 'check'
  else if (arg === '--apply') mode = 'apply'
  else if (arg === '--force') force = true
  else if (arg === '--platform') platform = args[(index += 1)]
  else if (arg === '--home') home = args[(index += 1)]
  else if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  } else die(`argument inconnu : ${arg}`)

  if ((arg === '--platform' || arg === '--home') && !args[index]) {
    die(`${arg} attend une valeur`)
  }
}

if (!home) die('aucun dossier personnel : passer --home')

let manifest
try {
  manifest = parseManifest(await readFile(MANIFEST, 'utf8'), { file: 'config/links-home.yml' })
} catch (error) {
  die(error.message, 2)
}

const absent = missingSources(manifest, { repoRoot: REPO_ROOT, exists: (path) => existsSync(path) })
if (absent.length > 0) die(`source absente du dépôt : ${absent.join(', ')}`)

let links
try {
  links = planLinks(manifest, { platform, home, repoRoot: REPO_ROOT })
} catch (error) {
  die(error.message, 2)
}

const HOME = resolve(home)
const show = (path) => (path === HOME || !path.startsWith(HOME + sep) ? path : `~/${path.slice(HOME.length + 1)}`)

const LABELS = {
  [LINK_OK]: 'ok',
  [LINK_MISSING]: 'absent',
  [LINK_DRIFT]: 'en dérive',
  [LINK_BLOCKED]: 'occupé',
}

/** Ce que le système montre à la place d'une cible. */
async function observe(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return { kind: 'link', linkTarget: await readlink(path) }
    if (info.isDirectory()) return { kind: 'directory', linkTarget: null }
    return { kind: 'file', linkTarget: null }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { kind: 'missing', linkTarget: null }
    throw error
  }
}

/** Remplace ce qui occupe la cible par le lien attendu. */
async function applyLink(link) {
  await mkdir(dirname(link.target), { recursive: true })
  await rm(link.target, { force: true })
  await symlink(link.source, link.target)
}

let failures = 0
const report = (state, link, detail = '') => {
  const suffix = detail ? ` (${detail})` : ''
  console.log(`  ${LABELS[state].padEnd(9)} ${show(link.target)} → ${link.declaredSource}${suffix}`)
}

/** Vérifie ou pose un lien, selon le mode. */
async function reconcile(link) {
  const observed = await observe(link.target)
  const state = classifyTarget({ ...observed, source: link.source })

  if (mode === 'check') {
    if (state !== LINK_OK) failures += 1
    report(state, link, state === LINK_DRIFT && observed.linkTarget ? `pointe vers ${show(observed.linkTarget)}` : '')
    return
  }

  if (state === LINK_OK) {
    report(state, link, 'déjà en place')
    return
  }

  if (state === LINK_BLOCKED) {
    const what = observed.kind === 'directory' ? 'un dossier' : 'un fichier régulier'
    if (observed.kind === 'directory' || !force) {
      failures += 1
      const why = observed.kind === 'directory' ? 'jamais remplacé' : 'refus d’écraser sans --force'
      console.log(`  ${LABELS[LINK_BLOCKED].padEnd(9)} ${show(link.target)} — ${what} à la place d’un lien, ${why}`)
      return
    }
    await applyLink(link)
    report(LINK_OK, link, 'fichier régulier remplacé (--force)')
    return
  }

  if (state === LINK_MISSING) {
    await applyLink(link)
    report(LINK_OK, link, 'lien posé')
    return
  }

  // LINK_DRIFT: an existing symlink pointing elsewhere, replaced by the link.
  await applyLink(link)
  report(LINK_OK, link, 'lien repoointé')
}

for (const link of links) {
  try {
    await reconcile(link)
  } catch (error) {
    // A sandbox refusal (EPERM), a read-only home, a broken parent path: the
    // line is reported like any other out-of-place link, never a raw crash.
    failures += 1
    console.log(`  erreur    ${show(link.target)} — ${error.message}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} lien(s) hors état sur ${links.length} — ${mode === 'check' ? 'relancer --apply' : 'voir ci-dessus'}`)
  process.exit(1)
}

console.log(`\n${links.length} lien(s) en place sur la plateforme ${platform}`)
