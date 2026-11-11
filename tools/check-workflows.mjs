#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

import { loadProjects } from '../lib/projects.js'
import { MODEL_DIR, WORKFLOWS, loadWorkflows } from '../lib/workflows.js'

/**
 * Check every workflow model against its document and the workspace
 * vocabulary.
 *
 * The panel refuses an invalid model at write time; this command is the same
 * check for a working copy — before a commit, or in a review.
 */
const root = process.argv[2]
  ? fileURLToPath(new URL(process.argv[2], `${new URL(`file://${process.cwd()}/`)}`))
  : fileURLToPath(new URL('../', import.meta.url))

const projectsFile = join(root, 'missions', 'projects.yml')

let states
try {
  states = (await loadProjects(projectsFile)).canonical.states
} catch (error) {
  console.error(`✖ ${relative(process.cwd(), projectsFile) || projectsFile} : ${error?.message ?? error}`)
  process.exit(1)
}

const { workflows } = await loadWorkflows(join(root, MODEL_DIR), { states })
let failures = 0

console.log(`workflows · ${workflows.length} étapes · vocabulaire ${states.join(', ')}`)

for (const entry of workflows) {
  const broken = entry.errors.length > 0
  if (broken) failures += 1
  const exit = entry.exit.length ? entry.exit.join(', ') : '(aucune sortie)'
  console.log('')
  console.log(`${broken ? '✖' : '✔'} ${entry.workflow} — ${entry.title} (${entry.entry ?? '?'} → ${exit})`)
  console.log(`  ${entry.file} · ${entry.nodes.length} gestes · ${entry.edges.length} arcs`)
  for (const error of entry.errors) {
    const where = error.field ? `${error.field} · ` : ''
    console.log(`  ${where}${error.code} : ${error.message}`)
  }
  if (entry.orphanSections.length) {
    console.log(`  sections orphelines : ${entry.orphanSections.join(' · ')}`)
  }
}

const missing = WORKFLOWS.filter((workflow) => !workflows.some((entry) => entry.workflow === workflow))
if (missing.length) {
  console.log('')
  console.log(`✖ étapes sans modèle : ${missing.join(', ')}`)
  failures += 1
}

console.log('')
console.log(failures === 0 ? 'modèles valides.' : `${failures} étape(s) invalide(s).`)
process.exit(failures === 0 ? 0 : 1)
