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

// « Priorité haute » couvre deux niveaux. Le filtre Priorité prend une liste,
// comme le Statut : le widget des stories ouvre la liste sur les deux niveaux.
const HIGH_PRIORITIES = ['urgent', 'high']

/** The filter bar at rest: no text, no dimension, default order. */
export const EMPTY_FILTERS = { type: null, state: null, epic: null, priority: null, project: null, missing: null }

/** Session key of the bar, next to `missions.theme` for the theme. */
export const FILTERS_KEY = 'missions.filters'

// What the panel's own selects can produce. Anything else in a saved bar is
// stale: restoring it would select a value the user cannot see in the list.
const FILTER_TYPES = ['bug', 'story']
const FILTER_SORTS = ['priority', 'points']
const FILTER_STATES = [...STATE_FILTER_ORDER, 'unknown']

function rank(state) {
  const index = STATE_ORDER.indexOf(state)
  return index === -1 ? STATE_ORDER.length : index
}

/** The values a filter selects: none, one, or a list of them. */
function selectedValues(value) {
  if (value === null || value === undefined || value === '') return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Keep the missions matching the free text and every active dimension.
 *
 * Each filter is `null` (or absent) when the dimension is off; active filters
 * combine with AND, and with the search. The search covers the project name as
 * well as its id: both are shown to the user. The state and priority filters
 * take one value or a list of them — the dashboard's widgets open the list on
 * several values at once — and `'unknown'` stands for every state outside the
 * workflow.
 */
export function filterMissions(
  missions = [],
  { query = '', type = null, state = null, epic = null, priority = null, project = null, missing = null } = {},
) {
  const needle = String(query ?? '').trim().toLowerCase()
  const states = selectedValues(state)
  return missions.filter((mission) => {
    if (type && mission.type !== type) return false
    if (states.length > 0) {
      const known = STATE_ORDER.includes(mission.state)
      if (!states.includes(mission.state) && !(states.includes('unknown') && !known)) return false
    }
    if (epic !== null && epic !== undefined && mission.epic !== epic) return false
    const priorities = selectedValues(priority)
    if (priorities.length > 0 && !priorities.includes(mission.priority)) return false
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
  return Object.values(filters).some((value) => {
    if (Array.isArray(value)) return value.length > 0
    return value !== null && value !== undefined && value !== ''
  })
}

/** Every non-blank string of a value, list or single, once, in input order. */
function keptTexts(value) {
  const list = Array.isArray(value) ? value : [value]
  const kept = [...new Set(list.filter((entry) => typeof entry === 'string' && entry.trim() !== ''))]
  return kept.length > 0 ? kept : null
}

/** A non-blank string, trimmed, or null. */
function keptText(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** A value kept only when the panel can select it. */
function keptChoice(value, allowed) {
  const text = keptText(value)
  return text !== null && allowed.includes(text) ? text : null
}

/**
 * Several values kept only when the panel can select them, in the panel's order.
 *
 * The state and priority filters take a list: a widget opens the list on all the
 * values it showed. A single value read from an older session is accepted, so a
 * bar saved before the list existed comes back intact.
 */
function keptChoices(value, allowed) {
  const list = Array.isArray(value) ? value : [value]
  const kept = allowed.filter((choice) => list.includes(choice))
  return kept.length > 0 ? kept : null
}

/**
 * One flat snapshot of the bar: what the session keeps between two mounts.
 *
 * Values the panel cannot select are dropped rather than trusted: a type, a
 * state or an order the session no longer offers must not come back. State and
 * priority keep their lists; epic and project stay free text — a stale one
 * filters to nothing, like a manual selection would.
 */
export function filterSnapshot({ query = '', filters = {}, sort = null } = {}) {
  const source = filters ?? {}
  return {
    query: typeof query === 'string' ? query : '',
    type: keptChoice(source.type, FILTER_TYPES),
    state: keptChoices(source.state, FILTER_STATES),
    epic: keptText(source.epic),
    priority: keptTexts(source.priority),
    project: keptText(source.project),
    missing: source.missing === 'any' ? 'any' : null,
    sort: keptChoice(sort, FILTER_SORTS),
  }
}

/**
 * Split a flat snapshot back into the three states the panel keeps.
 *
 * The values pass through `filterSnapshot` again, so a snapshot read from an
 * older session is validated the same way as the one the panel just wrote.
 */
export function filterBarState(snapshot = {}) {
  const flat = filterSnapshot({ query: snapshot?.query, filters: snapshot, sort: snapshot?.sort })
  const { query, type, state, epic, priority, project, missing, sort } = flat
  return { query, filters: { type, state, epic, priority, project, missing }, sort }
}

/** Read a stored snapshot back; anything unusable is the empty bar. */
export function parseFilterSnapshot(raw) {
  const empty = filterSnapshot({})
  if (typeof raw !== 'string' || raw.trim() === '') return empty
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return empty
  return filterSnapshot({ query: stored.query, filters: stored, sort: stored.sort })
}

/**
 * The bar the session saved, or the empty bar.
 *
 * Storage is optional: a missing key, a storage that throws, or a payload the
 * panel cannot use all restore the default instead of failing the render.
 */
export function readFilterSnapshot(storage) {
  try {
    return parseFilterSnapshot(storage?.getItem?.(FILTERS_KEY) ?? null)
  } catch {
    return filterSnapshot({})
  }
}

/** True when the bar holds nothing: no search text, no filter, no order. */
function isEmptySnapshot(snapshot = {}) {
  const { query = '', type = null, state = null, epic = null, priority = null, project = null, missing = null, sort = null } = snapshot
  return String(query).trim() === '' && sort === null && !hasActiveFilters({ type, state, epic, priority, project, missing })
}

/**
 * Save the bar for the session, or drop its key once nothing is left.
 *
 * Writing only when something is set keeps a cleared bar from coming back on
 * the next mount.
 */
export function writeFilterSnapshot(storage, bar = {}) {
  if (!storage) return
  const snapshot = filterSnapshot(bar)
  try {
    if (isEmptySnapshot(snapshot)) storage.removeItem?.(FILTERS_KEY)
    else storage.setItem?.(FILTERS_KEY, JSON.stringify(snapshot))
  } catch { /* storage is optional */ }
}

/** Session key of the open tab, next to `missions.filters`. */
export const TAB_KEY = 'missions.tab'

/**
 * The tab the session left open, or the panel's resting tab.
 *
 * `tabs` is what the caller actually renders, so a stored tab that no longer
 * exists falls back instead of selecting a view nobody can reach. The resting
 * tab is the first one: the dashboard, which answers "what waits on me".
 */
export function readTab(storage, tabs = []) {
  const resting = tabs[0] ?? null
  try {
    const stored = storage?.getItem?.(TAB_KEY)
    return tabs.includes(stored) ? stored : resting
  } catch {
    return resting
  }
}

/**
 * Save the open tab for the session, or drop its key on the resting tab.
 *
 * Nothing outlives the app: the storage is session storage, and an untouched
 * session leaves no key behind for the next mount to read.
 */
export function writeTab(storage, tab, tabs = []) {
  if (!storage) return
  try {
    if (tab !== tabs[0] && tabs.includes(tab)) storage.setItem?.(TAB_KEY, tab)
    else storage.removeItem?.(TAB_KEY)
  } catch { /* storage is optional */ }
}

/** Session key of the step the Workflows tab has open, next to `missions.tab`. */
export const STEP_KEY = 'missions.workflow-step'

/**
 * The step the session left open, or the first step of the method.
 *
 * Same contract as the tab: a stored step that the caller no longer renders
 * falls back to the first one instead of opening a view nobody can reach.
 */
export function readStep(storage, steps = []) {
  const resting = steps[0] ?? null
  try {
    const stored = storage?.getItem?.(STEP_KEY)
    return steps.includes(stored) ? stored : resting
  } catch {
    return resting
  }
}

/** Save the open step for the session, or drop its key on the first step. */
export function writeStep(storage, step, steps = []) {
  if (!storage) return
  try {
    if (step !== steps[0] && steps.includes(step)) storage.setItem?.(STEP_KEY, step)
    else storage.removeItem?.(STEP_KEY)
  } catch { /* storage is optional */ }
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

// The dashboard's queue: every state that waits on the user, most urgent first.
// `in-progress` is excluded — work already started is not waiting, it is running.
// `ready-for-prod` is excluded too: it waits on a release, not on a decision.
const QUEUE_ORDER = ['in-review', 'ready', 'to-refine']

// What the row asks for, by state. Unknown states fall back to a neutral verb.
const ACTION_VERB = {
  'in-review': 'Review',
  'ready-for-prod': 'Ship',
  ready: 'Start',
  'to-refine': 'Refine',
  'in-progress': 'Continue',
}

/** A mission is quiet once it has not moved for a week. */
export const QUIET_AFTER_DAYS = 7

/** Days since the last update, or null when the date cannot be read. */
export function ageDays(updatedAt, now = Date.now()) {
  if (updatedAt === null || updatedAt === undefined || updatedAt === '') return null
  const time = new Date(updatedAt).getTime()
  if (!Number.isFinite(time)) return null
  return Math.max(0, (now - time) / 86400000)
}

/**
 * The age a dashboard row shows: relative, and flagged once it is quiet.
 *
 * `relativeAge` switches to an absolute date past a week, which is right for the
 * mission list but wrong here: the dashboard's whole point is to show how long a
 * mission has waited. So the days stay days, and `quiet` carries the signal.
 */
export function missionAge(updatedAt, now = Date.now()) {
  const days = ageDays(updatedAt, now)
  if (days === null) return { label: '', days: null, quiet: false }
  if (days < 1 / 24) return { label: `${Math.max(1, Math.round(days * 1440))} min`, days, quiet: false }
  if (days < 1) return { label: `${Math.round(days * 24)} h`, days, quiet: false }
  return { label: `${Math.round(days)} d`, days, quiet: days >= QUIET_AFTER_DAYS }
}

/** The verb a row offers for its state ("Review", "Ship", …). */
export function actionVerb(state) {
  return ACTION_VERB[state] ?? 'Open'
}

/** Oldest update first; a missing or unreadable date goes last, ties on the key. */
function oldestFirst(a, b) {
  const left = new Date(a?.updatedAt ?? '').getTime()
  const right = new Date(b?.updatedAt ?? '').getTime()
  const gap = (Number.isFinite(left) ? left : Infinity) - (Number.isFinite(right) ? right : Infinity)
  return gap || String(a?.key ?? '').localeCompare(String(b?.key ?? ''))
}

function queueRank(state) {
  const index = QUEUE_ORDER.indexOf(state)
  return index === -1 ? QUEUE_ORDER.length : index
}

/**
 * The states the queue never shows: one is already running, one waits for a
 * release, and one is closed. A blocklist rather than an allowlist, because a
 * mission whose state is unknown must stay in the queue (see below).
 */
const OFF_THE_QUEUE = ['in-progress', 'ready-for-prod', 'done']

/**
 * The dashboard's queue: what waits on the user, most urgent state first, then
 * the mission that has waited longest. A mission that is not waiting on a
 * decision — started, ready to ship — never appears here.
 *
 * A mission whose state is unknown — an unmapped tracker status, or conflicting
 * state labels — stays in the queue, ranked last: it is the one that needs an
 * arbitration. Dropping it would leave the section's count disagreeing with the
 * rows it shows, and hide exactly the mission nobody has decided about.
 */
export function needsYou(missions = []) {
  return missions
    .filter((mission) => !OFF_THE_QUEUE.includes(mission?.state))
    .sort((a, b) => queueRank(a.state) - queueRank(b.state) || oldestFirst(a, b))
}

/** The missions already running, the one that has waited longest first. */
export function inFlight(missions = []) {
  return missions
    .filter((mission) => mission?.state === 'in-progress')
    .sort(oldestFirst)
}

/** Bugs assigned to you: unresolved only, the one that has waited longest first. */
export function assignedBugs(missions = []) {
  return missions
    .filter((mission) => mission?.type === 'bug' && mission?.state !== 'done')
    .sort(oldestFirst)
}

/** Stories of high priority — urgent or high — every state, oldest first. */
export function highPriorityStories(missions = []) {
  return missions
    .filter((mission) => mission?.type === 'story' && HIGH_PRIORITIES.includes(mission?.priority))
    .sort(oldestFirst)
}

/** Story points carried by a set of missions; missions without points are skipped. */
export function pointsTotal(missions = []) {
  let total = 0
  let counted = 0
  for (const mission of missions) {
    const value = Number(mission?.points)
    const missing = mission?.points === null || mission?.points === undefined || mission?.points === ''
    if (missing || !Number.isFinite(value)) continue
    total += value
    counted += 1
  }
  return { total, counted }
}

/** The line under a section's title, and the card counts, in one pass. */
export function dashboardScope(missions = []) {
  const projects = new Set()
  let open = 0
  for (const mission of missions) {
    if (mission?.state === 'done') continue
    open += 1
    const name = mission?.projectName || mission?.project
    if (name) projects.add(name)
  }
  return {
    needYou: needsYou(missions).length,
    open,
    projects: projects.size,
  }
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
 * The workflow step a mission is in, from its state label.
 *
 * The session prompt used to announce the whole chain (cadrage → exécution →
 * revue → clôture), which invited one session to run several steps. A session
 * plays the step its ticket is in; `ready` and `in-progress` are both
 * execution (the review sends work back to `in-progress`), and `done` has no
 * session at all.
 */
export const STEP_BY_STATE = {
  'to-refine': 'cadrage',
  ready: 'exécution',
  'in-progress': 'exécution',
  'in-review': 'revue',
  'ready-for-prod': 'clôture',
}

/**
 * What a session does in each step, and when it stops.
 *
 * The brief is one sentence on purpose: it says the step and its exit, so the
 * session hands back instead of running the next step in the same context.
 */
export const STEP_BRIEFS = {
  cadrage:
    'Tu ne fais que le cadrage : la fiche au gabarit dans le ticket, la branche et la base déclarées, le journal et la checklist ouverts ; à la fin, le ticket passe en ready et tu t’arrêtes.',
  'exécution':
    'Tu ne fais que l’exécution : la branche depuis la base, les commits, la PR vers la base avec `Closes #N`, le journal et la checklist à jour ; à la fin, le ticket passe en in-review et tu t’arrêtes.',
  revue:
    'Tu ne fais que la revue : chaque critère avec sa preuve, le diff, le périmètre, les tests, le journal et la checklist ; à la fin, tu approuves et le ticket passe en ready-for-prod, ou tu le renvoies en in-progress ou to-refine.',
  'clôture':
    'Tu ne fais que la clôture : prépare la livraison (PR approuvée, chaque critère prouvé) et rends la main ; le demandeur merge, ferme le ticket et supprime la branche, et tu ne constates qu’à son mot explicite.',
}

/** The step a mission plays, or null when its state names none. */
export function missionStep(mission = {}) {
  return STEP_BY_STATE[mission.state] ?? null
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

/**
 * Parse a mission checklist into blocks the panel can render.
 *
 * The file is plain markdown written by the agent: `##` headings, `- [ ]`
 * gestures, `- [x]` once proved, and the old system's `- [~]` for a point that
 * was not exercised. Anything else stays a line of text, so a hand-written
 * checklist never breaks the drawer. Pure: tested without a DOM and inlined
 * into the client bundle by `tools/build.mjs`.
 */
export function parseChecklist(source = '') {
  const blocks = []
  const counts = { total: 0, checked: 0, partial: 0, open: 0 }
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')

  for (const line of lines) {
    if (line.trim() === '') continue

    const heading = /^\s{0,3}(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    const item = /^\s*[-*+]\s+\[([ xX~])\]\s*(.*)$/.exec(line)
    if (item) {
      const mark = item[1]
      const state = mark === 'x' || mark === 'X' ? 'checked' : mark === '~' ? 'partial' : 'open'
      counts.total += 1
      counts[state] += 1
      blocks.push({ type: 'item', state, text: item[2].trim() })
      continue
    }

    // A plain bullet or an ordered line stays a line: only the explicit boxes
    // are counted, so a note written with `-` is not a false result.
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1].trim() })
      continue
    }

    blocks.push({ type: 'text', text: line.trim() })
  }

  return { blocks, counts }
}

/**
 * Geometry of a workflow graph, computed from the model alone.
 *
 * The file never carries coordinates: a gesture's position is a function of the
 * graph. Rows come from the longest path over the forward arcs, so the method
 * reads from top to bottom — the flow of a corridor, not a wall of columns. A
 * back arc — a retry, a return to the previous stage — leaves on the right and
 * comes back on the right, instead of folding the rows onto themselves.
 */
const GRAPH_ROW = 96
const GRAPH_COLUMN = 240
const GRAPH_GAP = 26
const GRAPH_PAD = 20
const GRAPH_ARC_MARGIN = 24
const GRAPH_ARC_STEP = 16
const GRAPH_LABEL_ROOM = 152
const GRAPH_GESTURE = { width: 220, height: 48 }
const GRAPH_STATE = { width: 160, height: 34 }

/**
 * Les extrémités d'un arc : l'entrée, les gestes dans l'ordre du fichier, puis
 * les sorties. Un modèle absent rend une liste vide, pour qu'un rendu puisse
 * attendre le brouillon sans tomber.
 */
export function endPoints(model) {
  if (!model) return []
  return [
    { id: model.entry, kind: 'etat' },
    ...(model.nodes ?? []).map((node) => ({ id: node.id, kind: 'geste' })),
    ...(model.exit ?? []).map((state) => ({ id: state, kind: 'etat' })),
  ]
}

export function layoutWorkflow(model = {}) {
  const nodes = Array.isArray(model.nodes) ? model.nodes.filter((node) => node && node.id) : []
  const edges = Array.isArray(model.edges) ? model.edges.filter((edge) => edge && edge.from && edge.to) : []
  const entry = typeof model.entry === 'string' ? model.entry : null
  const exits = Array.isArray(model.exit) ? model.exit.filter((state) => typeof state === 'string') : []

  // Every endpoint that gets a box: the entry state, the gestures, the exits.
  const shape = new Map()
  if (entry) shape.set(entry, { kind: 'etat', label: entry, size: GRAPH_STATE, rank: -1 })
  nodes.forEach((node, index) => {
    shape.set(node.id, { kind: 'geste', label: node.label ?? node.id, size: GRAPH_GESTURE, rank: index })
  })
  exits.forEach((state, index) => {
    if (!shape.has(state)) shape.set(state, { kind: 'etat', label: state, size: GRAPH_STATE, rank: 1000 + index })
  })

  const adjacency = new Map()
  for (const edge of edges) {
    if (!shape.has(edge.from) || !shape.has(edge.to)) continue
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, [])
    adjacency.get(edge.from).push(edge.to)
  }

  // Depth-first walk: an arc pointing back at a node on the current path is a
  // back arc, and does not push its target down a row.
  const color = new Map()
  const back = new Set()
  const walk = (id) => {
    color.set(id, 1)
    for (const next of adjacency.get(id) ?? []) {
      const seen = color.get(next) ?? 0
      if (seen === 1) back.add(`${id}\u0000${next}`)
      else if (seen === 0) walk(next)
    }
    color.set(id, 2)
  }
  for (const id of shape.keys()) if ((color.get(id) ?? 0) === 0) walk(id)

  const forward = edges.filter((edge) => shape.has(edge.from) && shape.has(edge.to) && !back.has(`${edge.from}\u0000${edge.to}`))
  const level = new Map()
  if (entry) level.set(entry, 0)
  for (let pass = 0; pass <= forward.length; pass += 1) {
    let changed = false
    for (const edge of forward) {
      if (!level.has(edge.from)) continue
      const next = level.get(edge.from) + 1
      if ((level.get(edge.to) ?? -1) < next) {
        level.set(edge.to, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const maxLevel = Math.max(0, ...level.values())
  for (const [id, value] of shape) {
    if (!level.has(id)) level.set(id, value.kind === 'geste' ? maxLevel + 1 : 0)
  }

  // Within a row, the entry state leads, then the gestures in file order, then
  // the exit states: two saves of the same graph draw the same picture.
  const rows = new Map()
  for (const [id, value] of shape) {
    const row = level.get(id) ?? 0
    if (!rows.has(row)) rows.set(row, [])
    rows.get(row).push({ id, ...value })
  }
  const rowWidth = (members) => members.reduce((sum, member) => sum + member.size.width, 0) + Math.max(0, members.length - 1) * GRAPH_GAP
  const widest = Math.max(0, ...[...rows.values()].map(rowWidth))

  const boxes = []
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const members = rows.get(row).sort((a, b) => a.rank - b.rank)
    let x = GRAPH_PAD + (widest - rowWidth(members)) / 2
    const y = GRAPH_PAD + row * GRAPH_ROW
    for (const member of members) {
      boxes.push({
        id: member.id,
        kind: member.kind,
        label: member.label,
        level: row,
        x,
        y,
        width: member.size.width,
        height: member.size.height,
      })
      x += member.size.width + GRAPH_GAP
    }
  }

  const byId = new Map(boxes.map((box) => [box.id, box]))
  const links = []
  let backIndex = 0
  for (const edge of edges) {
    const source = byId.get(edge.from)
    const target = byId.get(edge.to)
    if (!source || !target) continue
    const goingBack = back.has(`${edge.from}\u0000${edge.to}`) || target.level <= source.level
    let path
    let labelX
    let labelY
    if (goingBack) {
      const start = { x: source.x + source.width, y: source.y + source.height / 2 }
      const end = { x: target.x + target.width, y: target.y + target.height / 2 }
      const bulge = GRAPH_PAD + widest + GRAPH_ARC_MARGIN + backIndex * GRAPH_ARC_STEP
      backIndex += 1
      path = `M ${start.x} ${start.y} C ${bulge} ${start.y}, ${bulge} ${end.y}, ${end.x} ${end.y}`
      // Le libellé se pose dans la marge, à la hauteur de la rangée qu'il rejoint :
      // deux retours vers deux rangées différentes ne se marchent pas dessus.
      labelX = bulge + 8
      labelY = end.y + 4
    } else {
      const start = { x: source.x + source.width / 2, y: source.y + source.height }
      const end = { x: target.x + target.width / 2, y: target.y }
      const bend = Math.max(22, (end.y - start.y) / 3)
      path = `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`
      labelX = (start.x + end.x) / 2
      labelY = (start.y + end.y) / 2
    }
    links.push({ from: edge.from, to: edge.to, when: edge.when ?? '', back: goingBack, path, labelX, labelY })
  }

  const right = Math.max(
    GRAPH_PAD,
    ...boxes.map((box) => box.x + box.width),
    ...links.filter((link) => link.back && link.when).map((link) => link.labelX + GRAPH_LABEL_ROOM),
  )
  const bottom = Math.max(GRAPH_PAD, ...boxes.map((box) => box.y + box.height))
  return { boxes, links, width: right + GRAPH_PAD, height: bottom + GRAPH_PAD }
}

/** Drop a gesture and every arc that touched it. */
/**
 * The model a save sends back: the server's display fields (`errors`,
 * `headings`, `file`, `text`) belong to the answer, not to the file, and
 * writing them back would put them in the YAML.
 */
export function modelOf(entry = {}) {
  const { errors, orphanSections, headings, file, text, ...model } = entry ?? {}
  return model
}

export function withoutNode(model = {}, id) {
  const nodes = Array.isArray(model.nodes) ? model.nodes : []
  const edges = Array.isArray(model.edges) ? model.edges : []
  return {
    ...model,
    nodes: nodes.filter((node) => node.id !== id),
    edges: edges.filter((edge) => edge.from !== id && edge.to !== id),
  }
}

/** Drop one arc, by its two ends. */
export function withoutEdge(model = {}, from, to) {
  const edges = Array.isArray(model.edges) ? model.edges : []
  return { ...model, edges: edges.filter((edge) => !(edge.from === from && edge.to === to)) }
}

/**
 * Set an arc's condition. An existing arc keeps its place in the file — the
 * diff shows the condition, not a moved line; a new arc is appended.
 */
export function upsertEdge(model = {}, from, to, when = '') {
  const edges = Array.isArray(model.edges) ? model.edges : []
  const next = { from, to }
  if (when) next.when = when
  const found = edges.some((edge) => edge.from === from && edge.to === to)
  return {
    ...model,
    edges: found ? edges.map((edge) => (edge.from === from && edge.to === to ? next : edge)) : [...edges, next],
  }
}

/** A fresh gesture id, never colliding with the ones already in the model. */
export function nextGestureId(model = {}) {
  const taken = new Set((Array.isArray(model.nodes) ? model.nodes : []).map((node) => node.id))
  let index = 1
  while (taken.has(`geste-${index}`)) index += 1
  return `geste-${index}`
}
