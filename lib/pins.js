import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeAtomically } from './branches.js'
import { MISSIONS_DIR } from './projects.js'
import { Document, parseDocument } from 'yaml'

/**
 * Pinned missions: one local list, beside the mission declarations.
 *
 * A pin is a reading preference, not a declaration: it says which missions the
 * reader keeps at the top of the list. The store is a single `pins.yml` holding
 * a `pinned:` list of keys, never versioned, written the same way as the
 * declarations — one atomic save at a time, so a concurrent write cannot
 * truncate the file or drop a pin.
 */
const PACKAGE_PINS_DIR = new URL('../missions/', import.meta.url)
const PACKAGE_PROJECTS = new URL('../missions/projects.yml', import.meta.url)

/** A checkout reads its local missions; an installed copy reads the user's. */
export const PINS_DIR = existsSync(PACKAGE_PROJECTS) ? PACKAGE_PINS_DIR : pathToFileURL(`${MISSIONS_DIR}/`)
export const PINS_FILE = 'pins.yml'

const HEADER = ' Épingles du poste — jamais versionné.'

/**
 * Read the pinned keys of a store into a set.
 *
 * A missing file is an empty store, not an error. A broken file is reported and
 * read as empty, so the list still shows every mission: the panel offers no
 * pinned section rather than hiding missions behind an unreadable preference.
 */
export async function loadPins(dir = PINS_DIR) {
  const root = toRoot(dir)
  const pinned = new Set()
  const errors = []

  let text
  try {
    text = await readFile(join(root, PINS_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { pinned, errors }
    errors.push({ project: 'pins', message: `${PINS_FILE}: ${error.message}` })
    return { pinned, errors }
  }

  const document = parseDocument(text)
  if (document.errors.length > 0) {
    errors.push({ project: 'pins', message: `${PINS_FILE}: ${document.errors[0].message}` })
    return { pinned, errors }
  }

  const raw = document.toJS()
  if (raw === null || raw === undefined) return { pinned, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ project: 'pins', message: `${PINS_FILE}: must be a mapping` })
    return { pinned, errors }
  }

  const list = raw.pinned
  if (list === undefined || list === null) return { pinned, errors }
  if (!Array.isArray(list)) {
    errors.push({ project: 'pins', message: `${PINS_FILE}: pinned must be a list` })
    return { pinned, errors }
  }

  for (const entry of list) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push({ project: 'pins', message: `${PINS_FILE}: pinned entries must be non-empty strings` })
      continue
    }
    pinned.add(entry.trim())
  }

  return { pinned, errors }
}

const queues = new Map()

/**
 * Pin or unpin one mission, writing `pins.yml`.
 *
 * Saves are serialised per store and renamed into place. The file keeps its
 * comment and its other keys; the `pinned` list keeps its order, the new key
 * going last. Returns `{ key, pinned }`, throws an error with `status: 400` when
 * the request is refused (nothing is written in that case).
 */
export async function savePin(dir = PINS_DIR, pin = {}) {
  const root = resolve(toRoot(dir))
  const previous = queues.get(root) ?? Promise.resolve()
  let release
  const current = new Promise((done) => {
    release = done
  })
  const tail = previous.then(() => current)
  queues.set(root, tail)

  await previous.catch(() => {})
  try {
    return await writePin(root, pin)
  } finally {
    release()
    if (queues.get(root) === tail) queues.delete(root)
  }
}

async function writePin(root, pin) {
  const key = readKey(pin?.key)
  if (typeof pin?.pinned !== 'boolean') throw invalid('pinned must be a boolean')

  const path = join(root, PINS_FILE)
  let text = null
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const document = text === null ? new Document() : parseDocument(text)
  if (document.errors.length > 0) throw invalid(`${PINS_FILE}: ${document.errors[0].message}`)

  const raw = document.toJS()
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw invalid(`${PINS_FILE}: must be a mapping`)
  }
  const current = raw?.pinned
  if (current !== undefined && current !== null && !Array.isArray(current)) {
    throw invalid(`${PINS_FILE}: pinned must be a list`)
  }
  const kept = (current ?? [])
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== key)
  const next = pin.pinned ? [...kept, key] : kept

  if (document.contents === null) document.commentBefore = HEADER
  document.set('pinned', next)

  await mkdir(root, { recursive: true })
  await writeAtomically(path, String(document))

  return { key, pinned: pin.pinned }
}

/**
 * Attach the pinned flag to its missions.
 *
 * Every mission carries the flag — pinned or not — so the client never has to
 * guess which keys it was given.
 */
export function attachPins(missions = [], pinned = new Set()) {
  return missions.map((mission) => ({ ...mission, pinned: pinned.has(String(mission?.key)) }))
}

function toRoot(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : String(dir)
}

function readKey(value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('key is missing')
  return value.trim()
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}
