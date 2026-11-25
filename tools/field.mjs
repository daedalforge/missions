#!/usr/bin/env node
/**
 * field.mjs — écrit l'état, la priorité ou l'estimation d'une mission GitHub.
 *
 * Sur une board à champs d'organisation (`fields:` dans `projects.yml`), ces
 * trois valeurs ne sont plus des labels : elles vivent dans `Workflow stage`,
 * `Priority` et `Story point`. Le panneau les écrit par ses routes ; une session
 * a cette commande pour le même geste. Le label `blocked`, lui, reste un label :
 * `gh issue edit <n> --add-label blocked`.
 *
 *   node tools/field.mjs <state|priority|points> <KEY> <valeur> [--projects <fichier>]
 *
 * La valeur est le mot canonique pour l'état et la priorité (`in-review`,
 * `high`), la taille pour l'estimation (`point` de l'échelle du workspace). Le
 * `map` du tracker possède le nom de l'option, la commande l'affiche.
 *
 * Codes de sortie : 0 écrit, 1 refus (board, clé ou valeur inconnue), 2 usage.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { POINTS_SCALE } from '../lib/mission.js'
import { loadProjects, readerFor, trackerForKey } from '../lib/projects.js'
import { setField } from '../lib/trackers/github.js'

const USAGE = `Usage : node tools/field.mjs <state|priority|points> <KEY> <valeur> [--projects <fichier>]

  state     <KEY> <to-refine|ready|in-progress|in-review|ready-for-prod|done>
  priority  <KEY> <urgent|high|normal|low>
  points    <KEY> <${POINTS_SCALE.join('|')}>

Le label \`blocked\` reste un label : gh issue edit <n> --add-label blocked.
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
if (!tracker.fields?.[role]) {
  console.error(`field: ${tracker.id} ne déclare pas fields.${role} dans projects.yml`)
  process.exit(1)
}

let target = value
if (role === 'points') {
  target = Number(value)
  if (!POINTS_SCALE.includes(target)) {
    console.error(`field: ${value} n'est pas une taille de l'échelle (${POINTS_SCALE.join(', ')})`)
    process.exit(1)
  }
} else {
  const allowed = role === 'state' ? canonical.states : canonical.priorities
  if (!allowed.includes(value)) {
    console.error(`field: ${value} n'est pas un ${role} du workspace (${allowed.join(', ')})`)
    process.exit(1)
  }
  const option = tracker.map?.[role === 'state' ? 'states' : 'priorities']?.[value]
  if (option === null || option === undefined) {
    console.error(`field: ${tracker.id} n'a pas d'option pour ${role} ${value}`)
    process.exit(1)
  }
  target = option
}

try {
  const result = await setField(readerFor(tracker), key, { role, value: target })
  console.log(`${key} : ${role} → ${result.value} (${tracker.name})`)
} catch (error) {
  console.error(`field: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
