#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

import { loadProjects } from '../lib/projects.js'
import { LOCAL_MODEL_DIR, MODEL_DIR, WORKFLOWS, loadWorkflows } from '../lib/workflows.js'

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

// The versioned directory is the method: its four steps and `statuts` are
// required. The local directory is whatever the workstation keeps out of git;
// an absent one is a fresh clone, not a failure.
const { workflows } = await loadWorkflows(join(root, MODEL_DIR), { states })
const { workflows: local } = await loadWorkflows(join(root, LOCAL_MODEL_DIR), { states })
let failures = 0

console.log(`workflows · ${workflows.length} modèles versionnés · ${local.length} locaux · vocabulaire ${states.join(', ')}`)

for (const entry of [...workflows, ...local]) {
  const broken = entry.errors.length > 0
  if (broken) failures += 1
  const exit = entry.exit.length ? entry.exit.join(', ') : '(aucune sortie)'
  const counts = entry.kind === 'statuts'
    ? `${entry.counts.nodes} états · ${entry.counts.edges} événements`
    : `${entry.counts.nodes} gestes · ${entry.counts.edges} arcs`
  console.log('')
  console.log(`${broken ? '✖' : '✔'} ${entry.workflow} — ${entry.title} (${entry.entry ?? '?'} → ${exit})`)
  console.log(`  ${entry.file} · ${entry.kind} · ${counts}`)
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

const statuts = workflows.find((entry) => entry.workflow === 'statuts')
if (!statuts) {
  console.log('')
  console.log('✖ le workflow des statuts est absent')
  failures += 1
}

console.log('')
console.log(failures === 0 ? 'modèles valides.' : `${failures} modèle(s) invalide(s).`)
process.exit(failures === 0 ? 0 : 1)
