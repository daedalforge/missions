import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Document, parseDocument, parse } from 'yaml'

/**
 * Mission branches: the two properties a tracker does not carry.
 *
 * A mission that can be executed has a folder under `missions/` with a
 * `mission.yml` declaring its `key`, its `branch` and its `base`. The folder
 * name is free — the key in the file is what links it to the tracker's mission.
 * Nothing is guessed from the repository: an undeclared branch or base is
 * simply absent.
 */
export const BRANCHES_DIR = new URL('../missions/', import.meta.url)
export const MISSION_FILE = 'mission.yml'

const FIELDS = new Set(['key', 'branch', 'base'])

/**
 * Read every `missions/<folder>/mission.yml` into `key -> { branch, base }`.
 *
 * A broken file is reported and skipped; the other missions stay readable. A
 * folder without a `mission.yml` is not a mission declaration and is ignored.
 */
export async function loadBranches(dir = BRANCHES_DIR) {
  const root = toRoot(dir)
  const index = new Map()
  const errors = []

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { index, errors }
    // An unreadable folder must not hide every mission: report it and carry on
    // with no declarations at all.
    errors.push({ project: 'branches', message: `missions folder: ${error.message}` })
    return { index, errors }
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const declaredIn = new Map()
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

    const previous = declaredIn.get(parsed.key)
    if (previous) {
      errors.push({ project: 'branches', message: `${name}: key "${parsed.key}" is already declared in ${previous}/${MISSION_FILE}` })
      continue
    }
    declaredIn.set(parsed.key, folder)
    index.set(parsed.key, { folder, branch: parsed.branch, base: parsed.base })
  }

  return { index, errors }
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

  const branch = readName(raw.branch)
  if (branch.error) return { error: `branch ${branch.error}` }
  const base = readName(raw.base)
  if (base.error) return { error: `base ${base.error}` }

  return { key: key.value, branch: branch.value, base: base.value }
}

function readName(value) {
  if (value === undefined || value === null) return { value: null }
  if (typeof value !== 'string' || value.trim() === '') return { error: 'must be a non-empty string' }
  return { value: value.trim() }
}

const queues = new Map()

/**
 * Declare a mission's branch and base, writing `missions/<folder>/mission.yml`.
 *
 * The folder is the one already declaring the key, or a slug of the key when the
 * mission has none: the client never chooses a path. Saves are serialised per
 * store and renamed into place, so concurrent writes cannot truncate the file or
 * silently drop a save. Comments of an existing file are preserved; an empty
 * branch or base is removed from the file. Returns `{ key, folder, branch, base }`,
 * throws an error with `status: 400` when the declaration is refused (nothing is
 * written in that case).
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
  const branch = readOptionalName(declaration.branch, 'branch')
  const base = readOptionalName(declaration.base, 'base')

  const folder = (await declaredFolder(root, key)) ?? folderFor(key)
  const path = join(root, folder, MISSION_FILE)

  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw invalid(`${folder}/${MISSION_FILE}: ${error.message}`)
  }

  const document = text === null ? new Document() : inspectDeclaration(text, folder, key)
  if (document.contents === null) document.commentBefore = header(key)

  document.set('key', key)
  if (branch) document.set('branch', branch)
  else document.delete('branch')
  if (base) document.set('base', base)
  else document.delete('base')

  await mkdir(join(root, folder), { recursive: true })
  await writeAtomically(path, String(document))

  return { key, folder, branch, base }
}

/** Folder of the mission declaring `key`, even when its file is invalid. */
async function declaredFolder(root, key) {
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
  for (const folder of folders) {
    let text
    try {
      text = await readFile(join(root, folder, MISSION_FILE), 'utf8')
    } catch {
      continue
    }
    if (declaredKey(text) === key) return folder
  }
  return null
}

/**
 * Check an existing declaration before it is rewritten.
 *
 * The key is authoritative and unknown fields are refused, but a missing,
 * empty or ill-typed branch or base is not: the save replaces both fields, so
 * a file the list reports as broken stays repairable from the panel.
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

/** Key of a declaration, read leniently so a broken file still blocks a duplicate. */
function declaredKey(text) {
  try {
    const raw = parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    return typeof raw.key === 'string' ? raw.key.trim() : null
  } catch {
    return null
  }
}

function header(key) {
  return ` Déclaration de la mission ${key}\n Fichier local du panneau Missions, jamais versionné.`
}

async function writeAtomically(path, content) {
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
 * A mission without a declaration keeps all three at `null`: the panel shows
 * nothing rather than a branch it would have derived, and the session prompt
 * cannot name a journal path that does not exist.
 */
export function attachBranches(missions = [], index = new Map()) {
  return missions.map((mission) => {
    const declared = index.get(String(mission?.key))
    return {
      ...mission,
      folder: declared?.folder ?? null,
      branch: declared?.branch ?? null,
      base: declared?.base ?? null,
    }
  })
}
