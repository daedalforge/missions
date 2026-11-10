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

/** List the missions of every declared project. */
export async function listAll(projects, { signal, fetchImpl, refresh = false } = {}) {
  const results = await Promise.allSettled(
    projects.map(async (project) => {
      const memo = cache.get(project.id)
      if (!refresh && memo && Date.now() - memo.at < TTL_MS) return memo.missions

      const adapter = ADAPTERS[project.tracker]
      if (!adapter) throw new Error(`unknown tracker: ${project.tracker}`)

      const missions = await adapter.list(project, { signal, fetchImpl })
      cache.set(project.id, { at: Date.now(), missions })
      return missions
    }),
  )

  const missions = []
  const errors = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      missions.push(...result.value)
      return
    }
    const reason = result.reason
    errors.push({
      project: projects[index]?.id ?? '?',
      message: reason instanceof Error ? reason.message : String(reason),
    })
  })

  missions.sort(
    (a, b) => String(a.state ?? 'zzz').localeCompare(String(b.state ?? 'zzz')) || a.key.localeCompare(b.key),
  )
  return { missions, errors }
}

/** Empty the cache (tests, or a forced reload). */
export function clearCache() {
  cache.clear()
}
