#!/usr/bin/env node
/**
 * field.mjs — écrit l'état, la priorité ou l'estimation d'une mission GitHub.
 *
 * Sur une board à statut natif (`statuses:` dans `projects.yml`), l'état
 * s'écrit par la mutation `setIssueStatus`, sauf `ready-for-prod`, qui reste un
 * label posé sur l'issue. La priorité et l'estimation vivent dans les champs
 * d'organisation (`fields:`) quand la board les déclare. Le label `blocked`,
 * lui, reste un label : `gh issue edit <n> --add-label blocked`.
 *
 *   node tools/field.mjs <state|priority|points> <KEY> <valeur> [--projects <fichier>]
 *
 * La valeur est le mot canonique pour l'état et la priorité (`in-review`,
 * `high`), la taille pour l'estimation (`point` de l'échelle du workspace). Le
 * `map` du tracker possède le nom du label et des options de champ, la
 * commande l'affiche.
 *
 * Codes de sortie : 0 écrit, 1 refus (board, clé ou valeur inconnue), 2 usage.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { POINTS_SCALE } from '../lib/mission.js'
import { loadProjects, readerFor, trackerForKey } from '../lib/projects.js'
import { setField, setState } from '../lib/trackers/github.js'

const USAGE = `Usage : node tools/field.mjs <state|priority|points> <KEY> <valeur> [--projects <fichier>]

  state     <KEY> <to-refine|ready|in-progress|in-review|ready-for-prod|done>
  priority  <KEY> <urgent|high|normal|low>
  points    <KEY> <${POINTS_SCALE.join('|')}>

Le label \`blocked\` reste un label : gh issue edit <n> --add-label blocked.
L'état est le statut natif de l'issue ; \`ready-for-prod\` reste un label.
`

function usage(message) {
  if (message) console.error(`field: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

const argv = process.argv.slice(2)
const positional = []
let projectsFile = null
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--projects') {
    projectsFile = argv[index + 1] ?? null
    index += 1
    if (!projectsFile) usage('--projects attend un fichier')
    continue
  }
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  }
  positional.push(arg)
}

const [role, key, ...rest] = positional
if (!role || !key || rest.length === 0) usage('trois arguments sont attendus')
if (!['state', 'priority', 'points'].includes(role)) usage(`rôle inconnu : ${role}`)
const value = rest.join(' ').trim()

let bundle
try {
  bundle = await loadProjects(projectsFile ? pathToFileURL(resolve(projectsFile)) : undefined)
} catch (error) {
  console.error(`field: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { canonical, trackers } = bundle
const tracker = trackerForKey(trackers, key)
if (!tracker) {
  const references = trackers.map((entry) => entry.reference).join(', ')
  console.error(`field: aucune board ne déclare ${key} (références : ${references})`)
  process.exit(1)
}
if (tracker.tracker !== 'github') {
  console.error(`field: ${tracker.id} est une board ${tracker.tracker}, pas GitHub`)
  process.exit(1)
}
if (role === 'state' && !tracker.statuses) {
  console.error(`field: ${tracker.id} ne déclare pas de statuts natifs (statuses) dans projects.yml`)
  process.exit(1)
}
if (role !== 'state' && !tracker.fields?.[role]) {
  console.error(`field: ${tracker.id} ne déclare pas fields.${role} dans projects.yml`)
  process.exit(1)
}

try {
  const result = role === 'state'
    ? await writeState(tracker, canonical, key, value)
    : await writeField(tracker, canonical, key, role, value)
  console.log(`${key} : ${role} → ${result.value} (${tracker.name})`)
} catch (error) {
  console.error(`field: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/** The state is canonical: `setState` owns the native status or the label. */
async function writeState(tracker, canonical, key, value) {
  if (!canonical.states.includes(value)) {
    throw new Error(`${value} n'est pas un state du workspace (${canonical.states.join(', ')})`)
  }
  return setState(readerFor(tracker), key, { state: value })
}

/** The priority and the estimation keep their field's own option names. */
async function writeField(tracker, canonical, key, role, value) {
  if (role === 'points') {
    const target = Number(value)
    if (!POINTS_SCALE.includes(target)) {
      throw new Error(`${value} n'est pas une taille de l'échelle (${POINTS_SCALE.join(', ')})`)
    }
    return setField(readerFor(tracker), key, { role, value: target })
  }
  const allowed = canonical.priorities
  if (!allowed.includes(value)) {
    throw new Error(`${value} n'est pas un priority du workspace (${allowed.join(', ')})`)
  }
  const option = tracker.map?.priorities?.[value]
  if (option === null || option === undefined) {
    throw new Error(`${tracker.id} n'a pas d'option pour ${role} ${value}`)
  }
  return setField(readerFor(tracker), key, { role, value: option })
}
