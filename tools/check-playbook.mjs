#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLAYBOOK_DIR, PLAYBOOK_STEP_FILES, PLAYBOOK_WORKSPACE, playbookFile } from '../lib/view.js'

/**
 * Check the playbook against the files on disk, its index and the prompts.
 *
 * Four things can drift apart: the pages under `playbook/`, the index table of
 * `playbook/README.md`, the files the panel names for a step
 * (`PLAYBOOK_STEP_FILES` in `lib/view.js`), and the shape of each page — the
 * five sections, the entry/exit line, the `workflows/` document and the
 * `standards/` paths it names. This command fails when they do. Every error
 * names the file or the step so it can be fixed without guessing.
 *
 * Usage: `node tools/check-playbook.mjs [--root <dir>]`; the root defaults to
 * the package root, which is what the test copies into a temporary folder to
 * prove a missing or extra page fails.
 */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** The five sections every page carries, in order. */
const SECTIONS = [
  "## Avant d'agir",
  "## Les gestes, dans l'ordre",
  '## Pièges observés',
  '## Preuve de sortie',
  '## Où lire les règles',
]

/** The states a page declares, as the workflow model names them. */
const STATES = {
  cadrage: { entry: 'to-refine', exit: 'ready' },
  'exécution': { entry: 'ready', exit: 'in-review' },
  revue: { entry: 'in-review', exit: 'ready-for-prod' },
  'clôture': { entry: 'ready-for-prod', exit: 'done' },
}

/** The `workflows/` document each step page puts into practice. */
const WORKFLOW_DOCS = {
  cadrage: 'workflows/cadrage.md',
  'exécution': 'workflows/execution.md',
  revue: 'workflows/review.md',
  'clôture': 'workflows/cloture.md',
}

const MAX_LINES = 80

function rootFromArgs(argv) {
  if (argv.length === 0) {
    return REPO_ROOT
  }
  const [first, second] = argv
  const value = first === '--root' ? second : first
  if (!value) {
    throw new Error('--root expects a directory')
  }
  return resolve(process.cwd(), value)
}

/** Every page under `playbook/` except the README, as repository-relative paths. */
async function listPages(root) {
  const pages = []
  async function walk(folder) {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue
      }
      const page = relative(root, path).split('\\').join('/')
      if (page !== `${PLAYBOOK_DIR}/README.md`) {
        pages.push(page)
      }
    }
  }
  await walk(join(root, PLAYBOOK_DIR))
  return pages.sort()
}

/** The pages the README indexes: a table row whose first cell is a path. */
function indexedPages(readme) {
  const pages = new Set()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`(playbook\/[^`]+\.md)`\s*\|/.exec(line)
    if (match) {
      pages.add(match[1])
    }
  }
  return pages
}

/** The page each step reads, from the README's reading-contract table. */
function contractRows(readme) {
  const rows = new Map()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|(.*)\|\s*$/.exec(line)
    if (!match) {
      continue
    }
    const step = match[1].trim()
    if (!(step in PLAYBOOK_STEP_FILES)) {
      continue
    }
    rows.set(step, [...match[2].matchAll(/`([^`]+)`/g)].map((cell) => cell[1]))
  }
  return rows
}

/** The body of each `## ` section, keyed by its exact heading. */
function sections(source) {
  const bodies = new Map()
  let current = null
  for (const line of source.split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      current = `## ${heading[1].trim()}`
      bodies.set(current, [])
      continue
    }
    if (current !== null) {
      bodies.get(current).push(line)
    }
  }
  return new Map([...bodies].map(([name, lines]) => [name, lines.join('\n')]))
}

/** The step a page belongs to, or null for the workspace page. */
function stepOfPage(page) {
  const file = basename(page)
  return Object.keys(PLAYBOOK_STEP_FILES).find((step) => PLAYBOOK_STEP_FILES[step] === file) ?? null
}

function checkPage(page, source, errors) {
  const lines = (source.match(/\n/g) ?? []).length
  if (lines > MAX_LINES) {
    errors.push(`${page} : ${lines} lignes, au-delà de ${MAX_LINES}`)
  }
  const bodies = sections(source)
  for (const section of SECTIONS) {
    if (!bodies.has(section)) {
      errors.push(`${page} : section manquante « ${section} »`)
    }
  }

  const rules = bodies.get('## Où lire les règles') ?? ''
  const step = stepOfPage(page)
  if (step === null) {
    if (!rules.includes('workflows/')) {
      errors.push(`${page} : la section « Où lire les règles » ne nomme aucun document workflows/`)
    }
    if (!/standards\/[\w./-]+\.md/.test(rules)) {
      errors.push(`${page} : la section « Où lire les règles » ne nomme aucun chemin standards/`)
    }
    return
  }

  const states = STATES[step] ?? null
  const declared = /Entrée\s*:\s*([a-z-]+)\s*→\s*Sortie\s*:\s*([a-z-]+)/.exec(source)
  if (!declared) {
    errors.push(`${page} : la ligne « Entrée : <état> → Sortie : <état> » manque`)
  } else if (states && (declared[1] !== states.entry || declared[2] !== states.exit)) {
    errors.push(
      `${page} : « Entrée : ${declared[1]} → Sortie : ${declared[2]} », attendu « Entrée : ${states.entry} → Sortie : ${states.exit} »`,
    )
  }

  const document = WORKFLOW_DOCS[step] ?? null
  if (document && !rules.includes(document)) {
    errors.push(`${page} : la section « Où lire les règles » ne nomme pas ${document}`)
  }
}

async function main() {
  const root = rootFromArgs(process.argv.slice(2))
  const readmePath = `${PLAYBOOK_DIR}/README.md`
  const readme = await readFile(join(root, readmePath), 'utf8')
  const present = await listPages(root)
  const indexed = indexedPages(readme)
  const rows = contractRows(readme)

  const errors = []
  for (const page of present) {
    if (!indexed.has(page)) errors.push(`page présente mais absente de l'index : ${page}`)
  }
  for (const page of indexed) {
    if (!present.includes(page)) errors.push(`page indexée mais absente du disque : ${page}`)
  }

  for (const step of Object.keys(PLAYBOOK_STEP_FILES)) {
    const expected = playbookFile(step)
    const row = rows.get(step)
    if (!row || row.length === 0) {
      errors.push(`le contrat de lecture ne nomme aucune page pour l'étape ${step}`)
      continue
    }
    if (row[0] !== expected) {
      errors.push(`l'étape ${step} du contrat cite ${row[0]} alors que le prompt cite ${expected}`)
    }
    if (!present.includes(expected)) {
      errors.push(`l'étape ${step} pointe ${expected}, absent du disque`)
    }
  }

  const workspace = `${PLAYBOOK_DIR}/${PLAYBOOK_WORKSPACE}`
  if (!readme.includes(workspace)) {
    errors.push(`le contrat de lecture ne nomme pas ${workspace}`)
  }
  if (!present.includes(workspace)) {
    errors.push(`page du contrat absente du disque : ${workspace}`)
  }

  for (const page of present) {
    const source = await readFile(join(root, page), 'utf8')
    checkPage(page, source, errors)
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`✖ ${error}`)
    }
    process.exitCode = 1
    return
  }
  const steps = Object.keys(PLAYBOOK_STEP_FILES).length
  console.log(`OK — ${present.length} pages, ${steps} étapes, ${SECTIONS.length} sections.`)
}

main().catch((error) => {
  console.error(`✖ ${error.message}`)
  process.exitCode = 1
})
