import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MISSIONS_DIR } from './projects.js'
import { Document, parseDocument, parse } from 'yaml'

/**
 * Mission branches: the properties a tracker does not carry.
 *
 * A mission that can be executed has a folder under `missions/` with a
 * `mission.yml` declaring its `key`, the project it belongs to, its `branch`
 * and its `base`. The folder name is free — the key and the project in the file
 * are what link it to the tracker's mission. Nothing is guessed from the
 * repository: an undeclared branch or base is simply absent.
 */
const PACKAGE_BRANCHES_DIR = new URL('../missions/', import.meta.url)
const PACKAGE_PROJECTS = new URL('../missions/projects.yml', import.meta.url)

/** A checkout reads its local missions; an installed copy reads the user's. */
export const BRANCHES_DIR = existsSync(PACKAGE_PROJECTS) ? PACKAGE_BRANCHES_DIR : pathToFileURL(`${MISSIONS_DIR}/`)
export const MISSION_FILE = 'mission.yml'

const FIELDS = new Set(['key', 'project', 'branch', 'base', 'branches'])

/**
 * Read every `missions/<folder>/mission.yml` into `key -> { branch, base }`.
 *
 * `index` keeps the legacy key-only view (the first declaration of a key), so
 * callers that only have a key keep working. `byProject` holds every
 * declaration under its real identity `(project, key)`; a mission with no
 * declared project stays without one — the file is the only source, nothing
 * is borrowed from the board. Two folders may declare the same key under two
 * different projects; two folders declaring the same `(project, key)` are a
 * duplicate.
 *
 * The tracker list is not read: a board no longer filters the repositories
 * that may declare a mission, so a mission may name any declared project.
 *
 * A broken file is reported and skipped; the other missions stay readable. A
 * folder without a `mission.yml` is not a mission declaration and is ignored.
 */
export async function loadBranches(dir = BRANCHES_DIR, { projects = [] } = {}) {
  const root = toRoot(dir)
  const index = new Map()
  const byProject = new Map()
  const projectByKey = new Map()
  const projectsByKey = new Map()
  const duplicates = new Set()
  const errors = []

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { index, byProject, projectByKey, projectsByKey, duplicates, errors }
    // An unreadable folder must not hide every mission: report it and carry on
    // with no declarations at all.
    errors.push({ project: 'branches', message: `missions folder: ${error.message}` })
    return { index, byProject, projectByKey, projectsByKey, duplicates, errors }
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  for (const folder of folders) {
    const name = `${folder}/${MISSION_FILE}`
    let text
    try {
      text = await readFile(join(root, folder, MISSION_FILE), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      errors.push({ project: 'branches', message: `${name}: ${error.message}` })
      continue
    }

    const parsed = readMission(text)
    if (parsed.error) {
      errors.push({ project: 'branches', message: `${name}: ${parsed.error}` })
      continue
    }

    if (parsed.project && projects.length > 0) {
      const named = projects.find((entry) => entry.id === parsed.project) ?? null
      if (!named) {
        errors.push({ project: 'branches', message: `${name}: project "${parsed.project}" is not declared` })
        continue
      }
    }
    const project = parsed.project ?? null
    const identity = `${project ?? ''}\u0000${parsed.key}`
    const previous = byProject.get(identity)
    if (previous) {
      const suffix = project ? ` for project ${project}` : ''
      errors.push({
        project: 'branches',
        message: `${name}: key "${parsed.key}" is already declared in ${previous.folder}/${MISSION_FILE}${suffix}`,
      })
      continue
    }

    const entry = { folder, branch: parsed.branch, base: parsed.base }
    // Only a file that declares the list carries it: the legacy form stays
    // exactly as read, so a mission declared with one pair keeps its shape.
    if (parsed.listed) entry.branches = parsed.branches
    byProject.set(identity, { key: parsed.key, project, ...entry })
    if (!index.has(parsed.key)) index.set(parsed.key, entry)
    else duplicates.add(parsed.key)
    if (!projectByKey.has(parsed.key)) projectByKey.set(parsed.key, project)
    const projectsFor = projectsByKey.get(parsed.key) ?? []
    if (!projectsFor.includes(project)) projectsFor.push(project)
    projectsByKey.set(parsed.key, projectsFor)
  }

  return { index, byProject, projectByKey, projectsByKey, duplicates, errors }
}

/** Parse and validate one mission file; errors are messages, not exceptions. */
function readMission(text) {
  let raw
  try {
    raw = parse(text)
  } catch (error) {
    return { error: error.message }
  }
  if (raw === null || raw === undefined) return { error: 'the file is empty' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'must be a mapping' }

  const unknown = Object.keys(raw).filter((field) => !FIELDS.has(field))
  if (unknown.length > 0) return { error: `unknown field(s): ${unknown.join(', ')}` }

  const key = readName(raw.key)
  if (key.error) return { error: `key ${key.error}` }
  if (!key.value) return { error: 'key is missing' }

  const project = readName(raw.project)
  if (project.error) return { error: `project ${project.error}` }

  // Two forms, never mixed: the legacy pair of fields, or the list of pairs a
  // split mission declares. An empty `branch: ""` is still the legacy form.
  const listed = Object.prototype.hasOwnProperty.call(raw, 'branches')
  const legacy = Object.prototype.hasOwnProperty.call(raw, 'branch')
    || Object.prototype.hasOwnProperty.call(raw, 'base')
  if (listed && legacy) return { error: 'branch/base and branches cannot be combined' }
  if (listed) {
    const pairs = readPairs(raw.branches)
    if (pairs.error) return { error: pairs.error }
    const [first] = pairs.value
    return {
      key: key.value,
      project: project.value,
      branch: first.branch,
      base: first.base,
      branches: pairs.value,
      listed: true,
    }
  }

  const branch = readName(raw.branch)
  if (branch.error) return { error: `branch ${branch.error}` }
  const base = readName(raw.base)
  if (base.error) return { error: `base ${base.error}` }

  return {
    key: key.value,
    project: project.value,
    branch: branch.value,
    base: base.value,
    branches: [],
    listed: false,
  }
}

/**
 * Read the `branches` list: complete pairs only, each branch declared once.
 *
 * An entry names a branch and the base it stacks on; an unknown key, a missing
 * field or a branch declared twice is refused where it is written, so a typo
 * never becomes a mission with half a list.
 */
function readPairs(value) {
  if (!Array.isArray(value)) return { error: 'branches must be a list' }
  if (value.length === 0) return { error: 'branches must not be empty' }
  const pairs = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `branches[${index}] must be a mapping` }
    }
    const unknown = Object.keys(entry).filter((field) => field !== 'branch' && field !== 'base')
    if (unknown.length > 0) return { error: `branches[${index}] unknown field(s): ${unknown.join(', ')}` }
    const branch = readName(entry.branch)
    if (branch.error) return { error: `branches[${index}] branch ${branch.error}` }
    if (!branch.value) return { error: `branches[${index}] branch is missing` }
    const base = readName(entry.base)
    if (base.error) return { error: `branches[${index}] base ${base.error}` }
    if (!base.value) return { error: `branches[${index}] base is missing` }
    if (seen.has(branch.value)) return { error: `branch "${branch.value}" is declared twice` }
    seen.add(branch.value)
    pairs.push({ branch: branch.value, base: base.value })
  }
  return { value: pairs }
}

function readName(value) {
  if (value === undefined || value === null) return { value: null }
  if (typeof value !== 'string' || value.trim() === '') return { error: 'must be a non-empty string' }
  return { value: value.trim() }
}

const queues = new Map()

/**
 * Declare a mission's project, branch and base, writing `missions/<folder>/mission.yml`.
 *
 * The folder is the one already declaring `(project, key)`, or a slug of the
 * key when the mission has none: the client never chooses a path. A folder
 * with the key and no project is adopted when the save names a project, so a
 * mission declared before the split keeps its history. Saves are serialised per
 * store and renamed into place, so concurrent writes cannot truncate the file
 * or silently drop a save. Comments of an existing file are preserved; an empty
 * branch, base or project is removed from the file. Returns
 * `{ key, folder, project, branch, base }`, throws an error with `status: 400`
 * when the declaration is refused (nothing is written in that case).
 */
export async function saveDeclaration(dir = BRANCHES_DIR, declaration = {}) {
  const root = resolve(toRoot(dir))
  const previous = queues.get(root) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  queues.set(root, tail)

  await previous.catch(() => {})
  try {
    return await writeDeclaration(root, declaration)
  } finally {
    release()
    if (queues.get(root) === tail) queues.delete(root)
  }
}

async function writeDeclaration(root, declaration) {
  const key = readKey(declaration.key)
  const hasProject = Object.prototype.hasOwnProperty.call(declaration, 'project')
  const project = hasProject ? readOptionalName(declaration.project, 'project') : undefined
  const hasBranch = Object.prototype.hasOwnProperty.call(declaration, 'branch')
  const hasBase = Object.prototype.hasOwnProperty.call(declaration, 'base')
  const hasBranches = Object.prototype.hasOwnProperty.call(declaration, 'branches')
  if (hasBranches && (hasBranch || hasBase)) throw invalid('branch/base and branches cannot be combined')
  const branch = hasBranch ? readOptionalName(declaration.branch, 'branch') : undefined
  const base = hasBase ? readOptionalName(declaration.base, 'base') : undefined
  const listed = hasBranches ? readPairs(declaration.branches) : null
  if (listed?.error) throw invalid(listed.error)
  const wantedFolder = readFolder(declaration.folder)

  const folder = wantedFolder ?? (await declaredFolder(root, key, project)) ?? (await freeFolder(root, key, project ?? null))
  const path = join(root, folder, MISSION_FILE)

  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw invalid(`${folder}/${MISSION_FILE}: ${error.message}`)
  }

  const document = text === null ? new Document() : inspectDeclaration(text, folder, key)
  if (document.contents === null) document.commentBefore = header(key)

  // The list is one value: a save that names a single pair must not flatten a
  // mission split into several PRs. Nothing is written when it is refused.
  if (!hasBranches && (hasBranch || hasBase) && documentBranches(document).length > 1) {
    throw invalid(`${folder}/${MISSION_FILE}: this mission declares several branches; save the list instead`)
  }

  document.set('key', key)
  if (hasProject) {
    if (project) document.set('project', project)
    else document.delete('project')
  }
  if (hasBranches) {
    document.set('branches', listed.value.map((pair) => ({ branch: pair.branch, base: pair.base })))
    document.delete('branch')
    document.delete('base')
  } else if (hasBranch || hasBase) {
    if (hasBranch) {
      if (branch) document.set('branch', branch)
      else document.delete('branch')
    }
    if (hasBase) {
      if (base) document.set('base', base)
      else document.delete('base')
    }
    // The legacy form replaces the list: the two forms never coexist.
    document.delete('branches')
  }

  await mkdir(join(root, folder), { recursive: true })
  await writeAtomically(path, String(document))

  const saved = project === undefined ? projectFrom(document) : project
  // A save that names only the project leaves the declared branches untouched,
  // and every answer says what the file now declares. A mission declared with
  // the legacy pair keeps its answer to `branch`/`base` alone.
  const pairs = documentBranches(document)
  const answer = {
    key,
    folder,
    project: saved,
    branch: hasBranches ? pairs[0].branch : hasBranch ? branch : (pairs[0]?.branch ?? document.get('branch') ?? null),
    base: hasBranches ? pairs[0].base : hasBase ? base : (pairs[0]?.base ?? document.get('base') ?? null),
  }
  if (pairs.length > 0) answer.branches = pairs
  return answer
}

/** The folder named by the client: one direct child, never a path. */
function readFolder(value) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (!text || text === '.' || text === '..' || text.includes('/') || text.includes('\\')) {
    throw invalid('folder must be the name of a direct child folder')
  }
  return text
}

/** Folder of the declaration for `(project, key)`, even when its file is invalid. */
async function declaredFolder(root, key, project) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw invalid(`missions folder: ${error.message}`)
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  let adoptable = null
  for (const folder of folders) {
    let text
    try {
      text = await readFile(join(root, folder, MISSION_FILE), 'utf8')
    } catch {
      continue
    }
    const declared = declaredIdentity(text)
    if (declared.key !== key) continue
    if (project === undefined || project === null) return folder
    if (declared.project === project) return folder
    // A save that now names a project adopts the folder declared before the
    // split instead of creating a second one for the same mission.
    if (project !== null && declared.project === null && adoptable === null) adoptable = folder
  }
  return adoptable
}

/** Folder for a declaration that does not exist yet. */
async function freeFolder(root, key, project) {
  const base = folderFor(key)
  if (!existsSync(join(root, base))) return base
  if (project) {
    const prefixed = `${folderFor(project)}-${base}`
    if (!existsSync(join(root, prefixed))) return prefixed
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${prefixed}-${suffix}`
      if (!existsSync(join(root, candidate))) return candidate
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!existsSync(join(root, candidate))) return candidate
  }
}

/**
 * Check an existing declaration before it is rewritten.
 *
 * The key is authoritative and unknown fields are refused, but a missing,
 * empty or ill-typed project, branch or base is not: the save replaces those
 * fields, so a file the list reports as broken stays repairable from the panel.
 */
function inspectDeclaration(text, folder, key) {
  const document = parseDocument(text)
  if (document.errors.length > 0) throw invalid(`${folder}/${MISSION_FILE}: ${document.errors[0].message}`)

  const raw = document.toJS()
  if (raw === null || raw === undefined) return document
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${folder}/${MISSION_FILE}: must be a mapping`)

  const unknown = Object.keys(raw).filter((field) => !FIELDS.has(field))
  if (unknown.length > 0) throw invalid(`${folder}/${MISSION_FILE}: unknown field(s): ${unknown.join(', ')}`)
  if (typeof raw.key !== 'string' || raw.key.trim() !== key) {
    throw invalid(`${folder}/${MISSION_FILE} already declares "${String(raw.key)}"`)
  }
  return document
}

/** The complete pairs a document declares under `branches`, or none. */
function documentBranches(document) {
  const raw = document.get('branches')
  if (raw === null || typeof raw !== 'object') return []
  // `Document.get` keeps the YAML nodes; the answer is plain data.
  const value = typeof raw.toJSON === 'function' ? raw.toJSON() : raw
  if (!Array.isArray(value) || value.length === 0) return []
  const pairs = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const branch = readName(entry.branch)
    const base = readName(entry.base)
    if (!branch.value || !base.value) return []
    pairs.push({ branch: branch.value, base: base.value })
  }
  return pairs
}

/** Identity of a declaration, read leniently so a broken file still blocks a duplicate. */
function declaredIdentity(text) {
  try {
    const raw = parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { key: null, project: null }
    return {
      key: typeof raw.key === 'string' ? raw.key.trim() : null,
      project: typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim() : null,
    }
  } catch {
    return { key: null, project: null }
  }
}

function projectFrom(document) {
  const value = document.get('project')
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function header(key) {
  return ` Déclaration de la mission ${key}\n Fichier local du panneau Missions, jamais versionné.`
}

export async function writeAtomically(path, content) {
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function toRoot(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : String(dir)
}

/** Folder derived from a key, used when the mission has no declaration yet. */
function folderFor(key) {
  const slug = String(key)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw invalid(`cannot derive a folder name from key "${key}"`)
  return slug
}

function readKey(value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('key is missing')
  return value.trim()
}

function readOptionalName(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${field} must be a string`)
  return value.trim() === '' ? null : value.trim()
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/**
 * Attach the declared folder, branch and base to their missions.
 *
 * `byProject` matches on `(project, key)`; without it the legacy key-only index
 * answers. A mission without a declaration keeps all three at `null`: the panel
 * shows nothing rather than a branch it would have derived, and the session
 * prompt cannot name a journal path that does not exist.
 */
export function attachBranches(missions = [], index = new Map(), byProject = null) {
  return missions.map((mission) => {
    const key = String(mission?.key)
    let declared = null
    if (byProject) {
      const project = mission?.project === null || mission?.project === undefined ? '' : String(mission.project)
      declared = byProject.get(`${project}\u0000${key}`) ?? null
    } else {
      declared = index.get(key)
    }
    const attached = {
      ...mission,
      folder: declared?.folder ?? null,
      branch: declared?.branch ?? null,
      base: declared?.base ?? null,
    }
    // Only a list declaration carries the complete pairs; a legacy declaration
    // keeps exactly the three fields it always had.
    if (Array.isArray(declared?.branches) && declared.branches.length > 0) {
      attached.branches = declared.branches
    }
    return attached
  })
}

/** The declaration of `(project, key)`, or of `key` when no project is given. */
export function declarationFor(bundle, key, projectId = '') {
  const wanted = String(projectId ?? '').trim()
  if (wanted) return bundle.byProject?.get(`${wanted}\u0000${key}`) ?? null
  if (bundle.duplicates?.has(key)) return null
  return bundle.index?.get(key) ?? null
}
