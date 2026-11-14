#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SECTIONS,
  checkPage,
  contractRows,
  indexedPages,
} from '../lib/playbook-rules.js'
import { PLAYBOOK_DIR, PLAYBOOK_STEP_FILES, PLAYBOOK_WORKSPACE, playbookFile } from '../lib/view.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

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
