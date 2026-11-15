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
// How long a freshly created mission may stand in for a tracker page that does
// not carry it yet. Short on purpose: the overlay is a proof of the creation,
// not a second truth.
const CREATED_TTL_MS = 5 * 60_000
const cache = new Map()
// Reads in flight, keyed like the cache: two callers that ask for the same
// perimeter at the same instant — the Done badge and the Done lines at mount —
// share one tracker round-trip instead of both missing a cache that only holds
// finished reads.
const inflight = new Map()
// Missions just created, keyed like the cache: the 201 proves their row, so the
// open list shows it even when the tracker still serves the page from before.
const created = new Map()
// Bumped by `forget`: a read that started before the invalidation comes back to
// a memo it no longer owns, and its answer must not be stored.
const generations = new Map()

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
 * The reason lives in the ticket's newest comment, and it explains the label:
 * a mission held only by a dependency has no such comment to read, its
 * `blockers` already say why. Only a mission carrying the label that still has
 * work asks for it: the done history is a record, its blocks are settled.
 * `Promise.all` keeps the read in parallel with the list, and a refused read
 * stays local — the mission says `unavailable` and the next refresh tries
 * again; the project's list and named errors are untouched.
 */
async function attachBlockedReasons(adapter, project, missions, { signal, fetchImpl }) {
  if (typeof adapter.latestComment !== 'function') return missions
  return Promise.all(missions.map(async (mission) => {
    if (!mission.blockedByLabel || mission.state === 'done') return mission
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

/**
 * The row a creation just proved, merged into one project's open list.
 *
 * The tracker's page is not trusted to be current: GitHub may still serve a
 * listing from before the creation, and a second read cannot be relied on to
 * fix that. The row is dropped as soon as the page carries its key — the
 * tracker wins, later edits included — and after a short window, so a page that
 * never shows it cannot be masked forever.
 */
function withCreated(project, missions, now) {
  const key = cacheKey(project, 'open')
  const entry = created.get(key)
  if (!entry) return missions
  if (now - entry.at >= CREATED_TTL_MS) {
    created.delete(key)
    return missions
  }
  if (missions.some((mission) => mission.key === entry.mission.key)) {
    created.delete(key)
    return missions
  }
  return [entry.mission, ...missions]
}

/** Keep a read's answer only if nothing invalidated its perimeter meanwhile. */
function remember(key, generation, missions) {
  if ((generations.get(key) ?? 0) !== generation) return
  cache.set(key, { at: Date.now(), missions })
}

/**
 * Drop a project's memoized read, one scope at a time, and the read in flight
 * with it: a read that started before the invalidation comes back to a memo it
 * no longer owns, so it cannot reinstall the pre-creation page.
 */
export function forget(project, scope = 'done') {
  const key = cacheKey(project, scope)
  cache.delete(key)
  inflight.delete(key)
  generations.set(key, (generations.get(key) ?? 0) + 1)
}

/** List the missions of every declared project, in one perimeter. */
export async function listAll(projects, { signal, fetchImpl, refresh = false, declaredKeys = new Set(), scope = 'open', now = Date.now } = {}) {
  if (!SCOPES.includes(scope)) throw new Error(`unknown scope: ${scope}`)
  const declared = new Set([...declaredKeys].map(String))
  const results = await Promise.allSettled(
    projects.map(async (project) => {
      const key = cacheKey(project, scope)
      const memo = cache.get(key)
      if (!refresh && memo && Date.now() - memo.at < TTL_MS) {
        return {
          missions: scope === 'open' ? withCreated(project, memo.missions, now()) : memo.missions,
          errors: [],
        }
      }

      const pending = inflight.get(key)
      if (!refresh && pending) return pending

      const generation = generations.get(key) ?? 0
      const reading = (async () => {
        const adapter = ADAPTERS[project.tracker]
        if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)

        // Only the keys this project can own: a folder declared under another
        // reference is another project's business.
        const own = [...declared].filter((missionKey) => project.reference && missionKey.startsWith(`${project.reference}-`))

        if (scope === 'open') {
          const open = await adapter.list(project, { signal, fetchImpl })
          const missions = await attachBlockedReasons(adapter, project, missionsOf('open', open), { signal, fetchImpl })
          // The memo keeps the tracker's page; the created row is merged on
          // every answer, so its window is never extended by a cache hit.
          remember(key, generation, missions)
          return { missions: withCreated(project, missions, now()), errors: [] }
        }

        // Done is read by key, so a project with no declared folder asks the
        // tracker nothing: the view is empty without a request.
        if (own.length === 0 || typeof adapter.listDone !== 'function') {
          remember(key, generation, [])
          return { missions: [], errors: [] }
        }

        try {
          const done = await adapter.listDone(project, own, { signal, fetchImpl })
          const missions = missionsOf('done', [], done)
          remember(key, generation, missions)
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
      })()
      inflight.set(key, reading)
      try {
        return await reading
      } finally {
        if (inflight.get(key) === reading) inflight.delete(key)
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

/** The open epics a new mission can be attached to, straight from the tracker. */
export async function listEpics(project, { signal, fetchImpl } = {}) {
  const adapter = ADAPTERS[project.tracker]
  if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)
  if (typeof adapter.epics !== 'function') throw new Error(`${project.tracker}: the epics are not supported`)
  return adapter.epics(project, { signal, fetchImpl })
}

/**
 * Create one mission on the tracker.
 *
 * The state is not the caller's: a mission always starts at "to-refine", so the
 * route cannot open work already in progress. The adapter clears the project's
 * cached open list — the next read must show the mission it has just created.
 * The row proved by the creation is kept for a short window: the refreshed list
 * carries it even when the tracker's own page has not caught up.
 */
export async function create(project, payload, { signal, fetchImpl, now = Date.now } = {}) {
  const adapter = ADAPTERS[project.tracker]
  if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)
  if (typeof adapter.create !== 'function') throw new Error(`${project.tracker}: creation is not supported`)
  const result = await adapter.create(project, { ...payload, state: 'to-refine' }, { signal, fetchImpl })
  forget(project, 'open')
  if (result?.mission) created.set(cacheKey(project, 'open'), { at: now(), mission: result.mission })
  return result
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

/**
 * The native form an estimation takes on one project, or null when none.
 *
 * The route asks this before the write: a project whose map declares no points
 * (GitHub without `points:`) refuses the gesture with a 400, not a tracker
 * failure. Jira always answers its field, default included.
 */
export function pointsOf(project) {
  const adapter = ADAPTERS[project.tracker]
  if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)
  if (typeof adapter.pointsOf !== 'function') return null
  return adapter.pointsOf(project)
}

/**
 * Write the story points of one mission.
 *
 * The adapter clears the project's cached list: the next read must show what
 * the tracker now holds, not a minute-old answer. The same rule as the priority:
 * the cache is cleared on both perimeters, because a re-estimation also moves a
 * mission in the Done view.
 */
export async function setPoints(project, key, options = {}) {
  const adapter = ADAPTERS[project.tracker]
  if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)
  if (typeof adapter.setPoints !== 'function') throw new Error(`${project.tracker}: the points are not supported`)
  const result = await adapter.setPoints(project, key, options)
  cache.delete(cacheKey(project, 'open'))
  cache.delete(cacheKey(project, 'done'))
  return result
}

/** Empty the cache and the reads in flight (tests, or a forced reload). */
export function clearCache() {
  cache.clear()
  inflight.clear()
  created.clear()
  generations.clear()
}
