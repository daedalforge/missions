#!/usr/bin/env node
/**
 * setup.mjs — génère la configuration Emacs de ce système.
 *
 * Lit `system.yml` (propre au poste, jamais versionné), le valide, installe
 * les paquets des plugins marqués `install: true`, écrit `system-plugins.el`
 * (la liste que `init.el` charge) et pose les deux liens de `~/.emacs.d`.
 *
 * Le YAML est lu ici, pas au démarrage d'Emacs : lancé depuis le Finder,
 * Emacs n'hérite pas du PATH Homebrew et ne peut appeler ni node ni yq.
 * Changer `system.yml` demande donc de relancer ce script.
 *
 * Usage : node setup.mjs [--check] [--skip-install] [--skip-links]
 */

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const userEmacsDirectory = join(process.env.HOME, '.emacs.d')
const emacs = process.env.EMACS || 'emacs'

/** Les neuf plugins, leur module, et le paquet qu'un `install` peut demander. */
const PLUGINS = [
  { name: 'ui', module: 'init-ui', pkg: null },
  { name: 'editing', module: 'init-editing', pkg: null },
  { name: 'crypto', module: 'init-crypto', pkg: null },
  { name: 'markdown', module: 'init-markdown', pkg: 'markdown-mode' },
  { name: 'latex', module: 'init-latex', pkg: 'auctex' },
  { name: 'completion', module: 'init-completion', pkg: null },
  { name: 'projectile', module: 'init-projectile', pkg: 'projectile' },
  { name: 'magit', module: 'init-magit', pkg: 'magit' },
  { name: 'machete', module: 'init-machete', pkg: null },
]

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const skipInstall = args.has('--skip-install') || checkOnly
const skipLinks = args.has('--skip-links') || checkOnly

function fail(message) {
  console.error(`setup: ${message}`)
  process.exit(1)
}

/** Rend `system.yml`, créé depuis l'exemple au premier lancement. */
function readSystemFile() {
  const systemPath = join(here, 'system.yml')
  const examplePath = join(here, 'system.example.yml')
  if (!existsSync(systemPath)) {
    copyFileSync(examplePath, systemPath)
    console.log('system.yml absent : créé depuis system.example.yml')
  }
  return { systemPath, text: readFileSync(systemPath, 'utf8') }
}

/** Valide le document et rend les entrées normalisées, ou lève toutes les erreurs. */
function validate(document, systemPath) {
  const errors = []
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail(`${systemPath} : le document doit être un objet YAML`)
  }
  for (const key of Object.keys(document)) {
    if (key !== 'plugins') {
      errors.push(`clé inconnue à la racine : ${key}`)
    }
  }
  const entries = document.plugins
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    errors.push('`plugins:` doit être un objet, avec une entrée par plugin')
    return { errors, plugins: {} }
  }

  for (const name of Object.keys(entries)) {
    if (!PLUGINS.some((plugin) => plugin.name === name)) {
      errors.push(`plugin inconnu : ${name}`)
    }
  }

  const plugins = {}
  for (const plugin of PLUGINS) {
    const entry = entries[plugin.name]
    if (entry === undefined) {
      errors.push(`plugin manquant : ${plugin.name} (${plugin.module}.el)`)
      continue
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${plugin.name} : l'entrée doit être un objet { load, install }`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'load' && key !== 'install') {
        errors.push(`${plugin.name} : clé inconnue ${key}`)
      }
    }
    if (typeof entry.load !== 'boolean') {
      errors.push(`${plugin.name} : \`load\` doit valoir true ou false`)
      continue
    }
    if (entry.install !== undefined && typeof entry.install !== 'boolean') {
      errors.push(`${plugin.name} : \`install\` doit valoir true ou false`)
      continue
    }
    if (entry.install === true && plugin.pkg === null) {
      errors.push(`install impossible : ${plugin.name} n'a pas de paquet Emacs`)
      continue
    }
    plugins[plugin.name] = { load: entry.load, install: entry.install === true }
  }
  return { errors, plugins }
}

/** Écrit la liste des modules que `init.el` chargera. */
function writeGenerated(plugins) {
  const modules = PLUGINS.filter((plugin) => plugins[plugin.name].load).map(
    (plugin) => plugin.module,
  )
  const generatedPath = join(here, 'system-plugins.el')
  const text = [
    ';;; system-plugins.el --- Généré par setup.mjs, ne pas éditer. -*- lexical-binding: t; -*-',
    ';;',
    ';; Liste des modules décidée par system.yml. Changer le YAML puis relancer',
    ';; `node setup.mjs` : ce fichier est écrasé, jamais édité à la main.',
    '',
    `(setq emacs-plugins '(${modules.join(' ')}))`,
    '',
    '(provide \'system-plugins)',
    ';;; system-plugins.el ends here',
    '',
  ].join('\n')
  writeFileSync(generatedPath, text)
  console.log(
    `system-plugins.el : ${modules.length} module(s) à charger — ${modules.join(', ')}`,
  )
}

/** Lance Emacs en batch avec early-init.el chargé, et rend le code de sortie. */
function runEmacs(expression) {
  return spawnSync(
    emacs,
    [
      '--batch',
      '-Q',
      '-l',
      join(here, 'early-init.el'),
      '--eval',
      '(progn (require (quote package)) (package-initialize))',
      '--eval',
      expression,
    ],
    { encoding: 'utf8' },
  )
}

function packageInstalled(pkg) {
  const result = runEmacs(
    `(princ (if (package-installed-p (quote ${pkg})) "t" "nil"))`,
  )
  if (result.error) {
    fail(`Emacs introuvable : ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`Emacs n'a pas répondu pour ${pkg} : ${result.stderr.trim()}`)
  }
  return result.stdout.trim().split('\n').pop() === 't'
}

/** Installe les paquets des plugins qui demandent `install: true`. */
function installPackages(plugins) {
  const missing = PLUGINS.filter(
    (plugin) => plugins[plugin.name].install && plugin.pkg,
  ).filter((plugin) => !packageInstalled(plugin.pkg))

  if (missing.length === 0) {
    for (const plugin of PLUGINS.filter((entry) => plugins[entry.name].install)) {
      console.log(`déjà installé : ${plugin.pkg}`)
    }
    return
  }

  for (const plugin of missing) {
    console.log(`install ${plugin.pkg}`)
    const result = runEmacs(
      `(progn (package-refresh-contents) (package-install (quote ${plugin.pkg})) (princ "ok"))`,
    )
    if (result.error) {
      fail(`Emacs introuvable : ${result.error.message}`)
    }
    if (result.status !== 0) {
      fail(
        `installation de ${plugin.pkg} impossible : ${result.stderr.trim()}`,
      )
    }
    if (!packageInstalled(plugin.pkg)) {
      fail(`${plugin.pkg} reste introuvable après installation`)
    }
  }
}

/** Pose les deux liens de ~/.emacs.d, sans écraser un fichier réel. */
function linkFiles() {
  mkdirSync(userEmacsDirectory, { recursive: true })
  for (const file of ['early-init.el', 'init.el']) {
    const source = join(here, file)
    const link = join(userEmacsDirectory, file)
    let existing = null
    try {
      existing = lstatSync(link)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
    if (existing && !existing.isSymbolicLink()) {
      fail(`${link} existe et n'est pas un lien : le déplacer, puis relancer`)
    }
    if (existing && readlinkSync(link) === source) {
      console.log(`lien déjà en place : ${link} -> ${source}`)
      continue
    }
    if (existing) {
      unlinkSync(link)
    }
    symlinkSync(source, link)
    console.log(`lien posé : ${link} -> ${source}`)
  }
}

const { systemPath, text } = readSystemFile()

let document
try {
  document = parse(text)
} catch (error) {
  fail(`${systemPath} : YAML invalide — ${error.message}`)
}

const { errors, plugins } = validate(document, systemPath)
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`setup: ${error}`)
  }
  process.exit(1)
}

const loaded = PLUGINS.filter((plugin) => plugins[plugin.name].load)
console.log(
  `${systemPath} : ${PLUGINS.length} plugins, ${loaded.length} chargés`,
)

if (checkOnly) {
  console.log('fichier valide')
  process.exit(0)
}

writeGenerated(plugins)
if (!skipInstall) {
  installPackages(plugins)
}
if (!skipLinks) {
  linkFiles()
}
