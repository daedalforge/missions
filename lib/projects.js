import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

/** Default location: `missions/projects.yml`, at the package root. */
export const PROJECTS_FILE = new URL('../missions/projects.yml', import.meta.url)

const TRACKERS = new Set(['github', 'jira'])
const REFERENCE = /^[A-Z][A-Z0-9]*$/

/**
 * Load and validate the project declarations.
 *
 * A project whose `map` does not cover the whole canonical vocabulary is
 * rejected: an explicit error beats a guessed state on screen.
 */
export async function loadProjects(file = PROJECTS_FILE) {
  const text = await readFile(file, 'utf8')
  const raw = parse(text) ?? {}
  const canonical = readCanonical(raw.canonical)
  const products = readProducts(raw.products)
  const projects = (Array.isArray(raw.projects) ? raw.projects : []).map((project) =>
    validateProject(project, canonical, products),
  )
  assertUniqueReferences(projects)
  return { canonical, products, projects }
}

function readCanonical(canonical) {
  const states = canonical?.states
  const types = canonical?.types
  const priorities = Array.isArray(canonical?.priorities) ? canonical.priorities : []
  if (!Array.isArray(states) || states.length === 0) {
    throw new Error('projects.yml: canonical.states is missing')
  }
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('projects.yml: canonical.types is missing')
  }
  return { states: states.map(String), types: types.map(String), priorities: priorities.map(String) }
}

/** Product labels (Jira) -> display name, in priority order. */
function readProducts(raw) {
  const products = {}
  if (raw === undefined || raw === null) return products
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('projects.yml: products must be a mapping')
  for (const [label, name] of Object.entries(raw)) {
    const key = String(label).trim().toLowerCase()
    const value = String(name ?? '').trim()
    if (!key || !value) throw new Error('projects.yml: products needs a label and a name')
    if (products[key] && products[key] !== value) {
      throw new Error(`projects.yml: product label "${key}" is declared twice`)
    }
    products[key] = value
  }
  return products
}

function validateProject(project, canonical, products) {
  const id = String(project?.id ?? '').trim()
  if (!id) throw new Error('projects.yml: a project has no id')

  const reference = String(project?.reference ?? '').trim()
  if (!reference) throw new Error(`projects.yml: ${id} has no reference`)
  if (!REFERENCE.test(reference)) {
    throw new Error(`projects.yml: ${id} has an invalid reference ("${String(project?.reference ?? '')}")`)
  }

  const tracker = String(project?.tracker ?? '')
  if (!TRACKERS.has(tracker)) {
    throw new Error(`projects.yml: ${id} has an unknown tracker ("${tracker}")`)
  }

  const map = project?.map ?? {}
  const missingStates = canonical.states.filter((state) => !(state in (map.states ?? {})))
  const missingTypes = canonical.types.filter((type) => !(type in (map.types ?? {})))
  const missingPriorities = canonical.priorities.filter((priority) => !(priority in (map.priorities ?? {})))
  if (missingStates.length > 0 || missingTypes.length > 0 || missingPriorities.length > 0) {
    const missing = [...missingStates, ...missingTypes, ...missingPriorities].join(', ')
    throw new Error(`projects.yml: ${id} has no mapping for ${missing}`)
  }

  // A tracker value may name several canonical steps; it may not name two: the
  // last one would win silently, and a mission would take the wrong state.
  for (const kind of ['states', 'types', 'priorities']) {
    assertNoDuplicateValues(id, kind, map[kind])
  }

  return {
    id,
    name: String(project.name ?? id),
    reference,
    repo: project.repo ?? null,
    tracker,
    github: project.github ?? null,
    jira: project.jira ?? null,
    map: { states: map.states, types: map.types, priorities: map.priorities ?? {}, points: map.points ?? null, labels: products },
  }
}

function assertNoDuplicateValues(id, kind, table = {}) {
  const seen = new Map()
  for (const [canonical, value] of Object.entries(table ?? {})) {
    for (const single of Array.isArray(value) ? value : [value]) {
      if (single === null || single === undefined) continue
      const name = String(single)
      const previous = seen.get(name)
      if (previous && previous !== canonical) {
        throw new Error(`projects.yml: ${id} maps "${name}" to both ${previous} and ${canonical}`)
      }
      seen.set(name, canonical)
    }
  }
}

/** The mission key and the epic label are global: a reference names one project. */
function assertUniqueReferences(projects) {
  const seen = new Map()
  for (const project of projects) {
    const previous = seen.get(project.reference)
    if (previous) {
      throw new Error(`projects.yml: reference "${project.reference}" is used by both ${previous} and ${project.id}`)
    }
    seen.set(project.reference, project.id)
  }
}
