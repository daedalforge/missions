import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** Workspace data lives outside the installed package. */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const MISSIONS_DIR = join(DSH_HOME, 'missions')

/** Default location: the user's `$DSH_HOME/missions/projects.yml`. */
export const PROJECTS_FILE = pathToFileURL(join(MISSIONS_DIR, 'projects.yml'))

/** A checkout keeps its declaration beside the code; an installed copy does not. */
const PACKAGE_PROJECTS_FILE = new URL('../missions/projects.yml', import.meta.url)

/**
 * Prefer the checkout's local declaration, else the user's DSH home.
 *
 * The package never ships `projects.yml` itself: a clone can keep one locally
 * (it is git-ignored), while an installed plugin reads the user's file.
 */
export function defaultProjectsFile() {
  return existsSync(PACKAGE_PROJECTS_FILE) ? PACKAGE_PROJECTS_FILE : PROJECTS_FILE
}

/** Shipped declaration used only to borrow the vocabulary when no file exists. */
export const PROJECTS_EXAMPLE = new URL('../missions/projects.example.yml', import.meta.url)

const TRACKERS = new Set(['github', 'jira'])
const REFERENCE = /^[A-Z][A-Z0-9]*$/

/**
 * Load and validate the project declarations.
 *
 * A project whose `map` does not cover the whole canonical vocabulary is
 * rejected: an explicit error beats a guessed state on screen.
 */
export async function loadProjects(file = defaultProjectsFile()) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const path = file instanceof URL ? fileURLToPath(file) : String(file)
      const missing = new Error(
        `projects.yml not found at ${path}; copy missions/projects.example.yml there, or point the projectsFile option at your workspace file`,
      )
      missing.code = 'ENOENT'
      throw missing
    }
    throw error
  }
  const raw = parse(text) ?? {}
  const canonical = readCanonical(raw.canonical)
  const products = readProducts(raw.products)
  const projects = (Array.isArray(raw.projects) ? raw.projects : []).map((project) =>
    validateProject(project, canonical, products),
  )
  assertUniqueReferences(projects)
  return { canonical, products, projects }
}

/**
 * The canonical vocabulary for screens that only need to read bundled models.
 *
 * A fresh install has no `projects.yml` yet; workflow pages must still open,
 * so the shipped example lends its vocabulary without declaring projects.
 * An explicit path that does not exist keeps the clear error: the caller asked
 * for that workspace, not for the package default.
 */
export async function loadCanonical(file = defaultProjectsFile()) {
  try {
    return (await loadProjects(file)).canonical
  } catch (error) {
    if (file !== defaultProjectsFile() || error?.code !== 'ENOENT') throw error
    return (await loadProjects(PROJECTS_EXAMPLE)).canonical
  }
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
    translations: readTranslations(id, project.translations),
    map: { states: map.states, types: map.types, priorities: map.priorities ?? {}, points: map.points ?? null, labels: products },
  }
}

/**
 * Optional Tolgee side of a project: the locales to check, the file each one
 * lives in, and the locale the French value is read from. Without the block the
 * panel offers no import button, so `null` is a valid answer.
 */
function readTranslations(id, raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`projects.yml: ${id} translations must be a mapping`)
  }
  const locales = raw.locales
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new Error(`projects.yml: ${id} translations.locales is missing`)
  }
  const list = locales.map((locale) => String(locale).trim())
  if (list.some((locale) => locale === '')) {
    throw new Error(`projects.yml: ${id} translations.locales has an empty entry`)
  }
  if (new Set(list).size !== list.length) {
    throw new Error(`projects.yml: ${id} translations.locales is declared twice`)
  }
  const languageFile = String(raw.languageFile ?? '').trim()
  if (!languageFile) throw new Error(`projects.yml: ${id} translations.languageFile is missing`)
  if (!languageFile.includes('{locale}')) {
    throw new Error(`projects.yml: ${id} translations.languageFile needs a {locale} placeholder`)
  }
  const reference = String(raw.reference ?? '').trim()
  if (!reference) throw new Error(`projects.yml: ${id} translations.reference is missing`)
  if (!list.includes(reference)) {
    throw new Error(`projects.yml: ${id} translations.reference "${reference}" is not one of its locales`)
  }
  return { locales: list, languageFile, reference }
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
