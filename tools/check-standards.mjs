#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadProjects } from '../lib/projects.js'
import { STANDARDS_DIR, STANDARDS_STEP_FILES, standardsFiles, standardsProject } from '../lib/view.js'

/**
 * Check the standards index against the files on disk and the session prompts.
 *
 * Three things can drift apart: the files under `standards/`, the index table of
 * `standards/README.md`, and the files the panel names for a step
 * (`STANDARDS_STEP_FILES` in `lib/view.js`). This command fails when they do,
 * and when a project declared in `missions/projects.yml` has no repository
 * sheet. Every error names the file or the step so it can be fixed without
 * guessing.
 *
 * Usage: `node tools/check-standards.mjs [--root <dir>]`; the root defaults to
 * the package root, which is what the test copies into a temporary folder to
 * prove a missing or extra file fails.
 */
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

/** Every markdown file under `standards/`, as repository-relative paths. */
async function listStandards(root) {
  const files = []
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(relative(root, path).split('\\').join('/'))
      }
    }
  }
  await walk(join(root, STANDARDS_DIR))
  return files.sort()
}

/** The files the README indexes: a table row whose first cell is a path. */
function indexedFiles(readme) {
  const files = new Set()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`(standards\/[^`]+\.md)`\s*\|/.exec(line)
    if (match) {
      files.add(match[1])
    }
  }
  return files
}

/** The files each step reads, from the README's reading-contract table. */
function contractRows(readme) {
  const rows = new Map()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|(.*)\|\s*$/.exec(line)
    if (!match) {
      continue
    }
    const step = match[1].trim()
    if (!(step in STANDARDS_STEP_FILES)) {
      continue
    }
    rows.set(step, [...match[2].matchAll(/`([^`]+)`/g)].map((cell) => cell[1]))
  }
  return rows
}

function expand(files, project) {
  return files.map((file) => file.replace('<projet>', project))
}

async function main() {
  const root = rootFromArgs(process.argv.slice(2))
  const readmePath = `${STANDARDS_DIR}/README.md`
  const readme = await readFile(join(root, readmePath), 'utf8')
  const present = await listStandards(root)
  const indexed = indexedFiles(readme)
  const rows = contractRows(readme)
  const { projects } = await loadProjects(join(root, 'missions', 'projects.yml'))

  const errors = []
  for (const file of present) {
    if (!indexed.has(file)) errors.push(`fichier présent mais absent de l'index : ${file}`)
  }
  for (const file of indexed) {
    if (!present.includes(file)) errors.push(`fichier indexé mais absent du disque : ${file}`)
  }

  for (const step of Object.keys(STANDARDS_STEP_FILES)) {
    const row = rows.get(step)
    if (!row) {
      errors.push(`l'index ne donne aucun fichier pour l'étape ${step}`)
      continue
    }
    for (const project of projects) {
      const sheet = standardsProject(project.repo) ?? project.id
      const expected = standardsFiles(step, sheet)
      const declared = expand(row, sheet)
      if (declared.join(', ') !== expected.join(', ')) {
        errors.push(
          `l'étape ${step} de l'index cite ${declared.join(', ') || '(rien)'} alors que le prompt cite ${expected.join(', ')}`,
        )
      }
    }
  }

  for (const project of projects) {
    const sheet = standardsProject(project.repo) ?? project.id
    const path = `${STANDARDS_DIR}/repos/${sheet}.md`
    if (!present.includes(path)) errors.push(`projet ${project.id} déclaré sans fiche : ${path}`)
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`✖ ${error}`)
    }
    process.exitCode = 1
    return
  }
  const steps = Object.keys(STANDARDS_STEP_FILES).length
  console.log(`OK — ${present.length} fichiers indexés, ${steps} étapes, ${projects.length} projets déclarés.`)
}

main().catch((error) => {
  console.error(`✖ ${error.message}`)
  process.exitCode = 1
})
