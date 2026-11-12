import * as github from './github.js'
import * as jira from './jira.js'

/**
 * Tracker registry and aggregation.
 *
 * Each project is a source: it is read independently (`allSettled`), a failure
 * becomes a named error, and the others keep going. Nothing is assumed shared
 * between two projects.
 */

const ADAPTERS = { github, jira }
const TTL_MS = 60_000
const cache = new Map()

export const trackers = Object.keys(ADAPTERS)

/**
 * Keep the open missions, and the done ones the machine declares.
 *
 * Open work is the panel's queue; closed work is history, so the trackers are
 * read for the open missions first, and a `done` mission is only fetched and
 * kept when `missions/<key>/` declares it (see `listAll`). That is the one
 * promise of the panel's list: a done mission nobody followed stays out.
 *
 * A Jira status mapped on `done` is not always resolved — `resolution =
 * Unresolved` lets those through — so the state is decided here, once, for
 * every tracker, before the cache keeps it: the tracker's resolution never
 * decides what the panel shows, the declared folders do.
 */
function keepListed(missions, declared) {
  return missions.filter((mission) => mission.state !== 'done' || declared.has(String(mission.key)))
}

/** List the missions of every declared project. */
export async function listAll(projects, { signal, fetchImpl, refresh = false, declaredKeys = new Set() } = {}) {
  const declared = new Set([...declaredKeys].map(String))
  const results = await Promise.allSettled(
    projects.map(async (project) => {
      const memo = cache.get(project.id)
      if (!refresh && memo && Date.now() - memo.at < TTL_MS) return { missions: memo.missions, error: null }

      const adapter = ADAPTERS[project.tracker]
      if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)

      const open = await adapter.list(project, { signal, fetchImpl })
      // Only the keys this project can own: a folder declared under another
      // reference is another project's business.
      const own = [...declared].filter((key) => project.reference && key.startsWith(`${project.reference}-`))
      let done = []
      let doneError = null
      if (own.length > 0 && typeof adapter.listDone === 'function') {
        try {
          done = await adapter.listDone(project, own, { signal, fetchImpl })
        } catch (error) {
          // A closed read that fails must not hide the open work it shares a
          // project with: the panel's banner names it, the list keeps going.
          doneError = {
            project: project.id,
            message: `done missions: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }

      // A declared done mission can be returned twice: the open read may carry
      // a status the project maps on `done` (Jira keeps those unresolved), and
      // the closed read returns it too. One key, one mission.
      const merged = new Map()
      for (const mission of [...open, ...done]) merged.set(mission.key, mission)
      const missions = keepListed([...merged.values()], declared)
      cache.set(project.id, { at: Date.now(), missions })
      return { missions, error: doneError }
    }),
  )

  const missions = []
  const errors = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      missions.push(...result.value.missions)
      if (result.value.error) errors.push(result.value.error)
      return
    }
    const reason = result.reason
    errors.push({
      project: projects[index]?.id ?? '?',
      message: reason instanceof Error ? reason.message : String(reason),
    })
  })

  // A mission carries one state label; two known labels are a conflict to fix,
  // not a precedence to resolve. It is reported before the list so the panel
  // can show it and refuse to start a session on that mission.
  for (const mission of missions) {
    if (mission.stateConflict?.length) {
      errors.push({
        project: mission.project,
        message: `${mission.key} has several state labels (${mission.stateConflict.join(', ')}): keep one`,
      })
    }
  }

  missions.sort(
    (a, b) => String(a.state ?? 'zzz').localeCompare(String(b.state ?? 'zzz')) || a.key.localeCompare(b.key),
  )
  return { missions, errors }
}

/**
 * Write the blocked label on one mission.
 *
 * The adapter clears the project's cached list: the next read must show what
 * the tracker now holds, not a minute-old answer.
 */
export async function setBlocked(project, key, options = {}) {
  const adapter = ADAPTERS[project.tracker]
  if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)
  if (typeof adapter.setBlocked !== 'function') throw new Error(`${project.tracker}: the blocked label is not supported`)
  const result = await adapter.setBlocked(project, key, options)
  cache.delete(project.id)
  return result
}

/**
 * Write the priority of one mission.
 *
 * The adapter clears the project's cached list: the next read must show what
 * the tracker now holds, not a minute-old answer.
 */
export async function setPriority(project, key, options = {}) {
  const adapter = ADAPTERS[project.tracker]
  if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)
  if (typeof adapter.setPriority !== 'function') throw new Error(`${project.tracker}: the priority is not supported`)
  const result = await adapter.setPriority(project, key, options)
  cache.delete(project.id)
  return result
}

/** Empty the cache (tests, or a forced reload). */
export function clearCache() {
  cache.clear()
}
