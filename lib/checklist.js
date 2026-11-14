import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BRANCHES_DIR } from './branches.js'

/**
 * The mission checklist: the gestures a session runs and proves, next to
 * `mission.yml`.
 *
 * The acceptance criteria bind in the tracker; the checklist is the local sheet
 * a session ticks as it verifies them, each point carrying its proof. It is a
 * local file like the journal: the panel reads it, only the agent writes it.
 */
export const CHECKLIST_FILE = 'checklist.md'

/** Upper bound of the text handed to the panel, in characters. */
export const CHECKLIST_LIMIT = 200_000

/** Answer for a mission with no folder, or no checklist yet. */
export function emptyChecklist() {
  return { exists: false, source: '', mtimeMs: 0 }
}

/**
 * Read `missions/<folder>/checklist.md`.
 *
 * `folder` comes from the declarations (`loadBranches`), never from the
 * request: a key cannot walk outside `missions/`. The source is bounded so a
 * runaway checklist cannot freeze the panel; the file itself is left untouched.
 */
export async function readChecklist(dir = BRANCHES_DIR, folder) {
  if (!folder) return emptyChecklist()
  const path = join(toRoot(dir), folder, CHECKLIST_FILE)

  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return emptyChecklist()
    throw error
  }

  let mtimeMs = 0
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    // The file vanished between the read and the stat: the content is still what
    // the panel asked for, only its age is unknown.
  }
  return { exists: true, source: source.slice(0, CHECKLIST_LIMIT), mtimeMs }
}

function toRoot(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : String(dir)
}
