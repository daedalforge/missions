import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { USAGE_ELEMENTS, USAGE_MAX_DETAIL, USAGE_MAX_VALUES } from './view.js'

/**
 * The usage tally: how often the panel's gestures were actually used.
 *
 * It is a local file, like the branch declarations and for the same reason:
 * what this machine did with the panel is this machine's business. The host
 * writes it — one file, no tracker, no network — and the panel reads it back
 * through the `usage` route.
 */
export const USAGE_FILE = 'usage.json'

/** Shape version of the file, so a later migration can read its own past. */
export const USAGE_VERSION = 1

/** A detail carrying a control character is refused: it would break the line. */
const CONTROL = /[\u0000-\u001f\u007f]/

/** A refusal the route can hand back as is, with the status it deserves. */
export class UsageError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'UsageError'
    this.status = status
  }
}

/**
 * Where the tally lives.
 *
 * `$DSH_HOME/storages/dsh-missions/usage.json` — the convention the other
 * storages of the app follow (`workspaces.js` reads `storages/workspace.json`),
 * so the file sits next to the profile it describes and survives a plugin
 * upgrade. Tests and alternate profiles pass `usageFile`.
 */
export function usagePath(config = {}) {
  const explicit = config?.usageFile
  if (explicit instanceof URL) return fileURLToPath(explicit)
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const home = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-missions', USAGE_FILE)
}

/** A tally with nothing in it, and an honest `startedAt: null`. */
export function emptyUsage() {
  return { version: USAGE_VERSION, startedAt: null, updatedAt: null, elements: {}, broken: false }
}

/** Whole counts only: a hand-edited `2.7` is read as `2`, a string as a number. */
function usageCount(value) {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.floor(count)
}

/** An ISO stamp, or null: a date the report cannot compare is not a date. */
function usageStamp(value) {
  if (typeof value !== 'string' || value === '') return null
  return Number.isFinite(Date.parse(value)) ? value : null
}

/**
 * The detail counts of one element: a map of detail to count, capped.
 *
 * The cap is applied on read as well as on write, so a file edited by hand
 * cannot grow a row past the size the panel promised to keep.
 */
function usageValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([detail]) => typeof detail === 'string' && detail !== '')
      .filter(([detail]) => detail.length <= USAGE_MAX_DETAIL && !CONTROL.test(detail))
      .slice(0, USAGE_MAX_VALUES)
      .map(([detail, count]) => [detail, usageCount(count)]),
  )
}

/** One record, whatever the file holds for it. */
function usageElement(record) {
  const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {}
  return {
    count: usageCount(source.count),
    firstUsed: usageStamp(source.firstUsed),
    lastUsed: usageStamp(source.lastUsed),
    values: usageValues(source.values),
  }
}

/** A tally read as empty, and why: a broken file is a state, not a throw. */
function brokenUsage() {
  return { ...emptyUsage(), broken: true }
}

/**
 * Read the tally.
 *
 * A missing file is an empty tally, not an error, and it is never created by a
 * read: opening the Usage tab must not write anything. A file that cannot be
 * parsed — or that holds something else than a tally — is reported as `broken`
 * and read as empty, so the panel can say it and the next gesture starts the
 * tally over instead of failing forever.
 */
export async function readUsage(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return emptyUsage()
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return brokenUsage()
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return brokenUsage()
  const source = parsed.elements
  if (source !== undefined && (source === null || typeof source !== 'object' || Array.isArray(source))) return brokenUsage()

  const elements = {}
  for (const [id, record] of Object.entries(source ?? {})) elements[id] = usageElement(record)
  return {
    version: usageCount(parsed.version) || USAGE_VERSION,
    startedAt: usageStamp(parsed.startedAt),
    updatedAt: usageStamp(parsed.updatedAt),
    elements,
    broken: false,
  }
}

/** The detail of a gesture, trimmed and checked; null when there is none. */
function usageDetail(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new UsageError('detail must be a string')
  const detail = value.trim()
  if (detail === '') return null
  if (detail.length > USAGE_MAX_DETAIL) throw new UsageError(`detail is longer than ${USAGE_MAX_DETAIL} characters`)
  if (CONTROL.test(detail)) throw new UsageError('detail contains control characters')
  return detail
}

/**
 * One gesture, counted.
 *
 * The element must be declared in `USAGE_ELEMENTS`: the host refuses what it
 * cannot name, so a stale panel cannot invent rows in the file. A detail is
 * optional, bounded, and counted per value — that is how the report knows which
 * filters or sections people actually reach for. The thirty-third distinct
 * detail of an element is dropped, and the element's count advances anyway: the
 * gesture happened, even if its name no longer fits.
 */
export async function recordUsage(file, gesture = {}, now = new Date()) {
  const element = typeof gesture?.element === 'string' ? gesture.element.trim() : ''
  if (!element) throw new UsageError('element is missing')
  if (!USAGE_ELEMENTS.some((entry) => entry.id === element)) throw new UsageError(`unknown element: ${element}`)
  const detail = usageDetail(gesture.detail)
  const stamp = now.toISOString()

  return enqueue(file, async () => {
    const current = await readUsage(file)
    const previous = current.elements[element] ?? { count: 0, firstUsed: null, lastUsed: null, values: {} }
    const values = { ...previous.values }
    if (detail !== null) {
      if (detail in values) values[detail] += 1
      else if (Object.keys(values).length < USAGE_MAX_VALUES) values[detail] = 1
    }
    const tally = {
      version: USAGE_VERSION,
      startedAt: current.startedAt ?? stamp,
      updatedAt: stamp,
      elements: {
        ...current.elements,
        [element]: {
          count: previous.count + 1,
          firstUsed: previous.firstUsed ?? stamp,
          lastUsed: stamp,
          values,
        },
      },
    }
    await writeUsage(file, tally)
    return { element, count: tally.elements[element].count }
  })
}

/**
 * Write the tally in one move: a temporary file next to it, then a rename.
 *
 * A reader never sees half a file, and a crash during the write leaves the
 * previous tally intact — the directory is created first, because a first
 * gesture may be the first thing that ever writes under `storages/`.
 */
async function writeUsage(file, usage) {
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  try {
    await writeFile(tmp, `${JSON.stringify(usage, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * One file, one queue: two gestures counted at the same instant are written one
 * after the other, so the second reads what the first wrote. A rejected write
 * does not block the next one — the queue carries the promise, not the failure.
 */
const queues = new Map()

function enqueue(file, task) {
  const previous = queues.get(file) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(() => {}, () => {})
  queues.set(file, tail)
  tail.then(() => { if (queues.get(file) === tail) queues.delete(file) })
  return run
}
