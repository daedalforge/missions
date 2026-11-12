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
 * The two perimeters of a read: the open queue, and the closed history.
 *
 * Open work is the panel's queue; closed work is a view of its own. A
 * `done` mission is only fetched for the Done view, and only when
 * `missions/<key>/` declares it (see `listAll`). That is the one promise of
 * the closed read: a done mission nobody followed stays out.
 *
 * A Jira status mapped on `done` is not always resolved — `resolution =
 * Unresolved` lets those through — so the state is decided here, once, for
 * every tracker, before the cache keeps it: the tracker's resolution never
 * decides what the panel shows, the declared folders do.
 */
const SCOPES = ['open', 'done']

function cacheKey(project, scope) {
  return `${project.id}:${scope}`
}

/** Keep only the rows a scope is about, deduplicated by key. */
function missionsOf(scope, open = [], done = []) {
  const merged = new Map()
  for (const mission of [...open, ...done]) merged.set(mission.key, mission)
  return [...merged.values()].filter((mission) => (
    scope === 'done' ? mission.state === 'done' : mission.state !== 'done'
  ))
}

/**
 * Attach the reason of a blocked mission, read from the tracker itself.
 *
 * The reason lives in the ticket's newest comment, so only a blocked mission
 * that still has work asks for it: the done history is a record, its blocks are
 * settled. `Promise.all` keeps the read in parallel with the list, and a refused
 * read stays local — the mission says `unavailable` and the next refresh tries
 * again; the project's list and named errors are untouched.
 */
async function attachBlockedReasons(adapter, project, missions, { signal, fetchImpl }) {
  if (typeof adapter.latestComment !== 'function') return missions
  return Promise.all(missions.map(async (mission) => {
    if (!mission.blocked || mission.state === 'done') return mission
    try {
      const comment = await adapter.latestComment(project, mission.key, { signal, fetchImpl })
      return {
        ...mission,
        blockedReason: comment
          ? { state: 'found', ...comment }
          : { state: 'empty', author: null, body: '', createdAt: null, url: null },
      }
    } catch {
      return {
        ...mission,
        blockedReason: { state: 'unavailable', author: null, body: '', createdAt: null, url: null },
      }
    }
  }))
}

/** List the missions of every declared project, in one perimeter. */
export async function listAll(projects, { signal, fetchImpl, refresh = false, declaredKeys = new Set(), scope = 'open' } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`)
  const declared = new Set([...declaredKeys].map(String))
  const results = await Promise.allSettled(
    projects.map(async (project) => {
      const key = cacheKey(project, scope)
      const memo = cache.get(key)
      if (!refresh && memo && Date.now() - memo.at < TTL_MS) return { missions: memo.missions, errors: [] }

      const adapter = ADAPTERS[project.tracker]
      if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)

      // Only the keys this project can own: a folder declared under another
      // reference is another project's business.
      const own = [...declared].filter((missionKey) => project.reference && missionKey.startsWith(`${project.reference}-`))

      if (scope === 'open') {
        const open = await adapter.list(project, { signal, fetchImpl })
        const missions = await attachBlockedReasons(adapter, project, missionsOf('open', open), { signal, fetchImpl })
        cache.set(key, { at: Date.now(), missions })
        return { missions, errors: [] }
      }

      // Done is read by key, so a project with no declared folder asks the
      // tracker nothing: the view is empty without a request.
      if (own.length === 0 || typeof adapter.listDone !== 'function') {
        cache.set(key, { at: Date.now(), missions: [] })
        return { missions: [], errors: [] }
      }

      try {
        const done = await adapter.listDone(project, own, { signal, fetchImpl })
        const missions = missionsOf('done', [], done)
        cache.set(key, { at: Date.now(), missions })
        return { missions, errors: [] }
      } catch (error) {
        // A closed read that fails must not hide the open work: the panel's
        // banner names it, and the open perimeter is its own read.
        return {
          missions: [],
          errors: [{
            project: project.id,
            message: `done missions: ${error instanceof Error ? error.message : String(error)}`,
          }],
        }
      }
    }),
  )

  const missions = []
  const errors = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      missions.push(...result.value.missions)
      errors.push(...result.value.errors)
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
  cache.delete(cacheKey(project, 'open'))
  cache.delete(cacheKey(project, 'done'))
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
  cache.delete(cacheKey(project, 'open'))
  cache.delete(cacheKey(project, 'done'))
  return result
}

/** Empty the cache (tests, or a forced reload). */
export function clearCache() {
  cache.clear()
}
