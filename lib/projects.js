import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

import { HttpError } from './http.js'

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
 * Load and validate the declarations.
 *
 * A tracker owns the board: its reference, its kind and the mapping from the
 * canonical vocabulary to the tracker's own values. A project owns a repository
 * and optionally points at the tracker that carries its missions. Splitting the
 * two is what lets several repositories share one board without declaring it
 * twice.
 *
 * A mapping that does not cover the whole canonical vocabulary is rejected: an
 * explicit error beats a guessed state on screen.
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
  if (!Array.isArray(raw.trackers)) {
    throw new Error(
      'projects.yml: `trackers:` is missing; the old schema kept reference and map on each project. Declare one tracker per board (id, reference, tracker, map) and keep only the repository fields (id, name, repo, tracker, translations) on each project — see missions/projects.example.yml.',
    )
  }

  const trackers = raw.trackers.map((tracker) => validateTracker(tracker, canonical, products))
  assertUnique(trackers, 'reference', 'reference')
  assertUnique(trackers, 'id', 'tracker id')

  const projects = (Array.isArray(raw.projects) ? raw.projects : []).map((project) =>
    validateProject(project, trackers),
  )
  assertUnique(projects, 'id', 'project id')

  return { canonical, products, trackers, projects }
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

function validateTracker(tracker, canonical, products) {
  const id = String(tracker?.id ?? '').trim()
  if (!id) throw new Error('projects.yml: a tracker has no id')

  const reference = String(tracker?.reference ?? '').trim()
  if (!reference) throw new Error(`projects.yml: tracker ${id} has no reference`)
  if (!REFERENCE.test(reference)) {
    throw new Error(`projects.yml: tracker ${id} has an invalid reference ("${String(tracker?.reference ?? '')}")`)
  }

  const kind = String(tracker?.tracker ?? '').trim()
  if (!TRACKERS.has(kind)) {
    throw new Error(`projects.yml: tracker ${id} has an unknown tracker ("${kind}")`)
  }

  const map = tracker?.map ?? {}
  const missingStates = canonical.states.filter((state) => !(state in (map.states ?? {})))
  const missingTypes = canonical.types.filter((type) => !(type in (map.types ?? {})))
  const missingPriorities = canonical.priorities.filter((priority) => !(priority in (map.priorities ?? {})))
  if (missingStates.length > 0 || missingTypes.length > 0 || missingPriorities.length > 0) {
    const missing = [...missingStates, ...missingTypes, ...missingPriorities].join(', ')
    throw new Error(`projects.yml: tracker ${id} has no mapping for ${missing}`)
  }

  // A tracker value may name several canonical steps; it may not name two: the
  // last one would win silently, and a mission would take the wrong state.
  for (const name of ['states', 'types', 'priorities']) {
    assertNoDuplicateValues(id, name, map[name])
  }

  return {
    id,
    name: String(tracker.name ?? id),
    reference,
    tracker: kind,
    github: tracker.github ?? null,
    jira: tracker.jira ?? null,
    map: {
      states: map.states,
      types: map.types,
      priorities: map.priorities ?? {},
      points: map.points ?? null,
      labels: products,
    },
  }
}

function validateProject(project, trackers) {
  const id = String(project?.id ?? '').trim()
  if (!id) throw new Error('projects.yml: a project has no id')

  // The board fields moved to `trackers:`. Keeping one here would make two
  // sources of truth for the same mapping, so the error names the field.
  for (const field of ['reference', 'map', 'github', 'jira']) {
    if (project?.[field] !== undefined) {
      throw new Error(
        `projects.yml: ${id} declares ${field}; ${field} belongs to a tracker. Move it to the tracker this project points at.`,
      )
    }
  }

  const repo = String(project?.repo ?? '').trim()
  if (!repo) throw new Error(`projects.yml: ${id} has no repo`)

  const wanted = String(project?.tracker ?? '').trim()
  let tracker = null
  if (wanted) {
    tracker = trackers.find((entry) => entry.id === wanted) ?? null
    if (!tracker) {
      throw new Error(`projects.yml: ${id} points at an unknown tracker ("${wanted}")`)
    }
  }

  return {
    id,
    name: String(project.name ?? id),
    repo,
    tracker: tracker?.id ?? null,
    translations: readTranslations(id, project.translations),
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

function assertUnique(entries, field, label) {
  const seen = new Map()
  for (const entry of entries) {
    const value = entry[field]
    const previous = seen.get(value)
    if (previous) {
      throw new Error(`projects.yml: ${label} "${value}" is used by both ${previous} and ${entry.id}`)
    }
    seen.set(value, entry.id)
  }
}

/** The projects attached to one tracker, in declaration order. */
export function projectsOfTracker(projects, trackerId) {
  return projects.filter((project) => project.tracker === trackerId)
}

/** The tracker whose reference prefixes `key`, the longest match first. */
export function trackerForKey(trackers, key) {
  const text = String(key ?? '')
  let found = null
  for (const tracker of trackers) {
    if (!text.startsWith(`${tracker.reference}-`)) continue
    if (!found || tracker.reference.length > found.reference.length) found = tracker
  }
  return found
}

/**
 * The tracker-facing shape adapters already read: one board, plus the
 * repository fields of the project that carries the mission. `id` stays the
 * tracker's id, so the tracker cache is shared by every project on it; the
 * declared project travels as `projectId`.
 */
export function readerFor(tracker, project = null) {
  return {
    id: tracker.id,
    name: project?.name ?? tracker.name,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    reference: tracker.reference,
    tracker: tracker.tracker,
    github: tracker.github,
    jira: tracker.jira,
    repo: project?.repo ?? null,
    translations: project?.translations ?? null,
    map: tracker.map,
  }
}

/**
 * Resolve the mission a route received to its declared project.
 *
 * A mission key names one tracker by its reference. The project is optional
 * only when that tracker declares exactly one project; otherwise the caller
 * must say which one. Returns `{ tracker, project }`; throws an HttpError the
 * route can send as is.
 */
export function resolveMissionProject({ projects, trackers }, key, projectId = '') {
  const tracker = trackerForKey(trackers, key)
  if (!tracker) throw new HttpError(`no project declares ${key}`, { status: 404 })

  const attached = projectsOfTracker(projects, tracker.id)
  const wanted = String(projectId ?? '').trim()
  if (wanted) {
    const project = attached.find((entry) => entry.id === wanted) ?? null
    if (!project) throw new HttpError('project is required', { status: 400 })
    return { tracker, project }
  }
  if (attached.length === 1) return { tracker, project: attached[0] }
  throw new HttpError('project is required', { status: 400 })
}
