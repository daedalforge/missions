import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Archiving a mission: the folder leaves the panel's reading path.
 *
 * Done is read from the declared folders (`missions/<dossier>/mission.yml`):
 * moving a done folder under `missions/archives/` is enough to make it
 * disappear from Done, and the content is kept as it was. Nothing is deleted,
 * and the tracker is never written: the issue stays closed, the folder is
 * simply out of the way.
 */

/** The folder holding archived missions, next to the declared ones. */
export const ARCHIVES_FOLDER = 'archives'

/** Where mission folders live by default, next to the bundled `projects.yml`. */
export const MISSIONS_DIR = new URL('../missions/', import.meta.url)

/** A refused archive: the message is for the panel, the status for the route. */
export class ArchiveError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.name = 'ArchiveError'
    this.status = status
  }
}

function toRoot(root) {
  return root instanceof URL ? fileURLToPath(root) : String(root)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Move a done mission's folder under `missions/archives/`, keeping its name.
 *
 * The source folder is the one the declaration names; the destination is
 * derived from it, so an archive never renames a mission. Every refusal is an
 * `ArchiveError`: the caller only has to send its status and message.
 *
 * @param {{ root: string | URL, key: string, folder: string, mission?: { state?: string } }} entry
 */
export async function archiveMission({ root, key, folder, mission } = {}) {
  const missionKey = String(key ?? '').trim()
  if (!missionKey) throw new ArchiveError('key is missing', 400)

  const name = String(folder ?? '').trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new ArchiveError(`invalid mission folder: ${name || '(missing)'}`, 409)
  }
  if (name === ARCHIVES_FOLDER) throw new ArchiveError('the archives folder cannot be archived', 409)

  if (mission?.state !== 'done') throw new ArchiveError(`${missionKey} is not done`, 409)

  const base = toRoot(root ?? MISSIONS_DIR)
  const source = join(base, name)
  const sourceStat = await stat(source).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (!sourceStat) throw new ArchiveError(`mission folder ${name} is missing`, 409)
  if (!sourceStat.isDirectory()) throw new ArchiveError(`mission folder ${name} is not a directory`, 409)

  const archives = join(base, ARCHIVES_FOLDER)
  await mkdir(archives, { recursive: true })

  const destination = join(archives, name)
  if (await exists(destination)) {
    throw new ArchiveError(`missions/${ARCHIVES_FOLDER}/${name} already exists`, 409)
  }

  try {
    await rename(source, destination)
  } catch (error) {
    // Two archives of the same mission race on the rename: the loser sees the
    // source gone, not an internal error.
    if (error?.code === 'ENOENT') throw new ArchiveError(`mission folder ${name} is missing`, 409)
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      throw new ArchiveError(`missions/${ARCHIVES_FOLDER}/${name} already exists`, 409)
    }
    throw error
  }

  return { key: missionKey, folder: name, archived: `missions/${ARCHIVES_FOLDER}/${name}` }
}

/**
 * Archive several missions in one gesture, one folder at a time.
 *
 * The loop does not stop at the first refusal: the panel shows every line's
 * outcome, so a bad entry must not hide the good ones. An `ArchiveError` is a
 * refusal of that entry (same status and message the single archive would
 * answer); anything else is the machine failing (permission, volume) and is
 * rethrown — a broken disk is not a verdict on one mission.
 *
 * @param {{ root: string | URL, entries?: Array<{ key: string, folder: string, mission?: { state?: string } }> }} batch
 */
export async function archiveMany({ root, entries = [] } = {}) {
  const base = toRoot(root ?? MISSIONS_DIR)
  const archived = []
  const refused = []
  for (const entry of entries) {
    try {
      archived.push(await archiveMission({
        root: base,
        key: entry?.key,
        folder: entry?.folder,
        mission: entry?.mission,
      }))
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error
      refused.push({ key: String(entry?.key ?? '').trim(), error: error.message })
    }
  }
  return { archived, refused }
}
