/**
 * View helpers: filtering, grouping, relative age.
 *
 * Kept pure so the panel stays a thin rendering layer and the rules are
 * testable without a DOM. `tools/build.mjs` inlines this module into the client
 * bundle.
 */

const STATE_ORDER = ['in-review', 'in-progress', 'ready', 'to-refine']

function rank(state) {
  const index = STATE_ORDER.indexOf(state)
  return index === -1 ? STATE_ORDER.length : index
}

/** Keep the missions matching a free-text query and/or a type. */
export function filterMissions(missions = [], { query = '', type = null } = {}) {
  const needle = String(query ?? '').trim().toLowerCase()
  return missions.filter((mission) => {
    if (type && mission.type !== type) return false
    if (!needle) return true
    return [mission.title, mission.key, mission.project, mission.epic]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  })
}

/** Group missions by state, in workflow order; unknown states come last. */
export function groupByState(missions = []) {
  const groups = new Map()
  for (const mission of missions) {
    const state = STATE_ORDER.includes(mission.state) ? mission.state : 'unknown'
    if (!groups.has(state)) groups.set(state, [])
    groups.get(state).push(mission)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([state, entries]) => ({ state, missions: entries }))
}

/** Short relative age, in the panel's language. */
export function relativeAge(updatedAt, now = Date.now()) {
  if (!updatedAt) return ''
  const time = new Date(updatedAt).getTime()
  if (!Number.isFinite(time)) return ''
  const minutes = Math.round((now - time) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} d`
  return new Date(time).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export const STATES_IN_ORDER = STATE_ORDER
