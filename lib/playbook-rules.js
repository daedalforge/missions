/**
 * The form of a playbook page, shared by the CLI and the panel.
 *
 * `tools/check-playbook.mjs` is the reference: it keeps its IO and its
 * `main()`, and imports these rules so a save from the panel refuses exactly
 * what the command line would refuse. Nothing here touches the disk: the CLI
 * reads the tree, `lib/playbooks.js` reads one page, both hand the text to
 * `checkPage`.
 */

import { basename } from 'node:path'

import { PLAYBOOK_STEP_FILES } from './view.js'

/** The six sections every page carries, in the order the contract names them. */
export const SECTIONS = [
  "## Avant d'agir",
  "## Les gestes, dans l'ordre",
  '## Pièges observés',
  '## Preuve de sortie',
  '## Les règles',
  '## La fiche du dépôt',
]

/** The states a step enters and leaves, as the page's first table says them. */
export const STATES = {
  cadrage: { entry: 'to-refine', exit: 'ready' },
  'exécution': { entry: 'ready', exit: 'in-review' },
  revue: { entry: 'in-review', exit: 'ready-for-prod' },
  'clôture': { entry: 'ready-for-prod', exit: 'done' },
}

/** The workflow document each step's page must cite. */
export const WORKFLOW_DOCS = {
  cadrage: 'workflows/cadrage.md',
  'exécution': 'workflows/execution.md',
  revue: 'workflows/review.md',
  'clôture': 'workflows/cloture.md',
}

/** The eight repositories the repository sheet must name. */
export const REPOS = [
  'missions',
  'manager',
  'connect',
  'clienthub',
  'backend',
  'core-service',
  'marketplace-service',
  'ticketing-service',
]

/** A page longer than this many lines is out of contract. */
export const MAX_LINES = 200

/** The workspace page numbers this many interdictions. */
export const INTERDICTS = 13

/** The pages the index table names, as paths from the repository root. */
export function indexedPages(readme) {
  const pages = new Set()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`(playbook\/[^`]+\.md)`\s*\|/.exec(line)
    if (match) {
      pages.add(match[1])
    }
  }
  return pages
}

/** The pages the reading contract names for each step, in table order. */
export function contractRows(readme) {
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

/** Split a page into its `## ` sections, heading included as the key. */
export function sections(source) {
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

/** The step whose page this is, or null for a page outside the parcours. */
export function stepOfPage(page) {
  const file = basename(page)
  return Object.keys(PLAYBOOK_STEP_FILES).find((step) => PLAYBOOK_STEP_FILES[step] === file) ?? null
}

/** The numbers of a numbered list, in the order they appear. */
export function numberedItems(body) {
  return body
    .split('\n')
    .map((line) => /^(\d+)\.\s/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]))
}

/** Push every rule a page breaks; an empty list means the page passes. */
export function checkPage(page, source, errors) {
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

  const fiche = bodies.get('## La fiche du dépôt') ?? ''
  for (const repo of REPOS) {
    if (!fiche.includes(`\`${repo}\``)) {
      errors.push(`${page} : la fiche du dépôt ne nomme pas \`${repo}\``)
    }
  }

  const step = stepOfPage(page)
  if (step === null) {
    const rules = bodies.get('## Les règles') ?? ''
    const items = numberedItems(rules)
    if (items.length !== INTERDICTS || items.some((item, index) => item !== index + 1)) {
      errors.push(`${page} : la section « Les règles » ne numérote pas les ${INTERDICTS} interdits`)
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
  if (document && !source.includes(document)) {
    errors.push(`${page} : la page ne nomme pas ${document}`)
  }
}
