/**
 * View helpers: filtering, grouping, relative age, filter options.
 *
 * Kept pure so the panel stays a thin rendering layer and the rules are
 * testable without a DOM. `tools/build.mjs` inlines this module into the client
 * bundle.
 */

// Display order of the panel's groups: attention first (active work, review,
// next up, backlog, delivery queue). This is not the workflow order; the state
// filter keeps that one (STATE_FILTER_ORDER below).
const STATE_ORDER = ['in-progress', 'in-review', 'ready', 'to-refine', 'ready-for-prod']
const STATE_FILTER_ORDER = ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod']
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

function rank(state) {
  const index = STATE_ORDER.indexOf(state)
  return index === -1 ? STATE_ORDER.length : index
}

/**
 * Keep the missions matching the free text and every active dimension.
 *
 * Each filter is `null` (or absent) when the dimension is off; active filters
 * combine with AND, and with the search. The search covers the project name as
 * well as its id: both are shown to the user.
 */
export function filterMissions(
  missions = [],
  { query = '', type = null, state = null, epic = null, priority = null, project = null, missing = null } = {},
) {
  const needle = String(query ?? '').trim().toLowerCase()
  return missions.filter((mission) => {
    if (type && mission.type !== type) return false
    if (state === 'unknown') {
      if (STATE_ORDER.includes(mission.state)) return false
    } else if (state !== null && state !== undefined && mission.state !== state) return false
    if (epic !== null && epic !== undefined && mission.epic !== epic) return false
    if (priority !== null && priority !== undefined && mission.priority !== priority) return false
    if (project !== null && project !== undefined && mission.project !== project) return false
    if (missing === 'any') {
      const fields = ['points', 'priority', 'epic', 'type']
      if (!fields.some((field) => mission[field] === null || mission[field] === undefined)) return false
    }
    if (!needle) return true
    return [mission.title, mission.key, mission.project, mission.projectName, mission.epic]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  })
}

/** Values present in the list, once, without the empty ones. */
function distinct(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))]
}

/** Epic labels present in the list, alphabetically. */
export function epicOptions(missions = []) {
  return distinct(missions.map((mission) => mission.epic)).sort((a, b) => String(a).localeCompare(String(b)))
}

/** Priorities present in the list, in workflow order (unknown values last). */
export function priorityOptions(missions = []) {
  const present = new Set(distinct(missions.map((mission) => mission.priority)))
  const known = PRIORITY_ORDER.filter((priority) => present.has(priority))
  const unknown = [...present]
    .filter((priority) => !PRIORITY_ORDER.includes(priority))
    .sort((a, b) => String(a).localeCompare(String(b)))
  return [...known, ...unknown]
}

/** States present in the list, in workflow order; unknown states last. */
export function stateOptions(missions = []) {
  const present = new Set(
    missions.map((mission) => (STATE_ORDER.includes(mission.state) ? mission.state : 'unknown')),
  )
  return [
    ...STATE_FILTER_ORDER.filter((state) => present.has(state)),
    ...(present.has('unknown') ? ['unknown'] : []),
  ]
}

/** Projects present in the list, once per id, sorted by display name. */
export function projectOptions(missions = []) {
  const projects = new Map()
  for (const mission of missions) {
    if (!mission.project) continue
    if (!projects.has(mission.project)) {
      projects.set(mission.project, mission.projectName ?? mission.project)
    }
  }
  return [...projects.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** True when at least one filter (type included) is active. */
export function hasActiveFilters(filters = {}) {
  return Object.values(filters).some((value) => value !== null && value !== undefined && value !== '')
}

/** Sort a copy by priority (high -> low) or story points (low -> high). */
export function sortMissions(missions = [], sort = null) {
  if (sort !== 'priority' && sort !== 'points') return [...missions]
  const rank =
    sort === 'priority'
      ? (mission) => {
          const index = PRIORITY_ORDER.indexOf(mission.priority)
          return index === -1 ? PRIORITY_ORDER.length : index
        }
      : (mission) => {
          if (mission.points === null || mission.points === undefined || mission.points === '') return Infinity
          const value = Number(mission.points)
          return Number.isFinite(value) ? value : Infinity
        }
  return [...missions].sort(
    (a, b) => rank(a) - rank(b) || String(a.key).localeCompare(String(b.key)),
  )
}

/** Group missions by state, in display order (STATE_ORDER); unknown states come last. */
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

/**
 * Why a mission cannot start a session, or null when it can.
 *
 * A session is execution: the mission must carry exactly one state label, and
 * it needs the branch to work on and the base branch to open its pull request
 * against. Branch and base are declared in `missions/<folder>/mission.yml` and
 * never derived, so an undeclared one blocks the session instead of being
 * guessed. A state conflict blocks it too: the workflow does not advance on a
 * mission whose state is unknown.
 */
export function executionBlocker(mission = {}) {
  if (Array.isArray(mission.stateConflict) && mission.stateConflict.length > 0) {
    return `state labels conflict (${mission.stateConflict.join(', ')}), keep one`
  }
  if (!mission.branch) return 'branch is not declared, set it below or in the mission folder'
  if (!mission.base) return 'base branch is not declared, set it below or in the mission folder'
  return null
}

/**
 * Suggested branch name for a mission that has none declared yet.
 *
 * The workspace convention is `<type>/<key>` in lowercase: `fix/` for a bug,
 * `epic/` for an epic, `feat/` for anything else. This is only a suggestion
 * for the drawer: nothing is saved until Save, and a declared branch wins.
 */
export function suggestBranch(mission = {}) {
  const key = String(mission.key ?? '').trim().toLowerCase()
  if (!key) return ''
  if (mission.type === 'bug') return `fix/${key}`
  if (mission.type === 'epic') return `epic/${key}`
  return `feat/${key}`
}

/**
 * Value shown in the branch field: the declared branch, or the suggested one.
 *
 * A declared value always wins. The suggestion is never saved automatically:
 * Save is what writes it to `mission.yml`.
 */
export function branchFieldValue(mission = {}) {
  return mission.branch || suggestBranch(mission)
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
