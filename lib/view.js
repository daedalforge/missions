/**
 * View helpers: filtering, grouping, relative age, filter options.
 *
 * Kept pure so the panel stays a thin rendering layer and the rules are
 * testable without a DOM. `tools/build.mjs` inlines this module into the client
 * bundle.
 */

// Display order of the panel's groups: attention first (active work, review,
// next up, backlog, delivery queue), then closed work last. This is not the
// workflow order; the state filter keeps that one (STATE_FILTER_ORDER below).
const STATE_ORDER = ['in-progress', 'in-review', 'ready', 'to-refine', 'ready-for-prod', 'done']
const STATE_FILTER_ORDER = ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done']
const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

// « Priorité haute » couvre deux niveaux. Le filtre Priorité prend une liste,
// comme le Statut : le widget des stories ouvre la liste sur les deux niveaux.
const HIGH_PRIORITIES = ['urgent', 'high']

/** The filter bar at rest: no text, no dimension, default order. */
export const EMPTY_FILTERS = { type: null, state: null, epic: null, priority: null, project: null, missing: null }

/** Session key of the bar, next to `missions.theme` for the theme. */
export const FILTERS_KEY = 'missions.filters'

/**
 * Session key of the Done bar.
 *
 * Done is a view of its own, not a state of the open list: its bar keeps its
 * own search, filters and order, so opening Done never rewrites the bar the
 * Missions list left behind.
 */
export const DONE_FILTERS_KEY = 'missions.filters.done'

// What the panel's own selects can produce. Anything else in a saved bar is
// stale: restoring it would select a value the user cannot see in the list.
const FILTER_TYPES = ['bug', 'story']
const FILTER_SORTS = ['priority', 'points']
const FILTER_STATES = [...STATE_FILTER_ORDER, 'unknown']
// The open list's bar offers every state but `done`: closed work has its own
// view, and a saved bar that asks for `done` is reduced to no status filter.
const OPEN_FILTER_STATES = FILTER_STATES.filter((state) => state !== 'done')

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
 *
 * Closed work is a view of its own (`allowDone`): the open list drops `done`
 * whatever the state filter says, and only the Done view passes `allowDone` to
 * keep the closed rows it was handed.
 */
export function filterMissions(
  missions = [],
  { query = '', type = null, state = null, epic = null, priority = null, project = null, missing = null, allowDone = false } = {},
) {
  const needle = String(query ?? '').trim().toLowerCase()
  const states = selectedValues(state)
  return missions.filter((mission) => {
    if (type && mission.type !== type) return false
    // Closed work is history: it stays out of the open list, and a state filter
    // is not a door around that rule any more — the Done view is.
    if (!allowDone && mission.state === 'done') return false
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

/**
 * States present in the list, in workflow order; unknown states last.
 *
 * `done` is only offered when the caller asks for it (`allowDone`): the open
 * list keeps it out of its Status filter, and the Done view fixes the value
 * itself instead of deriving it from the rows.
 */
export function stateOptions(missions = [], { allowDone = false } = {}) {
  const present = new Set(
    missions.map((mission) => (STATE_ORDER.includes(mission.state) ? mission.state : 'unknown')),
  )
  return [
    ...STATE_FILTER_ORDER.filter((state) => present.has(state) && (allowDone || state !== 'done')),
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
 * filters to nothing, like a manual selection would. The open bar refuses
 * `done` unless `allowDone` says this is the Done bar.
 */
export function filterSnapshot({ query = '', filters = {}, sort = null } = {}, { allowDone = false } = {}) {
  const source = filters ?? {}
  return {
    query: typeof query === 'string' ? query : '',
    type: keptChoice(source.type, FILTER_TYPES),
    state: keptChoices(source.state, allowDone ? FILTER_STATES : OPEN_FILTER_STATES),
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
export function filterBarState(snapshot = {}, { allowDone = false } = {}) {
  const flat = filterSnapshot({ query: snapshot?.query, filters: snapshot, sort: snapshot?.sort }, { allowDone })
  const { query, type, state, epic, priority, project, missing, sort } = flat
  return { query, filters: { type, state, epic, priority, project, missing }, sort }
}

/** Read a stored snapshot back; anything unusable is the empty bar. */
export function parseFilterSnapshot(raw, { allowDone = false } = {}) {
  const empty = filterSnapshot({}, { allowDone })
  if (typeof raw !== 'string' || raw.trim() === '') return empty
  let stored
  try {
    stored = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return empty
  return filterSnapshot({ query: stored.query, filters: stored, sort: stored.sort }, { allowDone })
}

/**
 * The bar the session saved, or the empty bar.
 *
 * Storage is optional: a missing key, a storage that throws, or a payload the
 * panel cannot use all restore the default instead of failing the render.
 */
export function readFilterSnapshot(storage, key = FILTERS_KEY, { allowDone = false } = {}) {
  try {
    return parseFilterSnapshot(storage?.getItem?.(key) ?? null, { allowDone })
  } catch {
    return filterSnapshot({}, { allowDone })
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
export function writeFilterSnapshot(storage, bar = {}, key = FILTERS_KEY, { allowDone = false } = {}) {
  if (!storage) return
  const snapshot = filterSnapshot(bar, { allowDone })
  try {
    if (isEmptySnapshot(snapshot)) storage.removeItem?.(key)
    else storage.setItem?.(key, JSON.stringify(snapshot))
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

/** Stories of high priority — urgent or high — every open state, oldest first. */
export function highPriorityStories(missions = []) {
  return missions
    .filter((mission) => mission?.type === 'story' && mission?.state !== 'done' && HIGH_PRIORITIES.includes(mission?.priority))
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
  if (mission.state === 'done') return 'mission is done: a closed mission plays no session'
  if (Array.isArray(mission.stateConflict) && mission.stateConflict.length > 0) {
    return `state labels conflict (${mission.stateConflict.join(', ')}), keep one`
  }
  if (!mission.branch) return 'branch is not declared, set it below or in the mission folder'
  if (!mission.base) return 'base branch is not declared, set it below or in the mission folder'
  return null
}

/**
 * Why a mission cannot start a free session, or null when it can.
 *
 * A free session plays no step: it answers a question and may work in the
 * mission — the journal, the checklist, the ticket, the repository — but it
 * never moves the state. Only `done` closes it — a closed mission plays no
 * session at all. A missing branch or base, or a state conflict, blocks the
 * step session but not this one: the drawer opens it precisely in cadrage,
 * before the branch exists.
 */
export function freeSessionBlocker(mission = {}) {
  if (mission.state === 'done') return 'mission is done: a closed mission plays no session'
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
 * How a session is told to read its ticket.
 *
 * A github.com issue page is a few hundred kilobytes of HTML, so a fetch
 * truncates it: the session then re-reads through the CLI, one turn lost — or
 * works from a partial body without noticing. The prompt names the command
 * instead. `-R` is what makes it work from the workspace root, which is not a
 * git repository: there `gh` cannot infer the repository from `origin`.
 */
export function ticketReadLine(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(String(url ?? '').trim())
  if (!match) {
    return `Ouvre d'abord le ticket : ${url ?? '(lien indisponible)'} — depuis le CLI du tracker, jamais la page HTML (tronquée).`
  }
  const [, owner, repo, number] = match
  return `Lis d'abord le ticket avec le CLI, jamais sa page HTML (tronquée) :\ngh issue view ${number} -R ${owner}/${repo} --json number,title,state,body,labels,milestone,assignees,comments`
}

/**
 * What a session receives, common to both buttons of the drawer.
 *
 * The envelope is the same for the step session and the feedback session: the
 * ticket is read with the CLI, the step and its exit are announced, the branch
 * and base are declared, the journal and checklist are named, and the guardrail
 * closes. Only the brief differs. `extra` is inserted right after the
 * branch/base line — the feedback session adds the project's clone there.
 */
function sessionEnvelope(mission = {}, brief, extra = '') {
  const blocker = executionBlocker(mission)
  const step = missionStep(mission)
  const journalPath = mission.folder ? `missions/${mission.folder}/journal.md` : null
  const checklistPath = mission.folder ? `missions/${mission.folder}/checklist.md` : null
  const stepLine = step
    ? `Étape en cours : ${step} (statut ${mission.state}).`
    : `Étape en cours : à déterminer (statut ${mission.state ?? 'inconnu'}).`
  return `Travaille sur la mission ${mission.key} — ${mission.title}.\n\n${ticketReadLine(mission.url)}\n${stepLine} ${brief}\n\nChaque étape se joue dans une nouvelle session : à la fin de celle-ci, arrête-toi ; l'étape suivante sera une nouvelle session.${blocker === null ? `\n\nBranche : ${mission.branch} ; base : ${mission.base}.${extra}` : ''}${journalPath ? `\n\nJournal de mission : ${journalPath} — tiens-le à jour à chaque étape.` : ''}${checklistPath ? `\n\nChecklist de mission : ${checklistPath} — coche chaque point avec sa preuve.` : ''}\n\nGarde-fou : tu ne merges jamais la PR et tu n'écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s'il te le demande.`
}

/**
 * The prompt of the step session, taken verbatim from the drawer's old inline
 * string: the button, its label and its tests predate the extraction, and the
 * string is what they pin.
 */
export function missionSessionPrompt(mission = {}) {
  const step = missionStep(mission)
  const stepBrief =
    STEP_BRIEFS[step] ?? 'Lis le ticket et le workflow avant d’agir : ce statut ne dit pas quelle étape jouer.'
  return sessionEnvelope(mission, stepBrief)
}

/**
 * What a feedback session does: read the PR's remarks, triage them, fix or
 * answer, then hand back.
 *
 * The panel never calls GitHub; the session alone reads the PR, in the
 * project's clone, so the commands are named. `<branche>` is replaced with the
 * mission's declared branch in `feedbackSessionPrompt`; the other placeholders
 * stay — the session resolves them from the PR it found.
 */
export const FEEDBACK_BRIEF =
  'Tu ne fais que les remontées de la PR : retrouve la PR de la branche avec `gh pr list --head <branche> --state all` (si elle ne rend rien, dis-le et arrête-toi), lis ses revues, ses commentaires et ses fils de discussion en ligne (dont `gh api repos/<owner>/<repo>/pulls/<n>/comments`), trie chaque remontée (corriger / répondre / hors périmètre, sans élargir le périmètre), corrige sur la branche et pousse (`<CLÉ>: <impératif>`), mets le journal et la checklist à jour avec les preuves ; tu ne merges pas la PR, tu n’écris pas sur main, tu ne touches pas aux labels, tu ne fermes pas le ticket et tu t’arrêtes.'

/**
 * The prompt of the feedback session: the same envelope, the feedback brief,
 * and the project's clone after the branch/base line — a session must not have
 * to guess which checkout carries the PR.
 */
export function feedbackSessionPrompt(mission = {}) {
  const brief = FEEDBACK_BRIEF.replace('<branche>', String(mission.branch ?? ''))
  const repoLine = mission.repo ? `\nDépôt du projet : ${mission.repo}.` : ''
  return sessionEnvelope(mission, brief, repoLine)
}

/**
 * What a free session does: answer a question, and open every write but the
 * workflow.
 *
 * The drawer's session is asked before or beside the step, often in cadrage,
 * and must not advance the ticket: the brief closes the state, the labels,
 * the step and the closure. Everything else is open — a free session may hold
 * the journal, tick the checklist, write the ticket and work the repository,
 * so it can help without pretending to be the step. The mission guardrail
 * still applies: never merge, never write on `main`.
 */
export const FREE_BRIEF =
  'Session libre : aucune étape du workflow n’est jouée et le ticket n’avance pas. Réponds à la question écrite à la suite de ce message ; si le message n’en porte pas, demande-la et arrête-toi.\n\n' +
  'Tu peux écrire dans la mission : le journal, la checklist, le ticket (corps et commentaires) et le dépôt du projet (fichiers, commits, push sur la branche, ouverture de la PR). Ce qui t’est interdit, c’est de toucher au workflow : pas de changement de statut ni de label, pas de fermeture du ticket, et tu ne joues aucune étape. Tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur.\n\n' +
  'Tu réponds, puis tu t’arrêtes.'

/**
 * The prompt of the free session: the mission's identity, its ticket read with
 * the CLI, its state as information, the project's clone, the branch and base
 * when both are declared, the journal and checklist to keep up to date, then
 * the free brief.
 *
 * It composes beside `sessionEnvelope` on purpose: the step prompt is pinned
 * character for character, and this one must carry no step at all. The branch
 * and base are optional here — `freeSessionBlocker` only closes `done`, so a
 * mission in cadrage keeps its free session before the branch exists.
 */
export function freeSessionPrompt(mission = {}) {
  const journalPath = mission.folder ? `missions/${mission.folder}/journal.md` : null
  const checklistPath = mission.folder ? `missions/${mission.folder}/checklist.md` : null
  const places = [
    mission.repo ? `Dépôt du projet : ${mission.repo}.` : null,
    mission.branch && mission.base ? `Branche : ${mission.branch} ; base : ${mission.base}.` : null,
  ].filter(Boolean)
  const placesBlock = places.length > 0 ? `\n\n${places.join('\n')}` : ''
  const journalBlock = journalPath
    ? `\n\nJournal de mission : ${journalPath} — tiens-le à jour.`
    : ''
  const checklistBlock = checklistPath
    ? `\n\nChecklist de mission : ${checklistPath} — coche chaque point avec sa preuve.`
    : ''
  return `Travaille sur la mission ${mission.key} — ${mission.title}.\n\n${ticketReadLine(mission.url)}\nStatut du ticket : ${mission.state ?? 'inconnu'} (information seule).${placesBlock}${journalBlock}${checklistBlock}\n\n${FREE_BRIEF}`
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

/**
 * The reason a block just wrote, shown without waiting for the next read.
 *
 * The panel knows the text it has just posted and the comment URL the tracker
 * returned: the card shows them at once instead of an empty `unavailable` while
 * the list is refreshed. Unblocking clears the field; the next tracked read
 * brings the tracker's own answer back.
 */
export function blockedReasonAfterWrite({ next, message, comment, now = Date.now() } = {}) {
  if (!next) return null
  return {
    state: 'found',
    author: null,
    body: String(message ?? '').trim(),
    createdAt: new Date(now).toISOString(),
    url: comment ?? null,
  }
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
const GRAPH_DECISION = { width: 26, height: 18 }
const GRAPH_DECISION_GAP = 8
const GRAPH_LABEL_LINE = 12
const GRAPH_LABEL_CHAR = 5.4
const GRAPH_ROW_GAP = 12

/** Largeur approchée d'une étiquette, en pixels, pour lui réserver sa place. */
const labelWidthOf = (text) => String(text ?? '').length * GRAPH_LABEL_CHAR

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

  // Un geste qui offre plusieurs sorties porte un losange de décision : les
  // arcs sortants y prennent leur départ et ses conditions s'empilent à sa
  // droite. Le décompte ne porte que sur les arcs réellement dessinés.
  const outGoing = new Map()
  const conditionalForward = new Map()
  for (const edge of edges) {
    if (!shape.has(edge.from) || !shape.has(edge.to)) continue
    outGoing.set(edge.from, (outGoing.get(edge.from) ?? 0) + 1)
    if (edge.when && !back.has(`${edge.from}\u0000${edge.to}`)) {
      conditionalForward.set(edge.from, (conditionalForward.get(edge.from) ?? 0) + 1)
    }
  }
  const deciding = new Set(
    [...outGoing].filter(([id, count]) => count >= 2 && shape.get(id)?.kind === 'geste').map(([id]) => id),
  )

  // Une rangée sans décision garde exactement son pas ; une rangée avec
  // décision s'agrandit juste assez pour que le losange, ses étiquettes et la
  // rangée suivante ne se marchent jamais dessus.
  const rowTops = new Map()
  const rowPitch = new Map()
  for (const [row, members] of rows) {
    let pitch = GRAPH_ROW
    for (const member of members) {
      if (!deciding.has(member.id)) continue
      const lines = conditionalForward.get(member.id) ?? 0
      const diamond = GRAPH_GESTURE.height + GRAPH_DECISION_GAP + GRAPH_DECISION.height
      const labels = GRAPH_GESTURE.height + GRAPH_DECISION_GAP + GRAPH_LABEL_LINE + Math.max(0, lines - 1) * GRAPH_LABEL_LINE + 3
      pitch = Math.max(pitch, Math.max(diamond, labels) + GRAPH_ROW_GAP)
    }
    rowPitch.set(row, pitch)
  }
  let cursor = GRAPH_PAD
  for (let row = 0; row <= Math.max(0, ...rows.keys()); row += 1) {
    rowTops.set(row, cursor)
    cursor += rowPitch.get(row) ?? GRAPH_ROW
  }

  const boxes = []
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const members = rows.get(row).sort((a, b) => a.rank - b.rank)
    let x = GRAPH_PAD + (widest - rowWidth(members)) / 2
    const y = rowTops.get(row)
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

  // Le losange se centre sous son geste, à huit pixels de sa boîte : c'est un
  // repère de lecture, pas un nœud du modèle, et il ne déplace rien d'autre.
  const decisions = []
  const decisionOf = new Map()
  for (const box of boxes) {
    if (!deciding.has(box.id)) continue
    const decision = {
      id: box.id,
      level: box.level,
      x: box.x + box.width / 2 - GRAPH_DECISION.width / 2,
      y: box.y + box.height + GRAPH_DECISION_GAP,
      width: GRAPH_DECISION.width,
      height: GRAPH_DECISION.height,
    }
    decisionOf.set(box.id, decision)
    decisions.push(decision)
  }

  // L'ordre des étiquettes d'un losange : la cible la plus à gauche d'abord,
  // puis l'identifiant. Deux calculs du même modèle donnent le même dessin.
  const stack = new Map()
  for (const id of decisionOf.keys()) {
    const arcs = edges
      .filter((edge) => edge.from === id && byId.has(edge.to) && !back.has(`${edge.from}\u0000${edge.to}`) && edge.when)
      .sort((a, b) => byId.get(a.to).x - byId.get(b.to).x || String(a.to).localeCompare(String(b.to)))
    arcs.forEach((edge, index) => stack.set(`${edge.from}\u0000${edge.to}`, index))
  }

  const links = []
  let backIndex = 0
  // La dernière ligne occupée par un retour, rangée d'arrivée par rangée
  // d'arrivée : deux retours qui rejoignent la même rangée s'empilent.
  const backRowY = new Map()
  for (const edge of edges) {
    const source = byId.get(edge.from)
    const target = byId.get(edge.to)
    if (!source || !target) continue
    const goingBack = back.has(`${edge.from}\u0000${edge.to}`) || target.level <= source.level
    const decision = goingBack ? null : decisionOf.get(edge.from)
    const width = labelWidthOf(edge.when)
    let path
    let labelX
    let labelY
    let labelAnchor = 'middle'
    if (goingBack) {
      const start = { x: source.x + source.width, y: source.y + source.height / 2 }
      const end = { x: target.x + target.width, y: target.y + target.height / 2 }
      const bulge = GRAPH_PAD + widest + GRAPH_ARC_MARGIN + backIndex * GRAPH_ARC_STEP
      backIndex += 1
      path = `M ${start.x} ${start.y} C ${bulge} ${start.y}, ${bulge} ${end.y}, ${end.x} ${end.y}`
      // Le libellé se pose dans la marge, à la hauteur de la rangée qu'il rejoint.
      // Deux retours qui rejoignent la même rangée partagent la même ligne de
      // base : le second descend d'une ligne de texte, et ainsi de suite. Un
      // retour seul garde exactement la ligne de bf9e191 ; l'empilement reste
      // dans la bande de rangée, sans toucher aux boîtes ni au cadre. Un retour
      // sans condition ne dessine rien : il n'occupe pas de ligne.
      labelX = bulge + 8
      const previousY = edge.when ? backRowY.get(target.level) : undefined
      labelY = previousY === undefined ? end.y + 4 : Math.max(end.y + 4, previousY + GRAPH_LABEL_LINE)
      if (edge.when) backRowY.set(target.level, labelY)
      labelAnchor = 'start'
    } else {
      const start = decision
        ? { x: decision.x + decision.width / 2, y: decision.y + decision.height }
        : { x: source.x + source.width / 2, y: source.y + source.height }
      const end = { x: target.x + target.width / 2, y: target.y }
      const bend = Math.max(22, (end.y - start.y) / 3)
      path = `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`
      if (decision) {
        // Les conditions d'un choix s'empilent à droite du losange : trois
        // branches ne se recouvrent pas, et chacune garde son texte entier.
        labelX = decision.x + decision.width + 6
        labelY = decision.y + GRAPH_LABEL_LINE + (stack.get(`${edge.from}\u0000${edge.to}`) ?? 0) * GRAPH_LABEL_LINE
        labelAnchor = 'start'
      } else {
        labelX = Math.max(GRAPH_PAD + width / 2, (start.x + end.x) / 2)
        labelY = (start.y + end.y) / 2
      }
    }
    links.push({ from: edge.from, to: edge.to, when: edge.when ?? '', back: goingBack, path, labelX, labelY, labelWidth: width, labelAnchor })
  }

  const right = Math.max(
    GRAPH_PAD,
    ...boxes.map((box) => box.x + box.width),
    ...links.filter((link) => link.when).map((link) => {
      if (link.back) return link.labelX + Math.max(GRAPH_LABEL_ROOM, link.labelWidth)
      if (link.labelAnchor === 'start') return link.labelX + link.labelWidth
      return link.labelX + link.labelWidth / 2
    }),
  )
  const bottom = Math.max(
    GRAPH_PAD,
    ...boxes.map((box) => box.y + box.height),
    ...decisions.map((decision) => decision.y + decision.height),
    ...links.filter((link) => link.when).map((link) => link.labelY + 4),
  )
  return { boxes, links, decisions, width: right + GRAPH_PAD, height: bottom + GRAPH_PAD }
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

/* ------------------------------------------------------------------------- *
 * Repositories: what the workspace root holds, read-only
 * ------------------------------------------------------------------------- */

/**
 * The scan's rows, newest commit first.
 *
 * The host already sorts them; the client sorts again because the widget is
 * the one that promises an order. A row with no commit goes last, and a tie is
 * broken by name so two scans of the same machine give the same list.
 */
export function sortRepositories(repositories = []) {
  return [...repositories].sort((left, right) => {
    const a = left?.lastCommit?.date ?? 0
    const b = right?.lastCommit?.date ?? 0
    if (a !== b) return b - a
    return String(left?.name ?? '').localeCompare(String(right?.name ?? ''))
  })
}

/** The branch a row shows: its name, or the commit a detached HEAD sits on. */
export function repositoryBranch(repository = {}) {
  if (repository.branch) return repository.branch
  if (repository.detached) return repository.head ? `detached @ ${repository.head}` : 'detached'
  return repository.error ? 'unreadable' : 'unknown'
}

/** A working tree in one label: clean, or how many files it moves. */
export function repositoryState(repository = {}) {
  if (repository.error) return { dirty: false, error: true, label: 'unreadable' }
  const dirty = Number(repository.dirty ?? 0)
  if (!Number.isFinite(dirty) || dirty <= 0) return { dirty: false, error: false, label: 'clean' }
  return { dirty: true, error: false, label: `${dirty} file${dirty === 1 ? '' : 's'}` }
}

/** The last commit of a row, or the sentence that says there is none. */
export function repositoryCommit(repository = {}) {
  if (repository.error) return ''
  const commit = repository.lastCommit
  if (!commit) return 'no commit yet'
  return commit.subject || commit.sha || ''
}

/** A bounded scan runs in about a second: one decimal is enough. */
export function scanDuration(durationMs) {
  const ms = Number(durationMs)
  if (!Number.isFinite(ms) || ms < 0) return ''
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * The head of the repositories view: how many repositories and worktrees, how
 * long the scan took, and how many repositories git refused — the total the
 * rows below have to match.
 *
 * The rows carry their kind, so the head separates the clones from the
 * worktrees instead of counting checkouts as repositories: it says the same
 * number as the tab badge. A scan that only carries its total (an older shape,
 * or a test fixture) keeps the line it always had.
 */
export function scanLabel(scan = {}) {
  const rows = Array.isArray(scan.repositories) ? scan.repositories : null
  const count = rows ? rows.filter((row) => row?.kind !== 'worktree').length : Number(scan.count ?? 0)
  const worktrees = rows ? rows.length - count : 0
  const duration = scanDuration(scan.durationMs)
  const errors = Array.isArray(scan.errors) ? scan.errors.length : 0
  return [
    `${count} ${count === 1 ? 'repository' : 'repositories'}`,
    worktrees ? `${worktrees} ${worktrees === 1 ? 'worktree' : 'worktrees'}` : null,
    duration ? `scanned in ${duration}` : null,
    errors ? `${errors} unreadable` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * "3 094 commits on main": the total a history page belongs to.
 *
 * The count is what the branch holds, not what the page shows — the number
 * that tells the reader "Show more" will end. Thousands are spaced, never
 * abbreviated: 3 094 is a fact, "3k" is a rumour.
 */
export function historyLabel(history = {}) {
  const total = Number(history.total)
  const branch = history.branch
  if (!Number.isFinite(total) || total < 0 || !branch) return ''
  const count = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} commit${total === 1 ? '' : 's'}`
  return `${count} on ${branch}`
}

/** The folder that carries a worktree: its last path segment. */
export function worktreeLabel(path) {
  const clean = String(path ?? '').replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * The left padding of a tree row: one step per declared depth.
 *
 * The step is fixed, not read from the file's own indentation: a layout may
 * be indented by two spaces or by a tab, and the tree reads the same.
 */
export function treeIndent(depth) {
  const level = Number(depth)
  if (!Number.isFinite(level) || level <= 0) return 10
  return 10 + level * 14
}

/**
 * Usage tally: the gestures the panel counts, and the verdict a count deserves.
 *
 * The registry is shared by both halves: the host refuses an element this list
 * does not declare, and the panel counts only what it names. A new gesture is
 * one line here, one `track()` call where the gesture happens — nowhere else.
 *
 * Ids are dotted by domain (`filter.state`) so a family reads at a glance, and
 * every label is a sentence the Usage tab can show as it is.
 */
export const USAGE_ELEMENTS = Object.freeze([
  // Tabs
  { id: 'tab.dashboard', label: 'Dashboard tab', section: 'Tabs' },
  { id: 'tab.missions', label: 'Missions tab', section: 'Tabs' },
  { id: 'tab.done', label: 'Done tab', section: 'Tabs' },
  { id: 'tab.repositories', label: 'Repositories tab', section: 'Tabs' },
  { id: 'tab.workflows', label: 'Workflows tab', section: 'Tabs' },
  { id: 'tab.usage', label: 'Usage tab', section: 'Tabs' },

  // Mission list
  { id: 'filter.search', label: 'Search the list', section: 'Mission list' },
  { id: 'filter.state', label: 'Filter by state', section: 'Mission list' },
  { id: 'filter.type', label: 'Filter by type', section: 'Mission list' },
  { id: 'filter.epic', label: 'Filter by epic', section: 'Mission list' },
  { id: 'filter.project', label: 'Filter by project', section: 'Mission list' },
  { id: 'filter.priority', label: 'Filter by priority', section: 'Mission list' },
  { id: 'filter.sort', label: 'Change the order', section: 'Mission list' },
  { id: 'filter.missing', label: 'Show the missing ones', section: 'Mission list' },
  { id: 'filter.clear', label: 'Clear the filter bar', section: 'Mission list' },
  { id: 'list.refresh', label: 'Refresh the list', section: 'Mission list' },
  { id: 'list.retry', label: 'Retry a failed read', section: 'Mission list' },
  { id: 'mission.open', label: 'Open a mission', section: 'Mission list' },
  { id: 'dashboard.view-all', label: 'Follow a widget', section: 'Mission list' },

  // Mission drawer
  { id: 'mission.tab.details', label: 'Details section', section: 'Mission drawer' },
  { id: 'mission.tab.journal', label: 'Journal section', section: 'Mission drawer' },
  { id: 'mission.tab.checklist', label: 'Checklist section', section: 'Mission drawer' },
  { id: 'mission.priority', label: 'Change the priority', section: 'Mission drawer' },
  { id: 'mission.block', label: 'Block or unblock a mission', section: 'Mission drawer' },
  { id: 'mission.declare', label: 'Declare branch and base', section: 'Mission drawer' },
  { id: 'mission.open-tracker', label: 'Open the ticket on the tracker', section: 'Mission drawer' },
  { id: 'mission.close-checkout', label: 'Close the local checkout', section: 'Mission drawer' },
  { id: 'mission.session', label: 'Start the mission session', section: 'Mission drawer' },
  { id: 'mission.feedback-session', label: 'Start the review session', section: 'Mission drawer' },

  // Repositories
  { id: 'repository.open', label: 'Open a repository', section: 'Repositories' },
  { id: 'repository.main', label: 'Open the main worktree', section: 'Repositories' },
  { id: 'repository.tab.details', label: 'Details section', section: 'Repositories' },
  { id: 'repository.tab.history', label: 'History section', section: 'Repositories' },
  { id: 'repository.tab.worktrees', label: 'Worktrees section', section: 'Repositories' },
  { id: 'repository.branch', label: 'Read another branch', section: 'Repositories' },
  { id: 'repository.more', label: 'Show more commits', section: 'Repositories' },

  // Workflows
  { id: 'workflow.step', label: 'Change the step', section: 'Workflows' },
  { id: 'workflow.save', label: 'Save the model', section: 'Workflows' },
  { id: 'workflow.reload', label: 'Reload the model', section: 'Workflows' },
  { id: 'workflow.gesture.add', label: 'Add a gesture', section: 'Workflows' },
  { id: 'workflow.gesture.remove', label: 'Remove a gesture', section: 'Workflows' },
  { id: 'workflow.arc.add', label: 'Add an arc', section: 'Workflows' },
  { id: 'workflow.arc.update', label: 'Update an arc', section: 'Workflows' },
  { id: 'workflow.arc.remove', label: 'Remove an arc', section: 'Workflows' },

  // Panel
  { id: 'action.theme', label: 'Switch the theme', section: 'Panel' },
])

/** How many distinct details one element keeps, and how long one may be. */
export const USAGE_MAX_VALUES = 32
export const USAGE_MAX_DETAIL = 64

// The verdicts are indices, never orders: they say where to look, and the tab
// prints the numbers they were read from. The gate keeps a novelty from being
// condemned before anyone had a chance to use it; past the gate, a gesture no
// one touches is a candidate to delete, and a gesture used often the one worth
// investing in.
export const USAGE_GATE_DAYS = 7
export const USAGE_GATE_EVENTS = 20
export const USAGE_STALE_DAYS = 30
export const USAGE_IMPROVE_COUNT = 2
export const USAGE_GROW_COUNT = 15
export const USAGE_GROW_SHARE = 0.1

/** What each verdict means, in the words the Usage tab shows. */
export const USAGE_VERDICTS = Object.freeze({
  grow: { label: 'Grow', note: 'Used often — the most worth investing in.' },
  keep: { label: 'Keep', note: 'Used regularly — leave it as it is.' },
  improve: { label: 'Improve', note: 'Little used, or left behind — make it easier to find, or better.' },
  remove: { label: 'Remove', note: 'Never used since the tally started — a candidate to delete.' },
  none: { label: 'No verdict yet', note: 'The tally is too young to say anything yet.' },
})

/** The registry entry for an id, or null when the id is not declared. */
export function usageElement(id) {
  return USAGE_ELEMENTS.find((element) => element.id === id) ?? null
}

/** Whole days between an ISO stamp and `now`; Infinity when there is no stamp. */
function usageAgeDays(stamp, now) {
  const time = Date.parse(stamp ?? '')
  if (!Number.isFinite(time)) return Infinity
  const days = (now - time) / 86_400_000
  return days > 0 ? Math.floor(days) : 0
}

/** A count as a whole number, whatever the file holds. */
function usageCount(value) {
  const count = Number(value)
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.floor(count)
}

/** An ISO stamp the file may hold, or null. */
function usageStamp(value) {
  if (typeof value !== 'string' || value === '') return null
  return Number.isFinite(Date.parse(value)) ? value : null
}

/** The stored element map, whether the record or the map itself is handed in. */
function usageElements(usage) {
  if (usage && typeof usage === 'object' && usage.elements && typeof usage.elements === 'object') return usage.elements
  return {}
}

/**
 * The observation gate: both halves of it count.
 *
 * A week and twenty gestures, and only then does a count say anything about a
 * gesture — a feature nobody has had time to meet is not a feature nobody
 * wants. The two numbers are read as "and", not "or": twenty gestures in two
 * days on one tab is not a week of use.
 */
export function usageGate(usage, now = Date.now()) {
  const elements = usageElements(usage)
  const events = Object.values(elements).reduce((sum, record) => sum + usageCount(record?.count), 0)
  const startedAt = usageStamp(usage?.startedAt)
  const days = startedAt === null ? 0 : usageAgeDays(startedAt, now)
  return {
    startedAt,
    updatedAt: usageStamp(usage?.updatedAt),
    events,
    days,
    open: startedAt !== null && days >= USAGE_GATE_DAYS && events >= USAGE_GATE_EVENTS,
  }
}

/**
 * The verdict one element earns.
 *
 * The order is the ticket's, and it is the whole of the reading: below the gate
 * nothing is said; past it, silence comes before the count (a gesture left
 * behind is a candidate to delete whatever its past), then the thin counts, and
 * only then the two ways of being used a lot — a count, or a share of every
 * gesture the panel has seen.
 */
export function usageVerdict(row = {}, context = {}) {
  const now = context.now ?? Date.now()
  const total = Number.isFinite(context.total) ? context.total : 0
  const count = usageCount(row.count)
  const gate = usageGate(context.usage ?? { startedAt: context.startedAt, elements: context.elements }, now)
  if (!gate.open) return 'none'
  if (count === 0) return 'remove'
  if (usageAgeDays(usageStamp(row.lastUsed ?? row.last), now) > USAGE_STALE_DAYS) return 'improve'
  if (count <= USAGE_IMPROVE_COUNT) return 'improve'
  if (count >= USAGE_GROW_COUNT || (total > 0 && count / total >= USAGE_GROW_SHARE)) return 'grow'
  return 'keep'
}

/** The sentence the report prints under a verdict, numbers included. */
function usageReason({ count, lastUsed, verdict }, now) {
  if (verdict === 'none') return USAGE_VERDICTS.none.note
  if (verdict === 'remove') return 'Never used since the tally opened.'
  const gestures = `${count} gesture${count === 1 ? '' : 's'}`
  if (verdict === 'improve') {
    const idle = usageAgeDays(lastUsed, now)
    return Number.isFinite(idle) && idle > USAGE_STALE_DAYS ? `${gestures}, nothing for ${idle} days.` : `${gestures} — rarely used.`
  }
  if (verdict === 'grow') return `${gestures} — the most used.`
  return `${gestures}, a routine.`
}

/**
 * The distinct details of one element, most used first.
 *
 * A detail that does not fit is dropped rather than shortened: an empty one, a
 * control character or more than `USAGE_MAX_DETAIL` characters means a file
 * edited by hand, and the report stays readable anyway.
 */
function usageDetails(record, limit = USAGE_MAX_VALUES) {
  const stored = record?.values
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return []
  return Object.entries(stored)
    .filter(([detail]) => typeof detail === 'string' && detail !== '')
    .filter(([detail]) => detail.length <= USAGE_MAX_DETAIL && !/[\u0000-\u001f\u007f]/.test(detail))
    .map(([detail, count]) => ({ detail, count: usageCount(count) }))
    .sort((left, right) => right.count - left.count || left.detail.localeCompare(right.detail))
    .slice(0, limit)
}

/**
 * Everything the Usage tab shows, computed from one stored tally.
 *
 * Pure and total: a missing file, a broken record and an id that left the
 * registry all produce a report rather than an error — the tab's job is to say
 * what the panel has seen, not to refuse to speak. The sections keep the
 * registry's order and each one ranks its rows by count, so the same tally
 * always reads the same way. `retired` keeps the counts of ids this build no
 * longer declares, and they still count in the total: a gesture removed from
 * the panel is not a gesture that never happened.
 */
export function usageReport(usage, now = Date.now()) {
  const stored = usageElements(usage)
  const gate = usageGate(usage, now)
  const total = Object.values(stored).reduce((sum, record) => sum + usageCount(record?.count), 0)
  const context = { now, total, usage }

  const rows = USAGE_ELEMENTS.map((element) => {
    const record = stored[element.id]
    const count = usageCount(record?.count)
    const firstUsed = usageStamp(record?.firstUsed)
    const lastUsed = usageStamp(record?.lastUsed)
    const verdict = usageVerdict({ count, lastUsed }, context)
    return {
      id: element.id,
      label: element.label,
      section: element.section,
      count,
      firstUsed,
      lastUsed,
      verdict,
      verdictLabel: USAGE_VERDICTS[verdict].label,
      reason: usageReason({ count, lastUsed, verdict }, now),
      details: usageDetails(record),
    }
  })

  const ranked = rows.filter((row) => row.count > 0).sort((left, right) => right.count - left.count)
  const sectionOrder = [...new Set(USAGE_ELEMENTS.map((element) => element.section))]
  const sections = sectionOrder
    .map((title) => ({
      title,
      rows: rows
        .filter((row) => row.section === title && row.count > 0)
        .sort((left, right) => right.count - left.count),
    }))
    .filter((section) => section.rows.length > 0)

  const declared = new Set(USAGE_ELEMENTS.map((element) => element.id))
  const retired = Object.entries(stored)
    .filter(([id]) => !declared.has(id))
    .map(([id, record]) => ({
      id,
      label: id,
      count: usageCount(record?.count),
      firstUsed: usageStamp(record?.firstUsed),
      lastUsed: usageStamp(record?.lastUsed),
      details: usageDetails(record),
    }))
    .filter((row) => row.count > 0)
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))

  return {
    broken: usage?.broken === true,
    total,
    startedAt: gate.startedAt,
    updatedAt: gate.updatedAt,
    days: gate.days,
    gate,
    rows,
    ranked,
    top: ranked.slice(0, 5),
    sections,
    idle: rows.filter((row) => row.count === 0),
    retired,
  }
}
