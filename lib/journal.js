import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BRANCHES_DIR } from './branches.js'

/**
 * The mission journal: the narrative a session leaves next to `mission.yml`.
 *
 * The tracker carries the state and the decisions that bind; the journal keeps
 * what a session read, chose and proved. It is a local file like the branch
 * declaration, so the panel reads it and only the agent writes it.
 */
export const JOURNAL_FILE = 'journal.md'

/** Upper bound of the text handed to the panel, in characters. */
export const JOURNAL_LIMIT = 200_000

/** Answer for a mission with no folder, or no journal yet. */
export function emptyJournal() {
  return { exists: false, source: '', mtimeMs: 0 }
}

/**
 * Read `missions/<folder>/journal.md`.
 *
 * `folder` comes from the declarations (`loadBranches`), never from the
 * request: a key cannot walk outside `missions/`. The source is bounded so a
 * runaway journal cannot freeze the panel; the file itself is left untouched.
 */
export async function readJournal(dir = BRANCHES_DIR, folder) {
  if (!folder) return emptyJournal()
  const path = join(toRoot(dir), folder, JOURNAL_FILE)

  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return emptyJournal()
    throw error
  }

  let mtimeMs = 0
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    // The file vanished between the read and the stat: the content is still what
    // the panel asked for, only its age is unknown.
  }
  return { exists: true, source: source.slice(0, JOURNAL_LIMIT), mtimeMs }
}

function toRoot(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : String(dir)
}
