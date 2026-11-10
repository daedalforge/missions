import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

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
  const root = dir instanceof URL ? fileURLToPath(dir) : String(dir)
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
    index.set(parsed.key, { branch: parsed.branch, base: parsed.base })
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

/**
 * Attach the declared branch and base to their missions.
 *
 * A mission without a declaration keeps both fields at `null`: the panel shows
 * nothing rather than a branch it would have derived.
 */
export function attachBranches(missions = [], index = new Map()) {
  return missions.map((mission) => {
    const declared = index.get(String(mission?.key))
    return { ...mission, branch: declared?.branch ?? null, base: declared?.base ?? null }
  })
}
