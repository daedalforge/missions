/**
 * Missions panel — client half.
 *
 * It only shows what the host half gives it: a normalized list and one error
 * per project. No token, no direct call to a tracker.
 *
 * Two views: a Dashboard that has nothing to show yet, and the mission list as
 * one outline shared by the Missions and Done tabs, with a filter bar on top.
 */
window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

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

    /** The filter bar at rest: no text, no dimension. */
    const EMPTY_FILTERS = { type: null, state: null, epic: null, priority: null, project: null, missing: null }

    /** Session key of the bar, next to `missions.theme` for the theme. */
    const FILTERS_KEY = 'missions.filters'

    /**
     * Session key of the Done bar.
     *
     * Done is a view of its own, not a state of the open list: its bar keeps its
     * own search and filters, so opening Done never rewrites the bar the Missions
     * list left behind.
     */
    const DONE_FILTERS_KEY = 'missions.filters.done'

    // What the panel's own selects can produce. Anything else in a saved bar is
    // stale: restoring it would select a value the user cannot see in the list.
    const FILTER_TYPES = ['bug', 'story']
    const FILTER_STATES = [...STATE_FILTER_ORDER, 'unknown']
    // The open list's bar offers every state but `done`: closed work has its own
    // view, and a saved bar that asks for `done` is reduced to no status filter.
    const OPEN_FILTER_STATES = FILTER_STATES.filter((state) => state !== 'done')

    function rank(state) {
      const index = STATE_ORDER.indexOf(state)
      return index === -1 ? STATE_ORDER.length : index
    }

    /** The section a mission falls into: its state when the list knows it, `unknown` otherwise. */
    function stateOf(mission) {
      const state = mission?.state
      return STATE_ORDER.includes(state) ? state : 'unknown'
    }

    function stateInRange(state, from, to) {
      const start = STATE_FILTER_ORDER.indexOf(from)
      const end = STATE_FILTER_ORDER.indexOf(to)
      const index = STATE_FILTER_ORDER.indexOf(state)
      if (start === -1 || end === -1 || index === -1) {
        return false
      }
      return index >= start && index <= end
    }

    /** The values a filter selects: none, one, or a list of them. */
    function selectedValues(value) {
      if (value === null || value === undefined || value === '') return []
      return Array.isArray(value) ? value : [value]
    }

    /**
     * Keep the missions matching the free text and every active dimension.
     *
     * Each filter is `null` (or absent) when the dimension is off; an active filter
     * takes one value or a list of them, and a list matches any of its values (OR
     * within the dimension). Dimensions combine with AND, and with the search: the
     * dashboard's widgets open a dimension on several values at once. The search
     * covers the project name as well as its id: both are shown to the user, and
     * `'unknown'` stands for every state outside the workflow.
     *
     * Closed work is a view of its own (`allowDone`): the open list drops `done`
     * whatever the state filter says, and only the Done view passes `allowDone` to
     * keep the closed rows it was handed.
     */
    function filterMissions(
      missions = [],
      { query = '', type = null, state = null, epic = null, priority = null, project = null, missing = null, allowDone = false } = {},
    ) {
      const needle = String(query ?? '').trim().toLowerCase()
      const types = selectedValues(type)
      const states = selectedValues(state)
      const epics = selectedValues(epic)
      const priorities = selectedValues(priority)
      const projects = selectedValues(project)
      return missions.filter((mission) => {
        if (types.length > 0 && !types.includes(mission.type)) return false
        // Closed work is history: it stays out of the open list, and a state filter
        // is not a door around that rule any more — the Done view is.
        if (!allowDone && mission.state === 'done') return false
        if (states.length > 0) {
          const known = STATE_ORDER.includes(mission.state)
          if (!states.includes(mission.state) && !(states.includes('unknown') && !known)) return false
        }
        if (epics.length > 0 && !epics.includes(mission.epic)) return false
        if (priorities.length > 0 && !priorities.includes(mission.priority)) return false
        if (projects.length > 0 && !projects.includes(mission.project)) return false
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
    function epicOptions(missions = []) {
      return distinct(missions.map((mission) => mission.epic)).sort((a, b) => String(a).localeCompare(String(b)))
    }

    /** Priorities present in the list, in workflow order (unknown values last). */
    function priorityOptions(missions = []) {
      const present = new Set(distinct(missions.map((mission) => mission.priority)))
      const known = PRIORITY_ORDER.filter((priority) => present.has(priority))
      const unknown = [...present]
        .filter((priority) => !PRIORITY_ORDER.includes(priority))
        .sort((a, b) => String(a).localeCompare(String(b)))
      return [...known, ...unknown]
    }

    /**
     * The filter state a mission's raw state falls in: the workflow's own, else
     * `unknown`. Every count keyed by a filter state uses this, so a mission the
     * band shows is a mission the band counts.
     */
    function stateFilterValue(state) {
      return STATE_ORDER.includes(state) ? state : 'unknown'
    }

    /**
     * States present in the list, in workflow order; unknown states last.
     *
     * `done` is only offered when the caller asks for it (`allowDone`): the open
     * list keeps it out of its Status filter, and the Done view fixes the value
     * itself instead of deriving it from the rows.
     */
    function stateOptions(missions = [], { allowDone = false } = {}) {
      const present = new Set(missions.map((mission) => stateFilterValue(mission.state)))
      return [
        ...STATE_FILTER_ORDER.filter((state) => present.has(state) && (allowDone || state !== 'done')),
        ...(present.has('unknown') ? ['unknown'] : []),
      ]
    }

    /** Projects present in the list, once per id, sorted by display name. */
    function projectOptions(missions = []) {
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
    function hasActiveFilters(filters = {}) {
      return Object.values(filters).some((value) => {
        if (Array.isArray(value)) return value.length > 0
        return value !== null && value !== undefined && value !== ''
      })
    }

    /** Every non-blank string of a value, list or single, trimmed, once, in input order. */
    function keptTexts(value) {
      const list = (Array.isArray(value) ? value : [value])
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      const kept = [...new Set(list)]
      return kept.length > 0 ? kept : null
    }

    /** A non-blank string, trimmed, or null. */
    function keptText(value) {
      if (typeof value !== 'string') return null
      const text = value.trim()
      return text === '' ? null : text
    }

    /**
     * Several values kept only when the panel can select them, in the panel's order.
     *
     * Type, state, epic, priority and project take a list: a widget opens the list
     * on all the values it showed. A single value read from an older session is
     * accepted, so a bar saved before the list existed comes back intact.
     */
    function keptChoices(value, allowed) {
      const list = Array.isArray(value) ? value : [value]
      const kept = allowed.filter((choice) => list.includes(choice))
      return kept.length > 0 ? kept : null
    }

    /**
     * One flat snapshot of the bar: what the session keeps between two mounts.
     *
     * Values the panel cannot select are dropped rather than trusted: a type or a
     * state the session no longer offers must not come back. Type, state, epic,
     * priority and project keep their lists — a single value read from an older
     * session becomes a one-item list, so a bar saved before the list existed
     * comes back intact. Epic and project stay free text: a stale one filters to
     * nothing, like a manual selection would. The open bar refuses `done` unless
     * `allowDone` says this is the Done bar.
     */
    function filterSnapshot({ query = '', filters = {} } = {}, { allowDone = false } = {}) {
      const source = filters ?? {}
      return {
        query: typeof query === 'string' ? query : '',
        type: keptChoices(source.type, FILTER_TYPES),
        state: keptChoices(source.state, allowDone ? FILTER_STATES : OPEN_FILTER_STATES),
        epic: keptTexts(source.epic),
        priority: keptTexts(source.priority),
        project: keptTexts(source.project),
        missing: source.missing === 'any' ? 'any' : null,
      }
    }

    /**
     * Split a flat snapshot back into the two states the panel keeps.
     *
     * The values pass through `filterSnapshot` again, so a snapshot read from an
     * older session is validated the same way as the one the panel just wrote.
     */
    function filterBarState(snapshot = {}, { allowDone = false } = {}) {
      const flat = filterSnapshot({ query: snapshot?.query, filters: snapshot }, { allowDone })
      const { query, type, state, epic, priority, project, missing } = flat
      return { query, filters: { type, state, epic, priority, project, missing } }
    }

    /** Read a stored snapshot back; anything unusable is the empty bar. */
    function parseFilterSnapshot(raw, { allowDone = false } = {}) {
      const empty = filterSnapshot({}, { allowDone })
      if (typeof raw !== 'string' || raw.trim() === '') return empty
      let stored
      try {
        stored = JSON.parse(raw)
      } catch {
        return empty
      }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return empty
      return filterSnapshot({ query: stored.query, filters: stored }, { allowDone })
    }

    /**
     * The bar the session saved, or the empty bar.
     *
     * Storage is optional: a missing key, a storage that throws, or a payload the
     * panel cannot use all restore the default instead of failing the render.
     */
    function readFilterSnapshot(storage, key = FILTERS_KEY, { allowDone = false } = {}) {
      try {
        return parseFilterSnapshot(storage?.getItem?.(key) ?? null, { allowDone })
      } catch {
        return filterSnapshot({}, { allowDone })
      }
    }

    /** True when the bar holds nothing: no search text, no filter. */
    function isEmptySnapshot(snapshot = {}) {
      const { query = '', type = null, state = null, epic = null, priority = null, project = null, missing = null } = snapshot
      return String(query).trim() === '' && !hasActiveFilters({ type, state, epic, priority, project, missing })
    }

    /**
     * Save the bar for the session, or drop its key once nothing is left.
     *
     * Writing only when something is set keeps a cleared bar from coming back on
     * the next mount.
     */
    function writeFilterSnapshot(storage, bar = {}, key = FILTERS_KEY, { allowDone = false } = {}) {
      if (!storage) return
      const snapshot = filterSnapshot(bar, { allowDone })
      try {
        if (isEmptySnapshot(snapshot)) storage.removeItem?.(key)
        else storage.setItem?.(key, JSON.stringify(snapshot))
      } catch { /* storage is optional */ }
    }

    /** Session key of the open tab, next to `missions.filters`. */
    const TAB_KEY = 'missions.tab'

    /**
     * The tab the session left open, or the panel's resting tab.
     *
     * `tabs` is what the caller actually renders, so a stored tab that no longer
     * exists falls back instead of selecting a view nobody can reach. The resting
     * tab is the first one: the dashboard, which answers "what waits on me".
     */
    function readTab(storage, tabs = []) {
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
    function writeTab(storage, tab, tabs = []) {
      if (!storage) return
      try {
        if (tab !== tabs[0] && tabs.includes(tab)) storage.setItem?.(TAB_KEY, tab)
        else storage.removeItem?.(TAB_KEY)
      } catch { /* storage is optional */ }
    }

    /**
     * The view the session left open: the tab, and the Settings section standing
     * in for Settings under the same `missions.tab` key.
     *
     * `usage` and `workflows` were tabs of their own before Settings gathered
     * them: a session stored on one of those names reopens that section instead of
     * falling back to the dashboard. Any other unknown value falls back like
     * `readTab` does. No second key: the section is the stored value while
     * Settings is open.
     */
    function readStoredView(storage, tabs = [], sections = []) {
      const resting = tabs[0] ?? null
      const restingSection = sections[0] ?? null
      try {
        const stored = storage?.getItem?.(TAB_KEY)
        if (sections.includes(stored)) return { tab: 'settings', settingsView: stored }
        return { tab: tabs.includes(stored) ? stored : resting, settingsView: restingSection }
      } catch {
        return { tab: resting, settingsView: restingSection }
      }
    }

    /** What `missions.tab` holds for a view: the section while Settings is open. */
    function storedView(tab, settingsView, sections = []) {
      if (tab === 'settings') return sections.includes(settingsView) ? settingsView : sections[0] ?? null
      return tab
    }

    /**
     * Save the open view, one key: the Settings section stands in for the tab.
     * The resting tab still drops the key, as `writeTab` does.
     */
    function writeStoredView(storage, view = {}, tabs = [], sections = []) {
      if (!storage) return
      writeTab(storage, storedView(view.tab, view.settingsView, sections), [...tabs, ...sections])
    }

    /** Session key of the step the Workflows tab has open, next to `missions.tab`. */
    const STEP_KEY = 'missions.workflow-step'

    /**
     * The step the session left open, or the first step of the method.
     *
     * Same contract as the tab: a stored step that the caller no longer renders
     * falls back to the first one instead of opening a view nobody can reach.
     */
    function readStep(storage, steps = []) {
      const resting = steps[0] ?? null
      try {
        const stored = storage?.getItem?.(STEP_KEY)
        return steps.includes(stored) ? stored : resting
      } catch {
        return resting
      }
    }

    /** Save the open step for the session, or drop its key on the first step. */
    function writeStep(storage, step, steps = []) {
      if (!storage) return
      try {
        if (step !== steps[0] && steps.includes(step)) storage.setItem?.(STEP_KEY, step)
        else storage.removeItem?.(STEP_KEY)
      } catch { /* storage is optional */ }
    }

    /** Session key of the playbook page the Settings section has open. */
    const PLAYBOOK_PAGE_KEY = 'missions.playbook-page'

    /**
     * The playbook page the session left open, or the first page of the list.
     *
     * Every step of the parcours has a page, the workspace one has too: the stored
     * value is a page id, and a page the list no longer carries falls back to the
     * first one. The panel opens on something editable, never on an empty editor.
     */
    function readPlaybookPage(storage, pages = []) {
      const resting = pages[0] ?? null
      try {
        const stored = storage?.getItem?.(PLAYBOOK_PAGE_KEY)
        return pages.includes(stored) ? stored : resting
      } catch {
        return resting
      }
    }

    /** Save the open playbook page for the session, or drop its key on the first page. */
    function writePlaybookPage(storage, page, pages = []) {
      if (!storage) return
      try {
        if (page !== pages[0] && pages.includes(page)) storage.setItem?.(PLAYBOOK_PAGE_KEY, page)
        else storage.removeItem?.(PLAYBOOK_PAGE_KEY)
      } catch { /* storage is optional */ }
    }

    // A mission with no known priority comes after the ones that have one; a
    // mission with no usable points comes after every mission that carries some.
    function priorityRank(mission) {
      const index = PRIORITY_ORDER.indexOf(mission.priority)
      return index === -1 ? PRIORITY_ORDER.length : index
    }

    function pointsRank(mission) {
      if (mission.points === null || mission.points === undefined || mission.points === '') return Infinity
      const value = Number(mission.points)
      return Number.isFinite(value) ? value : Infinity
    }

    // A blocked reason is free text: the mission keys it cites are the only edges
    // the list knows, and only the keys of the visible blocked missions count.
    const BLOCKER_KEY_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/gi
    const FOUND_REASON = 'found'

    function compareMissions(a, b) {
      return priorityRank(a) - priorityRank(b) || pointsRank(a) - pointsRank(b) || String(a.key).localeCompare(String(b.key))
    }

    function normalizedKey(key) {
      return String(key ?? '').toUpperCase()
    }

    /**
     * Whether a mission waits on its block. Closed work is history, not a queue:
     * a mission marked `blocked` but `done` no longer waits and no longer blocks.
     */
    function isWaitingOnBlock(mission) {
      return mission?.blocked === true && mission?.state !== 'done'
    }

    /**
     * The keys a blocked mission waits on, from the reason the block recorded.
     *
     * The reason is written verbatim by the form, so its prose is never parsed:
     * only mission keys are read, uppercased, kept when they name another visible
     * blocked mission, and never the mission's own key. A reason that was not read
     * (`empty`, `unavailable`, absent) or cites nothing known creates no edge.
     * `knownKeys` is the keys of the visible blocked missions.
     */
    function blockerKeys(mission, knownKeys = []) {
      if (mission?.blockedReason?.state !== FOUND_REASON) {
        return []
      }
      const known = new Set([...knownKeys].map(normalizedKey))
      const own = normalizedKey(mission.key)
      const cited = String(mission.blockedReason.body ?? '').match(BLOCKER_KEY_PATTERN) ?? []
      return [...new Set(cited.map(normalizedKey))].filter((key) => key !== own && known.has(key))
    }

    /**
     * Order the blocked stage so that a mission waits for the one it names.
     *
     * A stable Kahn walk: each turn takes the first mission whose blockers are all
     * placed. A cycle has no ready mission, so the walk takes the first remaining
     * mission and keeps the base order through the cycle. Every mission is placed
     * once, in the base order when no edge constrains it.
     */
    function orderBlocked(waiting) {
      const knownKeys = waiting.map((mission) => mission.key)
      const blockers = new Map(waiting.map((mission) => [mission, blockerKeys(mission, knownKeys)]))
      const placed = new Set()
      const remaining = [...waiting]
      const ordered = []
      while (remaining.length > 0) {
        const ready = remaining.findIndex((mission) => blockers.get(mission).every((key) => placed.has(key)))
        const index = ready === -1 ? 0 : ready
        const [mission] = remaining.splice(index, 1)
        placed.add(normalizedKey(mission.key))
        ordered.push(mission)
      }
      return ordered
    }

    /**
     * Sort a copy: workable missions first, then blocked ones.
     *
     * The order inside each stage is the list's contract: priority (high -> low),
     * then story points (low -> high), then key. A blocked mission whose reason
     * names another visible blocked mission waits for it, transitively; a cycle
     * keeps the base order. Missions without a known priority or usable points
     * close their stage instead of opening it.
     *
     * The order is not a session setting: every reader sees the same work first,
     * whether the panel was asked to or not.
     */
    function sortMissions(missions = []) {
      const base = [...missions].sort(compareMissions)
      const waiting = base.filter(isWaitingOnBlock)
      const workable = base.filter((mission) => !isWaitingOnBlock(mission))
      return [...workable, ...orderBlocked(waiting)]
    }

    /**
     * Move the pinned items first, keeping every relative order.
     *
     * The partition is stable on both sides: two pins keep the order the sort gave
     * them, and the rest closes up behind them. The input is never mutated — the
     * function is used inside a render, and `sortMissions` already returns copies.
     */
    function pinnedFirst(items = [], isPinned = (item) => item?.pinned === true) {
      const pinned = []
      const rest = []
      for (const item of Array.isArray(items) ? items : []) {
        if (isPinned(item)) pinned.push(item)
        else rest.push(item)
      }
      return [...pinned, ...rest]
    }

    /**
     * Move each mission after the dependencies that hold it.
     *
     * The walk is the blocked stage's own, over structured `blockers` instead of a
     * reason: a stable Kahn pass takes the first mission whose visible blockers are
     * all placed. A blocker outside the list constrains nothing (it is filtered
     * out, or lives in another project), a mission never waits on itself, and a
     * cycle keeps the base order of its members. The input is never mutated.
     */
    function respectBlockers(items = [], {
      keyOf = (item) => item?.key,
      blockersOf = (item) => item?.blockers,
    } = {}) {
      const list = Array.isArray(items) ? items : []
      const byKey = new Map(list.map((item) => [normalizedKey(keyOf(item)), item]))
      const edges = new Map(list.map((item) => {
        const own = normalizedKey(keyOf(item))
        const keys = (blockersOf(item) ?? [])
          .map((blocker) => normalizedKey(blocker.key))
          .filter((key) => key !== own && byKey.has(key))
        return [own, keys]
      }))
      const placed = new Set()
      const remaining = [...list]
      const ordered = []
      while (remaining.length > 0) {
        const ready = remaining.findIndex((item) => edges.get(normalizedKey(keyOf(item))).every((key) => placed.has(key)))
        const index = ready === -1 ? 0 : ready
        const [item] = remaining.splice(index, 1)
        placed.add(normalizedKey(keyOf(item)))
        ordered.push(item)
      }
      return ordered
    }

    /**
     * Group missions by state, in display order (STATE_ORDER); unknown states come last.
     *
     * A section whose mission waits on a visible mission of an earlier or later
     * section moves behind that section, as far as the order allows: the same
     * stable Kahn pass, over the edges between states, keeps every other section
     * where it was. A section is only moved whole; a within-section wait is the
     * row order's business (`respectBlockers`).
     */
    function groupByState(missions = []) {
      const groups = new Map()
      for (const mission of missions) {
        const state = stateOf(mission)
        if (!groups.has(state)) groups.set(state, [])
        groups.get(state).push(mission)
      }
      const entries = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b))
      const visibleState = new Map(missions.map((mission) => [normalizedKey(mission.key), stateOf(mission)]))
      const after = new Map(entries.map(([state]) => [state, new Set()]))
      for (const mission of missions) {
        const state = stateOf(mission)
        for (const blocker of mission.blockers ?? []) {
          // A blocker outside the list constrains nothing: neither its own order
          // nor its section is there to move. The section read is the visible
          // mission's, so the edge always names two sections that are rendered.
          const blockerState = visibleState.get(normalizedKey(blocker.key))
          if (blockerState !== undefined && blockerState !== state) {
            after.get(state).add(blockerState)
          }
        }
      }
      const placed = new Set()
      const remaining = [...entries]
      const ordered = []
      while (remaining.length > 0) {
        const ready = remaining.findIndex(([state]) => [...after.get(state)].every((blockerState) => placed.has(blockerState)))
        const index = ready === -1 ? 0 : ready
        const [entry] = remaining.splice(index, 1)
        placed.add(entry[0])
        ordered.push(entry)
      }
      return ordered.map(([state, list]) => ({ state, missions: list }))
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
    const QUIET_AFTER_DAYS = 7

    /** Days since the last update, or null when the date cannot be read. */
    function ageDays(updatedAt, now = Date.now()) {
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
    function missionAge(updatedAt, now = Date.now()) {
      const days = ageDays(updatedAt, now)
      if (days === null) return { label: '', days: null, quiet: false }
      if (days < 1 / 24) return { label: `${Math.max(1, Math.round(days * 1440))} min`, days, quiet: false }
      if (days < 1) return { label: `${Math.round(days * 24)} h`, days, quiet: false }
      return { label: `${Math.round(days)} d`, days, quiet: days >= QUIET_AFTER_DAYS }
    }

    /** The verb a row offers for its state ("Review", "Ship", …). */
    function actionVerb(state) {
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
     * mission whose state is unknown must stay in the queue unless it is blocked
     * (see below).
     */
    const OFF_THE_QUEUE = ['in-progress', 'ready-for-prod', 'done']

    /**
     * The states a digest widget never shows: one waits for a release, the other is
     * closed. Both have already left the review the widget is about, so counting
     * them would promise work the bound forbids. A blocklist, like the queue's, so
     * a mission whose state is unknown stays in unless it is blocked: nobody has
     * decided about it yet.
     */
    const PAST_REVIEW = ['ready-for-prod', 'done']

    /**
     * The dashboard's queue: what waits on the user, most urgent state first, then
     * the mission that has waited longest. A mission that is not waiting on a
     * decision — started, ready to ship — never appears here, and neither does a
     * blocked one: it waits on another mission, not on the user.
     *
     * A mission whose state is unknown — an unmapped tracker status, or conflicting
     * state labels — stays in the queue, ranked last: it is the one that needs an
     * arbitration. Dropping it would leave the section's count disagreeing with the
     * rows it shows, and hide exactly the mission nobody has decided about. Blocked
     * or not, it follows the block rule first: a blocked one waits on another
     * mission, not on the user, whatever its state says.
     */
    function needsYou(missions = []) {
      return missions
        .filter((mission) => !OFF_THE_QUEUE.includes(mission?.state) && !isWaitingOnBlock(mission))
        .sort((a, b) => queueRank(a.state) - queueRank(b.state) || oldestFirst(a, b))
    }

    /**
     * The missions already running, the one that has waited longest first. A
     * blocked mission is not running under its own steam: it stays out.
     */
    function inFlight(missions = []) {
      return missions
        .filter((mission) => mission?.state === 'in-progress' && !isWaitingOnBlock(mission))
        .sort(oldestFirst)
    }

    /**
     * Bugs assigned to you: not past review yet, the one that has waited longest
     * first. A blocked bug waits on another mission: it stays out, however old.
     */
    function assignedBugs(missions = []) {
      return missions
        .filter((mission) => mission?.type === 'bug' && !PAST_REVIEW.includes(mission?.state) && !isWaitingOnBlock(mission))
        .sort(oldestFirst)
    }

    /**
     * Stories of high priority — urgent or high — not past review yet, oldest
     * first. A blocked story waits on another mission: it stays out, however old.
     */
    function highPriorityStories(missions = []) {
      return missions
        .filter((mission) => mission?.type === 'story' && !PAST_REVIEW.includes(mission?.state) && HIGH_PRIORITIES.includes(mission?.priority) && !isWaitingOnBlock(mission))
        .sort(oldestFirst)
    }

    /**
     * The sizes an estimation may take, and the only ones the host writes.
     *
     * A story point is a relative size, so the scale is the workspace's, not the
     * tracker's: GitHub stores it as the `sp:N` label, Jira in the project's
     * `story_points_field`. The list is also the refusal — a value outside it never
     * reaches a tracker, and `0` is absent because the way to remove an estimation
     * is the tracker's, not this route's. It lives next to the words the panel
     * gives a size because `tools/build.mjs` inlines this module and not
     * `lib/mission.js`, which re-exports it.
     */
    const POINTS_SCALE = [0.5, 1, 2, 3, 5, 8, 13]

    /** Story points carried by a set of missions; missions without points are skipped. */
    function pointsTotal(missions = []) {
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

    /**
     * The points a mission carries, in words: `5 pts`, `1 pt`, `0.5 pt`, nothing
     * at all when the tracker gave no number. A mission without a number says
     * nothing: a row that said `0 pt` would invent a count it does not carry, and
     * a plural starts above one.
     */
    function pointsText(points) {
      const value = Number(points)
      const counted = points !== null && points !== undefined && points !== '' && Number.isFinite(value)
      return counted ? `${value} pt${value > 1 ? 's' : ''}` : ''
    }

    /** The line under a section's title, and the card counts, in one pass. */
    function dashboardScope(missions = []) {
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

    /** A checkout older than this many days is cold: nobody has touched it. */
    const COLD_CHECKOUT_DAYS = 30

    /**
     * The branches of open missions that still have work to send.
     *
     * The scan is the truth about a checkout: a mission branch the root does not
     * carry is not a row, because the panel shows what it can open. A branch held
     * by two checkouts — a clone and a worktree — is one row, and the worktree
     * wins: that is where the work happens. A branch with an upstream and nothing
     * to send is not a row either.
     */
    function branchesToPush(missions = [], repositories = []) {
      const checkouts = new Map()
      for (const repository of repositories) {
        if (!repository?.branch) continue
        const held = checkouts.get(repository.branch)
        if (!held || (held.kind !== 'worktree' && repository.kind === 'worktree')) {
          checkouts.set(repository.branch, repository)
        }
      }

      const rows = []
      const seen = new Set()
      for (const mission of missions) {
        if (mission?.state === 'done' || !mission?.branch || seen.has(mission.branch)) continue
        const repository = checkouts.get(mission.branch)
        if (!repository) continue
        seen.add(mission.branch)
        const ahead = Number(repository.ahead ?? 0)
        const neverPushed = !repository.upstream
        if (!neverPushed && !(ahead > 0)) continue
        rows.push({
          key: mission.key,
          mission,
          repository,
          branch: mission.branch,
          ahead,
          neverPushed,
          reason: neverPushed ? 'never-pushed' : 'ahead',
          label: neverPushed ? 'never pushed' : `+${ahead} commit${ahead === 1 ? '' : 's'}`,
        })
      }
      return rows.sort((a, b) => (
        String(a.repository.name).localeCompare(String(b.repository.name)) || String(a.branch).localeCompare(String(b.branch))
      ))
    }

    /** The gravity of a checkout's problem: an unreadable entry wins over lateness. */
    const CHECKOUT_GRAVITY = { error: 0, behind: 1, dirty: 2 }

    /** What a row says about its checkout: one reason, the gravest. */
    const CHECKOUT_LABELS = {
      error: () => 'unreadable',
      behind: (repository) => `${repository.behind} behind`,
      dirty: (repository) => `${repository.dirty} dirty`,
    }

    /**
     * The checkouts that need a gesture: unreadable, behind its upstream, or dirty.
     *
     * One reason per row — the gravest — so a checkout appears once, with the
     * gesture it asks for. A clean checkout has no row: the dashboard is a digest,
     * not the list.
     */
    function checkoutsToFix(repositories = []) {
      const rows = []
      for (const repository of repositories) {
        if (!repository) continue
        let reason = null
        if (repository.error) reason = 'error'
        else if (Number(repository.behind) > 0) reason = 'behind'
        else if (Number(repository.dirty) > 0) reason = 'dirty'
        if (!reason) continue
        rows.push({ repository, reason, label: CHECKOUT_LABELS[reason](repository) })
      }
      return rows.sort((a, b) => (
        CHECKOUT_GRAVITY[a.reason] - CHECKOUT_GRAVITY[b.reason]
        || String(a.repository.name).localeCompare(String(b.repository.name))
      ))
    }

    /** The scope line of the Repositories section, and what its cards hold. */
    function repositoryScope(summary = {}) {
      const repositories = Array.isArray(summary?.repositories) ? summary.repositories : []
      const count = Number.isInteger(summary?.count) ? summary.count : repositories.length
      const toFix = checkoutsToFix(repositories).length
      return {
        count,
        toFix,
        label: `${count} ${count === 1 ? 'repository' : 'repositories'} · ${toFix} to fix`,
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
    function executionBlocker(mission = {}) {
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
    function freeSessionBlocker(mission = {}) {
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
    const STEP_BY_STATE = {
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
    const STEP_BRIEFS = {
      cadrage:
        'Tu ne fais que le cadrage : la fiche au gabarit dans le ticket, la branche et la base déclarées, le journal et la checklist ouverts ; à la fin, le ticket passe en ready et tu t’arrêtes.',
      'exécution':
        'Tu ne fais que l’exécution : la branche depuis la base, les commits, la PR vers la base avec `Closes #N`, la revue interne à l\'aveugle du diff, le journal et la checklist à jour ; si elle valide, le ticket passe en in-review et tu t’arrêtes, sinon tu corriges les constats et tu fais relire jusqu’à validation.',
      revue:
        'Tu ne fais que la revue : la revue du diff est celle de tes collègues et a eu lieu en exécution ; tu constates leur validation sur la PR (`gh pr view --json reviewDecision,reviews`), tu vérifies que chaque critère d’acceptation porte sa preuve, que le périmètre et les tests tiennent, que le journal et la checklist sont à jour, tu écris la décision datée dans le ticket, tu poses le label ready-for-prod et tu t’arrêtes ; sans validation des collègues, tu nommes ce qui manque et tu ne déplaces pas les labels.',
      'clôture':
        'Tu ne fais que la clôture : prépare la livraison (PR approuvée, chaque critère prouvé) et rends la main ; le demandeur merge, ferme le ticket et supprime la branche, et tu ne constates qu’à son mot explicite.',
    }

    /** The step a mission plays, or null when its state names none. */
    function missionStep(mission = {}) {
      return STEP_BY_STATE[mission.state] ?? null
    }

    /** The folder holding the playbook, versioned with the method. */
    const PLAYBOOK_DIR = 'playbook'

    /**
     * The playbook page of each step, relative to `playbook/`.
     *
     * The table is explicit on purpose: `exécution` → `execution.md` and
     * `revue` → `revue.md` cannot be derived from the step name. This is the
     * contract `playbook/README.md` documents, and the page the session prompt
     * names — never its content.
     */
    const PLAYBOOK_STEP_FILES = {
      cadrage: 'cadrage.md',
      'exécution': 'execution.md',
      revue: 'revue.md',
      'clôture': 'cloture.md',
    }

    /** The page a free session and a feedback session read: workspace gestures. */
    const PLAYBOOK_WORKSPACE = 'workspace.md'

    /** The playbook page of a step, as a path from the repository root, or null. */
    function playbookFile(step) {
      const file = PLAYBOOK_STEP_FILES[step] ?? null
      return file === null ? null : `${PLAYBOOK_DIR}/${file}`
    }

    /** The line a session reads the page it must follow from. */
    function playbookReadLine(page) {
      return page ? `Playbook à lire : ${page}.` : null
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
    function ticketReadLine(url) {
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
     * branch/base line — the execution step adds the mission's worktree there, the
     * feedback session the project's clone and that worktree.
     * `page` is the playbook page the session must follow: the step's page by
     * default, the workspace page for a feedback session.
     */
    function sessionEnvelope(mission = {}, brief, extra = '', page = playbookFile(missionStep(mission))) {
      const blocker = executionBlocker(mission)
      const step = missionStep(mission)
      const journalPath = mission.folder ? `missions/${mission.folder}/journal.md` : null
      const checklistPath = mission.folder ? `missions/${mission.folder}/checklist.md` : null
      const playbookLine = playbookReadLine(page)
      const stepLine = step
        ? `Étape en cours : ${step} (statut ${mission.state}).`
        : `Étape en cours : à déterminer (statut ${mission.state ?? 'inconnu'}).`
      return `Travaille sur la mission ${mission.key} — ${mission.title}.\n\n${ticketReadLine(mission.url)}\n${stepLine} ${brief}\n\nChaque étape se joue dans une nouvelle session : à la fin de celle-ci, arrête-toi ; l'étape suivante sera une nouvelle session.${blocker === null ? `\n\nBranche : ${mission.branch} ; base : ${mission.base}.${extra}` : ''}${playbookLine ? `\n\n${playbookLine}` : ''}${journalPath ? `\n\nJournal de mission : ${journalPath} — tiens-le à jour à chaque étape.` : ''}${checklistPath ? `\n\nChecklist de mission : ${checklistPath} — coche chaque point avec sa preuve.` : ''}\n\nGarde-fou : tu ne merges jamais la PR et tu n'écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s'il te le demande.`
    }

    /**
     * The prompt of the step session, taken verbatim from the drawer's old inline
     * string: the button, its label and its tests predate the extraction, and the
     * string is what they pin.
     */
    function missionSessionPrompt(mission = {}) {
      const step = missionStep(mission)
      const stepBrief =
        STEP_BRIEFS[step] ?? 'Lis le ticket et le workflow avant d’agir : ce statut ne dit pas quelle étape jouer.'
      const worktree = step === 'exécution' ? missionWorktreeLine(mission) : null
      return sessionEnvelope(mission, stepBrief, worktree ? `\n${worktree}` : '')
    }

    /**
     * What a feedback session does: read the PR's remarks, triage them, fix or
     * answer, then hand back. It answers inside the threads and resolves none of
     * them, even the fixed ones: closing a thread is the reviewer's gesture alone.
     *
     * The panel never calls GitHub; the session alone reads the PR, in the
     * mission's worktree, so the commands are named. `<branche>` is replaced with
     * the mission's declared branch in `feedbackSessionPrompt`; the other
     * placeholders stay — the session resolves them from the PR it found.
     */
    const FEEDBACK_BRIEF =
      'Tu ne fais que les remontées de la PR : retrouve la PR de la branche avec `gh pr list --head <branche> --state all` (si elle ne rend rien, dis-le et arrête-toi), lis ses revues, ses commentaires et ses fils de discussion en ligne (dont `gh api repos/<owner>/<repo>/pulls/<n>/comments`), trie chaque remontée (corriger / répondre / hors périmètre, sans élargir le périmètre), corrige sur la branche et pousse (`<CLÉ>: <impératif>`), mets le journal et la checklist à jour avec les preuves ; tu réponds dans les fils sans en résoudre aucun, même corrigé — c’est au relecteur, et à lui seul, de fermer son fil ; tu ne merges pas la PR, tu n’écris pas sur main, tu ne touches pas aux labels, tu ne fermes pas le ticket et tu t’arrêtes.'

    /**
     * The prompt of the feedback session: the same envelope, the feedback brief,
     * and the project's clone and the mission's worktree after the branch/base
     * line — a session must not have to guess which checkout carries the PR.
     */
    function feedbackSessionPrompt(mission = {}) {
      const brief = FEEDBACK_BRIEF.replace('<branche>', String(mission.branch ?? ''))
      const repoLine = mission.repo ? `\nDépôt du projet : ${mission.repo}.` : ''
      const worktree = missionWorktreeLine(mission)
      return sessionEnvelope(mission, brief, `${repoLine}${worktree ? `\n${worktree}` : ''}`, `${PLAYBOOK_DIR}/${PLAYBOOK_WORKSPACE}`)
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
    const FREE_BRIEF =
      'Session libre : aucune étape du workflow n’est jouée et le ticket n’avance pas. Réponds à la question écrite à la suite de ce message ; si le message n’en porte pas, demande-la et arrête-toi.\n\n' +
      'Tu peux écrire dans la mission : le journal, la checklist, le ticket (corps et commentaires) et le dépôt du projet (fichiers, commits, push sur la branche, ouverture de la PR). Ce qui t’est interdit, c’est de toucher au workflow : pas de changement de statut ni de label, pas de fermeture du ticket, et tu ne joues aucune étape. Tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur.\n\n' +
      'Tu réponds, puis tu t’arrêtes.'

    /**
     * The prompt of the free session: the mission's identity, its ticket read with
     * the CLI, its state as information, the project's clone, the branch and base
     * when both are declared, the mission's worktree when it can be derived, the
     * playbook page of workspace gestures, the journal and checklist to keep up to
     * date, then the free brief.
     *
     * It composes beside `sessionEnvelope` on purpose: the step prompt is pinned
     * character for character, and this one must carry no step at all. The branch
     * and base are optional here — `freeSessionBlocker` only closes `done`, so a
     * mission in cadrage keeps its free session before the branch exists.
     */
    function freeSessionPrompt(mission = {}) {
      const journalPath = mission.folder ? `missions/${mission.folder}/journal.md` : null
      const checklistPath = mission.folder ? `missions/${mission.folder}/checklist.md` : null
      const page = `${PLAYBOOK_DIR}/${PLAYBOOK_WORKSPACE}`
      const places = [
        mission.repo ? `Dépôt du projet : ${mission.repo}.` : null,
        mission.branch && mission.base ? `Branche : ${mission.branch} ; base : ${mission.base}.` : null,
        missionWorktreeLine(mission),
      ].filter(Boolean)
      const placesBlock = places.length > 0 ? `\n\n${places.join('\n')}` : ''
      const playbookBlock = `\n\n${playbookReadLine(page)}`
      const journalBlock = journalPath
        ? `\n\nJournal de mission : ${journalPath} — tiens-le à jour.`
        : ''
      const checklistBlock = checklistPath
        ? `\n\nChecklist de mission : ${checklistPath} — coche chaque point avec sa preuve.`
        : ''
      return `Travaille sur la mission ${mission.key} — ${mission.title}.\n\n${ticketReadLine(mission.url)}\nStatut du ticket : ${mission.state ?? 'inconnu'} (information seule).${placesBlock}${playbookBlock}${journalBlock}${checklistBlock}\n\n${FREE_BRIEF}`
    }

    /**
     * A conflict session's prompt: the checkout it runs in, the branch it works
     * on, the reads that show the conflicts, and the guardrail.
     *
     * A repository drawer carries no mission, so the prompt names the repository
     * and the gesture only and never claims a step. `git status` opens every other
     * read: the panel runs no git gesture itself, the session alone reads and
     * resolves. The gesture exists even without a known conflict, so the prompt
     * says what to do when there is nothing to resolve.
     */
    function repositoryConflictPrompt(repository = {}) {
      const name = repository.name ?? '(dépôt inconnu)'
      const path = repository.path ?? '(chemin inconnu)'
      const branch = repository.branch || '(HEAD détaché)'
      return `Travaille sur les conflits du dépôt ${name} — résous ceux de sa branche courante.\n\nChemin : ${path}.\nBranche courante : ${branch}.\n\nInspecte d’abord l’état du dépôt avec \`git status\` et \`git diff --name-only --diff-filter=U\` : les fichiers qu’ils listent sont les conflits en cours (merge, rebase ou cherry-pick). S’il n’y a rien à résoudre, dis-le et arrête-toi, sans geste git.\n\nSinon, résous chaque conflit en gardant l’intention des deux côtés, sans écraser le travail en cours et sans \`--ours\` ni \`--theirs\`, marque les fichiers résolus (\`git add\`) et termine l’opération commencée. Tu ne lances ni \`git merge --abort\`, ni \`git rebase --abort\`, ni \`git stash\` sans le demander.\n\nGarde-fou : tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s’il te le demande.\n\nQuand la branche est propre, résume ce que tu as résolu et arrête-toi.`
    }

    /**
     * A squash session's prompt: the checkout it runs in, the mission its branch
     * declares, the reads, and the one commit the branch keeps.
     *
     * A repository drawer carries no mission, so the prompt finds it by the branch
     * it names — `missions/<clé>/mission.yml` declares it — and stops when no
     * mission claims the branch rather than guessing one. The panel runs no git: it asks
     * the session, which reads and rewrites the history in place.
     *
     * The mission's base is read from `mission.yml`, not from this prompt: the
     * drawer's detail carries the branch, never the base. The old tip is captured
     * before the reset (`git rev-parse HEAD`), and the merge-base is only the reset
     * target: the before/after tree comparison and the push lease both use the old
     * tip, never the base. That comparison is the proof that folding the commits
     * dropped no work.
     */
    function repositorySquashPrompt(repository = {}) {
      const name = repository.name ?? '(dépôt inconnu)'
      const path = repository.path ?? '(chemin inconnu)'
      const branch = repository.branch || '(HEAD détaché)'
      return `Travaille sur la remise en un seul commit du dépôt ${name} — replie sa branche courante sur sa base.\n\nChemin : ${path}.\nBranche courante : ${branch}.\n\nTrouve d’abord la mission qui déclare cette branche : parcours missions/*/mission.yml et retiens celui dont le champ branch vaut exactement ${branch}. Si aucune mission ne la déclare, dis-le et arrête-toi sans geste git. Sinon, lis son ticket avec le CLI, jamais sa page HTML, puis lis son playbook : playbook/execution.md pour les gestes et playbook/workspace.md pour les quatorze interdits.\n\nReplie ensuite la branche sur sa base déclarée (le champ base de mission.yml), en capturant la pointe avant tout geste :\n\n- \`git fetch origin\` ;\n- \`git rev-parse HEAD\` : sa sortie est l’ancienne tête, la pointe de la branche avant le reset ; c’est elle que la preuve et le lease attendent ;\n- \`git merge-base origin/<base> HEAD\` : sa sortie est la cible du reset, pas l’ancienne tête ;\n- lis les commits à replier avec \`git log --oneline <cible du reset>..HEAD\` ;\n- \`git reset --soft <cible du reset>\`, puis un seul commit : son titre vient de \`gh pr view --json title --jq .title\` s’il existe une PR, sinon du sujet du dernier commit local ; ne le préfixe par '<clé>: ' que s’il ne l’est pas déjà, puis \`git commit -m '<titre>'\`.\n\nAvant de pousser, prouve que l’arbre ne bouge pas : \`git diff <ancienne tête> HEAD\` doit sortir vide.\n\nPuis :\n\n- \`npm test\` ;\n- \`node tools/build.mjs\`, puis \`git diff --exit-code lib/client.js\` doit sortir vide ;\n- mets à jour le journal de mission, la checklist et le corps de la PR (avec \`Closes #N\`) ;\n- \`git push --force-with-lease=<branche>:<ancienne tête>\` — une seule fois, sur cette branche seulement. Si la tête distante a bougé, si la branche n’est pas réductible ou si elle n’a déjà qu’un seul commit au-dessus de la base, arrête-toi et dis-le sans toucher à l’historique.\n\nGarde-fou : tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s’il te le demande. Tu ne touches ni aux labels, ni au statut du ticket, ni à une autre branche, et tu ne demandes pas de revue.\n\nQuand c’est fait, résume le commit obtenu et arrête-toi.`
    }

    /**
     * Suggested branch name for a mission that has none declared yet.
     *
     * The workspace convention is `<type>/<key>` in lowercase: `fix/` for a bug,
     * `epic/` for an epic, `feat/` for anything else. This is only a suggestion
     * for the drawer: nothing is saved until Save, and a declared branch wins.
     */
    function suggestBranch(mission = {}) {
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
    function branchFieldValue(mission = {}) {
      return mission.branch || suggestBranch(mission)
    }

    /**
     * The worktree a mission works in: the project's clone, suffixed with the key.
     *
     * `~/projects/missions` + `MIS-42` → `~/projects/missions-MIS-42`, a direct
     * child of the workspace root so the panel's scan sees it. A mission never
     * works in the clone: the clone keeps its base for the requester's manual
     * tests. Null until the clone, the key, the branch and the base are all
     * declared — no worktree can be derived without them.
     */
    function missionWorktree(mission = {}) {
      if (!mission.repo || !mission.key || !mission.branch || !mission.base) return null
      return `${mission.repo}-${mission.key}`
    }

    function missionWorktreeLine(mission = {}) {
      const worktree = missionWorktree(mission)
      if (worktree === null) return null
      return `Worktree de mission : ${worktree} — le clone ${mission.repo} garde sa base, réservé aux tests manuels.`
    }

    /** Short relative age, in the panel's language. */
    function relativeAge(updatedAt, now = Date.now()) {
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
    function blockedReasonAfterWrite({ next, message, comment, now = Date.now() } = {}) {
      if (!next) return null
      return {
        state: 'found',
        author: null,
        body: String(message ?? '').trim(),
        createdAt: new Date(now).toISOString(),
        url: comment ?? null,
      }
    }

    const STATES_IN_ORDER = STATE_ORDER

    /**
     * Parse a mission checklist into blocks the panel can render.
     *
     * The file is plain markdown written by the agent: `##` headings, `- [ ]`
     * gestures, `- [x]` once proved, and the old system's `- [~]` for a point that
     * was not exercised. Anything else stays a line of text, so a hand-written
     * checklist never breaks the drawer. Pure: tested without a DOM and inlined
     * into the client bundle by `tools/build.mjs`.
     */
    function parseChecklist(source = '') {
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
     * Les extrémités d'un arc : l'entrée, les points du modèle dans l'ordre du
     * fichier, puis les sorties qui n'y figurent pas déjà. Un modèle absent rend
     * une liste vide, pour qu'un rendu puisse attendre le brouillon sans tomber.
     */
    function endPoints(model) {
      if (!model) return []
      const kind = model.kind === 'statuts' ? 'etat' : 'geste'
      const points = []
      const add = (id, pointKind) => {
        if (typeof id !== 'string' || !id) return
        if (points.some((point) => point.id === id)) return
        points.push({ id, kind: pointKind })
      }
      add(model.entry, 'etat')
      for (const node of model.nodes ?? []) add(node.id, kind)
      for (const state of model.exit ?? []) add(state, 'etat')
      return points
    }

    function layoutWorkflow(model = {}) {
      const statuses = model.kind === 'statuts'
      const nodes = Array.isArray(model.nodes) ? model.nodes.filter((node) => node && node.id) : []
      const edges = Array.isArray(model.edges) ? model.edges.filter((edge) => edge && edge.from && edge.to) : []
      const entry = typeof model.entry === 'string' ? model.entry : null
      const exits = Array.isArray(model.exit) ? model.exit.filter((state) => typeof state === 'string') : []

      // Every endpoint that gets a box: the entry state, the points of the model,
      // the exits. A status workflow's points are states, not gestures.
      const shape = new Map()
      if (entry) shape.set(entry, { kind: 'etat', label: entry, size: GRAPH_STATE, rank: -1 })
      nodes.forEach((node, index) => {
        shape.set(node.id, {
          kind: statuses ? 'etat' : 'geste',
          label: node.label ?? node.id,
          size: statuses ? GRAPH_STATE : GRAPH_GESTURE,
          rank: index,
        })
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

      // A graph without any arc still has an order: the points of the file, one per
      // row. A freshly created status workflow thus draws its six states as a
      // ladder instead of stacking them all on the first row.
      if (edges.length === 0) {
        let row = entry ? 1 : 0
        for (const node of nodes) {
          if (node.id === entry) {
            level.set(node.id, 0)
            continue
          }
          level.set(node.id, row)
          row += 1
        }
        for (const state of exits) {
          if (!level.has(state)) {
            level.set(state, row)
            row += 1
          }
        }
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
    function modelOf(entry = {}) {
      const { errors, orphanSections, headings, file, text, summary, counts, ...model } = entry ?? {}
      return model
    }

    function withoutNode(model = {}, id) {
      const nodes = Array.isArray(model.nodes) ? model.nodes : []
      const edges = Array.isArray(model.edges) ? model.edges : []
      return {
        ...model,
        nodes: nodes.filter((node) => node.id !== id),
        edges: edges.filter((edge) => edge.from !== id && edge.to !== id),
      }
    }

    /** Drop one arc, by its two ends. */
    function withoutEdge(model = {}, from, to) {
      const edges = Array.isArray(model.edges) ? model.edges : []
      return { ...model, edges: edges.filter((edge) => !(edge.from === from && edge.to === to)) }
    }

    /**
     * Set an arc's condition. An existing arc keeps its place in the file — the
     * diff shows the condition, not a moved line; a new arc is appended.
     */
    function upsertEdge(model = {}, from, to, when = '') {
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
    function nextGestureId(model = {}) {
      const taken = new Set((Array.isArray(model.nodes) ? model.nodes : []).map((node) => node.id))
      let index = 1
      while (taken.has(`geste-${index}`)) index += 1
      return `geste-${index}`
    }

    /* ------------------------------------------------------------------------- *
     * Repositories: what the workspace root holds, read-only
     * ------------------------------------------------------------------------- */

    /** Session key of the worktree switch, next to `missions.tab`. */
    const REPOSITORIES_WORKTREES_KEY = 'missions.repositories.worktrees'

    /**
     * Whether the session shows the linked worktrees.
     *
     * A worktree is a second checkout of a repository the list already holds, so
     * the resting state keeps it out of the way: only the exact `'1'` the switch
     * writes turns it on. A storage that is missing, foreign or throwing gives the
     * same default, never a view that cannot say what it shows.
     */
    function readWorktreesShown(storage) {
      try {
        return storage?.getItem?.(REPOSITORIES_WORKTREES_KEY) === '1'
      } catch {
        return false
      }
    }

    /**
     * Save the worktree switch for the session, or drop its key once hidden again.
     *
     * Session storage is the app's lifetime: the choice survives a view switch and
     * a reload, and closing the window clears it. An untouched session leaves no
     * key behind, like the tab and the filters.
     */
    function writeWorktreesShown(storage, shown) {
      if (!storage) {
        return
      }
      try {
        if (shown) {
          storage.setItem?.(REPOSITORIES_WORKTREES_KEY, '1')
        } else {
          storage.removeItem?.(REPOSITORIES_WORKTREES_KEY)
        }
      } catch { /* storage is optional */ }
    }

    /**
     * The scan's rows, newest commit first.
     *
     * The host already sorts them; the client sorts again because the widget is
     * the one that promises an order. A row with no commit goes last, and a tie is
     * broken by name so two scans of the same machine give the same list.
     */
    function sortRepositories(repositories = []) {
      return [...repositories].sort((left, right) => {
        const a = left?.lastCommit?.date ?? 0
        const b = right?.lastCommit?.date ?? 0
        if (a !== b) return b - a
        return String(left?.name ?? '').localeCompare(String(right?.name ?? ''))
      })
    }

    /** The branch a row shows: its name, or the commit a detached HEAD sits on. */
    function repositoryBranch(repository = {}) {
      if (repository.branch) return repository.branch
      if (repository.detached) return repository.head ? `detached @ ${repository.head}` : 'detached'
      return repository.error ? 'unreadable' : 'unknown'
    }

    /** A working tree in one label: clean, or how many files it moves. */
    function repositoryState(repository = {}) {
      if (repository.error) return { dirty: false, error: true, label: 'unreadable' }
      const dirty = Number(repository.dirty ?? 0)
      if (!Number.isFinite(dirty) || dirty <= 0) return { dirty: false, error: false, label: 'clean' }
      return { dirty: true, error: false, label: `${dirty} file${dirty === 1 ? '' : 's'}` }
    }

    /** The last commit of a row, or the sentence that says there is none. */
    function repositoryCommit(repository = {}) {
      if (repository.error) return ''
      const commit = repository.lastCommit
      if (!commit) return 'no commit yet'
      return commit.subject || commit.sha || ''
    }

    /** A bounded scan runs in about a second: one decimal is enough. */
    function scanDuration(durationMs) {
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
    function scanLabel(scan = {}) {
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

    /** Session key of the repositories bar, next to the worktrees switch. */
    const REPOSITORIES_FILTERS_KEY = 'missions.repositories.filters'

    /** The working-tree states the repositories bar can select, in display order. */
    const REPOSITORY_FILTER_OPTIONS = Object.freeze(['clean', 'dirty', 'detached', 'unreadable'])

    /** The name each working-tree state takes in the bar. */
    const REPOSITORY_FILTER_LABELS = Object.freeze({
      clean: 'Clean',
      dirty: 'Dirty',
      detached: 'Detached',
      unreadable: 'Unreadable',
    })

    /**
     * One flat snapshot of the repositories bar.
     *
     * The bar keeps a search text and a list of working-tree states; a state the
     * bar cannot select is dropped rather than trusted, and a single value read
     * from an older session is accepted as a list of one.
     */
    function repositoryFilterSnapshot({ query = '', state = null } = {}) {
      return {
        query: typeof query === 'string' ? query : '',
        state: keptChoices(state, REPOSITORY_FILTER_OPTIONS),
      }
    }

    /** Read a stored repositories bar back; anything unusable is the empty bar. */
    function parseRepositoryFilters(raw) {
      const empty = repositoryFilterSnapshot({})
      if (typeof raw !== 'string' || raw.trim() === '') {
        return empty
      }
      let stored
      try {
        stored = JSON.parse(raw)
      } catch {
        return empty
      }
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        return empty
      }
      if (stored.query !== undefined && typeof stored.query !== 'string') {
        return empty
      }
      return repositoryFilterSnapshot({ query: stored.query, state: stored.state })
    }

    /** The repositories bar the session saved, or the empty bar. */
    function readRepositoryFilters(storage) {
      try {
        return parseRepositoryFilters(storage?.getItem?.(REPOSITORIES_FILTERS_KEY) ?? null)
      } catch {
        return repositoryFilterSnapshot({})
      }
    }

    /** True when the repositories bar holds a search text or a state. */
    function hasActiveRepositoryFilters(filters = {}) {
      const { query = '', state = null } = filters ?? {}
      return String(query).trim() !== '' || selectedValues(state).length > 0
    }

    /** Save the repositories bar, or drop its key once nothing is left. */
    function writeRepositoryFilters(storage, filters = {}) {
      if (!storage) {
        return
      }
      const snapshot = repositoryFilterSnapshot(filters)
      try {
        if (hasActiveRepositoryFilters(snapshot)) {
          storage.setItem?.(REPOSITORIES_FILTERS_KEY, JSON.stringify(snapshot))
        } else {
          storage.removeItem?.(REPOSITORIES_FILTERS_KEY)
        }
      } catch {
        // Storage is optional: a full quota is not a reason to fail the render.
      }
    }

    /**
     * How many rows of the displayed list answer each working-tree state.
     *
     * The states overlap on purpose: a detached and dirty repository answers Dirty
     * and Detached. A row git cannot read answers Unreadable — and Detached too
     * when the scan saw a detached HEAD before git refused — but its working tree
     * is not known, so it is neither clean nor dirty. The filter below asks the
     * same question, so the counts and the rows cannot disagree.
     */
    function repositoryFilterCounts(repositories = []) {
      const counts = { clean: 0, dirty: 0, detached: 0, unreadable: 0 }
      for (const repository of repositories) {
        const row = repository ?? {}
        if (row.error) {
          counts.unreadable += 1
        } else if (repositoryState(row).dirty) {
          counts.dirty += 1
        } else {
          counts.clean += 1
        }
        if (row.detached) {
          counts.detached += 1
        }
      }
      return counts
    }

    /** True when a row answers one of the selected working-tree states. */
    function matchesRepositoryState(repository, states) {
      if (states.length === 0) {
        return true
      }
      const row = repository ?? {}
      return states.some((state) => {
        if (state === 'unreadable') {
          return Boolean(row.error)
        }
        if (state === 'detached') {
          return Boolean(row.detached)
        }
        if (row.error) {
          return false
        }
        return state === 'dirty' ? repositoryState(row).dirty : !repositoryState(row).dirty
      })
    }

    /**
     * Keep the repositories matching the free text and every selected state.
     *
     * The search reads the name, the branch the row shows and the subject of its
     * last commit — what the user sees — never the path. States combine with the
     * search, and the order of the rows is the list's own.
     */
    function filterRepositories(repositories = [], { query = '', state = null } = {}) {
      const needle = String(query ?? '').trim().toLowerCase()
      const states = selectedValues(state)
      return repositories.filter((repository) => {
        const row = repository ?? {}
        if (!matchesRepositoryState(row, states)) {
          return false
        }
        if (!needle) {
          return true
        }
        return [row.name, repositoryBranch(row), row.lastCommit?.subject ?? '']
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle))
      })
    }

    /**
     * "3 094 commits on main": the total a history page belongs to.
     *
     * The count is what the branch holds, not what the page shows — the number
     * that tells the reader "Show more" will end. Thousands are spaced, never
     * abbreviated: 3 094 is a fact, "3k" is a rumour.
     */
    function historyLabel(history = {}) {
      const total = Number(history.total)
      const branch = history.branch
      if (!Number.isFinite(total) || total < 0 || !branch) return ''
      const count = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} commit${total === 1 ? '' : 's'}`
      return `${count} on ${branch}`
    }

    /** The folder that carries a worktree: its last path segment. */
    function worktreeLabel(path) {
      const clean = String(path ?? '').replace(/[\\/]+$/, '')
      const parts = clean.split(/[\\/]/)
      return parts[parts.length - 1] ?? ''
    }

    // ---------------------------------------------------------------------------
    // The outline: what a generic workbench asks a list of groups.
    //
    // The workbench knows no mission: it receives groups of rows, a query, and the
    // renders it draws with. Everything that decides *what is a result* lives here,
    // so it is testable without a DOM: normalisation, the matcher (key, title, then
    // checklist line), the numeric shortcut (`206` finds `MIS-206`), the anchor
    // cap, and the counts. Each count carries its own unit — a mission, a checklist
    // line, an epic, an action — and the labels never add two units together.
    // ---------------------------------------------------------------------------

    /** Checklist lines an outline row shows before it prints its `+N`. */
    const OUTLINE_ANCHORS = 2

    /** At most this many actions are offered for one query. */
    const OUTLINE_ACTIONS = 3

    /**
     * Normalised query: no case, no accent, no padding.
     *
     * The same form is used on the rows, so a query typed in lower case finds a
     * title written in upper case, and `declare` finds `Déclarer`.
     */
    function outlineQuery(value) {
      return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
    }

    function outlineHas(text, needle) {
      if (!needle) return false
      return outlineQuery(text).includes(needle)
    }

    /**
     * A key matched by a number: `206` finds `MIS-206`, never `MIS-2060`.
     *
     * A query that is only digits is read as the number a key carries, so the
     * three digits typed from memory are enough — the tracker prefix is not.
     */
    function outlineKeyHit(key, needle) {
      if (outlineHas(key, needle)) return true
      if (!/^\d+$/.test(needle)) return false
      const digits = String(key ?? '').replace(/\D/g, '')
      return digits !== '' && digits === needle
    }

    const EPIC_SEPARATOR = ' · '

    /**
     * The key and the title a tracker composes into a mission's epic value.
     *
     * Both adapters write `KEY · Title`. The value splits at the first separator,
     * so a title that carries one stays whole; a value without one is a key alone,
     * and a blank one has neither.
     */
    function epicParts(epic) {
      const text = keptText(epic)
      if (text === null) return { key: '', title: '' }
      const at = text.indexOf(EPIC_SEPARATOR)
      if (at === -1) return { key: text, title: '' }
      return { key: text.slice(0, at).trim(), title: text.slice(at + EPIC_SEPARATOR.length).trim() }
    }

    /**
     * The matcher: groups in, ranked results and visible groups out.
     *
     * Within a group the order is the order of the families: a key or title match
     * first, a checklist match after it. An epic whose label matches is shown with
     * all its missions — they are the context of the result, not results of their
     * own, so they never enter the mission count.
     */
    function matchOutline(groups = [], query = '') {
      const needle = outlineQuery(query)
      const out = []
      const counts = { mission: 0, checklist: 0, epic: 0 }
      const matches = []
      let total = 0

      for (const group of groups) {
        const id = group.id === null || group.id === undefined ? '' : String(group.id)
        const label = String(group.label ?? id)
        const source = group.rows ?? []
        total += source.length
        const epicHit = needle !== '' && (outlineHas(label, needle) || (id !== '' && outlineHas(id, needle)))
        if (epicHit) counts.epic += 1

        const hit = []
        const missed = []
        for (const row of source) {
          const key = String(row.key ?? row.id ?? '')
          const title = String(row.title ?? '')
          if (needle === '' || outlineKeyHit(key, needle) || outlineHas(title, needle)) {
            hit.push({ row, kind: 'mission', anchors: [], hidden: 0 })
            if (needle !== '') counts.mission += 1
            continue
          }
          const anchors = (row.lines ?? []).filter((line) => outlineHas(line?.text, needle))
          if (needle !== '' && anchors.length > 0) {
            const shown = anchors.slice(0, OUTLINE_ANCHORS)
            hit.push({ row, kind: 'checklist', anchors: shown, hidden: anchors.length - shown.length })
            counts.checklist += 1
            continue
          }
          if (epicHit) missed.push({ row, kind: 'context', anchors: [], hidden: 0 })
        }

        const rows = epicHit ? [...hit, ...missed] : hit
        if (rows.length === 0) continue

        for (const entry of hit) {
          matches.push({
            kind: entry.kind,
            id: String(entry.row.key ?? entry.row.id ?? ''),
            groupId: id,
            title: String(entry.row.title ?? ''),
            anchors: entry.anchors,
            hidden: entry.hidden,
            open: source.length,
          })
        }
        if (epicHit) {
          matches.push({ kind: 'epic', id, groupId: id, title: label, anchors: [], hidden: 0, open: source.length })
        }

        out.push({ id, label, epic: epicHit, open: source.length, rows })
      }

      // Ranked across groups: every mission match, then checklists, then epics.
      // The tree keeps its group order; this list is what the counts and the
      // tests read, and the order is the one the field promises.
      matches.sort((left, right) => outlineRank(left.kind) - outlineRank(right.kind))

      return {
        query: needle,
        groups: out,
        counts,
        total: { missions: total },
        matches,
      }
    }

    function outlineRank(kind) {
      if (kind === 'mission') return 0
      if (kind === 'checklist') return 1
      if (kind === 'epic') return 2
      return 3
    }

    /**
     * Actions that match the query, at most `limit`, never shown at rest.
     *
     * An action is searched by its label and by its keywords: `declare` is a
     * keyword of both declaration gestures, so the query offers two ways in.
     */
    function matchActions(actions = [], query = '', { limit = OUTLINE_ACTIONS } = {}) {
      const needle = outlineQuery(query)
      if (needle === '') return []
      return actions
        .filter((action) => {
          if (outlineHas(action.label, needle)) return true
          return (action.keywords ?? []).some((keyword) => outlineHas(keyword, needle))
        })
        .slice(0, limit)
    }

    /**
     * The keyboard's one list: the actions, then the visible missions.
     *
     * The same order the list shows, flattened — the cursor moves on this list, so
     * the arrows never disagree with the eye. Each entry carries a stable id, so a
     * query that keeps an entry keeps the selection with it.
     */
    function outlineEntries(result = {}, actions = []) {
      const entries = actions.map((action) => ({ id: `action:${action.id}`, kind: 'action', action }))
      for (const group of result.groups ?? []) {
        for (const entry of group.rows ?? []) {
          entries.push({
            id: `mission:${entry.row.key ?? entry.row.id}`,
            kind: 'mission',
            row: entry.row,
            anchors: entry.anchors ?? [],
            hidden: entry.hidden ?? 0,
            group,
          })
        }
      }
      return entries
    }

    /**
     * The field's count: one label per unit, never a total.
     *
     * With no query it says the size of the list; with one it says the family that
     * answered (`1 of 12`, then `1 action`, then `1 epic`), and `esc` only when
     * there is something to erase. `2 missions · 1 action` is two counts, not
     * three results — the sum is never computed, let alone shown.
     */
    function outlineCount(result = {}, { esc = false, actions = 0 } = {}) {
      const counts = result.counts ?? {}
      const total = result.total?.missions ?? 0
      const query = result.query ?? ''
      const parts = []
      if (query === '') {
        parts.push(`${total} mission${total === 1 ? '' : 's'}`)
      } else {
        // A checklist line surfaces its mission: the two families are one count of
        // missions here, and the unit never becomes "lines".
        const found = (counts.mission ?? 0) + (counts.checklist ?? 0)
        if (total > 0) parts.push(`${found} of ${total}`)
        if (actions) parts.push(`${actions} action${actions === 1 ? '' : 's'}`)
        if (counts.epic) parts.push(`${counts.epic} epic${counts.epic === 1 ? '' : 's'}`)
        if (parts.length === 0) parts.push('no match')
        if (esc) parts.push('esc')
      }
      return parts.join(' · ')
    }

    /** The one family that answered: what `search.family` counts. */
    function outlineFamily(result = {}, actions = 0) {
      const counts = result.counts ?? {}
      // An offered action is a gesture, not a result: it names the family only
      // when nothing in the outline answered.
      if (counts.mission > 0) return 'mission'
      if (counts.checklist > 0) return 'checklist'
      if (counts.epic > 0) return 'epic'
      if (actions > 0) return 'action'
      return 'none'
    }

    /** A count of a lot, in its own unit: the epic row says `4 open`. */
    function outlineOpen(count) {
      const open = Number(count)
      return `${Number.isFinite(open) && open > 0 ? open : 0} open`
    }

    /**
     * The length of a query as a bucket, never as the text.
     *
     * The gesture counted is "a search of this size", not what was looked for: the
     * query itself may hold a key, a name, or an internal word that does not
     * belong in a usage file.
     */
    function searchBucket(value) {
      const length = String(value ?? '').trim().length
      if (length === 0) return '0'
      if (length === 1) return '1'
      if (length <= 3) return '2-3'
      if (length <= 7) return '4-7'
      return '8+'
    }

    /**
     * A title cut on a word boundary, with an ellipsis.
     *
     * The tree gives one line to a title; a cut in the middle of a word reads as a
     * different word. The renderer hands the short form to CSS, which keeps its own
     * ellipsis for the width the layout leaves.
     */
    function clipTitle(title, limit = 64) {
      const text = String(title ?? '')
      if (text.length <= limit) return text
      const cut = text.slice(0, limit)
      const space = cut.lastIndexOf(' ')
      const kept = space > limit * 0.6 ? cut.slice(0, space) : cut
      return `${kept.replace(/\s+$/, '')}…`
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
    const USAGE_ELEMENTS = Object.freeze([
      // Tabs
      { id: 'tab.dashboard', label: 'Dashboard tab', section: 'Tabs' },
      { id: 'tab.missions', label: 'Missions tab', section: 'Tabs' },
      { id: 'tab.done', label: 'Done tab', section: 'Tabs' },
      { id: 'tab.repositories', label: 'Repositories tab', section: 'Tabs' },
      { id: 'tab.workflows', label: 'Workflows tab', section: 'Tabs' },
      { id: 'tab.usage', label: 'Usage tab', section: 'Tabs' },
      { id: 'tab.playbook', label: 'Playbook tab', section: 'Tabs' },

      // Mission list
      { id: 'filter.search', label: 'Search the list', section: 'Mission list' },
      { id: 'filter.state', label: 'Filter by state', section: 'Mission list' },
      { id: 'filter.type', label: 'Filter by type', section: 'Mission list' },
      { id: 'filter.epic', label: 'Filter by epic', section: 'Mission list' },
      { id: 'filter.project', label: 'Filter by project', section: 'Mission list' },
      { id: 'filter.priority', label: 'Filter by priority', section: 'Mission list' },
      { id: 'filter.missing', label: 'Show the missing ones', section: 'Mission list' },
      { id: 'filter.clear', label: 'Clear the filter bar', section: 'Mission list' },
      { id: 'list.refresh', label: 'Refresh the list', section: 'Mission list' },
      { id: 'list.retry', label: 'Retry a failed read', section: 'Mission list' },
      // What decides in the outline: the size of a query (a bucket, never the
      // text), the family that answered, and what the preview is showing.
      { id: 'search.q', label: 'Search the outline (length)', section: 'Mission list' },
      { id: 'search.family', label: 'What a search answered (family)', section: 'Mission list' },
      { id: 'preview.kind', label: 'Preview what the cursor points at', section: 'Mission list' },
      { id: 'mission.open', label: 'Open a mission', section: 'Mission list' },
      { id: 'dashboard.view-all', label: 'Follow a widget', section: 'Mission list' },
      // The list's batch gesture: the whole Done perimeter in one confirm, so its
      // count says which list people reach for it from.
      { id: 'mission.archive.batch', label: 'Archive the filtered missions', section: 'Mission list' },

      // Mission drawer
      { id: 'mission.tab.details', label: 'Details section', section: 'Mission drawer' },
      { id: 'mission.tab.journal', label: 'Journal section', section: 'Mission drawer' },
      { id: 'mission.tab.checklist', label: 'Checklist section', section: 'Mission drawer' },
      { id: 'mission.priority', label: 'Change the priority', section: 'Mission drawer' },
      { id: 'mission.points', label: 'Change the estimation', section: 'Mission drawer' },
      { id: 'mission.block', label: 'Block or unblock a mission', section: 'Mission drawer' },
      { id: 'mission.pin', label: 'Pin or unpin a mission', section: 'Mission drawer' },
      { id: 'mission.declare', label: 'Declare branch and base', section: 'Mission drawer' },
      { id: 'mission.open-tracker', label: 'Open the ticket on the tracker', section: 'Mission drawer' },
      { id: 'mission.close-checkout', label: 'Close the local checkout', section: 'Mission drawer' },
      { id: 'mission.archive', label: 'Archive the mission folder', section: 'Mission drawer' },
      { id: 'mission.tolgee', label: 'Import the diff into Tolgee', section: 'Mission drawer' },
      { id: 'mission.session', label: 'Start the mission session', section: 'Mission drawer' },
      { id: 'mission.feedback-session', label: 'Start the review session', section: 'Mission drawer' },

      // Repositories
      { id: 'repository.open', label: 'Open a repository', section: 'Repositories' },
      { id: 'repository.adopt', label: 'Bring a worktree into the main checkout', section: 'Repositories' },
      { id: 'repository.remove', label: 'Remove a worktree checkout', section: 'Repositories' },
      { id: 'repository.tab.details', label: 'Details section', section: 'Repositories' },
      { id: 'repository.tab.history', label: 'History section', section: 'Repositories' },
      { id: 'repository.branch', label: 'Read another branch', section: 'Repositories' },
      { id: 'repository.more', label: 'Show more commits', section: 'Repositories' },
      { id: 'repository.resolve', label: 'Resolve the current branch conflicts', section: 'Repositories' },
      { id: 'repository.squash', label: 'Squash the mission branch into one commit', section: 'Repositories' },

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
    const USAGE_MAX_VALUES = 32
    const USAGE_MAX_DETAIL = 64

    // The verdicts are indices, never orders: they say where to look, and the tab
    // prints the numbers they were read from. The gate keeps a novelty from being
    // condemned before anyone had a chance to use it; past the gate, a gesture no
    // one touches is a candidate to delete, and a gesture used often the one worth
    // investing in.
    const USAGE_GATE_DAYS = 7
    const USAGE_GATE_EVENTS = 20
    const USAGE_STALE_DAYS = 30
    const USAGE_IMPROVE_COUNT = 2
    const USAGE_GROW_COUNT = 15
    const USAGE_GROW_SHARE = 0.1

    /** What each verdict means, in the words the Usage tab shows. */
    const USAGE_VERDICTS = Object.freeze({
      grow: { label: 'Grow', note: 'Used often — the most worth investing in.' },
      keep: { label: 'Keep', note: 'Used regularly — leave it as it is.' },
      improve: { label: 'Improve', note: 'Little used, or left behind — make it easier to find, or better.' },
      remove: { label: 'Remove', note: 'Never used since the tally started — a candidate to delete.' },
      none: { label: 'No verdict yet', note: 'The tally is too young to say anything yet.' },
    })

    /** The registry entry for an id, or null when the id is not declared. */
    function usageElement(id) {
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
    function usageGate(usage, now = Date.now()) {
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
    function usageVerdict(row = {}, context = {}) {
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
    function usageReport(usage, now = Date.now()) {
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

    /** Distance between the trigger and its tooltip, in pixels. */
    const TIP_GAP = 8

    /** Smallest distance the tooltip keeps from the panel's edges. */
    const TIP_MARGIN = 6

    /**
     * Where the panel's one tooltip sits, from the boxes it has to live between.
     *
     * Pure on purpose: the placement is what breaks in silence — a bubble half
     * outside the panel, or one stuck behind its own trigger — and a real layout's
     * boxes cannot be built in a test. The tooltip opens above the trigger when the
     * panel leaves the room, below otherwise, then centres on the trigger and is
     * pulled back inside the panel's edges.
     *
     * Boxes are `DOMRect`-shaped (`top`, `left`, `width`, `height`); the answer is
     * relative to the panel, ready for `position: absolute`.
     */
    function placeTooltip(trigger, panel, tip, gap = TIP_GAP) {
      const above = trigger.top - panel.top - tip.height - gap
      const below = trigger.top - panel.top + trigger.height + gap
      const side = above >= TIP_MARGIN ? 'top' : 'bottom'
      const wanted = side === 'top' ? above : below
      // A tooltip wider or taller than the panel cannot be centred: the clamp
      // stops at the margin instead of inverting.
      const rightmost = Math.max(TIP_MARGIN, panel.width - tip.width - TIP_MARGIN)
      const lowest = Math.max(TIP_MARGIN, panel.height - tip.height - TIP_MARGIN)
      const centred = trigger.left - panel.left + (trigger.width - tip.width) / 2

      return {
        top: Math.min(Math.max(wanted, TIP_MARGIN), lowest),
        left: Math.min(Math.max(centred, TIP_MARGIN), rightmost),
        side,
      }
    }
    const ART = {
      village: 'data:image/webp;base64,UklGRsj6AABXRUJQVlA4ILz6AACw5AadASoABdACPm00lUckIymmpnPbmTANiWdtnTUS8Yjpeu3YB32e3qYtdcqPOfgz/ReBv6D/iPYA8jf+27vvuPqFfsb6lWbc4H6A3+/+3npp/c/+tf1NdyfZ/4P+o8Em8J5B97r6Wun/jil6G/FP+9//fSB8g/yv/t/uPJf8o96Kcu8UZIPlvmX/4+1V/gehZ7k8/z8j0CN38SjHzx1/T+jfy/f9Ppk+ip/0eBuR6OE0IYv6ZlR5A2gLlA3ojvsoQFRMbW4gClw0AauwZdEezzxgv4IERJxGG9TEAKcbfiZiWRVleC1Ed/DQCMY9DGHd2W0HBC0vc6447x3AKccCO8gM6k2bPacKcv7rkwwebRG3ftBXzJfMCdcIiOtKYdNVwYBRURKciqE++5cwXWrlatGrzgZqHcJurCcOYQCabJgri1gnHlSY+V6dvZhYy3nT4f4CXy2MpqT0mqezdS+lhFAq+/LNtAVUhiyhMBudFOfVjQ+DASSaoaoQJMHeKJRxc46+nit9b2ZL4FdK/hcJOGRiMwAxhv0qATvbSsCtt+mGWV3TPAPV5mFm/C8IC2HcUCuMddgxbENDMGe0iAPv08DF9b5M27pcKmnKMrXoKJSaJH3Z0iI8T2v3YSq2+fwcQpJhsq84Mp5JHqBTsyPMaaZRJpAuMn0PG1L30Nhfw/23zFPL8wZ6DIR7fC0AQa3Mq5HSRMgMakosimWnXnYGH2tiZyg+IrXYJX5XL7tFp1BDj4NoogqvejE3xIHHB9WyijdS0jsquMEbI09qWoppbUHEVZ3OJNc/xyrng3juQn13OIEWbvG2rOEhyNc5XZGKzRc878KuqD5mfkSSMLQhVDx2SP3/zmKy7ZrZ8UNxpFAmFDFevqVA5VSko4MVHrKaTo+xyMt6LVTI84bFeRIMwqmkWvBCy1VJPjN9RN+PPmk8yv/hNbkJpzZ7E/wfPjN97NI72uu5KEvEUT92LFctUxMr52hrW/aRhNglymvTluLkE7CE5QKg1dRIWYJuWta82M+w3QQ+b95sEwL0EIhgyEiuElIvNqv0UoMPUpkv3nXM+1GFvd7YrRHMTnuejAchiRzuREvC+AliXJdEG8wh3gxe1NPOgz2hMM+i3jG4LVBjYqu+yFeaKZ+bclpbWxYnFcNFBuPnfsajanFzQZJKtpMA+JnhN8NkmqyeUU70ftoLkdMUmyEExrMJNgDldlhkC98g6/u6Bj/7sORcTYeu6MVh4kvsOERZ6QD+6gK5RrnleDDr0nSmbO9W7IdBiUTMGA/dwXSB6BmmbBj/yGZ1+St4knal437WWO9y4WZzHByrjGEQAlfbUeSxgLByFGz6TKbabNDLCNliEqt9QQIZzsrrqfIybRzdfJQR4dRUgQUM/860hUetdWUCLean4uEVcp+k46i9sjYRtLne00Bl2RLGCvPX9db9wz/Xgj9OMS+a0bG6piHqCAtTk5oRmJTTadyoaCHNULm1vk/nbMo5VoawTJUP9EKEnvsbzrVyhn01NU6x/U3qV3/qvKtNLqkzApa2D6mRAdNjHeaoliY+yonB2VbXdV2IlE8MavIigL6degl0wRIbgxZdDj2FlLQnBluhuEYjx1GMsyR3+s13a1MMFWr6ojIODObNfl08oSaaFQHefKULy5fiY5mNh2uuAV+s+paUH8lJUrUxer79VpUUY7Tu19um0LO6PF0/mJcuVK+28WH84fZt4ZEpYVEPw30o9rlnikXtQ3kYTNIhk17yNWKKmJjoGayo6cGbxob1pYeOc5wtmAjVshygdmClP8QlvRZg3yNZgJdd2n6WUaY+UZUrs0SyQrVMbWY0myxZmKRXL34Q3T6qSztDFce5wDteV0Dh6ZqEc/7A9AxCGthQBZ2axhPE44CcpyHt9Bt30V5Se4Supy0m1t2Q+z8grz+Zo8WSvi9I4PclWBpW2VRPDQbp0TC1yAC/ZHb0IlsXwmEgH0DuuWLveCI67eeYLfKDXbP8C+4uqCdKMGLrVsWXME8JFb7toksWvFXzZ5BiZLWvLoCsN11xcZBH5CuPIdB0A8+h1p2IY1FQRjIvvfSq/fZ6Ntuv41I6r/zDhL7sxuggEWkL07eYm1A0RddNDYiLBVhCekobyx6S0LrRCPM3x6MoM/2l5tNXFFzRbRXX1tc5fua54RTUTEU/qv9D55mHO0K/Ur5UUY5u36PZz+mYfIR0sccyMV/7Mrs7NIAgX/wvGlBh3K+VPAmNUKnb+8/UtNQBHDWhvQ+46xN0GxkKGS64dwBU/9dqrXmLudllP+6enrZDv3uPAsPyp8JXrXZRuIaG/V9Xw43UT8Ct8uJLKDYe/QxT5ouoN8Udp2KyINjUZ00fDEq2VWLJFQjqumMIdjWazxgc/D+QEHQF0Q7rreEhME6+HUoW6WrVJKp2GlmqOrftu/UyZQBOFSIWpq4wmiKPTdeF5BquGVieK/kWDRlOuaKOMHQkVIQmFAiffm6CHUbi8Ms53NmoL4RUqLrlLi7JAwTYGDJjUXKs5VYrpEJp8Je/AydgKBraXzvh6KNC/aMcf4kr0DBPpRuUNd8cJVW2bNsu1Z/DQwOvCQ/bOngRv23XonZRfaYjwjhiIFQhBXSs7gaoXSOrR2u0lcVYPkWK520gz7lsqbuFR18u7iis06pRhsZGGcdipJH0xl/EsdLuiauTdbFIV36fpTcuRvoy7UqbPpJ8puAq+tJj9/LVKpVKXWSZTmgt0o9t/masCWIrht7NInG5dQ4KZxl5j7rFc4A8LDEcCvBUhT9euWzXqMzKudyMfunmjVZZRGjBsjMgU2eAQOOxQo0Ek8s/eCCcIVWzfOBEgFdxMl1sZAQ/zTlyPEJWlgURSqrdxgU5RUiYXRos659J76TgsMyBPPIlys4UiKhH9Jf2sgdkUOXjFUVd/l2hYiOhLG51jyaQQDaVKr3IQf9EIuPt7aGeagRErWsW0jCoRxpNNVjPoyKWHx7CqQRRe199pMmqIIIrhbRA/qfX2nIdph05SWDC07lE5EjK8+PdJYIqhnq5Jp6e651oi3HrxXI4BKaLDV5B+LX+kzBYNLSOz9nN/vu3vGAP2PUBdRJt+2247TC4u6ekAphlzXRyYUrup6mg0kA+KjaIoWEXNdvsMM1PLJXgaUpP6WGf7EDlFJc+0MkKV3b+Fen4uMZ6KW1wZ+Ui2gNutheXYxiW9wZZfLjpQyv3yXh21Ic6JxqAu+BHy8auQeqFvsbdRIXfdfFp3cCfCReXH+c0J49xMna5TBt9VlAIXt15TPOtn6HRnY2QjKzWJxopRFqCk1WWKN2QnxNmNQdaHQchdCQ+INtkM9piHEcV+GAyT/nz6Epg/8omdphGPm8WcrrCm8eQhvmenDx/VxAmcpr0OOu8gd03PrFK0tSN0obV86LCCQ49PX1UmmUxox2Q0G+SEsUvagVSrt2V5wFa1dJEYDnFU8nFhejaj3W93Y5UzSNIzBoVN0vgi6nXJKZX1KQ2cQglOLBYIAbm5vlYdn0xCY4PAP/7/H/UebEkn3x3nG/eDx/96Rw+DekrgTsCo8wYdIVw046SIu7oGx/tWG4N2eww5itD/9N76a69heNZAxvzn68DVcCApV/RxglUB9/EPDTAvEL3pvT2jcNhb4fngl6Ecm2i8dcRmb0ttu7Mnde/211MzG5YUA1dQ0Xi2kTLIo9No7JfjYykrtyGdNJvR8ThQy63eOTXSqwhHorVbEYCL0KsjJ240a28tPVqJ8ErZIQWwQBf8TPzc+5p3s5Y/rLuKPMqIPtOEdVtfwR+7LXVQYo5x3pcxsvwjjP8N0Q00qM+EeIVWdLfGndL2h3543qXWpZQYBM1jUltzrsToLCCXW70llgP6ulvWhxUEM5sXdnpNoEaTzMUcqWtlBt7z8D6WmISG16fwOukvfx0HGXCqHtb6Hbjc99HQ/mE0H85GlqPzaMuYlg6W0QwmI0ccoLNNZ+l67BXhXNnnnj3Izo77NP7GgXpXhKHuE7mojT0PrtK5aifInL/U0ZCDwGCd6Pn/kQhbY+AkvbebX01VjsZRP4Z341pg0PINXuPh9IvhjlK9FbTexzNpDwIy+sE02nxBt627lWPll979KVLCNRealeyQ/c7W6hpI5B5plWdQJdNF3XwCg/HuMbGqxgtQ8LrvyNVi/FJUN5hR67yUri8/ah5GAoitItOYd3EobDJ4lylh9BL7Bip+61U/yZ4LmbZIdBP/5JpUrR0e9YlsFQ+uCrXD7fN2xrJGrPeyrM0ejbqY4UYaF7OL4SzIhV0yhL3r9s1+caSJq6zIZlUJEbnMbDQNyZN0sCtNQ6yrUy5DiDyil0QRpO1+WtXIEpGpsHCyZQ8e+LjOCdcvdja9icecEFn6zQwls7M59sdQdjm/uFnB5Wr5+cvzBu4uLPqP3xB0C/tCpRUWg8qBJ29M7EVO25YKJFlA/Yiv/PziX05Yi43tJlgWAFx483Kn5YrJipRSTLPwWgvwozbQv0S2o89PPOijymC6bHfiMDQO3VAoebiKXwHu1KNLX7a8xd/pJMk55eEESaD+kw1uJ6CFh3VCFeSplRZqVqqiUgew6BFWLwQUjYyT30w5fVldG6t+3tVm4YHxrGig26t0I16EyVE0fhFCesxoMvtSSXONBIRvJ9Qvk7SGZCboo1ZPONs0c/O0F6l8TixfVgF1cBI474t/YBfn7fRktcP6WrkBCNxLS4bt6JHegp81AOBl0B0pbSh3vA6VoZ4jZxpy5xSN34uHkf9brG262Zag151tN0K0l4nFzuzeagwtrmFTqp5V9pwcPr57WB3pzUO7qfjWNGmxQN8c32sv+VKvIVy5XMRCjsqEV3gf+i19XfXT9nJ2YzrCTrS5BakI6GtAjflmzwC9ntx1vrc8Eio2UGR+R+w75pKIXQ/w1HnqGfa+qABIrzkOa1pys54QxuBIDYEOA0T7HcvB/4ftgcnvbklexjEIictsSbP6nGmlkArQ8hftlcpyNWHTc8po43aV8qUdH8sKir1uNkjBv4iuweUA2f8fpJFmmTH43RYrdc8OjaB1YX0VHJmSODmTW19PFakIPaKDupY1Xw8+CyNitaoZcRuHk3OegPrzv6BNHfXMKLmzyWYCtN7D/zRYqYWCqNnSVNF8d6sfnu1YImk+OupQor3msKQ0koSV4RLtWbbKEtH11v4xo/zFWxeI1PKFeT8Ot2aQulO+Gtj6cyBv3OAcW7lm+0H+Cber3hDnNkVx+A+bOjkh/HV8GpFkI6WoFrbXr57vZa/x5Lvtqx7KSrMs04RqmxLn6tvkBQjCm6vLZ+QOWiokXUy56FUumaXNizn+HuFtFi3eJFSHXfb7nUfTYi3nfOd9VfFKQE1Nn+oVUVbTpapv2P7hwElUu668ofX3+E9JbvlwLBsy93O6S1IXVZljWu+/GtMom9RaFxk+SW1VsQRqFBe1LWnHpE1ggf9ouHD1U+GhpFIBaPj+o0KYcIPbGYAAvcj+6vAp/0sdULtP0LZCy8OJ85GcUXLvz6mjn2jIdg1Ux9juY7IuDmv8fAOdvKp++jf4sfOknEusqjFrPCou9v8Rx9VxWkKQNQ21MiF1Bxzt0p5uwNexErZBqItc7KYRH3738XW0ioAyIJgJuvB07wM140LYaJplt9mNlowQUWQi/irdZPOGgQBVWJRdxl8jYrLzzEdCPu/2qvs0CStOz9QDakoVO88qKn36uABuERfslIicKXUdVE7r7tkUnTXMABqGLb+pAgEPwk8+qSpY+Huo7DJTfi2SIOrEC3uYhaam/B+Uo3NxVuXprjVF8mRnlCayL9NLn0CkBL5H0kYD66FWSnXEcTHvGADrDAVd/vcqyq7QpnO+Hpsffddgd9ofdxUp8CRDGt9n2FFkdbMHFPQB/XlOLNjAShT68kwSjGqtESyL765Nf4ZSGT7aZUGhPEYn1kRspm0FTKXN8X7/Qv0V9qLAZc/6lU8Y2vOkAkb/omsNBj+ljB2B7hFVn1fT9IAIXwWPvJ5yCEdFY6FxNYH2IxG0xcCiTSXvUIVTimMJL1xz4satyTcI33Mt+gzKI0HuDydyvOUICsBlK+fgngoZwmG6ffJYZG1WTm44Chsa4tQOAdexQzNQx09Ddj7e0Uf+Scb356VSFO6kYCUCIeSG1wqRDwcP5KUCPThqZ1HQtrA9MfYTNxvZZ2gB2Xq5toG7TyiZ6VIGwZLuc05l2YBQ7kLttyaDdqV8dEvMrEghEbiT+OxmKaNui9XfgCsENhXkMYibn98ViA9XkF8a9hQWXY0qewHO538Bbm5EVUBNSyq6bz55ouODagG30bfJKveS0qMd74EgYu9RQh/gPU910veH7f4S8epYxSKWQEm4gbD2Gvv10I8wkeV9+iahdDXvQcUFAvKHj46KbZxFF2ixQnZwWd+BCdsdi3EQ6ZmwQ0ok1TXcPOtFj5qEIDQEPo+7T/hS8yTG5p90iKjIykam2jeGFuz3+FNw6k9KcBa0L/6/lQk8TuLrgsXr3SjnJRwjHbazTHMrDffyjeK+3XcDiI8GYLVvUbmnuzCavNOF5Z9372APlrjhUVZVpn09RwbGUM9DVzmFmanwiINCBGC8EgbV9gbyEy7ccy7Upoknoi5ge7HxqQFn9JB5+otYneGLNJBLo94dlCzFwuhW4icaVuQ3sGZCNv2fj8Pd6IIhBSvoi0J95emmEXBVW73r5ePOBuod0zV6g/fZs5mZlow9zZSPYuiDZCnSZ89dSPn22HF51p40ESf+7Sj4kSMCyIdqDK9dEHRhw5vqA2YxuZnAV1EDLtYFFfr/KnzA0SurHtNCYkP1RB7/ldlxcS7b1leRtIagYzvZZAe5WxUYLdCQms7uwciB/mfhu4LT8uPr/2EHTOBBExpr/udN367CfwCkzdg/AgiuzsO7/D9mBXHxsbKwXTxxU59wpilP0D9HwuA/RFMdOTQzCpT5DyARncRqTLx0Tm/1t9Jnx8KLCLCVJG1IrhfxjSEpEtVWu0wjxm8TmFkeoo9nJcSRMzgCIxB0pkAiXu49T6MATkJy76pgb0zGCg4tE2YEXWJVCyboisA+zEkLGB+VQKrmy/s6Aq4lTs7x5kUN4O41Wp1vfr9ORJS6tlSDP7CnxlQcD8vYaEW2zCBgjqxdRrAQJPTEQ5fouMn4saxlvLUGgNiDRCulHxtDDnl3pfYxjWK5HplyvutERLAWkGj0ya2uH4fEchajAiUvu7lo49DXOkBOlaG3x+OF0IwNWLdLmKfJkmvH32UJE3yJxpqNhiS7nufsdd9/9YVZY4SY2Dch1K2063oRS5yjxCv9gznucjxx9nwveiYTcNi2B3EKOse6c3ZJeOFo+/fC9Da6bUq9MCnspEpe7mpYV2tG7npIDPEDosPuGroHkAtLRS5XyDyJB88wtY0mpfUd/d14dCG+yhEcTg+Q7xhHRLqnvJJ/rlEKNYo2JD+fSLqVtP8cSZ4Sb9RCxNNOxceuXJWL7V/hblJQY/fmj/8Gx1W/36se7R2sFUxNJzUUM73vRG7UCyzoG2TbrfVGkJMcTQQrpcRW/1hYcMidujDefmx2pNYcWF++83KsCd9U2NPaWfeIxS3GwQh5r8pYcdO21RZ7lPPAJEa624uBgXs+FJpAWzUJ7PV0iaZTftdmo6aHVR8mrTea6vXnJdynk20ojwEeOuihY/uqnGaVyV5ODaNKSFUKLyO9B0ADO1hqZXvWLlBwsaEJK59wnK3MCXnjS8t3NxK8qf1BC7LjwYNUdyKvlr2nQ26xvOEoqEjuz921U9S6cfNNSnhDFuFmGz2yuIHY3+OTcSyEyMg+M3rUPROSJ380yMLu31xKeVqCKcmTzcg+2nfMCsUTY97pTSEBhX0WpGsNN/DGI4JKiR07SyvEMI4+AQiziWReOk1c1vyd93kfnx5swOsXZwSHVP9iHEfHRtEfQCz/Jt4tiYZuAXX4A8DCtqUwrSO5FOY6iPWh730/voQHRe9qDQX8pauMVgjB9AImVZzq9Cne/QOTKlCgasov049Lp1zFWO4zOUxlU0f1+yhnQRdQGAWzV0sEVBZaw9x9ivsWYR4TIf7t09VnSq7qDXJQfkubNI/MLK0d+nuvwezpDBz3EjCzaQ2RFB4LkXgNxIrzy0+xcG1uoyv3bcj/w3joQ2oyAg5LcBwLKTbXZakaM2tbiCCAzqoiM6wAtftJwzxJLHiQfdl3cL9/0C6UUfDcBcLQZ17iqP6zOO/D8mbgP0Mqa+u4+sw+eDtDgl0VdfUEnUyER0NYpx+laQmNu67KHBMOa1X7Sfc6oCagu+5SK+L1XRMCueeGeL/mv70wkQvk3Ih/kCRxYWd/zNTOofF5/HpF9ThbPNPFOiFRmh+hCRopkjEcjK9YRLTRqv0mRNen9Vuzsa2hoeiSJb9cDerNembcMVvyCOM5IQeKrpORGcW3ol2BK+aIFQQAf2qDdYul4rf1qhmmmwV0Zlpr7u19yE7h/oAA1RP+a67wsz3le2hV00Zpjdl25xnLKqiAuHcMn4pNcyDlysQgDqssIUnK3te8BhGc6lV2Z9SXNu0Z/e/7mUUpEtHiAoxiC2V8hk9x3ksH/PYD6bGVJ487YkqFV/JRuXeBRwf3JBXb3P0nMMNkjww6dBXajY+ZkXdE3LssM/S9dTIl9v0Odhc9BitPMQ4BjrOD1UtwFKxqa4QvltGf3Xa/nAbL9g6PUWsgKvodeABRICh7H8uCJc/02UM3K0PahYahtZ2ap3K+cokcY/qQLuO0DgR9fUuwx5QV7mazIJhZtMorvYfGzPspWVvBzfqfdInjgwgh0q2+3xg3XTvdEVFS1hDhVhLO0CrY36G3OshxINLufZQdQmtrD3wad6PSXNJ4HXLem46u9HocClrV73erfRpHlQs6tHyuj/ejgRs2ySGukZKygdU9svNz+BLbk1L+9MX8m3+ockPPXvN7W5wxnlmB4MCcj38s2K8yHksm9iFXj9SvTrHg2qG7wMEvPckL4D6JqBjEvsCsMXLJuxha7z6CJe8y+/NmPFtSNjBu9RZpSTiq22PixYYMRjkirR+/p3cDQ5ul5xHvpSjzJ0b6PIaAMHxNi2SU3Y8y4zqJkN4AQtozEBVKCAbAw6O0Wk7fsnEiqjuNDwcyM1pAk+ZYDkIcCnNz0L/E6iYWySKCrdLha2h9JXYWpHQ1T5j5nLYL+wUxzu4y4gKbn0OBwkLLrH5H1xTwD49R0uo82+MyTpRAGKD7EG9F6eA0X08eJOXkXNCJhZC3SbZA/+jFiHaSzCkJpkZHbXPn2qrW4XRqtpmyrfBOG7gsLYOZ8nq3sTu9UkvzNIsH2AwjsVubTnJu5TZrqBNjqi9lKvWHa5/PQdAf9QtuyFu6x9xJK4FMKoqgwfIuYrqtpyq8Zrrvy4FWC8sTwN2Mu4JhHVyfepHaP5s+EooLE6v9R2JAkdalIxm1vJiDlMJHEcTrtxckMlK+wEKYx3uQQMhuVX/eGlIm2JMbFqZ1NvpgxcAi9hL4rjrdjhMC4Ws6BRwg99O+6vqk6gvHHxtW3q+WVg3lGBK5zhp1n1BJmrpkX43DFWaUhlW47yqkiV8k8hepQDGlC2lRr6xnB9ONzbyjFEwbg0QpAVc8lIB3P+QHHkc96f0alOr4BRreI2CLq4oR0f2DHegodhDK1HIzBoj7lHhtc7nFj85Mcbdr5CciJwhvBInhyPTkja/e8zRH/0a+wPStZuiYxoLRj3kIihCusez0Bos0DUpeSiUZYJ3DqIsDt0L0nvbPuDaQbwh45AaAJ4ubm8m1Om31+q4OmBu1JXKGgroC4F4zPPWWmSwrzGuLpPRW8QxYpJShDO6H4blhRAOIhCwBSRqHG9P5OKZs7axPCoEBFntXvcR+w6bRWFaxN+DD3/XITU4TbCnuYIuJOiZrfmVdYLkMtAXnFicPvsH/1owjX9nQBGxbIWJxcPN6hZl73ywXI7B+VrISgB5OOIPt0Iy12oEw6r9vmEECoZzIv544S781Om4kyDVvzYwMAe+h6/T6JTcXjBxUh6BxF64EytectQ//oj85VsYf3hPILm4gi/4X0UBcvjQBNGMv7TcR5DQ2ZNe6Mhz+f6oiKG6+ig7NN/TofC/wsSt+eeLFJAJEg0gELRCo3Xn+60jfGU5cLJetSH3/vphnVlv1Q+bPFtjOvO8Ua0L4CwqC6XgQD/lZgtNlYbAX1auJCi6+dkrukHeN/apVcE2ok4BVI+HI1jWRyBexWhHlN7lbCujKWdoewvkM+vWso8GmYiPiesdBkHd5Kpg9iQDslYZbQz3Er9jLBuD6M5GLDMTUgrK4T8ywC/6OIROUhkbxV4+K0cnZq2+UpNbAQNxlsdYUlkQIFhudqiCcXBIezWRHQcWuYvtP3pLhwlUUKy+P2omZPP9Otar6omhCzF6EoqX6Xsb9rPvxggHmlJnot53g+4AK0qJigEoJQqKlnpcNrT3fYkU1MvxOA+hWguKTcDLtWYs92CH2nRV2VX02Kih5HSo/ZxJcIJhB+x41OWgXmsgOVETUjwMr+7vRA5phCDcvSG3cap0/GwdtMBDTXyT1gxnBJsjt3nwXkvvW3xn1AXOYWRf4xofkrUAdGVm1joRCbehyIcXawvqsKpgXlf5j9dU8/jhK7w5IIYrAkuRpZniazOJA7h3YaQwbGG1blRtE6s33OmSYSdO8KLXhYb1f//a8cD93e9I6AANndYCaPkpzS/CzAR1Cp7WQKK2QVbMmLbxgPSIotXI4WDKoQyoOL1zg5EW14stUXFTu1999fHOKaa8uX4oYwFUyeBktNXp3C5q05KuuTHLZhFU8DK1tJYUOsWfnZBso5jYSpjt8CVRFJNLdF7p9gxvd+E4a6Eb0o5hyLYX6dbqJ9T7OW7dVUX7NlBWgW4Qh7CNtpR189XjNtmv8aBFxTEYhnGesH5TIbZzWzptJCVRw8NXcTHn5zZgIaxDMCkSlkLt2gwIoJph66GmX36PYvEn6LeoVrX4OBxzSK+2nZoN32I9ZEqO2mxgFh9L79fxWNVAK2hSRHVKg+BqIUnUUlXeGmZK5LpKPKqDnWJ3pd5yEENTGnMF5qQp4Sq0I8w01WgWA1/lkrV+KNWQlLx0QEY6Sl+iDDBFxEqJhqy2rP+Kl5dcmA0stu8Y3qQU55NQlWQo0poszkOF5voK5LFfKxdAm3veT3mLMl0y2pQcj8JwqXkWUCP0DrKlvl0+W/Bw62vfQDKdO/OOK9oPvYPuLqZOV+rsu9vgr1/kj2GUq23IwG/RaOKyNCs4EnxiECbHu93fRGrskUDy4W/g48M40EE/D6BbqZGwFP5fk4cPvs1Fika1lJqTgrU171Q6/lBWud93XmeFA6mi7TuAWkfNtBBUMCRSZnIT4NZ7hJlKSMGT/eTaYvOqMoHU8jyy7Bn+wLNOlRnZzoaLWiEdYH3NLLTHR1wytp8NlTvkk+9AA3mZZs/7r/OlR1G0NePXs7exYEqBeu+A6AHxAmF71rvQfwLCffI039bMbFLkrgEGrgbHx3jrfS6gYuMQVf+su7AWRiaIvJCmDBP0mUX65AWqpQOB+ZYhyNl0R6PttlfQbLNaPf6pAN/AX9DxxRHzcqTgWE8GRPbxcZMbP7W9B4dQ50R8KAAXc2soSiX56/pJ8z3o2pg/yYmImxtvvY8Ayir1x+Riyh6lhMhVRFLpID9J7az2gpJuDD7charwTM7lmromKTkGdbsfCiyZhjnFwMn2ZoRXrCw24rZkRzSoVnY0HSn8+UI1vaf/URWIBva1T7Mth8Lj/u24KZpOb2i2cGqeKF7ci2GAxVpSUocOKA/Cb90cxtvV+pAyggVsmfxAqE1nE3V9xhTi1jHssX+k0AxwxcDrGsjht2oP1nk0z0RXpbCZj9Cp1VPP4rzZ6JOqKoI++KmVgystU+ZBVXC9gsZD6Rj5Sho5P8Kzka57HllMJYitWyAsyxhCFj788tRn76RjCrngEc2fu1sxPvtp6+2l2d2i5Q8EWnk5fNFetsNNENvYc17cMSSPo/93Q/K+VJC+USjzXJWl75lrMY3QxpaUtPyE+BTFxSinJHORKAuj0VSlb9pFx+uSOwsTU27ctHTqPbtzzO5ecdZnzICuLR0M9Rrt2nN/JC6Gac9+C4xM9c0ifP10W0DHmvtMQSgcRKaxf/PxNqp8HfEN8rE/guRw97/Pkr2I+fIQz8Vj70A2o8V9nKEcYAsAJ8oDwJplVfCa5mySYlWzFScw9HLHwNi66DbBYCZq0iV6aZzlr5rjwGf3xUkv80oXFNsZzT/fHdXtKrmMdiXscDLOfYyRRoIbjV9gJbyAMnAcVz5V1k4a//7tnwW3OdvIoSd/4G+cblT7GFcVZPAqtp1qroSD07m+5jIPZ4bazDS4U3yVpp/tgIhngMddUO1zPzccIBsYhwF0D5riqLTchZNF5pmQqZPg1cs0R4LPEABH4ru9C7UJAZ2bBwT3OavbYKXjHCusYZjZtUEUPsiccgfit3uK8qnFoe5oUv9+W4Dnzo8wIgs//HWB01abXbEEkcPxLjUfc6yQ1dlJ6QdnVdxFru0JnNJ7NQqp/WpBFh9W42fo7QequwX5fyWZ7sO/B1lChcECehwl/ZiX+r/5BazRvzIJBs+5/dfO4NvOKaF5HRPHHD4rFrivzKw/nbNdaA+eAv0RI3UTKgw5mBCRQyaae8MCGZdUNW5A1+Sb5ojQ4XpUzlypCjCaOzBbgoPyYlaNUHPhQuBLMeJt+8nj6ve3v98g7RJGCbwyJB57jYlFn0tMCNWElyt7fvzoksIEKGcJPwWt3GoomcrxDomPVDmU4pAsFJuVcwkkLfqfozhDGSwXs9xQJV/Mb/g916VCzMnxHDMS62eA9dfaUdI9vTjFLb6M+kDt4vRMyzskQ6+sY7OsDvzgxPHHHyMj5acOY7O+739CjvjEmvj/WfNYKehEjkppedGZm2/C1OAs80iblPzv8QjcYrMhy6kcX0Z71PnfrT7k2qMIOG4wj0A7gMa2rm4RJwxixhPwu37u7l12FTJT7jZ1dyDaP6aEdsxyHeX/AOon5ccCK6p/kYE35KTzjzriszGvrM27DLThZitUUsZ+Th/r4yAK4c327pUdk2MvivFFhlCPO4Ws2B0s5pHrKerTlqwLjaks7GZnKKG3ZTDh0J4gYTJHtEKK5rHe+v0qUy5maLhYeIOlErcF4fgWWZ35/FAnHHxjrcsUtMrGKW0e3iiev3BbhVXkH7nL3sLz8CXlESMkCh04zawESvEoAdlSU/Bj77oMCNC6YkMFYJFSzEKom3vdylQULsY7nWafUd+vOFPzePjjG7r90J23mSlAfgthByh6HFTMDCryApSgxX4YbhFRV74sqJApC103cc1HYTN7bjoCawaZerQttViDHHKsWf8gZpZNeDC4oAfJig+HWm3jsQZUpQCoRbaX081MYyiTIcn/KsAwIzGBz4Zo7UZVYp0//wkT/8BYXbrfbO2/b0uP+PB5q6tSFTBNzkzb5RIxumI0Xr86kyHqNZ/iSWLJQndprv3iVcB3mxiwQrhYq+or8ezoxTOPigeflZptxhnAEP4L6I6vWbuGCtj8l9CQm+kgctEH0GJZAV39Ao7d1AzQIOSXSRLgmOG/hzExigtOP3B9yrwL0CDso+rRj7guzRo5zgEbBdKmx9F7pUdFmNhxubfbVY4fUNZo1+pFVYqRX+vrlUJ1dNFi2+JZc7k851k/sLm5WPVEHmer7Zvpaz9f+NWcUdpFTdKlTbyKBl6Le3I8C4oO6WlBCqL2CaU7ADLJ2i0ouZjJe+fvbM5Vt4nik6EwuFL9e8fJS9UjbAGa6I/n9x/kxtziEeMI+plNYdlL83OMaKc6kIePHz1Ex79cIh9YUAX0vt8mOT8wT/BdxFcjeS8930eL0PTbV51Ar9Gr24v0MDDpsF2V9y9/r78QXn/92ZY599e6bo20+VfVoGvgcWJ0Fec1PZ2dt1XIULw/PjHMmRH//CFG6N6eXniMpS63YvHw1ynzl2OH8bEQu0IqjioI9DxnxwD6nDqibK9KSX/QSJQXCBepu6iIzvhOTdsptNVVwStmOuXY7bra7qOsNf3P7RK/n/bYYUK6HPcyZn6w94B94713CZF/LSDQ2XknvbQStuK97fy05aLyvRrprnIQsZcTk9Bh+3NRlbH5yDOsZnH87nSb1fiGM75SRxAEcxskqSyGR4GBKUqyXInZnau++5tWGnn4npAvqLnvoK/qOhDa06BXHCPVtUeB/Wyfx+KOOrNjAuYC8KWgryI3+43pUGDNMPSOmJ9feup8U9cE2OceTxMbFspajsF9JHJJ3BOPLA93zu4F96mfqPvFkJdYjdMKhL+eo28jeXrWOLl0FkMjFgBvGs4vqzfoR7sRsPLR3BATG4lMfq0eaVqQyb+hvBJ8hx1Z9YZbPKUzRpiAc+k+EiKQD0xpMOk9gaGxPgxxoaLku1i2/4E4Od8SCrXlIXtASePbBSD2Z3yzKflL4Xu2pjrRq4LZPsAXhfjTcMhAIoW0ez39tiw+HkdMkixJ3xaeZ6eRdiAOA12FFwImlXwcPezPmjVKQZgyeu6/vjyWEy4Um5EmLyhtW8dhIYOeibhTUcXWlSnGNm4NdAlJiFU8kSM2YJ1SNiQnw1GhQDRte94xlp+W4m3JFzto2aOJ8+J+3Ekt5rreX3910UnKrvkcekLo9TS1Zrtc4FTiCTHGA/Kgu3E/HJdHsyL/a6E6Jg774VjDIabZlcICd7qoVSBeoNxJ1NdWak41sEDQ06+mCMnWg5k53VSnwmj3rGyBSgR2TN3tvtTdhYc9VFaGT+RjkorlH14R3LhBBAAAurBWtiNTRHzXy/SQbi2hDLPDrXBecDsHw89soKz/DXeW1MJsjw5n9rFG95qhKg+ZgMbO3axmGI1ovxABJB6RRroeywWjRXFZwQHYtaJrieaGZ0f5mrxb+F9QYCaEZMJeIfGHV1PgUIWqrisbUQ8KrIzl45XnNq9zYXRxtnDhEHhFdPOl0KUOq1SHzdrH9TXeTCu1Xa78Dh2Iz3Xkg0Jpg3j8880YTmuSID3YGm0f6zt1tqrQFJID1evhw3MQzsO/72ZJYXGXTebEzvBG/fsIa6jiu7eSFya3pTkptPo3AkrPSK/oSsn+zBRzIzkE8NrsKQw/nJZyHJppttGQ+M0Zcqxn3STCnimEssE61pPoZ4UV9Td5w7mHSI086UdO5SuU+px/TNsWI9S4kqdCJaS5mg10vF2fBw8Fz7kj67NGesV39HOKA2n8lVMQOB/EkCI5U85ed0lHqa7wRaLNqfWBoPFLuz50Db+9gpg4OOegRdci0dVpvokW5UAQ3p9i6b7kvDmEsPOcC6IquaresvJYQcGRsPFa1x6PcQDZtFyA0SylPJOrhKs0jZ9c0QGSPtiX3CZ+tYOsby6mZUqOeew8xF6sLcQ91mzKFiRe6i+/WMft437rK/cUaDgglv/nytAj8dgsIqsb3b/DO//9c+BZQ1zr+gfmIBo/1vImqJLRB6TJJPfVR7a6fl5F31589W5xeaNOL8VW37RQrKnKoL7X5guEeqWmucK+nrrJ/PCVO7FQmny41i5UGSwENHtIBA1V7KEj1zhJ0Hpy7gG7fF1crZP7E1OdLL1ctYvC0qeSnwRx1TEWtGhlsVoUdh2vKDAK1vt/TVp9QLzD3E1oToeuT+KTsbey/IawdX0b5VPJ8zCSHfxnhdGwtHTXkZ0euiunae+NPoq3CxC8rqWl7z7YM83zrLpDx1Ct74LK073KckjkfDJ1Kf6/9jCMKAxoVITxLvM6aDugyKJeCzRClUB6wsoNHmG8bhJq0JBFP5HK08BKynS7ve3jz2dDWTHPxxp0n2jEJrwkTXPoRe3xNYn242oXUeBVmUZ3XVasT2psWR6ry5OcSc6p9ERO49Ev+3gtOrQvcJ7CeW2eqclgYqmDHPUHnEapKe/gy6iugcTCaLuVhCyLDY/k8ogt3eiQ1fnCwrf/lhjCte53NptKskQaNhipx98TWfczSxzyRswGplFz+5Cc6tPvn5GZPSnPU9M+aQDLwV4ROOKLnyffJ9KxgU/diwmJeMK2KKMSEi0meDyeq2/1vt4adef/REN0PFRlUOcKC1IXdL0pu088Z+CZ/f0ZifwCWec8qSPp6+sTi+u1QAJD4jfPRO8tuVmOALQOgtb/Pr/PMFnSWpZKosC25GW0Xy/REjWqY2FfQ3rTsvK/weEKQOuki25LwidaF+B0oJMT3QkIKlHk2tQFWculC7qI3yz6tC1k5nHslNzXrptByL/Fh/fVNIa0mU4qcpLuaThRHNSdC1dLHgJy6b/qwFvLKSa4NbJFT2VYSRWCuZxArS8u4olu3teQmQcQatcfHucIbsUJ/TEEPfqpJlu5riLR5Ph88+AiBIl8DsB1sTIOXdRvhc3JazEuyWgrFhxlWcknVKliE/OlZuVrnqu7uAILcI1JeyiT523TvzqYYcMz7eumwCGOFEm0CoDOV/dSzLctA37kp7ZsMUSW1MtLXiupWh2Djl2+YGqi3lzhYpoAMUIzxlyxJi91cwBLJV2CymIlntqLXqXytnD4uuWMKrTeLoLABk4SEP7D3UdzHTMcVZrB1VkZvNjWcSqrqGwUCHQ9e+DB3obOCGkP4jPqLIpkVtzm35lFj1gATGvxfVrD4eoM0s9CLFE8mQIKCe2TpVCsCYXUX3fXncsf2EhrK5JdQlkGApxd1V3kD/IrrrvsE8LEKVhbfmsq2czxUNuT+6ZmxqezsTBYW+8hsja1QdY5By+t5ewhGY+p3ZGxPYzrRuDee5IdccJR+y+V23ZmPmBrErQyH120JUPAyRhKEp90EyXZ+pbz4c4lVPawid8ZRgQyymJomWcb32DcP56Spju8ckHtV5VHLJSnRNXzWkUw9guh+/b2FO4M5LDtrRltK7wVk2a5I2kNR47oV8phpMAqG8aHDLt9UjF5RhHQEfZtZYLC4M+tHBnQZUXySbVPvr3k0ErsaB+rClsuxL672gi4gXQbdLRa380E8vPIE+ItPlhoM4ig/l3kWpk0eFzA42EXgrAbPRfS9FDpN0QH4VoVgHYwCqAlS1Nt/Fd8f8nLs5frX+uDsr45T3+MkiInp4J09CjnJX9MMHp1tTJIE+uPmN01mGZxmByD+7S5x46krX6/PwZkvj4SAwFNgOhnd/4zInumyaTcow1jkolqpgElAmoRdSPb53hd0BUTuV7hIrxGzPPH5CfD/RD8Mj8YyelGcFVye4hkwXk1I+3dSnwDwwssCroOUOmabURDmzYyrJWwFTtpLDp45ywJhTiVPeeHAKxR3fKpMfw/5GalehZ6tV04W8S/ShQPuDvn1S3bqqhMcpn2ZNXFw2y1GwrHOaQRECKhXK8E05XL4szn9NBedMOYI3wGXphFbXWJ3ImPF7sCduYOiAahDzc9q5kcxxgr3ZUNN9LnvYVVWstq/Jsog/ciGhgqKAcnuTUYaQsJrYGI3O7qQ41uCuA+ZL/owjG0lUfYUibbPrimsJNr2YYu6aWqBkGAerBTQb9XlFLODF2z385oIXzh6ypM6VAZv/SDI29q9fnFYC4OAnTzx3WSWwUm1+fFnkRL2oxeszspzfbQQCkgdO7Kn0Q5/UNWNvUycaozL+rQP2e/hRDQnM++CLqMguM0jJ3RRHB9g7eoHVC1oXkjEhXKytdZAMpfqYpbVp6ILgYEi9hgRT1Vac/RK/JWc5AJ5wu19HRUINbzEOqO02iWS358LTy5Y4Rw05TTNIeNlLDKd1O1k4gjx2tAODzhsWD2iaPxwYDkm/k3Ndxr7uJ4f4/wpC83EHZQBtxIKO9mGSQSD5h2UH+JJcZ56gPm8HQQuFq4s55N8P7v4VudH7FiPnPSWdr9NdRL7D+yHL27V2CUCdAEUNwUZopfMbIVtnOAhx2IWaLvvA0r6vPvUWAtKyOI+wCJaFfEOowFyA6Kylb/Xp1PuSs9riDSlPF1q/O+syMuvRfGdXfIcv8hwhfZuZ/8bft1nnLdhuzwrbyPjRsa2W4cndAcMChS+h2sPfQB+yNO+OFuypVBuZnIXPNmmBrFzKrnfdbuY2lXNuEFX8uryFdutXoTYyULJyrXkM9CeM0986pExLJeGoOyifYSLv4mrXPLRV7PxZUnutzqHoy9393LhlbFMhUxSkdL6wrXy8O2aPjzQhliCUgaAEGRRgXwhQTnov+qRuy3TFwDTXjO55WLGPViN20M8oOF2+9L4sqvEWEmuSCKlTOq5Jllkig26lvyLUCX9cuJwkEnGtQZsVsXmJAKRytYOi2jNhvc7QN0VOg8YmNX1aH3gVZdmErDT+rFlHH2sMv3rEQ53CA399iZc6ka4h4yfwtlOwBK4OZr/n42w190r7Xgk1CpsHlxu7o1SqNfWAQ+g7+0vONWZK4B825ZmnkbUbg8Y+C6/V5/cKVgbw/fh2e2AXkOIRhQPbZFk/aXCzx25CgUJCRUnNJnGq74bIMDrXXz+Y32gRsdydoTDBct3tpRBjj0XD6GI3948vS73hneIhOmi9xkqDdHhONfhW6D4UJslUdiV1/weArwhOiykLMP4m3zr/c0H3lZ/CsO2AMxC0PpmM0akeloRR0EbwACDQonIglQErKQcnAHq8x9CDgtLBbGdhbzbKsZY8ivyo0s+v3Hiy6ngNXL+DEMDPTdF+bFkqUjl6USUvvJ+hyY53vJttjpRbn02qETaUDiLsYmP0AilCyeB5eh+dbFT8t8o2wF6LHQ3E5RYtvicPmPGQ6ErQIn36Ja5l+5ZK7PlcsgQszDzManzwVQH97Bf2I2YPnFOWySvWMOXSXURPTTfByHPKDlbDBoF3YuojFmqJCAaXCcGAD8UWGSCDZ//EF/3Ef4ktY3/+Uf/65f9GPS0/IXA6Ok4Pqg7td8rfd/dIiTsH9yzApzUXKHMgDL824QD/SE4VsYhjjvqFucvClM5slNQ6kcqIvAs0utDH7z8F6XtuB3W4AVEGaY5XHNqMrAWja+Oqs78mkhMz1L/FjRYbNBrBlEkbCfne3uyxIt0f1cr4pIj8KgYfimsQ/JN5acSu0qPwUPxgg/IKF82OWjYOVO7/3bT81ZDWkZwKeklw4iiVq2fbP6NtFnpMTrk5ejZT3Z0RZXTiTku+UUMEeg1uEp77vitFxCr+dJXbV0JqjcSAAXFcejAHbcbd4S5AA5pcwOJQEZAbJVBFkG4FgjbEjtmiYUbQAL0AAKGCTObOALSgIMlwj2eJ230MWw4pyLyOnD8q1ghy1YsgQ84nbYnohf2BRn9foswAlgSRf3wjn+wlxYyxulWZzJsg/ULscz7Vs/mhMRcSZfOqgz2wFnDmrEdEu5o/XRWYDO2x0njudimXOdk/y7guej/OPcVD5Re1X+kbe5R+c4kubrZAwZirUzroOXVyov8gJnZAGlbwu4qKsF8GNhwL7Yc+1GIEmg/lUUQJR4mBQLKK5pWVB3Nn7mLJQ3doda66Bs6ksqR0225Tfe1ncQ3ycl2swPgs+3sj2mZIcEzuIB8R3gB1CZScpjUxCzt1sfk7u67h8o8QOJD/EkMiyZOy8lV7UVs4QhIixt65dZS1/zkY16AX0gr/fcT2V7dGNg47yl7Ss9GPjvWaKiEIrL8TpudU3Y3KOTsc9tvWQOoQUFJe8PMgW0pcXYeqMQWfaQL7eIxPGTCOqBdQWxl6SGJRtJuJiBOSiCmYtk9hvShtrGwY/XFURfShcYn6BJ0mQo4p/qUAAWJaAnqb29YSVYX8zJJQFrr/SAACu1HNlIcuMgXySlfJjObwrR+3KiH+WAibMpqK2OOLJHbBHw+DhrE0fxrlkd2t7kDCBqfVW7acNn2HpqYKAE+LMNBASh7MqOJyfr4SNG3TDBjIXonmnHSeAzXGiXEd4P39kHtDmYHfCcanQZoYbUcdkAyAqSJRq354m5HD4nd3v+WyYdqD+6/0GCf1eeEjkNvcrZI9s4IrB0ISGYjR6DcLuGiO4s2ihyWbkfj/OJo7L/QAf4P9ayE4VUGD1auM+OHz1/G+tNrwMDWoxAUcFTNq7Ma9vXTDP7Qe2Zsh82dBP0rfrp3eVRzcUYUx1fzBdvh42Npjci/cDcaR9PUMctH4UUDykAgESZAZC1TRn0puG1srTTfPJms5XKVfnio8LbU+oEVrur4Z0A1ohEsz5IHaNCb6mYcE8aLXv3cTfvImatT4VWjicA6Qybu7bylt7hxDahEDC+/2VhYiSFJnw5KvskaXt5cYshWOyrJ7o1ArQlQecQfVWW6xRTS+d0jBCq7QN2LwPJDmO3EGnPpaQCxMCvKGSFoYg90b/m1NJH8Ri/HNURegqDiNRUQoOLVPkDq6ZJgWKo2fQDy3Veo2szPDtZ77yuco4KuqbhEJuIvipN+/IjZDDHxanQLERicQH4ZO8b33h4B3LMiw//ga/6BawX4vTZu001SuYA0TGR2Z9Ep8h6juxVh6ObjjrRmLDTd9JY6SPtjxCeOazk3IPPtI6+62TiS7XBXFGjInLD2CQb7ngkLMVcGh1Yan74DtMRmHbLJF6L35QlAeJtTZu/e9upIXNY3vgk8PHWJCVBKWBmH0ornl33Xkgfz8HNs5IHRlR4hW7NJXKeiWBELBqXcyqU91DPjWseBzg1T5K4gZzdqLTCxiWTsqjtfvSz4pp+SCo0da+72j5Hx7QYtTindfiLDl7acHVyURjgv0B5Gs3F4YUmGBwXThGzczoLaCg3Ji+xh7nfLClhHShk8V+4o48op9Mlb2firy44xuksGP7AtMyLjxJDK9BuCg8CtNww4Cn1a3z6XVJQzQi+MGe2WIu2hCGuZpr676i8PdLpZfYmyVc/EDUL/jQS/EP8KkC4Li/0ZOKoGqIuq/fXmwNbXCKt7wU1UfEZRlYWV0eNnWPVMMqbfJ4uu27EvGr6aTdYyDArsBTOUH5GeYYsG/lwOEe3LuHXKN/JtG0eRFJPhCK+411LC55rpjjYDKBZW1REbwWqP/knSNZFQf75Hgi+ng5YL1K5vnhu65JNw8C8NIUjkfZa1VoABB/doHK4SaLSHMNnjNwFqKsAzNiwFiCm8l2Qg4crNGYTer0IzlSaBs5K+7e+d2FKWchQSxsLT9RycJASIvvZ1hMUrJ0rJ2ppCgurvkwmSDvo5HimThyRYUbb3qYyV0a0MsgTLSZTQBlo9P3ZYVAiunZ4bkHtioTq7zBgYt5f+pk8HWUXvn7vOMMDsxDYjxyNYYdGMpRU6gc2sWSjlQ46bLQa0sgrhGxjtuH1mFQY3jlkwdsaZGgNfyMnuMv8En/eClZi6hi4A0hPkOANXR8/KCB2MX1eoBhDfjvz71V6gMcRIpiVq1FaEd4XIkqVL/OlQ0BcLudkiS4njGQ52Ov5gsoziyGfTcLyvxs+MZwCuk8NanUj39yESbmfS/P4hi831zT++OLhWRyhm3EOjV1+0tuQ3P5C3cmy94flLNm6OAcnYNfXRcBZ5YPbHySniB7IqbgtTtvVi72Csok8sX/FnKbpCcp3IhGVJsAMu7GpG+A3jhHCJg9QoDFpblnxd7wXIJaNzCT3N1lmalxydUpyhFJsAIsquRaPmDgNnCFGimRlDWuA48v0sqsDwhGuwJwrG1aTLHfCkdiHVBuJ7TnTKT1Cb5tPTWKCAtJNGiPiEybkXNrbnaxkD79+MjBYTPKlq2YYqBjL1By5IXlyrm2KoVcbEhU/4Ooj0XC5//QJMICgpgeOEhAmwA9118LxUD0jh0e1fYlYt+MZqwy7daOxU9L5lDztcCbBR2LGe8tJYh1qDgFHwoJunq+CMCiizR9tYELwkCEp5PLQoBOw74JejJDahDJYbeIiMbFRJBVhgL9DuhvsvcCo63yuFMwq+te0Gtyy0BwDbWxH8t0mSvgprpzqLD2bYPyY2lZoSvnlca5wkYfC5JQifM6W0tCE8CLbcofnI8CfwKEiKL9kSktkXjtCFzZCZZBISM1ECfhtjru6ELhqeAajbrlwLrTCvqn3USlDcFdRVOzDnm/7yQKPe0EUIHr6gZ9V47QdRzJ3xabkYcbzjlz/1S8f7bIW9PX+HDipCIWc35FTLPXX5aVSRF/nPRUNu46yeOMjo4UicEPxAMo7WTvDik3xfKXKKY5p27TxTpMtQM8/mzuv7fyG/8BJsmZeWg5LodfcnN1Cwzn12jonNDWupo4ibzoWOrF4zgq2AAiFEHajI5XgDed7PN47eLbtkcrGVWQ4vHoP9lk1tbsh7bWHgsY+ENjuJtNN+/fheJXi9hy6MW8IQq0QATzo2l6yV+tbvSjuT7DLHrKKa7ufzDzDbSWyqDfp5ESggZax/fb9CvgCAwjMgBybeMwDAVOqyMgWZAbUFntSSAUhp5zIjfoEBSk6NRhtZnt3xTjR32L5vz1btK3lePmwcC2iRYeIT001RbpZI4fYvgYlVAlGgfLLnjfJBx9B3Hec/RgZaoSxHDVPeHeQPJBLzx3BBy3DNo0p/J3IRlkgenTF5AeBPOX1Tx7A1Yk2g7VrME8LfND5tqPXxnGH5mGxv6rkLQjuK562HOeJzIDxHQ6tUerb6seg4ajyQ56cJcGh05tIvpCqLF1m3dUpxewZ6ufP+orr8IvnNVHiSX4srSU+dBD23F8lRYs/eCgLk2JJsLCTUoBIy/ZIX5ft9WuKJv0qGi8sCn5G0+2TYk5Mn4s0QZIEB+GEoJ08FS0rCCvwBjlo5y4W4YOZ8ZzAIp6nf3MCrkdu9oyKAdqdGONjc6vi3aqXMqCKABfNsAEpFUKDWkm1nYHUG3Qrs2oaOo6EZjZw3s5rYGibmA2BPEPzjZZMZWtjUEZ2tu/J1ihj+iXFNZE5+6XlcDl8B0EaC3SPpib3I51yrJKG/MaoU1gMZAIyYMhbPX54DxwZt+JXZXzhXqN942G+MU5jxulLVbqzzSjw/tdZzex2kQNR6ZrEcBqBQfhUGp4/zdL+XMjqsStgsq1mpSC/xvDm929eG3XfxhIYNJzISeZNjZfG212V9/0BNzeKlSQe2FFnopqposeAx2dvPC2CY3BTPy8RPrHMAK72aTqNOhbNLEA3RjRe7oBxhp0mbIEaod1s2+d6Uzd+8xPAcMWgfOHa7h14Pq7RgsEu3ViOQOYLbDnV+gELLCIK+NHp8ZOPP8p7hrTWgTVIw1q3+FiXfmgg/o2bot2PqLtgERFSqrX9VZLvv/ozm1p8wbsF2wZG+WKDplCsI7q68nQUO0SjfpSKu29PI5rtsnbob+PZbmOUKE9Xo4P1B8tObKfbwI6SVGvWvqC7jNgdP13Q6IrqetZVNPQ5erNMMoxVMq9ogJ/mbmb4TVMLHIeN1KXRwp0QUF4A3RNk84wn7L/EvUZBMulan0IYRk5oC2QSxkeeMCth4lEI2PVWMHpJzZmVNHI4uJB8EvlLKViJFqt156QPmS6lygTsm90JMExgEzBBj48TBZNnORQPVf4NYaKJEc/AXphCXxt7BCpU4H3FM162jXXd+YI1cy8OQRS6gV/YMg6Ndcqga1MCqNfpTQ2GSS7zu7aLky64ZW12S4zuauH3try5R6sS4at9K02W38e7E0eNaBmkqvRfPfAi8YDiM0BBiXTTyHvYTesWDLnPOfKfyeBrdCZsOqAAFg8QPQ4iBe0XdzRAZSrgTLvQohXi/wiJhoF6gBjw4yOsfBnYoeCy7s+XWk06w+HtLsd35ACV2ECFFME4Ei2dnS/UlesFiknCQcQoNNi7TLX2z0O6Vpn6+TP4qAtP5hLLYhd6fkYe2ZEXDxON3/soIBr79ziIp/6pHMv44mbBadZhPw8RX/YegODASnW4m4avkUadRJwfnOECB8cGG/VNaOz0+CTVLNF8DYMZD0KoDjz3KAhDPSsNCJfR3ZvVcRpm/8S3bb+oB1eqAzEW3M/+d2bbG1qfSYDjTYgSul36SwpumIBy/r45Vl62VQlPUci8PhDHLstRvShLwkBgAa0MQ5Lm3ITp1/j+v/WsvccEsIpBQiLnmkRLNNUI9W+y+h3W0fczHwPEHoStD6Spf9xadBlPErn6Bbi9F612LGaRlyLOl6jD4/SvmoPS2qTrktixK+POraPDoFmCMxEmY+tkkBF5livLXcAMEYZ0n7V/ZEz+qZ6aOMTBi35PiU8zpvzqLsJK1tCyM+6rlW8quzNSEYFRTqLjDMDEsQJEkYBIK7ehj3GAg796BX8IiBXYL8xdU2RF06Ta0II19ZxYBwK8/dO5JUAWfx7Ps9D7Jvm4TMjWUYwORr2Fts8fjUmvsvGx6papdtKbDg+IceWB0tJbzjR+tzKyqTYll/PZeOW7xMO1obY0hDQkdL5cc4Awjt+LKiVelELMI1FbWhWC7hHu3CuCuTZYGQfqEFlf2rT0/GDRQz1Bn9N5Gl1cBmVXMqhzhV4RFfvrfchYayVtQneV4L4bJCqngHL8686lcb9309/1wTK0w9z+z5rqgPGJetlgUcTg1CWFTIYs7Ow9TO6zE2sw9lEGcEeiwIBfsJHBgKTfvN/DFP/zyadUJsAwDJokzjSuyYeDmWFRl/+2fLimndTvL4txFgJJCVmebVIdqfy0i9LzrIbjRKGCRgoqouupwtUBFtX5dgsOkbWunkupLHh4TVDR89wGM/RooQ+5ozGUDJ+GNtD94Dhf4Let8hQpkx2SwSYClGC1i344NZUyO6NzwKjz1VmoAbqjBtM54VcnqE/mDwzzv/12rHIBE7to/NQAjoy14oVazYYy0QEnpBv1OkDd6/yjf+vxWMV5DMcc9GG7IBNlZzCvQFfonByRTiSEUsyj+3xUUEBck+p52f2mI6atwrU3WP3p5KbfqiVp3yxkGw4h8ZvTnSN6W8DD9yL+AJuDPM19TDu6RAB5QKVHkN/uTR7usSVxqhe8vyoz94Y4PF8VYOwtZeaOiBTl+sCtCfORMbTJQRVANTR/KvYg1aq0v8RKPd8Z46QD3zFxvERhg+5TeaHaL8fsArDsjl8IztHMQBpMAJbetTAW/jy0N+W7Vn7VmsUsurR+pvjM8k6Io1h7tAGMGacG5ziiKNA5pykCeUbiBTMT12FOiEHg4lx7hFyBP3GmHXHVQH303nY1CpVlrAX/o653KGaPhbFiVbLOY9YsWjxwaLLLNE56Df4RJk+j/CCFaLKN4opyt4NvCQPgV+I8+w3Cf8JZlk85vah0EzRQJm5lFl8X9pqzjM+VtJJ6ktk+L1My9B2ljKy9vcUCajCwE1zjUJ2tc+hx8UWW/v3DJ5Xzl37mC3T0nzL6rYc29w4XRFjvhFfLnf3V3zWvbkGnZeuYVX1UfcR40TUnVQ5O4pDarVXWkgjPHI3xiF2+1n6m6EALcGjfeoFC81mteIL2MmUU5W4n+L6+cNrJvTm3JPLC7p7Z3Sij7aZVD25L0hISmHcmB6mBl4p8TwuW7S5OWabQjSkdqREAJyg2JS32dq7r6Swue+aAGgRivqCCnnnrUEDzYzLKxiicz9WEzheET6MRxppP6RLUsAHexLM4mF+qU1SBoatgR+2VqIDIvlGqyY8ko3arJ6b/+569sWVKlBfMa/55NwGgwc8ROFF44N87P0hCkmAkmvHXZjZJtilwVYshNvCg088N+yyHUvcrvN1XGGxWHzZaMfXlxuxPQSglWJyPMp304h/qxlSNLg/FN4lwtpeVMLTYUap/MP1Bd1fllnzDCQk5e/H2v4HsTyn2UZlmcHoH9umnvzztx8IWG2MmDHjbLl3nx2HckmiDFTwt3FGDbD0EkN/MQFrmmtCAye7ABmN7ye85bdJmdqDqVHija7ZPb6Dsq/4h/eRDpFJaN1AxxajnCwgEXFiHiurANmVZnl5X6W3WXj/QoUqi5C3opcvb6m5mqRDrnG17klnBkqYmlPqV5tsMQ26RISJdarvwcEaCPghFdHQLfMaoMpiSPyrDmZtdJAwPySiQkRJdyKYJ6DxcHt1nNWKUU1XmjPWE6xI+6sdl01xh/JAdbpXQ6sTXvOvCmEY0ZyFiC4Id+aXX3/b1HzYoQPgHrLmE0KZMiVBccMeZbk5bzjcYDQBD1YjKhFoLEfDBwzc1KIqu89pR3CcurQGbP42pS1LW2lHrsnqtj2vZZLYh4aGkCBCs/w9lMB7tMbmIpQrXE6Ynxv0jz+aVmIYTi5uAohAnRDpsbaFb5wrNZ3ffwp6WuglA5coqxAo06v5WJ9cvPufO6U+G7U5ZMqX/648cFuZ4i5JEvX6MRvHpljptEgQ0Z5Uqcz2qrGzUcKzUblyMQdcQbcH2T3I9AJR0oC8MhccgPjz4AbVfleO3YsZUIs9LIl/QLOpss3pKyYF9XBUHhDPBU0sZSzBZwPM5JJDyY3BbgJl+XhABkyFceUYTY0zlyCXOYcrz0W7tzuJNwxHTmbsPRkSwTcZNHfp+1zHy00QN39MMflOM3i0ggu2Y2zdrSwQuxzVSGhgexYenSUL4C1hvQ98/tkdDfyqZ03YEl9g+F8hGWWW6VBXyL4e1lBqZDXuyAyX9GxT6ojDwGxRiDs1ey6ebhSnD0eEyRFFyLjoWYGq9jAF3bS6GZbMByMHsZFcV0WhAifzs08Idyiq8bP+ZLziCKSDuYqgPZlh134SDdMLcCBqPYFeyEiJGYACU6hFsUQVQqiHpG9Cs7ETUsL4ie5rMb17p4SHcF6rdKXMAcv07ZgAThbwkGzre/ott70E3noDMcKsanM7WdwKL85Fn5HBucA1TvdOb/IouObALyubqgJnPkT8DRvyS/MkNh+ScdntCj90g623Q16Ey/fm5BpaDui4A53m/yarcxawMBRKjJGUaYuHBfzJV965GsXPb1LzpiItcsT2g6yok8LOAGbgkn7T60pY7YUSfYLb/agSuknKjiiyamHgJXdkzLhxFCLGPUZpH87HZzudPGn42bFFfSODkExJaOhYv1FzaIn0D3/SwwZAnjuBLMlyXuOqvqiexrKzx7OtgrZ6DM5Yxr+TdESBGx1Bri7Ujvz5w0PaPBrtPAgWM+Ualy9oZdxWM2lrwA0DGesPSZ9LyZ/KHVaDYroe93chv0+aTSlVxVD2hccjjKf6X7V+1Deir5v27DlIriLJs7U0IIM/dWSfG5pChPkBBz88t+uzkpm1YBN2+zgykiBLimivaM5Fnr1/PnCiXlngByp/wkm3fyIAfaU3VRXAx5C78wEMNLlLxEqfz/ul/0Nkkb5Snz96JhI67cVqrHs1Pi6PiCdHPce4ovYsHx3I/bYzrKmP60kWoQUz1hOzrJmHzNYjf9bf4Z4CQFPDzotmGY2OJidjXNu6TJyQcuIxDB1ijFESfk350c01CumtlZczNbSFQujlopttLjMmoIZGX3ZAVN3yKfdHt5i7YgeceYA1JfTQqg0Z5Kf4/KiJ+oXagflR41vUSPGzUQoa37JFSkcdq07F3gkCLa92NcpdiW6JEdxge4bdZ1SKFOMibV4iP4AmrRqXSvWWx+lR1R4+eWde0EsladKTT0XVyQSEac0MErWuoFcT/ZopCCgx23BfBp+mcqXhlw2w5DLbGyiobflC9QfUfPJrEbPBh+S4dCgag/pGwZMz4S760UrF/MtT+btA3+R/+ZnZp1rTdac2LfZUkfZPuHZ7NejPNvwjEvB77LwdApXrwSFDywZB1C60aAUScb++1wDg2C3CaRll3c5stD3UWeoHLlczJ+SATgkk/RKIpZ9c6CEiS8N6VP/KjmmrRJcGHXQSwi2vuVxWdssGsBimt+kXaSO0AcQj1/JUpNVBL3Ni/h+D59bmNsT5YxL4MIv3n+AiWmxJnzHOdE9XNwejVuE+J24QFa8EjgTGkyoGh8ucazTxw3jIn2izVjlzHJPlDHGJSs1DHDfA0PeisG5AtHMiz9KM+ydXNT4HMZS2VAjHwJz7muPh7aCOQOU2Sax0GBfAE3k+CFmWpocKteYKwQLijghdpezHbkMHcT/LU/owf6dPrZU1csODfkerf9psKBANLu1mBzrEDLs9Y3iL7twW5RfHJMBz+AXrBrHLtOJp832ZK8XzlkhmVxtMiqGpKCOI/7k/xPVFP3jRzUTdk+aXBoS+I6CBwroRqW29sjcrYfj9xnz2RRDZEVit4sHG0ucSN8I+ZNlBjb2SPbpXqRonckjmRgCXCWiKpEeVup/W7ZIbXZ4Skq7HbeNLgRDfUrfm4/Q5mPijSPUF7uqZpbxDhZavFjL77k+RJTn5ChksUpdW9QuQ5e6Gg2f10yqrhzwVFwySvomLQiYrZagQGZzyb8pO7CaDwR3B/xJNRi3QMk6dy3vy7azrsp+uAGrHJN2+z8jjOuUKX5/FBiCmuFACtVNwN9ManyREH1qLo7O2D3tyoNp8J3EyJ6z0kFxUUoM4+Mky05nYUtF6rA0eGr8gMcFPbMzh65ymRQP+EQbkmhtRu67mEsJocKe0Sf6WdYa4BUL7621k9sWp3Rl5krlrrRlerOKeILAY75x3Ia6Rjpl9KmbKVDgM0gtdhv/uL95faV7DD9qYkVOu1Av0lc9J1ihXR6RV5Ca+vzu28BGIrkd1+6/FWPq47AI1xp/EpyDD4xFjWhS2npVo3O8Q1DuGgYL9VEf80+lGJcJLgpCUAqbO/rytMMz7lsw3XibqJDxGIX30MV3FYV5eMwJF6fkUTWRcrcxq8jKZvPxRyBKLkPHYJ3U6kUOPzHTq+1vkzhNWToWC6oj4SE1wzmAgGaDdqPzrYACn8o5XIQyQFLDOwtzRlxh2eiBsmv71CsdSqkufDb3RBKmPNKmu3VUCVKsa+s8jozSrV/XfwwATErZCKRwk5m4onoN9C4pRy8O5gHL95jdSPURj0jfRaq+OJ7yy8vIg80gZHgQVgrSoPiOPEFlYlbKIwYFQ9u8XiVTdfk82mpJt7bwN4qs7K02vkepmev+u7zRCR6/QEKL4JSMznkI+mNMmL6TQ0lTZp2itdew8DHEq9nTU8VbHTgNH9iPYIn1+FvnwvIyi8Dqo/dtmSBFfOlTVdHTn6QCRjqjDX5nuCI6Q+YSSCzq5xSzszNx4PGZhzBvN2z/E7jaPk+P6d5sob96ianRUdMIwkzC3+QXLyYmCg28Qx8H8+EQ/DcI5Tftn47G8hOeSQurxfVa+EU7wOibZ2MIQYtTn4HcxavNt9GOMHJzj7x+CZzf+Y9b2FaTlefNU51ybtlN6IyOkFIDVvLR/aw2md46fXgSJmHDnPcumPK7YauBExP9GjIgM5KAFPRJvE/dhrj3UynspvqF5GyBFB4Y9MYzLUSoR0zHXfl+N8ijNdpBtFVT2oMiQQSRPFsYnhdAB9BnzB6imZwKMFiLAVrCGPaj5g4PD5gHdfMUHHvxriP8IwIVvv6Fj4AJi0c5yIANDAYqdHLElToxi6j0BQelqndd64qKp2epoUeZgldZsQGew6DLic1KubMVZFxr3p64nASZvj1mFAUPnSS12VCncXa27LVLy0RhbQPWnZMjaf1JmFW5njCKhdCZluD22qoxq6+v97Mh8sJ+yXvXdqnBQB3ZI98e0kkl+vkN/skmw3WIiJn+6+/FdcCb5q+kGi3AmaqojZTLQhO97jWLl8QowUEF4wSfUmyfszfW3peTc3QlXOg/I6ZIFlWfwpRnxzbiUf1AW+3zK3SQ+lto0n2rrcn9sc5B0DMLkvysqs1yp1LV+zQqYnuOZg7f7EYbVA6XMmoYb0A7bbU6l6X9AY2hgSbNwgKLVK5z3xU01FQ/9YgITU1g5aVz60PT7inuoqznXlqpSbFDmP6e8qBsgcD+YsSSbGcW6SsfTJEIVNBGjXTVTnZWYf4E6raTRlygY3OIeTY8CZWB84GCcD6tbFj1V1yr8W4CEhmZf9K1rMESWUZmEz5pUVwL5BVYS3OyOTEiaZmAxhRIhsLvr8o/m+THWSCSVsPmZkeFnWGnCaBDiPy+mHaaoKf433gTqB1z273647ZB/JVL3ecrzHTNyqKQGonC5h1Yu2E94lKIM2/SL++RiVGkaeZVJovVb+HljTUFeL+PEThHBsCFcund+r/crdOnVg3cDE2tKNsM/KgLedD0PAT9uvtxZUnOxpb9xrENcgimXvO2E3i7X5CmK3iOD3ujlFbWD336uBms7REd3yb4vSP6jFrNQDtaakmHdgkyWmppFROAAH/JoRrOSahYODwFHD/tQLz+5HA1W40zwwOV9W5Jid0hY+apakKO0TPWxdrVNUUXZeL98LkZLjzH2+sQ6CtwhDiDZivY9FFLZwB7e60m6YY93/GnWCbpjq4IJvgspiOsN18Al+CaQKiu+sc4Y2sBhKYqMEqcZLjsOafM5OxOWlI224f3/PrVgARwp4Oa/GfTKKvx8Pl3QH0h66iY+dgex+kvvxSeuZFucSVuYlOpwwjZKwmMR+a26mfLBoUBKV+ryyFdRZhIJbvdq5J6FwOxJf8cB+/gNa8Ivi3etAqonpAUxGUJICkF+zt7S4Kl2ojGynmmAfiiQ1v85lB4vj/WJjoCjSBoygIJ3ryin/normoSzhMzJ+M1Ob1u4Dlx4l0KOcIybAT+eVN9ZUqwc4lmMtax8ApCQXVbHT9H+hXAZBOvH2BxA+A/ru6WijKvvTiXlYLecWH4i8sSYNtAyUsQD7lb61rcBMUvG68hVsA6MwXMoWt5nFmGEUW/t1VUVSFhz8OTW8jUB+p32NxxsXExiuYQ8++qQjLUpatc1oyPFoLPKeFzLHFNAfrYnDgYJyA+78TdzMFU2bhxGAK7awxKHNfxOGzeiesJ4xholxgdvgo5I8ANWnsLrb8RNkqTpH1NeOth2ZtxZBKPSPsE/O7P1gIki+9ZfL01bNz5dGE11mh2VhQ8T0LZAMyi1V7oON1Zec7WWf8T2NDD9BMj2lEeVBxCVo8NLnUVZzZRZw9CqpLTuyFq0mvy1TVL1Mu7c/ZAqaenXT5SnPM5Av1ZsgNrVwFZSD5wRIuq1jfe4rT0NPi4UuiHg+oxjNfBFIQftf531Wnej4Q6jMwFhgonKm2zl7j9YPfSJNSFch4cAyjOZ+zn9UZWG++1tQB1YndHADpyx8ysTwvwWeYgWTHs/GuW5GLJtUzizdZTaU5t357GNj6GhU9tic9zPrNdNdQ+z3RGB35xp7D/yPb/dZfbmONokEKvg8Z/+RIIPZi2TC6OcLkeXa6GgKt4tCEA7Y0rI6ZsyNRR4Q7ggTd+n3GFHKDpDaCmzs+ncW6jBYLYG6C1BooB1sav91pLF2MCu10stezq4ObYrv5cz7IUUVI61zt3sX40HJPqHYEOACfSlgzXgn3g7cnmff3cb59YCwmYCxfDrBk/7Wl39+3RxFiVgEEKwWmoI9lt2L7IJnjwbeuq6kXo1/D+aif4V3ejMj6gudNEUEKnzsvtBE3XXPsi2FZGlWCA+i4jMkPBf0L3ltggwtwRiAydCiT06BDk07Cg+Mokiw2jI/sH7pwq6NF18IDUVdZoCT2kDGcqIgP2GtPmPtIVxKbtDgqb3Z0ps7TB/oy4IaoFqIzRloi7aY3BXvwPbfKllWMCn8h5hzFCr5zIjDeY0o+H+Kp8WbaxbqpY1n6plIOAYJqHpSHuhvOfyEnhIHeoifUEOf2gPk6Howk7KUyVsK0XBHrFMl0BLA6XJ7OjwjGAoD+I/8WjHzxEXSAyV82C9HsM1qctTGf/DYOKRT3GVQ2giln1lNvr6iG7zKr2/N+vAJwS/VuD0vWyfJtACBhjCRTytGqVYOcN/zIvxtnn94T5mh4XTvNhaNeiK1bdwsQwunfCEz7j0ezIgOngu5+Y6fO/5BaPsOo9dNm48FrhKb/sljfkrhpgCjfQc5CdYFzQsloASFk9xB/1MkY8kcuqEXGsGb8/6gc0a3g2MJqk+XSYlyYg+cqbvO+K4/TcviXDL95KrmerZTNjfUJqv8QwmhDGtALpIdoVyBOMoicv7AXWAd9KiD0NdV2KQaxxY+HOoL05Udd71gJzxxDu+uwz1BHj313txRsVySxT+znMofwy9gYBWpr+2w/jUAsYXeHgst+j1GFFSJ1FLTtrP3uIUbcai3hFNhQtTpee8mfYLMC2PJ9gnfB75Vx2isP1pDqc70TFuqrj1YBcH5fyAhOWvRe3P6VLnDn38Bw54WlQBGz4hYRW5qMnat4gZoATSZed2G/CSxCwFJcPJ4fcghUKtCmh8kzpwMzGnjHMjflBcVNPSKV7cdo05W4CLvFnZqNZhuJ8uvia8aTxZ7o8E+HZM9T0TixCsPapR708Qdf809v1tJQSG9CPHKQ9E9dvsktWgn7JTHHRej6N1xeCB1FoVhHC/3zXsHvtXldwosKJyKM/Ni17npjRqbrj7EpIg7BjpcXFJZ7+h7JFgd9Zn89rn9uJU/qsFVNEaXF3ovQ9Wu35fEiDdE2LiljNswmdg9X7JhP6wCB9ujMTErYglO54rwLyAO/9U4CCiTE+VsAcvEFnCL4rY76TgtpV35ub2BOKk9jBp2NSVOsDSiN6T1LQGOshKL1waPa89LGtzJDntRnEaNjoakyYGpNCZ17dDME58pi7c1TL4heMlGKVM/E9k4dfy+T7i3PqUZijjTCMHNuJuuhVjHPS9OXPR6v3rLfD1PFzan7G/gbYCobfcm+2ngD/BY/oPtSQrJ6URkLnAkDZcXplwS3iceOgxObagY2fzDMR+m0lKiCm7YNE9jRxnnGtMG4pbUEJjCqjRYCHCQZ+L7PtshY8+zAPPA9W72FzxK8eaJxofTDVhvvA+kS9oUsUrRHB0c5anJU+vf6PEeJT00HZvrtvygrzjqd58hkDiCEtV7ATzNvUEKDUmB30zaJAwVVyTKuRX8yoPLIn5FRh8YUbuvCaabIm1NN+BvyLNk1B89co9O1pjFOQAiql971gv0zcsJdZLJbFUCnhhAgwnnEegTT991clsWTRutHM4puCpEVVEKUj7vI/oRxC0wpZ33Ee+RfXgkzlHrQIXpw5aNU/ye6k6VnxFQapmHSFNpsh9Cr94TwAAJAACWmh9V/iDF6tMggAruucVCh5855MJxp1ZB7b8UzpV1YX48zuySLikFDGLYGTIhOtmzsCJvVySllGBLsZTDPgHu8NeBBoRW8zLKXRps6Gws2a2OcdTn7mpzhrVf6xwVwVvpISECkcxiBAopPHhCEHtKoBbUcCUqQ9CVIGWD21lEAbxsY66JIsZ/SrkZGdr19fI1fBIY2N1CCG0RInRmiBgTpRX+Y9prjRCV/74L9RsE7tU6SWBCJmOdcctRiuqbXSpBjtkXojY8binb+LkllKW3kiSJ1Q7j9x+9nEb59d15gVKb/Ls8JOzhLUh9t+EY19ynthKt2y4k9PDFYf0iknZ870NVFLhxZgEjGrJHFY2efv9EfkRljszKtT7asZCJb5HIZbruSX5ZTURMnQl/rxFo0oWHbLcAXa4bkOXfH1g9kZXz37enx2w4BMCVQE0ZZWfhis8lBaGaoFBLd9u2U21zxHcTQvOxmWF3LTj+cz7IGNTeg6KJ941zSip4dWEO/nw5y1HQ+KT3K9TbrstIbzDyoyum2AkphFA6wOTTaWnRTmINbe01BIFhDeklLy9fsrTS6yl4TN1z/DwwhaawnfaY2l6v1z/rsx9MzLFfMOXUtLsjzb+67NfZTZNkon0Y1BOBFxLAV72fxiNsDQsq+Z+sp+WoRszRaZKZR4B7AS1J8OxaoFQflW2aL7rFGxpG3RpoNFobTX+wzwNp4Ktz/hTdcVC32etQCm8o1BLVBe8icDTCVI2Zs0uzvo6zcR1zAYN8AKjUzjznHpENZWxlD8eBV8AClZ44YIdKjF2tu0JxDcn6FYIjpijEikFTT+kltF/l/1VMZ4uNjAFecIWqQBGsvRIlyuUx04T0dAhXcKazZOp/IlaDzahFFQ8TL6mOHW65RgPcGTn7eRpS92vSS5HU/bKwSChmTxp9pfPUlbv+w3u9athG9nLOOba1C5oEf9uBceICVl4oJrtdntDtw4Ru+8m9pXfCjryJmmciAv/qgOaMQi7yVhwULjPhFMa7IwA69wvQwmQEGHbfgomjp4HXOmMK5px7Mrpy8wvsKHc6zMO3Ur5hT31VJ5Tji+PpKLYHZUQLSJFB9Hs3YP08jBPOk6bvNycTgpE/1OZDLClCln2JKpqvSIQR/cB010NP5FUEXCEpm1fT4kqLC3SrJTwZii0GUDxeOqW2660XT2iCehqzdIGS+Fl97EwVMW2RSM9+OCS0iGZOjaa8BjufRC5n+/dSSKfoCEpwQ4Cj7gAmCZyStcpIfFf3M/JA39bH/ZvMh5uceRYjgj8oBSh4w2W107wLXuUNdw3VvXX8kdE0HTuMEwGNG7qNQPNgsHl6UXxgpGLzNbOm7lHQ574QdJ4wJZ/MPWgXa9jMAcI6b+CGBvmYiTbDxf6MsydULmWfPOM/y19Gs5GhxdUW64H7r9jvuUaV8Qimq+3Vg65ClKk//3rojXzEKnbi7V/ETGTAKvckFqr3t1sCSCbaUZy3Ap9s3N5KrS+nMgxzL8+QokeKKv56CqhiZsmMq3Cn2sEl8CyM1ZqCkxwHubz1k95HQ1X63LCqK4KwXzs0QcIRDdL19/sTdwUmrVC5Jwxz3rm6vs3iilAEc1BHgAYyyiFoEq8/Q0B76hRd+nJQYsJgaC3jFygeb7/iU3A9AzlYptjEyoaOWJmsU6MicIOdmtNoaM4b64NWVJE2VIlQIDBXiS0BCLvnQneGlbYLRO1ShagdYQaMQuEarccV2xdDFF9ZTe3V7LmsmCkbqLd4NH3+5SZRSxYaU1kUziWQC7HJke9xsrIJH3HBdc4qMYjSLgOJJ4SCApHBqOU0eiq8zZFwobEPmpzErZ/15G5niPKpsYIeRqm49CCCDo2P+An6dK7vd7w62+XjGWJseu3uWfx4y8cUYjtHMR+eWbZxjgbRmbnyaJfZPV1/wrtMGpTl4AQjgoCyBA6rNflj+Z8+ikSgaOm9s+ilYMAfgDCClyj7hkAkeo5ZOzn7+PNfzKPBBTqZb+hIv2gXJSb/OpZSPZ4wrDXZiizwcJU0IFbg8cjA59Xb0s+ij8XMWhrkHF3dvHjkRtJzzgU7FFR006CdUkGvSv7aRzlxIO4WThF+E3xzAnQTGBC27fGLEUFVz/ZX9f5ld83NfDdMjQy9vns3Qgl9TLyB2ao/sL8gRHJNMNa+8EApUVHbs//30sBohNuSBysF+telVsTPvKWEV7sbpp7ttZEbo4xiVNQczmuMypKfnF1S+ycGX3kezT6aBI185jeo2hfhQoAPeIi4X1l0XsgVmUsn6+5o/Xj0BXepvh/KR8rDkBbWjNX4Mwqw7UvlEtIfRcRBQl8x91Ld/sWXYZisFyCsS83wMjSMMHULC1fe6Nl9V83U9NqUJTfZRdbGfYoC6Ymojb55sLSFEdlkAvNyWr4zDlBZEmRJZtn0CcBKeSYhBTUPbONhmFdfIpexMxya7cxIHc6+e+iSwutFS+y2BW/ajwWvS3rUJRdeLYjKPR+jv9o/5v2Y94YqBceAbcZA5ZbrSHlNtU8KzY+K0MM9Xh3Gc7FIerfHv90DA2//QLyOs+yTL6RZwd/Ku2OiXJDkd8OsWP7P1TJ2a+zXezP9854U4NTZK7GLXm0Pf0IkzXPrsMvyktxk/mdjiiPff+o5Z+9QnPicFQMCE57VNfnpRpg5LZ/i+/MfeJX7scm758PjCrpY0i98NgFBVYtMzbxJ/19YJKYwKf8NAlAryGIM7RCVK1YkedIPbrndzjd1RnF6eilEIvzFGkw843VQYfkBd5kCCtsZdfkXuul0xdCiCznS6aLFiY6+1l1VvjkKiQKwUk1AwP3SoZlzdekjM1ivkHmw86ThLk2lSejDvmfSYX8/mUXAmlDvfYVBkYo6Age+iNaHehaGhBNPw8zkbHxQ2soMVKEOO9cvCvI+ILNtWVw0aWc9nuK96ZoVvPJaJ64jM3SCCvDe5z9RyYuvMApU4I1Ee5IMj6a3SJjnlBsMWU57i9wuPxSsptIkN8G2ZlsHwz+fYQWMi4GipntTAT+dI1O0g9qJ1T/U0SFbSWDQN4Bveifl8gGCE48ZGsa7bRXXRN9aILZ/g7U2XkhbN1DtRCZdcRMGKpZXPhIWhoIXaOI3bBBKLhTacl14PHM35C3SX0eKtLUWfhWa9hPDdKKZRpQAo/RiQI+nEgdxoZ349tJvqfoPoDIPbEwe7gdlVzjX4liRtdd6johSPHj/wjsNDNMdVnMcI55pjB5BvFkshAWBcFWOSDgjVQGbkijU/0b4F/Qghct1tPqKq/E1ciaBkcTksaosWIrFCyXE5JU12G0U2d91qZSUSiLUXcSlt/rL9mrx5UxxMISA6IWQ6sc1lwI4FHXwhOH95MzMVJaUl/XUgvhJ+Qz9ZpDcB9E6czRBTh6LBoUgiSs2eAWyYXOat9XSfWjyAUzXZ6ICcnpEHCbXp+zk5iDS9OVWyWm9Sd6GJiCY489xwLnsli/yKDQHgDA0Zj2sjmEaqS8dfRJFCb4ebiL4cvFmatja4B0ydgc+o6G6iTv2dIiWkLg6SLQy7BNOB13m7FIerV3w3JDyYUAbByi1WggEQgLqcrz8elb1k07Z/0vEVa3smbLuE69L8rG7d8/VyvNWDZ2lNxLzKl9QT374g4iDq2rtm29+deE/eX+YZrL6IPXjwCi7zZU9y5pnd73WuFsj/kqlvIXOxLTnacmIPaWbnHRK70GI5pbZ49Gc16mBc9GOb8JxONWe7w3TnUasyV398x4pX4YUWO+tqFnpmuAz1+WTGno/zMRcVow//G9pdmDC7UVCaYOLruGRawwug3cqczvdUTrtLedfHh0Lg+8gipz5JCo7FwZCBJp3CAad4NSNNXe/KpqaiX/xkvw1uLAe+ZFlEWNNwDrduYUq+pz6KcB31PhresngTb18mzixx7i1feRryAnskTINVnVQh/wMUv3jVoOy+GBwzOZhbZmqj1DbzFHsWp1rcaKygGatAzPhPsrjWmz3kch8D9Buwk1oPaiVqRh95WWr03xBOU09NT4QPdUK+kRvbXrRg8d2sKFq0IJ3Rt/j1pFjdN/jD3YdwZ80ySIkWqUpdiHNW5nM/GJTG2yWeYHhh7JwGYWstdA6LxpKOHSkVgE19kr3+Dddga5BlPj6WK+oPTuz7SNueoUt0QwCneVvbh6x5lyRMCtPcf5F7rJ7sSyOXWFhl+JcnLCTcm239NnuFC9NZpN3SjbqLcX5oMDydlmHNjN23++QwNq/W8AEhq/DcecPV67LgZM7n8quiDNLmcUqoHURgsAOB4rmzzER/HO8D/a6KXM0RUw1746IZvliZnrxsYpajRF4Zie2HuJ5eNPqhT9ww2B0pp+04ALPTFBkQNCle2NZCP7VoD3AnBlt/KtzU5MnNhjRl+PtGvza/zLc/UgM74HmgvEXSYacASQCuS41oXWPtbG85SKfRoNjLg2pP76PM6pQTYoFP1+XYscxg4rtLSDcO/VPmaDI0A6/RUmqG/RJnLm/7Xl7DozFp92MEKElI5D152AixH5dImOwFSbWqV+sKzWD1+EzfcA/mK/V4X6ZWPPyucWqrXcThsIe0irDsNZ0pdmx5t6bSzJd2L6PSjl3pW2KGZRRx4DZnCnfa3qsJY6xQ6JDVF64qGP5d8YQrOzMuRx+7sQTA5lBnurK3ZCpaJ3nT8uC+VJZgiN3aYX1uSIwYHvDHkfJT0RmzcgoStDHBbzwFO6ZDE//z++Gppmi7NSt+o9Sq3MLdMdfVZ/kK02t0y+f3GtjzBuasw+2LknrJKyUS9/AqeoxGAcH1C40zcvVvgPyShBSDcRx6mZx9bdPri0q7vztWHJkthNIY9dkEkXWDHFMAy3h+yZuCLj/m3VFckm2oAyaSgQKkXjP3jvWv/tNSyvNDO6+tUJlUzmZNqnaru06wplialqpul7PoQlylqP2Ntqwu+K68eccCH+G/g+ymj83IjQk1G06SbpWXy47OvNP7o5FPk09928+TTw5XpW8tnAg8cwS7zszdwwrcatxniCQ3DOoF+9Jh6XXnTPKye8NQ/vQ/tgSDb2PAunNMa864u67ZWB16A50xn+RSTu4D7nCFi31WF6NElo+WXuRMZJaVnng8tqPvs4F4Rn9OU2iMA/2lVDgvuGGKZBkBOs9iMusnCOjeH5z0v2ND+yNAQLdoxa64Ut2FihHAS3xSP90T3GfFRMD3YXNV7kNWKM5nzDv66oCxUdjO+J88waHXoCuHM0JAqgbCxqhBqcyy5xqP76pd/tpyzjjd6dDOe01SJy+0/r4dIiTdcybKHOK7FcA+WlGxO82Pczel1055d6U1FslxM1A73tVCGd92WhzNQYJqG6g0lBH56WO11A+2sWfyLBZtJwthW8FLI0d/bLXvz9t4Le0W2N5ybzrPMSC9UYVExAqW3SmwogSTmHkThZy+JwwYj8AQBwv1U5D9AqApAUCnpfRAqL3VxpIO7D3NA+cfi69E0H2P/yXDfwOQvpSqxCr0Tchky9G9LdC/pkQd2Ktdra/9RGQcrl0vyqhyOcVSZ2R0iKjvx4NnlfdtT1EyXlImWPSLGCZ/eSAzTFa9ZTlGzKgoYTCWhL9NNJ/+qgQeNEifbwDyBA3RwjnTi/MSLXbUShE4S7sBF1UKqHsvQIfwWP3wNUYVEEooy+1+GHkG+wxgAPC2BoCLhVwwNgreLvsX75Afy95G3ktw8zuQGZ2al3yhlWWGLy3Hnpfp0szLlFONVACI9f/xWxJV587xPKcvmlzPmfukD/enzhlWiVCDesXqR9QxkPdzSt4lsRNrJQe/4RR1bmaV8eu638GAqwxgjkmDz9FJjPoTrXJoEG2ipSD6F24BRVj4nZBjCj4fe+p0Pg2FsfNouxxxFROKD7wzgYKUSaEJzAhiggmlK/yD3U2dQO9CHd5ytOwbSfiA3x/C1gzmbQCfY4eDm5qaa+JqNc+disCBaBKe3LIl+3Z0bsnN0GuUxjxq55lhRQbASmAGyU+dquoloDVRna6yWLvRzhe/Ecebv8kxq3hptUd9O+ufzJ8CAxQoixuGwNZU7mt7fVjyJPsFWlEdjhBIk59hRVR2fkuduLgs2JOjMCjDng/zs+SpM2B4lxnRHri3bwxeKzzhiovodQtFlCtDuVOvz6rIcPzRabFzStDJKzeTgCrRFivNrE0H7K9cnL5EJKQYe/4ATnjzQMc5BEWZRKGPb9FN9egFGWLOwq79pY8DiyMOkP/6nROKJvsIllYB+ojY/VfcHrOmNAn1oILUJxx4lDYhPMiPiqj5Zcjm6w7ZuRi3eln0i4wrYupNeto6iT+7VpkZeDZK6X5F/lDGEjE6URZGnRiE42GcNZ+vk2DLuTlhS7uOhdNrTiA+NKuxNjD7t8HmkqpWQBkhNxI8cZRwNNqdQfyZfdp5Z9rfi5ifTaMHZtV2G2sacBdreIM4RkqWfZ+Qqx/dXCRwusvi/D40v9+nKh7W7z4ue9EgF0PSuZu37It59q6t4F7dJ8Mu61XtYW57yvbPIz8DNrlfNWAzp6o57eQ0i6GR9Nxd/e54eMnZf6RxZRmGGIzcZxJ81Q9eCttVQSECWuKV/4pHz0DnYQ1Rg8Fu4fSWhD+CK6+mIt9kP+Xb6fFsHKZmu3/9n3AADLvchMurmQV8J+I/+rLePl3qbTy6MmyATd7j/ghnptfO7pd0Zg+t07AKNEbNMr8FylSVU+4OcbTJd/srBZmrQDPDaQFe/uz+VYlB2zIlibS5+1dEXK91iQCYbF1yRwBF8XxwWKuRFlZZahftv3dT5Q2L4CeSF81ph3pGkbZH28Q13lX2CmSlUR4tf8VzTK4ufejhjfnNxWDzC81Sti+cbIzYifsJzPZtDqgHsWZo59CmUUKDfURkZywBT4wJVx3YqjBzHZiVIw08gUGknqKGAmoFmPKf/9YLDRQuS4EwvdhmGKpqQzJ/Kui1/J9kpxO40qCsnr2v4+wg1ID2o62wqcIa+Io6m0pDTT8U0itlHAG3yg0HNFyHlpaJweFoJogkdoujXpas63j9zYsz/qbOAEVcTTJYEBDMOwNK6HFqWghCBZymsmtS658lerYVZnvgmc3drcjWEBcFm0sPEcjngENKCLe8/F+eYxF6WIrCNe8uoQF4kuPfPUxAjP2alD7bgzckwa20fUZuvu/G99H6SEZ/njCX3eNiRjWf6CwLZ72CIHbFLoAg79+mEcBmodWDjrkIwfGwQducnQD5rmiFzVNrzNfgNYGn+7SOfF1HzyfFJ7ev8YE53/juoYmH0yydGmK/YCVED5qcOBmgX7aQ5Nc6lcC2hlDzjkx4X2NQwuQawa1/6VcDoBHp/ULyBT5Cw4ria1Bzc2P7jy4g9p5xfIxaLaCDYgFBuslD+k28ySAJj9f6+i6g+uFSgoa/Ex3aHkYmT2iyJkzPvvNS0IqlxTc3aMzpOvTUIzw0kV6GR9Nkh4ZANg12/bvj4O0psg/2mcSLCEfllvnnGn2LYx3A/wepJB1SZpCYIBfMIoKDBmItaD8yQ/DIVhEQZkBC6f76E0B/atOfPT4M/B3r0S1sjJgdi/ZondC9b853+6OabvoLWelM/+JnJ1u64Gelf4tUfPIQN6xsxjZcQ2dI+wxdqyT304xZAFOGZ1175I39+yPa115p/05qIbZRLUWKf5hch/iDJCrsDH0gljbpXoHqGETK+w6mDNRSI3+0BNtZDYNNlfdsIdyXjNUS26B780utbOs5hTXCWO4dt3DbOyGilgRl9q9uoJyI66dyb63jljzy6rjurr+/oD3cXumYYjUwCHLqIz2pGZ/xLHFw3n5V3RK2dM40MnkYxivi0Zf/RDPiUyP/gUTG/dP9VWER88ETiMTyBuh6GMyfUDbDSim82LmRh33f/oQskYImQNaS+AuoJKQs5twE0xpC7xDsdgeE4S22fiojjej75ExFxf9JUqoF3tj8yL/tlCOaY1wEZYQ8ITE+nuyP2NOmYUzv0OmdBUoc2mm7mWFtFORG8qBB1cU8Vfrh576R4SwIULWZVf0B45+be6+Ezpn2/ZBX2fwM3X3Mhtl6jyjUcfj08Nnvc62J4JV+ws2u6CYjvcbYG4tTwTL32LWSBTa6zK6gAVnqZY/jdhAjEudSEMToXtxQCN8Joi48G4qbwv/sx4XGGGDyMisEw4bf5hGEBsDn+kqEBv9UTSiQtOxxHcwfvkY30RNIVJVfr7pGQBW04MAFV05+xxJ7XaXwI1xoiyJ7MnRKGBCUNkLx6vH6jCSWns7fQG0pbi9HnarqXl5jEg9qz9ysEY+R1zmHIPukDdk6EtvALTk9Hv45Q1AeBlFX9Yjoo7hN/wva1hp3yzJgoA5JgdV0RgvE1vWH0eyXnVNPuZHV+Zfj1U1Ja0/snYwhT7TIikMnB76VzdGg4NuThIWChzO5+vH1bjfJR9KX8UYFqpy2tZsM+B0C7ugvSAYRHYLi0KRTDjDcEGlnkEWprxjvzvzgWloDNqGeTyXLeGNJgc8ZfPalSQSwQkyoOdFtC2colSv+sA/43WqZYK6/QYqaFOFLn1cTDzynIkkkSplV1CibntDP5b5RQW2vKvissMORX2XrhRQLqMYTVL1HEQCbd4dVEIaXuIZz5ttNo0y/TQtMXRz3xPvD4Dk7gZiaekrxViI+9zeMK0WH5PvIrlFLoF3zPYChMJEMRcG4uyCZRyEjZrZdc5c2mroUvQHHsImDyulOLVt6ktfAPI4fnEulVZoFSvSlAMEPp4n+qDfJECZtGkZ7dm/0PM0bSVag686rushYqkSTuLh5lBVPVQA82kadb9AmF0dAKg9Tod3plkmXoutw8GOz8r1w9tVN+5DY+9JGDleH3PV0tGvYzG8QIXHg8lJ7IzSKw9VhR8xdbxJQtjXaL6vvnbnSh2JgMkxz9vKFioBecLcez2brvY8U6lO0bsntDxzfT+leBYQYciPYUpC7pO1xiRR8NzcotKUOzIZcJ4xly8iM+K8TJovnrc+T42sNZftrjt4678DzExTysW6qCc610udYWXYSz+qdAgRkXUqp3TkS2p5/tL4SHaFAVsZwSnNNbxF1BBa7H6lT7mAVK4rziSeZCxHbpZBD+6sAu+cciqBjC1aN7kBv7bYhp6n+NkcWL8fwXKBNQNWKeWqrsD+/L1LZIAFADKECWlzwEMEc6/STkdLymX2soToMD4w2Dn7MOqMVSnJxBuzsEg2Fj18cKikPhFAhtyfDjnu5F47/eGJ74Ma1zZuvwtUiIH257WIcaTY3hpbvlttF978RR2HmM78jFJPz7eSzKnEt0Qa+ST9ajDaS7i7NLZLG6Lm8+ktLwFk4Nkz9PGRf1Y/owS83jkWeLZyaNVrOtIBz5TaQD29mY9EsM77VW2XfIUaOrAb3Byiam6Mk3ZUygTnDKLYmR5HIbyGS+sMzmT1Wezlj9H+uJ0V2bFvZcXCPDjkB9JzPeQjiPGbj+17TAYodWdnVd4iwzWAVniryMg3fVyCGB4Y3pDLI+gqUy5JdScLERZEkt+R4b4zFNtsRX6y24YgN/Ew42GBN8E0BXAomEnAIevj4+Nke/vGIC+Red++rWbPUGGa0fsKJXFUEe/7WFZzirxyCXW+vqfI94xMDTreXCoXS39B+nEb3C52rC/1ptqc1wFbTJhoL/qVvsBztCIpbIFuRNN+Rym8d5hUYL+85jV3aP501qGQ2nbBmDMrEzPPDGFSmRejFBQf2BUinILP/NVc0lxhbmNT/8c+f5nRO6hK4Pgfc1tuqPLhhvXVzWXgW7j+yZA5qxOby5ra4Pz4JU447aMRvECyjgv6IQBY1VmQXCyRL0PeOiP9GTbVOSdcPk5+K8Fz+3fQF6iPkneSofeRjvHOjGrfza6MtObcR5jw9g4wQGS0PV3w0HmacQ2hbohqCBX9hRppDFfcrqkVzou7Qo+KhzQoTwD6fn2SVHcsdqXNKkwzkjcbJj7FqB0WgLn3THenYqNe9Dr1UrPcGz3jSInisXXb+gaqkCHW3dGGhsMo4owENLKZWFHy9L7iE1eM9SBBc9fap5vAQPD7cMv8fHAtrDzQiC752LuSVAknMeSeRHDTXJ7702llYMz3qh2WmLLSSBjwzRYG9mhHWpEIQcGiDaju/+RIsHCQgBdjLEKbxRoXTaKteqPknKsi6Ld6XWvJijYJiwpbS+bESZ+aPk96IWR76lhpMk/5sMo/0Tnd+w5xC2CaaxBZWSUoWNBWBHnpbBVn/l8+UYKLscZlGFVnT6dDEU5d8oTqbf6fI+zLlMe24G69taSGVolU5HEw8OfsdL/vmDu385Kt/sBW630qSVWe4zUGLInbERdKQJixbIxvvFkoVaYTUDxyz4ekLeuNqFyBtyTPquhHjN+TtYgjMP0TKFT/vSl/+zVxAhM//3r4Yne7mk3WoMCSNZiZlpNQmdMHG+zZMJDLmxx9POaUF6Sw7tQMrlTQjmaMBcJqplh+7+SOs7VrSQNjSmFO6/PVe7ebNaXCOTz3oChn/i0+lJKIszufJQ/g4KxbGPuvzP4mJbei3pStSgX/uigXD3MVicj2fO0IcHwUJrB4R2SZY4/vCqruRYb+pkt263mJTyRSQ+O8EMu4JAyFHwFpCXqWYKUr9DisJUidoDAO7DPAR6i5u7aXSrBD613KCp0CbyurFKZsCYAcBQ523Bnqv8/LtaaPC4uV3PddjfLsgUSolU9JFlhB9J9wkE1bNKjbbBOcuNcsym+QsDEvYzggGS5O0pCM4bYJ75o70ohnTSDVeE42LVlKcskoGr7gqCgXDsY66r4to4UET85miuui7+l8933An0JKsZe7sQy+7oO1HUuwvZYZsLe3C7UD9JAerbJ3IjMwH5wnW5vQ0AZjMbHiKTWVymmd7rnap/HeTbs4u2IUrGpjHGpUYi6gYNkCLGVMUmUHoh+3sQLs6dt29+TOmAOTvA0gJ9qtHHBNdc3T0J3HS7y8Lyp3DnadrtGy6TZvBSrBjYsAMxOtOHWiUWIiUvBTaq6iz/as+jBiDMxX/uReknigo6e/ohBvXDjmVQpeavplFuVdqakdRhYnr3O08YtGKtUCzludTJMdPzdHNjw19denypJN8hRBQAD88yKsGPeI5JbfDIbAG2zLrXmroqJU9HUn5SVZJfhv5az6TQwUbiPOcYIeZdBL4xtYd1inRGkwn8ZfE7dKW4MScUHYZ3i3nXS5Qs5hjs5TvwNgcVm5FG0NHD41nQVQ4y6kiJ5rjLU0B1WCDjnvM+DpExuXX2n/yzXoIHub/kJJ1eiSLwmT69hUCuovq6ljgxXXI5CrtdvY1oSQJkUBDkT9E2vsh55sqrnaXej2RFpY12+1T8EhGioDf4eveF1c+QkGj7nsHBUEyMKb9aCNxp/MmrV82EsrbVVWjulD4PHpwz2WeXv63/Z9u23/ldR1ubLDFz2ouTZJnT3KXbv196dY+YB/cuIMU93kVIuaPq8wxR102ThwCuHmZSA1HfYJ1rrM0+5gnUXgT/q2qDUPfugWakT4gSnkIfd5cZuawauMzIZRez8tCuGunRn2mFRWeNI24v2OypYESBD6rgBAsAefjFAfaCqtYwPVScaAdmM0CEbo2mitAcfeOyDUJfsuZLO5GrA6tRD6ysYqcVbhmxmg1A4lELOsXbV0np2YiknawGZew2mlzyvYncgsp865jAaet1DIMDEaf2Uzw7hhdq1gGopLjRcm0BpgWmsByAX3+jbhkdyL9uP5UFPmNEn/tvg707jhhmSQnYkyYC2g5KpV7xEFPr6zVPqY80M8ncakoPjUdI962NaHYZCt0b7zskJCM2AiNWHJeevzHHhT15Pi2ImZqiVJ5ae6Pp81+eSHmuSnhgNngWSxqSqEVoeBw6XAmaHRjrOu2/UNFl4BFKKDCwgc6zezaxv/qhVSjdz6WRqO0t3lLmVR+tTTy9/YOB7QK4AVw9fqBQCUNzvd8HVnu7ZKwCVvc9QGnn8tHiHFUGmjlhW8ptl3oGg6jjPpvG/LHaRY659rBWhh+hk4ZnBdoZIOMrk/ST3kSECB5tF/tfXRv2bLZknGW60eqVFz5BnAftImwe5JFJX/nXEtedBLc42cVi4N/QpROwnSgaXQe+bIhcvgzARIXXyjhk8p2ZBxE1Av2XS9A4GcNNHI8TuFbmJPyMEG5EPkVtgMEgyY+E8KtvYg1Ps95bdIvaMH5+XyqYu2ieX6Qn8brXm77OvHLuh0RBagE9IL/3Em59vWLvgF2uRbn17fedzVe9lAuRnaq5YjLZG3hqX286UUD7W1NtoLEhR7iwZG+hjA1QcAPAdu7r/udo8JOK/2oIKgxgsl+xufGXAkoxlR4BtsjUcvXzQopC+teh/2oanKDRmocVWXZhxlnkM+b67tMfEw8K1x7bNV3OE7vEoGAxPXODb2DwpyPpfmyp8MQ6T8YWwohDmOe+VPOB29xOSsmGtlWQolAtweSX3eba4CBTE5eoJ1gqotEOmHBnteBgtl9/rArreOagFoIeMnJ4AkOzh3RCMlQ3vxoX+yeR/mR/mTTOweR5RnL1f9Pf8PEy/7VV+rTHMPPXaa6g7ryCmdDZ50uRUFVfPz0YRDyghYM95pIm6HBKv1w+5vHOoNKbkC5YgMRhh71Jtz1aymAWjqKC6JO9zLo6Xj/azOb5a9Qyp5tXjlC/z+NYxxSyLEF1wPB37Jhx2kY+O4MeJDTNNOofHWV78gBcTiiowFqBxuCSaXLhsq/vQrLvHZMtzZCN5pvUlSDvahW0qp8wh9DgSA23nKSFwbxJrPe4loUbSMQY2fSbAp2sMeHha43Eqtf6D5ETlXJZJSuwvo0MwDqwQm+HjvMR7l8d8PfEIVQyfnE+9Cmm5Xt9IQF0j98zNGh/4cjJsoelTD1vrenNVbMQS+N3F8waxXJcVvnNlrb1lpt8bP2ZU5bWyS8qHxXY2Iy/JlQvXpP4ujwo4KdWAws4L1un8MV0eLTOy8tSJz/FSuDmkuUkEx/PA2gpbdyCFwF1XJKnlkPy7lRCovBHX4V4w0nQvTSu5B8GE3jsReg3t2VG9kSa/JQZnHcUqHrW0FnurH6dW6GWdAcE6wBtiqy4lpK0MQ6KREBtpsFCZD3zV00dFAww6r/+WEAitzFiRyXObacjwdCilsd4Mgq5grbSPlUI7CYlMMzl/dnRoEWrTmWHMzPweIxqt1HvGyxThnt0V/WuOdNuAxHWVOEGKb+Y+mFZx0qBGP1kw93x8qG7PctMHWds4ERObUjjZ/OfHMIFFQOD/8h1ZnVfXzVnb4BrdoBkcGnL5/R6aVu1Yaboqk5cVyL0QUlcXyDnGDktvVEJ+BtqjnP+49F6pWZa8+Dw53Duuk1K/hD36IUVPbDrcYrTRbpBRDHCLF/iVmO6SNzcOLOj0MiybR6iyw2f1ptHSUopspLq++5z5Zy0BCA+L2QVGq3NYQjjjCklozRPbbCh3k0G8hWzJc44iGLL2r3v5AOi5JYyQVK7bLqCwYa2mNy8o22O3SLdf/vJFeCLFLgA7RhlYNMp79pibKpmmX4DKSQ0HCk3f94N7gM5RUmTp9zCXoVYcbjVfCtpISUJs12d+dcUgMHKE73eaMQjxoPhxozR4t7TliuaJ51ceO1tlmZpFedKEJoV5l2wUDRuOiiSwnYm99HkKj7Kxh4uvGvs1+JnEOUcN/sdgX0oeKxO2i7WL56B++jf+VbYc97Td13St5Az8Y/VqWhsVEEqw1azaGRtbvmBj0FFkjZWIlLHw7an2aMpkAda9ouonIeNLHQuU7PoMWPCF1yR3NlB9QU8AptSIVaStcLhxcmF+5Jj3sUCLU+W0YF+WSoxW9BO4LVffsbev1UrOgZT7u4xPyXH+eplXevqEqMtW394Z1tI1jqZdkiqDPKjTlbydoxLxmFQljpy7MRK+o10ozLtmPWSXcVUbQooChn8RuY3YbhJzWSV1Orru/4vk4PB5XCKdBvyMn0zF4dvqpuZbdeaQOoaP0Fi+YAnmd1Lwi/Y/gD4jSSmPJ0oL7j1V9210C1KAa9ydrPdB0m3g273al7cGVx8JL5QsXHGr3S7WyVfu+8b4CmxmW+Kvx5fLd/omMqLSXYhQP2pcQtCZyyO7xf5ZpCrgM5UJv/Ek43ahPya5QDOxMaCEgNMoO7nnlTyiRVOwFgJL74QCW/QAxG1b+WQ9aX/CYoNemM1Gyno0tf/+JO20VAVIi8hw5GO4sfPk7NsxfhIDrBoaNXRDFA+MuZiTuRduPWg7cQkBPFK+g3xlty/T44L7Qns3e2Qrfs7PJI/tGMd175yRBMIaupGqWp7H+m++XxGHF4JIH9bxc4+nKvyKNddwxyh4yIk1XoWXvDNc+dRUqPKNR/EsA1MhA02Ru5Zvsb433LsHIRrYgxAAFxglId7ZiDh3pRfP6emF6M03hrAd8Fp8r0ZJ1I7NLZDonioI6/eUgSM9wul2zLP9ynRcFoI20oD/fH5FenU7eGNCnfS51wsHsFNrCdxNKL18+CbrDPQjRYdhDv2gGULD97+xq9wPj95ImQE78cAhqZz+pmkojRIC7dy8UmblPbx9bsd9nuAJtNwKfJxsQx/IId58yMQI2XHYzExighpCx5jXr+9/yVLpgp95MJqUGZ+/BFWpt4Eo7CW0sQko02ewC5MONLX1+3iaKh2Q6WDx2J22+3g01/+zKOdjLgjAS5ZSZF63k2dKOz88C3bFxwGuk3PD/xgGwj3LeFzVAF7MafAXkRU7tHieji22IwOiYxWMKFWWS1F8KQajy1G/6u20bAIuCenHY8gj/dG576DNXszEJMEBkgdlHm1DEZU6bElF5hG7p/OIXnLhfuHHYwJG4rgUh+XYZ6LZZ5lDca5mPqmaRrZsn4RZkzm8KL5JpeXPStitSiBNPZr+3MSpGDCJFSEsf+2qnIDSanJGkxnF6Fko8ddgkxkzrLF+DzAAuzGcUn1W0XuU/n3wmcXNwznnl8BVopnUyUzmHciErkOK4v72sgj9b5XNvAR5pjDAMFnktaX76XRT7pIliHC818Zt9UQ4IFPBH+aw1X5rAFp/6izgdCNyenHeMs5kgFHPJvPiT/v/X3GrYT8Tg12TXk5MHH36ruozDSDJhiGcT0UDgd4pnhSRCdU8DdcwDWGyxry5JoinkqWmYLkipRQneRny1EMPcQiFHaQhGq5DDhTGc9yKSN4hWp4OCYCu9f1akY4qvnHGBbPbifhs6C4tgA9ZcwVhYR8FlxTP/hqrPvREpwRusZ0VjZOtFDtDRrCIjx6PY1DiYoAXriut+MlG16tvX5pVQmRcRumhJvP6LLTJutA2JnDIuRqnEMI1t6Z+pYYVM9+8h8Wvv3h+EAi1aGuUOg3WRUCWdV9T9AF+BQP9NFkr+WbQXJXoo7ySm8+PKHJG7ydeThxfcNOWD9ytWfPk1nO8K9o32NfPMAWpwYShmHUzUy8dEicUNvbEg/wP78wMrW2LLc1vUMK09X6Ul52PiJcU0Fi/XiaUY/attpga4cUtlOuOMb5nrx2oNgbWtqGa1pMI/Q+8NlE/2wgsWDKFkF+DBaLiHlo3s66asgy7yrQE4BHDmxwVKS8FUnp8ML6FM+9hk9eMJWjM+ALSdjUaMfDPURlE6b4H+zBZaDCtk7Rwp5/IXvAq1Y7Az+l8I43lETPGJHmOs5HCY2K6TlwGgnDwMBxSWNh5nhOuli9LctcqU8iB1GNfblFrSOSyeZFKbE+MWkwrVsz4Uax/Bq9MJxA7el8XwEjjsWMMwrFAfWh+twgq1nYlYnMcXV1Seq3ZjJlohaGDIpwupCVRmilaYXJ2ZlCGik1W260o+vRufHXTpNCBtTyT8WoqtIsqmTEklV67vlIW2RUKt+xLG+cD0sHTV9/yx/9zJqtM0B09fglV9FIk6hImmpv0UGZjRFc8blaqj3Lk3z+cWsjzSbiWTPQI2lcLPYDFSljHYN+cL3CyZp57PEpj/X0hIUyFFAwsBJPlYnxZxqzimw6x3Dp5YGRqeiqSRQtZumx0bU18WLh0E7vpoXoHNvRjoNG1l0DhteYLLvNFG9H6yHSqcB8Chb8yFLH4n16dgOKu5AenuKi003oCv+9te+79xBzOPRBxa/2LkuMSdRAnV698Jh5Ee7WO3uEhIzLEBqP1WjDQW/S2iQx/jjebq4hiQLQWwR1ED+8LtWhUO5SjFf+Y1sExBSOTm94yWepg8/ltdhFPbOjAtTPaJXnuOBOIdnuypJz6PlAdJrof9xfRa4iHrzAoO0FHgpb04lZAn9nfNtAqHvmQSgU0CpLOnsJkP3lLINvWkxYHh4zu4Ova6JGP3Nx5qTQYrdWIo7ogL/pvT8pVTEacKUEc60MYDY+1V5rEFItegFDgTV2sCISdBRMIvp7w6y7IUBc9v5kqHoOmUsAElBrgtdxWHtQbGrul18ufFEAJwJw9oh6Ferh9D587bYK+paKkc23NyDG2c5t7F6VO21Ky7iwytQ2sX+MeWICzUEhk1knaBqI4HKxEivFgcpXS8jNRH4PO5A/sc/DuqA1fN2esXNHsn8mja7/yZR3XqxnQTuGen7chqRMKa0ip9FESKQsCxnMbtLIYeZL3+Q7HjRnkc3UMO/RfkQU0ULKn4TZTQPnmc9EuQlZ6hXrMlNnkz3JQNhE/3AVyYDenA/eDRGMBBNrq0seqR4CdF6wTw21VoMsIvyX4t3d93vFMMDRjHOmfEFVykn43TJZ2Zsd1vNJdmLA8HvUV2j9pbofNrmNtYlQQaoYpxd1bJo4DWQR7/S+mNyX2lfN138ht+m+LzSxO9IzUtGAF7o5Ittd59TkY/0VCfQk5S2TH2yLI6+7HmQx7DEUkX/UNTxcbrlj+EnKblsdaFSe92or7OTUqvBRFU9MJyCKkyozulFi9709Hf/Jxz8qZvbbUZAO/F4TElEa+az6M7ZNllLvXy5PvZ1FqGVRz4pg23NA5I2GgrQOW3hxeuew/Nji3/CE2pStELuVCUZQG1Sbw3jBi/Swh+bjx+5Qx5UmoIvmUTcLvzulWluSmuam0OGBg56j6qTsdpiQnkxiy6kSsxoTcUKxvepKhR+9iHyLkjQ7bDk4Thpgh96Jbi1YL4Pzeb0zWQ9KHmFcsI/0dEVxxm9XvLBSqW2szn3ydwlz3Kj5Ch7GDMFrvAm5DHAKnuK9Obe61hzQyVXqKR/cZztopnmI7DL0yuTDjqha73lC1P55h0W1QNZPc+cjnKjENoGBQQuG+VnMxsEn1+cadESaIB7Ox6owhfAaJGn1s61zMSz9h5XDsMNz5/u4r0Bz0n4RimRfKypXIdp20WzAhG0M9GPeHvvcK53y68Ltm/ddfi9iuySY7pQfaz2uNUP+0kV6cxUj+fP6DVLDe13h8vCJgG0hSx1F6g5pLftyWn2IaLW6YTBjh1ZfMwyQlXrSq0sy+zndYk40sTVRsglfB93iGQLsTGSL5u0QW958mcPfKcjwc7kDqI49k5a9Zm1LO4Q7rkMl0y6o22/9b/UNdrIysgljedEJMk2sHx97qCAR+nxoruNVN2O0nLn4CRLShg1CvyGageHkrbnUgeMu8EffuF35CdGd2ZTlGocxbvDFqmx+6MtVLZN+m9qrYcutbftrbOryjqAV/36pA1E9w9m/z6I2Tf7wpix3130RSDMfrG3AVWngBUvm/Iv6DC3G9/fvyfgrfnaWRn/AO+lVbVb9w02d/NYxK1aaF3GOab5ABeGllwsFMegftGpnD+Q3Soggd6sZPyaoPGaDEm4hI5m1B8FbRXdGPIOfo4uFX1XSCfiHKzRkq5Q6a3DHwCH+M1gZlZ/KL4wSHeYjtoYx7fa2Sm60YL1OHWGJKLdI+AtNKehBoKAEZ+8HhVV97YXc/7Jg1irM281bfhz9GDy1gtFUBHMMNasCpEpsVMhL61PwqpkJ8RB1755QCI+zvG9jEy3B5xKr/Xb6vx00iSSYilH8FoPiNWUPNSB//9k3872h/pzA18KqULOGEDx33rQFMfjUK58oXjSpSoBly+h80YyTTPK+ROnOrE0y3bx4BA7xC6zH+MfzMvgRWSxSoU98jqqDNAIrbVMEndxDgNjMsdZK0u5YPGjbMzIOSvifHi/xeQa/XqvGmJgJkMZIictPuwiC06Ejo8hcBMYgmu3mIzwTbfb3prwca5NCf62DMHfVXr5Bi2QxF8dDoTeUnzmVj8lQ4zcH5sHPBJclv7BOBz+KpTpXWZVF2rQpiB9FqeiEi0M2PyLfGtFg+oIGONX/LRznKUdvSKN+LRrPQkCrq/l95WOx8T2WAagnkMcSbpDLK/GVkGXlCkVb6AiL8u86OpgOa7PyKuBpKoC0BeAwL+iR9BUSsS6F49/YFr72D6PC7n6Szr16jjHkoxFXfwOrF9yuCFlR5naxHTFLk3NiOSWQYhPT8h4pA02zmv3ftBbiq95ay5fxSfhmsFou99wKPNYMuVkYvpKFzhfW0RWHa+gaNsbsRX8flnMZqlDfD1a78h3UgbyB6y39SN1OcjmiG+Wd3GTnjwMRpA3WYC34pvpxV9iij24J3x32rGbWwnJs86pctSmrkiYbWEBKXndnYCbzIzyrBN4xbUp76D9KZi5wOxIYX7AjKcaKe9bNwTsdI2irMM1Fgf8ZkzBibXOHPiRJcENK233VSvH+PzniwCLMkGdLsBPPMQ9pGgons22CyljM4vWdlMVt1frEHXpnXK060kqrmf30W8sUkS2x4p9Y0ZVQY+F9KPP7RnA5+1WPTQHnDjdQWwu6Rcki+8tMFkGIL/tnkrE3tpMvPS3gjDE9ntPlmoSSYwr2WZFvxqz/X2MBrD7Np/KSGVdfjAs/KMNSfXqiONcdBYuU5zATPRga3cYmUx857BAC/bKAgi5ypV+CVtawBtAKKd3+k7hoHe4brvCZk5gA1Sa//1O0I49Tud1G2jHW3Y4NWW38FZrOFwuU9RpjjGzOHjP4kq/ffWINGaeCDvEsIrpd+oKaw7jCcqE+1qNYi1cbDCf4k83iAeyupMybHtth6WlZ7gIzLv9q3h2zIYPWbS4vjoEn6dubs4oBMnIywMuveeshHYB+9E4ziYfrZBDlw7lD6RkbEyM22QxfCew8eZwCPMJ3tS+Dm7gZCpmOsSlKINZLl03gb9qO1w5zyJkYihpP4o1HqhMG/RTv3RPlTTCpnmC7c8ZOyp/9QRJKGBz7Ol/zdBfQMy7bUxBs9J52RkMPYkuCzLUn315nVqzNfwo2YvuLelTe6A4U2jlMbTYV7ouk2L6nEO5kCbD77X3nrw+VagiJ3bx1MJFCGqlMTP0dxdnewLB1LHRVVvI1M8muxuhnVBy8yHAmYLdUFvDKsXKjrWzwG00u89S2RiGDIVFIsXonzsxmYODXymX1Z/Mm4+VcPkO1TD81bQDNRa8Uj+PIT/L5hlz0Q4jDrqDTU0VVr5bOTQvTyyp/JobDl41uNws1pae9synUhiDFY36n5+URubEdwNOO28XHgLdVymAzfqSEJrSEvCEa4kG2xWqyg292OeCxrsZmHJXuOi/+F1iRvuQ/HvoEcp4X02aahewQWdptYIf4qcsdPu/uayfr5MZVTJmnmpD/NJXWdTh6LR+4VsBPXyfuOE9zB17hfcbbEvOAjt4EhC3ZJevKSPPLRhOwHG3r4hgm4qhrxbI8Cf2f5fpTc4yK2pLdptwqWKRrJJ3GB++uzO9REOLdqWR7kTEzjy/pR1oGufwA+EBqH8EEc23v+gKxAfsTfyN2xtC0D26Gb2Esa/jG9H8erFJpmnDZ327abjfjrQuTJVGvCKfOiA7T0UNs+1xkcz0wVkCYU1gswC5QPIqphbtd+H2eNCUquCiXEeh/M/C1XhQZ+8ccVEBn3Iizqu2DVrvAg5j44UhvwxkQyWsMffNfAZ5tlK+qaClGtD1xTmYZAacOAX+akYp3mFNfqrjsVRvDV/8PSpux/B0uhi4kIU2HHE2zNTR+QkZJPyQ39+/+5R6y8yXyaYyb4PxOOezhusmK/qkVDzuLitBDWXe4ZTXHBzJfxS/tUkgtfzW7oZEmJM87s2jcd+GG5t30Wh81YNaIv8i5NY0kSOuS31jt+xiTiP4u5i1SN+hlVlfHDQfl6AtcZCabjU4TM+ZuQeK0CF9bTkLldLbvC43J3laoS2UIMwuwVGKOvDxBTvGxh/QwA/uJbeQdrpLvCp3sgqYMfgbarpHKbQEnnDKqr1kMNw7wEULmR0387B1zZoW62uNDx7+oq+O2c9mphewAAGb8z36xQsygJi89J646XuDexXkb/tH1Ln/K132KxxXMm5wtkbTD4xyNAfUq7n30Efeidxj6JqJUN2Z45w7qz4pCVmcNH5MHZIvkVNox2nv9U8y4Gw6P8lHvCUsQYuypq7G3Ce6ZQb84/UoO8zvWfHzdsNYkVuQ24dqmjEFVdvW72J/KISdlNxg/HJOC8FS/HZylTJra4cO6n61SKkD6iFJBb9QxnELJNNFIAAPN6REwdbCfe43lszcQVSCueNZzaiLAgmIz7UyUaO1CqzzHZdrWBZuvuSJ5eeirMK88t3QACP/PpV+aJnmOqszcBIKCWU0Uxhv0fhj9cYMYTm5mbVvfLiOhboENbhFEeXbQJE0JmTquj/rzL6nUTg/xkmV8hwipqFHfMIaulwNlCbHZTIHNJ1/ckelYLiV3Njyx8MlTn2l2PT0VA67LKiu5cwylAZaha7bmN94xgZbBJWM5KmTZe7Fw3b2jHAhuRWq111EzojKN9PZiJxUUsKyCP1Y+r7E4RURU2DKykEkECn++YDfvl0DNmFJn/7JZ0a/+9EhA1vjaUFeXkU0irJdZIxSiKAIiO/xLaxCJGWIZnxwfH5gY80sjTuwp5JOVwYtRebJaZVm/M/11orrJxSu1RsMj04Qbgoetfaf8XqRkBM2r/stfdiltZk2taQCE94LbmXRg/5aVQC87M5Bjc3DH7lCJUiI4mWcjMUCnjP05OQK76/BFaNJu1d4YgOgxse/Z0yj1qsh/b+D6X8tjc4sU+6NJY0xpmOUnA5uqXi9NyRVMDNRS/7HIpcA7i9z9pXFPWX1TI9Nt3n+l5Bts0yl9iEqTqN3pjIBIRJZreU7W5vD92/HlYuf8jmwHcjQgVj7KT32A0UEA5ySiTlMLfMU4O7MIQtabiLL6KdAtW4NKZZVhVgIkdaaDm/HOjXOOvGMrFtsocgL/izT0SYVKX0EVSJuN1sanfcLodHNUb4fE7wTzb/HcMqkjlDEmvmYBIV4aqdSU205JCVVX+ij9nzndizl78cY27TvygQhwPsilt/qm7GFtwckvHBAfpAIgEHVBHjE74ldV/a29waRikdwKZIOIvsGCu3EoJWgV/td5yqZagMtVTrxQf8dSMFcoWVz+NXuj+UHd83y/1v9ZLMyOAj0979w8OJ0b7HHaEOFGPE8i4tcRIXQTrfNEY3DXD24g1UGBs+Kf4M1wbTHK2z9qqXBE7k4H6ac7m+M0W/HMV2StlYJskpO7iy6jGGA5zrmAZez5+g/jnrBFwVsjpvKHdseN1xOcmLOlP2cymvo7BAX1hjD/x+sD4qYvnhO7YpHnKWZUzFQHs989UUaVzCgxuEzJ6yi+SsqLfUYeLBylq3+0w9HFcahQfsx+FR/LBQXvuP2q1O8w98Fyv7Z21T2IPU5Z4COOUNOEHgIvv5HFfvBSsrlVC0wLc3gf90dk6MlUao2+6j5owutKVOAJQD+8+o0M1oFXYeRyur20I0yj4nl/ezZ2LDgvAB4bNTrtID5g92n51kPPkhnjemJNVbzKkLX8XSGE+vyTg0WZjzmKFNikH1+gdNnLdO8EbuKJcuOzYKioBN1+OznAC29XxuEEHVdFcPMWoLDf+yzQ2GFpeINa1/3LUvnXBZHPcGcWHCc7iQ3oQ6nVCPJv9LKvP41rj3dig34LPLr11zphko+ZT636TO62x1Mc3uLDU4J9RS5Zj5yfPq9R1fP2gSHSo/d3p5tt+4ioTOmtVkJtuF+4zzomYkbBL4TlMIYe7TLiWfok1fFvmsfMK5jjDMmEKeKGCV9FE8JP3vsnaDusSBX6t1IxMYebvxY5YT97u+eXWvUlOw4L6hliV0nuBKMnh2RzYTrVE70dnvQy4UoT4tMvNSHaU7t+qWwh+3SOJ7NhfEPa4Sxt4EfYe7FO1mYJMfPvE8KnDXWF87ypgP2Ef0TQL70wInaXHzgiugbmgQB740iInKRNcrav2kjo9SngCh9NdsDjRKMXihjamVxjjCxrgNEI6wvc4hZAflKQPvCo66/CQgmSYH78AvsN3FQ2DcpG5IEu3FVE7WmPeiVPZOrjrvxeNziyDpTau/tEuuWn7cfzbGee+5KE70DUEIOgkHVq5l/IIWPFs6/4XxiUstV6JOi8r6q7hpK9jORvFOZf3oTSTGBKK5v/Kuo7J00ZCL/7DfACW4hCOEQFUaHa2eMF/8cgj9m/eQv4xb6+i3Uuu/TSCgtwHRbSXJUX34xHsHx1LQkTgZGG5UmO2GcGpZHg7mTx9Up3bUagd5DZICIP2QWSWs65kfBg/U/9qz+J3Gyw2ABDzUK8why52XdLjk1ByZeMMVqIzSVZj8dOsYSnC9a6XEjI6FQYxnJsPaYCwQT9i/OBXoQCEKUq52VncGuexZyb1FoLZ6WAdM2Qghvk/Y9bOolx74ZDtd8Cn/CeTTkvDeYWFxpPUZnEMH2rdgfCWSyImetvML+Ro+apYzAREJ9Xfr6/PO+DqNS288YgUsXd6XvBz0OpoYoQEHyhrAHttKD2FKWkgdFfowph4ijq80a5h4XMyuPh16WlGi8xhQonbBtFvDi7iUKS1OcdkmtnGaIysQQ2R+K7tOF5ScSN10IUm4g6eHF4eaEzlZQhYiGKwkWcOq2usTfULwkJJ5Tm3FhLOUUbhlJhp8wtEdG8xhu+hJGvu8yoZ3Z83+x3PGfOct0tnARvtyvR/W2/3LmxXM17J3NnIWVi7Gwt9WUdmUFegjmLBXaIOvd2KFc6gUXO0gALKxZTEsB7ftmT7CKtYdTkRN+oxwwtxL/K4ux/zU0U/1775e//EChNE2A2CraUJEF0CmGfeuunkr35SuQkAz3G6TOJGY3Mht8SfaCN5E/q/6vOsT8C8i1GfYSmxQmI7pmJqPjp+/DKE40hnyFUoHoKuVpZqYsExfSfVf29WwfX9OKo9YJ0ncfLYG7UfVxjmGu2l+SO30kxrmy7chwmGSrXNANhazWGgDnqy4Akdh+RfB5LfWXMvefJbVCKMRNZ7nx4uLVECr3Gq0WAVEnT2ppfyZN3auduHjS4ZMcIA/8xIMtw+hplX488zRPalCes8glNzmQFQQKHh6d4gL9Ll/W2Kwlq4/zUd6XZN+v5cM4+jbrHMgxRZeiLFpdMZGcwoJQdItz3/LpGnZ501Qlo9b3exOG9yowKMScSEK7lurKWk3mZZ+RNeYUKOcaZ8wCRifW5MQbUcy0rEhCrqFNh7BW8KgJSLvQHQAfcuxd6wYYPELLSA3YwgIB+S0x/XtzffeaNa1Hx8sKr/1DUZQgxz12lFNH5W2j5uEY5WauZ0M1wqw5/0vSwvuHTiWXbmgPboN9lcc1zd/+Gs+zTqWXN0DF4f3zQAdeRZ5l2kdjJ7JH+fm05fF9uc6suQxqrTMsZ3GbH5aL8e+wFQCvu0QfwKpLcH3QVpFnOtfwW8ASAzRnQrqj1uR789O/hX2PqTRBiUmfOYRMoUxzpRfY7UZnp/rBJfJ8mnj/PbjQvz/TyoLIGvGkh3P51B2FiRhxfa7cQYh+IBYQL+k3EuibPbvpMhvRrh5u5sAvW5EuQ34LVlLW1Qn0RrB2dJeJwlhQa9hAz7Wv3kso4epcljYarGmWvXnLS/k4xiU0PqGZ1jNWHlWopsglQ2irFdpFt8csnNvCQWyARw8TEOfl6jioUCypPyQxlDe8v1SBNj+KOf/1Aphj8b/d1gs0qwlBgZ5izylO5/efy14dhUvG0SNh5SSFdcNjll04xQOSCoCptEx+3o2Kc0KrH+viLPiqOTsWEq1U28YFhd/93Nlw9OoNXR/5xp3HXBzoQCm8OTlmExtolVOXzFyUv2Ii3qHOt2DgSr6xb0Ionc72R6U24CKSi8zUDA9M58a0o7/RfAIG/ktg+FufVbGxgpCeau4xBGDHphpTJKcta9DzCrj2nJkvh798gbBJo63f5Pz637m58b9HTPLxbkC9xVommJZpk1suKOYfFE7XDM/IM1Ld4fjHjcE72F+1W3ACzNAt3gU4TFSXGLxyySh2iuRMw7dFkS29bVSS70QJqeEVBpciYKlUlbzoO7YEJIMzmjnd5ktTG7gCh0M7lj4yxAtXfmqqlHnRRY3HqkmBCMffIiORrE4LQX5EAZCRQYdr21+Ahi0UuFR54nlr2nZ9ls1A0M15PtXuM4mig2rwwgNNGvnDJuCiRXjdQwCKF7llij6VvLTsFTJEZmQz0T1VPaJibZc+mjoN2yUC8I1DjB3gjZnPsCwk23j/kuLv7qVHg86CVcqqJ4/Zxeoa4FETFJxUZXXmcymg+PB1qxcb0Edlpu104f4nX/BUrHFTVn4373STYJVkG0n5B128V6YliD43kNRHdlhPwZ0vZ/BFa4HHxk07Nee3rTGRlp6Lqh3Sv7TATDdQwp8fBbtdUP6ENC6Ie900RC2yZgRCUG+a/YGnZTZbr8QEg2B/EsUovrH1Gf0hIAxHD77ziPAzqEu9/GyoIPcKpDEKICVJzME8MUR4pI72CKLIsV7VHMnQVvVGM2uLCBUATWLuHjpNsBMZRUb+htGKbyfOOhqfnerthZP8rFma1C7gDcBLp55ec36eFfZ2MbNE40mZaXJESjj9qjfMfgIe88efnKoOFJQJ6DSMM9I+BK77xfd7HGeJlRfnjYOqxKjxTKpYW2UamoL9aBdSvA8PpHc+2Ws0NiUeKAK3DGeImxAXlT8WjdyMyNQimo++snYY50IVaM1pvVc7A8UMYDBKR2KLPIjQddRvm5nEqV+PKtu9OtW01peutNff0Y07wxDyafP2FrHCcTBy7U3sCq9DU2z5TQp1IK1K1J979tLCVBp280tkzINGvUp+SQ0xdubHM6kdUv+9d2pZSlMVaxPQlBo5XKT9j+HGhVIQJgG5cKEA2fZlhlXNCo2P/d+PGOKELn0nrjon/gkm1AmfL9L2eKbjGuPEbK4MynGcthuR0vceveKfsemMwSYs48vfojZdUxe7tj500PPkXCbAdbTBqpj9GwScd4o2wBDt5qKQPpH8qBl7XY7AtX2e8Atl843Cg6taeIlWnocmQBEMiy0RS2vYvbBAoamVBAu2DJIkgjA601lAd0/cMfN+WWjcCHfMapShVnzFGWIKXRdnMWHXl0kS0MjzHmbC4o4+RxZa753dPxKGKxZZ3xmtDbWarBObX4jIwmufCgun8xjwK5ngrWgBubEqRThsM3VJxBkopPTVhMTDAvNAdVt7X6ia3LEmFRqeaAT6EMJpBifvH82QBVLUjYAAlYxb5DjQaXhttiMwP5bSqh97p0ZnlRlM6UmNjvmlgHTaLlYIWix4hE/cCgMaAG84qmwHUdO2WEybp31yZvNz9LVt+LiYTj2KSNzonpmDVAAhSZQ5bIDOsZH3srmggwAoDWu2ASNolFrMNCTRnXlijlrfkxrFdE/NZxJhNE20HPlt7F+glC695yjJvJqp8eLtQi044Pn7XtPKtjbze9oB2/Kjzty2PUYuILlkb1rMo+aK12YxwbPRhIRsSQrtk+d3OgLj2XfsjT9rl9Lsm98CkksIWYNoaMYkC/W3y0iXQ4IDVsU+nh7TlYV8oPiHzpbyeab8d+CjgJU3O3RVvVlgEa15H1plI6rd++eA9mcWwwA2QScig9d9CDQLkvH0cdi1Py8+M7Pc7gRcil0X5e5aO1a0m/ub7BVmUZk25+T5QbPttBhnrIhS42Zb3dnaF0VcCrnMrYnVFCvKR7n2JfiikKzWWbaqy4AhkUcFeT/0yW6AMwXt0dm3H2xe4lHC4IcCQPjZIL0Cx1X2bU1U/0X1i0fgmCtqD1SKUhQl11H4OW+n7lekIGh5mTo9UKHoCh0AoWptzNnGxiE9yIeHTrdM9ibrjLeqdwByth0YqHsdjItGIJHbBSCEe366WK2/9vMvCXaCWd9LPHB0TRubNGz16sYu4unt5+fCtJ8pTNeYDkSBY98IMO29noq8nyOtgDDhbUh0WX5f5u6+NaKOy23T+70G7UCQe5kKv7Z+KH0oau5ov1GCxuhfIl2rfNbDkDePYs6XDjstKOdnZQmOdLT+BMsDfP5ZO8dOPGsUVcFJC4T8zD8hVQIm12Yob6oMYYdWaAfk0YfiJE6OgtWrdQwT8Dx/86cgPV2Z5AqYciGjrBiKPUP5ZsLu+Ysu2TpxOgM3d9uGsiiu5d9DiKLninLo22GNALwEO2JPZAuy8SlUvqCdfnJcp2pTvUo+NxKl1d1Jze6xhDdfV/aRJZcKRuedJehDNuas9OzsCdiImWpGKuVrq2afDwf+b4eGShtTNcIXIPF/nV4A8Tp5H14TlMlGo1nzurh+jBc+OaQso1TQ4epzS5QebDkREWcl2de6rSI3Q7QrmmNoPEhFUkYZ0Hpi4RVcc5XPQfoMbVp/iPTzVnz+zvB5nw1rCoeBKjwn9l8ehfEbpK/5AY9IXj512cBYRUU0r0iH2H5gwg+W+IwsXmoQ0HUDOMkNYhPzw26EVxWf+fDLNEEFx1L3BdbThI1vTu+I2Rd9WtGQsC9qZ8RBvhALy+jeFsUfXxvACnMxHmyl5efucwAKIekX/SwrNeQxYUCaXUpDniuZKIm0eDVqw9HTP+x/3hyeESNc9+JV0dT70tkXzvTvrXWO1C/Hl2dsnniEVz6Op8XAvVgkMjEdYf82Sf1g+UElyvwSDfu3pgoHrqyTqNao1g7aTA7xG1gfXVQ+QPilUAHxFU4qdu/0lsS9u43LWM+yxAPrfIo9kN2IA1cumo+HZK1EM86bKoYZjkxsUXIlvcU3U0FFgnF7b8xNcQXAosFSrVVMnOqiHdtYoQSwkwTpz2uEnksxcM+qCv7Diayig2KWK2LIwJ37lQTNfIp5w8KVFcGiqyDKaXf1pJGQx4GFfIfUQ5UpkjGjEw04/7/I/B774WIfkZj4FO3nIeFoavySz3FcTJFGcr5kLfUXgLEVDgp/17Vv6KjaL9q93HXYPG7U32oYXgfPMjdyjfRgDrzb1GZsaznbjSyyv96uKnNjYOtypb/EsyKcbNVymicAz4EI8Q9S3gNZ2v9lFZvRrzpUBl1LroVUTObgmiujAf+gyVmZM+RTrjlyBAVAvLEi4mv4EnK8rl6UuL6+GFBIomXUS3w2SkAsEUDFZeG95pYVwd8YDzEB6svprX7dupJuQcJNYYqKao6tHq7GA4V8iLkflidM9SecjYUiE2emYRZC/52QPHM/E8r3XFIXJ8EQ/+91+o7LyaR5NkWo1oz4aOG3ycSMK0d/ebzX0KGsG33n9JPEd3jyxE95blYHLMP4UI4TZ1kuCzDhQXzfLQPqDM07QHfScPHkK5h0Ula8v9Y3M9wMZ29ZHyNaPCeC/ox51X1eQqd7oy/UrzWBztymyIhf4yHPGSxfNutWKpfUexFk1VO6+wBknldLftwwTs09LClhY8Rtt8HAdNoHcEs3jVeAjjKoUt3mQVrYlG5DM1des92viKBUp7/TBWNxZNunnD3fINrnpe7TEgvgRQ0exwdtnd6JAVHETRV8fQK5NaWfpuvtuJErUYBrQPvHS/mG0ahCmA9M7A+T4JQ+4hv1r2nqVma1EvKnqQtRiZb8o0KzFX371WYbIneXhJxWr3qko3mMjxt09BK8ML431qzjIEFk2dSt3Sm9IYzumgPEKljpQaVP9QdUGXw3P6C0dd3JZgrU1pBdhgZxxLJqBK8eX3J5XLx3H3VPT6nB+1xbbA+gWGUNk6gHFCsQY5v3D4jJi3fGDVIVpA0GB+ifLjrB6vL/Z2jWQITczDsaxny0C23NB91LD5R7fTIaO2gADG7lEfSPa4lgebun+zVBVQmmVayGBD9afFS+Kw9ca0fOP45BoWXeuccmEpVdtZSXFuBMygNfY7L7VsEyrtekqjc2rHarcd4FCmlN5N15X6VuEj9uig38+RkaRVmN3stEBQxtRMugWLPi90Of29nJ/91Z/DMXP7wWMd5v2SzCp6kkDMFSb7mlVzgmuMtHaCSPAjcnTDFKVPlJq3n/Tn7Ynih0baFPHKNmvlVvWstH5LwDlZQxLtHK5z3UEEMlzIkuev17OD6sSv3zIAlb1/w76v9XFg8oUANaFX7AOOTVuFAf5KJio9y5fflLXQmMop4YlYX9SwIxYSz/bcEEKUt44MGtW4c1/iRBTPY4GK0lxGQn++6Dg0kh/BXQU08BCi+0tIND0qAncMIUPb8H0CSnOuMNId419V+nzBCwKONi5W1J/4e0RkskPuCwKc4FJOh961epyJ3RhSE8Q0ipehJSUKXJP1NsYfYiUXik5Lyer6L6BfEUYRpzKvjVBHXQo3i4hbX0TtAzW+Wi0U/vc6+asOhRfmO5kJt/YtWOjhSGHwWQD8qNtVxFolTjGFnW0BFtrH5Od7DlybGpsmAH5MypXUoXw5oon1Z9YtwR9TWSSl8EOxhDl75zQA/HnSENn5XwNk55HXX/zxRKrubc+nwdVDRODYylqI4x+akj5SGe2RKre56cYZSsUGJfm+m4fG6qgR6L9SEFnV/Gs9/fwb138a+Rvmy5zMaxMtPXsCEqr6mD1iPPIB7wrWVVvV2qMDJzFS7QvyVlYuGoWgwKIYqJOaF0BdjFZ+WQ04fkVaTYILCWM35UEmNrp7x9ryw+7jKtbt3ZDyYx4B7mslRzPrNGsKlVTOrUm+xlUxkhPifMf71l9fFP3tmxOJeA/mcnjID9xM3nybPWi7XYLtbJFuvOvfX6ohTuMMG9o/pLufParpl82wCMtpxZNuCZf/+HDFGJkfSrRbZofLuJ2h7a1vzyZa4ZTeP6hunDkXy5mGgtmFP7joicWElzYsnbgCQtTeeraCpw0kx1fKADY0wLnh0z4SOZhTdwEVfiniwQzWZK9Q36qaaXd7CRKEbeYlaFmsHV0r7bLEgTLUOioD/b0ET8Itk35ZmaBTkan0FGAMV7DSivfnKJYsICrCIqbv1KprxsOAqEzQB1L5Tewh/eNLftAsCdVk5hc/rAqlkHmjo790HrDjiKB00oK5J7EWF57ykKDuA2NyrK+9penN6XMwY9ST0kDWvxFm8xJsOjk2d5p2DRaDhrGOq8Yppth7eedGKzCy1CnL/PBk/dLue/VNG65GmDXRFt0REizpVH7Khrzo5QGVN8WBB7GO5wgRRe7rVdg/crdnTlC9+JpH/SDlUrFsKFdqt8ceJU8w91dByhLQ1DCYcAeAx6TC/1QnOfxHkpHd7+5UixtNstJt5Y0ksolJr8k6Xq+xrwlY4cin72sXzfW+eKD2o1tnSPGbB3+xtbfXckFUiVT8KBdfQYyP2SyXhY/TLTNGtluAFGUR1sqMuzBtulmVtMFNsN33eg03JeNmHXPJ5AHWA10W63kwVKLmy/wBXG6T+r4mCTtT/5dyBLyCnOVUbMqgM35UYaVdI+COVVn97nSjEFAdW+ve1C0dzBwYszaoyvLs0dTQF3JMcvUzVwc8wAZPZoHIULUypRwlItUi4S9VhqriDuE60BbcTt6kZ7+aFQW8UjBVq/VFud0vh7uEUounNYzyDiyLgjqgpUb2tOMxFEBke5pHMG9P+iU0PVw3sA4Pj/tMoMvriDiGrSBd1SgdHUE3w8EW5TMk9hd+/tYcGSCNNs45+kDq8e2LzE02ya0u/rid947z7KSy05Yv9HkNrGRqQgknIvqevp3SKs3KB5ZzTD417GdqGxAYgcsvWbtJMjh7buZu/+Jak9qyP83Er8kHK1kZBIHoWzd6ulrZ2e11Q9IQkSWoT7xUp7TEoV5SSFuLMwH+mASV0gGSaOVhnZLLHAp4hjJfD9/S0GJ3Eq6gu8//BrJmW+4P0lcPxMF6YOytPvmwcjPZyLUKe+HTcmGuoPURdfUeIHkVoljclEEuIzCqPPfuRCYzdqWPFEFfs/AG0FBDwqmhDnin53EH5gO0oMNNKuDfkr0YgY6KW3aA/7P3ymQnCie7Z7kRos2x/UwHUMB2mcPl1hLSDxYSTnAm7pl9IJqrRf1gXg1iT0JiStdbcKdYMH7mVO9I933zv40ac4kPfKVuLJcpKmkDh1tMMN+9V2SDW3Mhb755VU+tY0tnhHLQjt4urKF0lEwCPP6PRT/QKIVIXAn1prpHba/emy6efTrzGcr6fAGlOSJje2iz+u+9K7YxjF6uw8dxouy3KVrvjNsBrkn1itcokeRBTbaC2O9MX6Yxi+l3oiFs4MzE/6PnjZCoEJ2kqe/OPO/wlH5C4cgEIyOUPvb8hrrNR1NMSTOiUq7r+bej6o4BOZiTNimJg3d6zpXKD18zVZsJ6TqNmqWdwbcCR2qO1IGkKGC6Uqb9YUT+41T+qZWiELu2pnqv4wwsCF2eezU4hPY9DdgrsE5zSFz7ZRiNw6cvFEw+84e35gl50vwjx1JIix9O4AVWvDjdw/MHg/gF4SCKB/oEsFBc35INqebJIW6eCsjezc7JKGQdBK8uHfCFQ9vjyI312YBfKgxGE2l9KqK4+8t5hRySAjMCKtY/WAMFsW0/j8LhB1fiaTd895BwOoF7yWK8OlstTu7YekwqNBP9TBI7F6AO5hhvH5nR/QCxj+ud/tiBOiu2r7wPpskTBbdhEUxUaqVHbvuQoqp3ZLH7ZU1yj0GZ0BDIverL4Qd8fSM2USYULDz1f/ctUZE5MFyGy4KNP/KRuBUsb3xUrG8iTHfdhk5nEvYnTZqEDNiRiR/IFGl1bkQ5VxftekjagRkyfNxz38laucPAUE3zxVTSRcEov8dXUj0lUhVOpo5S/N/9QAsrGQVRATqCwSEnJNXUqvebw0QNfpB8KkPSvOlHb6xq7cycuWel3HC1gd4Lz6Fbzh7BnzsH9wWtyaAC0ALGdkSrJDdVnGAc2wzq9ThF9RniBMG4N6YETcpH+Lufm/TjizbQJWrCSzBZUQ7zFF130eL4q0N5+z8aDL8LQncMqJwMqkLvYMi3JLJvOxfMSyM6JFUg0RYchiwhQ3E89HaXw1ON4UKSLd+G2Wyr3+A0+jhi5HrT6w6YCjDAH2x/IHyW2T/Znc21CZuYsTThl4F+Y5FUoN+dpsRS52YRLG2PnEjVVGjwlj25SfhPO9DfWc108BIgecbrdaSX/fMqzabnpkpDADIET1tJgXAzApcH9RvarrWWU59HixU3pNfCTw+GN+r3FksfoRIhCPoqNqagKOI1bBBZSpy++KXVqntd9/1vEviPwKip2G8XnFqueL2hI4yLzDi7bbCBhKXuEOQ0EXf9/2kT52B9iOp3pcCUNMzJMfM1/IGgW7sBQQ6hk1SCeZyMfl+Qpa8L82LUSZADalkJM3DtzYYWTPaezJiJ8psH8iIHSFUCIWDSE1coqYReucjhoRLnz778y9ea0fufF/25kEGWJcKN0SMg3hl9iWSenvfXFGPiBIHsn+shKPXwXXrAEKd/IGb0G7ZKnUOssJ+1iZISoo3NBOHB0b+06MBtM2FDnRl6r7RnmTflZDiZjrHWGzAqOVFilUmMbFmQ/ADo2qSG5jRgj3ZIYx/eM6EiyAgeTHL/C/9sUM8y8eannkllRi3QNUrK2Cd41yoqeiuKEDh5ygSvD98XItsmD/Gm7WdL/YQbrquLMu9wRFcN9Sr2SyZTrKRNSTuyhBA3+8mz2FGVV9QUmdurk7bntG/n1B8YcwLykBaIylSLRTy5cjYGOAqfwfih46myKuqn8B5AvBkKNeWCn6Q+MlnK5jsoNFsrd8v5xGLOzr/h5Pw4UvoBNqmgmbbN9ehZr4HsHiEUCzu8USrueB3mk8HEXKBw8ituKrROvQ0Ur3Klg17w4RBN/vluwK8ICmVF75zBy86A/sFbP1267B7agpQggPda8UNmVWofhDbEo1teZwm2Bcen7PHLeMPLdmT3oLqSAEuA3EyZdOn9DNMgj/L5K18HXIjJmPQU0PWLwm5ZH3pZJ0zEX1KrXbhBIGT+nPJA/cPjomSFHxumBHz5OmIoYet1ofa1qUrfBj/j484/uU9WJ7WJ0zTmwJi3NYpvWWYCxAyQMeSxrZoHN033l+1sQJqmV4OBNrPbDlTnJnzA+fwUSBOd9sQqXB/GSQCqD+mzmPy3L19NZGa9CNr5eGF3R9klJsBEIiED6DD9JY/civPFdPQ39L+V2UNhhD/DhgoioI6b/UiXKOgjrtrVedOe5Y+93bDRiSp0OxNXJc6oEAyTKEWlXKp+A8IGtxosBNMSzscDRBo6RYxuP7NWDdso5+T9iCwHY95r8b5yTDU8b7yeG47eFU6xZ9LiMMcrKFyMkaE51c9ijiz9sjT/Y0rqsFGbFYNHhlVUdft+aiF3FGw6GuEXR2Z3/Nr1EEqM0TM6f3G6jCPxeSzinrWYyYi+DtbuKnnvyzpaODfi+e7hQIZuQjKTcsNyQHO6dUWASpJEsdBUjiadjgJyqsD71sDs0HcT8LTNI2cu7bqgDe6bOByywJUh5R1F/pWG6JzZkOFXf8AF1/sXcMEd5TvWd9uloZG5K6ohV83sxTQQjG0b0BX0iTomsJILBrsih6e/KT9sneaoz9u/MP4iBNoI3BcmDIdBARtlQAHKNAki1y+y69Z5WnV1LeM6t0tOKmvd8IpSZbtGFRxU4tXYilFr6VQAH2DrqKkJ7oMiox6DdSKYLHpe4lLs2FjJHLVd2EaC91qvDr9/JvlAl7CS1uIbmyWVc8/ofUNBoQliStRniIUm/dmcBu9FHZmbo2nciYUnPYf8LlZakMH+Ym8DQFkNCXcHCtHuoH/CueTZ6P/Uh5DKcklvifLdEw+0OPPG8FZtnoBsFBt49KVLi/qGGikiNtooPq6ldFxyTekl04zpalBNkLp9tSIapVvJTlqXr3fVMa1lqqWcaeW5Ogv59/QjAMsaPsK7/fbD1PASPgCQ2Yug2HDZ0xoSGc+STMZD6VM2C1mRLnfbUlAJ6kycpUE6hALMNNLQ/ctBGXhs0tpJFvg7HSNHSIoirrHez5FExN1sCHVsDoog+pTuOsKTpRL58XmRzbK6+WFmSzRtlUmzlQbaeLu+E5oLQssN7o9kQy3K1ivwI7OQlgudehZ9Fbnsh+e1DXb82GU+eOYwgG81JFRHSKVFhp0OSIS0GBagkVKGUjr9f85y7TmompxXgqWTBBeH9B09GCHbctAIe2i1IG9M86rE16Vz6iphWOPGDqps64yHdl8DEPHZpohhZ/wAT+xn8GqciA3ojqfkDEGFg1xSq4EF61G58Lh28WExTcrPkrTd4ai2lVPvXw+3On8QaKfXvM6joVZ0ii064M5DLo4RZR2lx3DsRqFKSMqtz9pPyKc/XQiH81Ebf5UCzE4ROLgmupWSY7C2Kq/ZcepmD5J2bFpU1zm4aE3gBYBaCw13gLzY46KOi3pdwRIwNHfMSosXfZRPpHIJO9G10xMQ00jjuvRPJ7B/HsQJFXmyob0SAjA/xkv3vaKtBHzSCwv9bwSAJcp6Iu5300+nhup30w9ddq9NWpWhx7SzUiSiI4eMPtSMQLRO3/UfYngfCMtEzg8FOF87YrtnZY+xwUooUhGcChhJVfDgl6J7rrjIOaGiHBOHMjXjO9lpIR1uL8WeKKbzCAikt0Qke3QtA2x4ZWnyZBHcRTiS+XusL5CMurX28OcFuUdAM+mXKseASm0bQN706tUm8mPu8iwrQInxdjcreyx4DfvyWUE9jLbUelSX8BT9aDVDZbbdCB/oZqs6iPUuiXPDz7mdn4LaEBfKNGSaRtMUGJv/a39lEHKfbHfl5C5x8FRfGNwj48/lSuDAnUSNGWh/1UqYkjpn8kynO0V7dGm5ToBgE9ywQJaKhD7D8WwLQx3dXd/pozT/kmKKrDfy+PeF7nwdpMM3iKnOTnCPbHhTCFNIVkjeThT4benpRBKhH3ZJbY4O9qABFE4NtQkeznVy3RUJnwXKv0K/M30gMRAlN1o7PvNBvHts2gp4UOL0z4LCAeg/Bssfey5A7ggwQdu5RRd/3rbBZmWQ/e42llfkMOuVThrHbP6t9WYAitAYRpEtvYW8yMhJKI/3oM7jg0m1MhFeU9rsP/vrLwA4bvQy7ON4pkCYVwvB8/v8LeuXaSJZw5k7rqnvZFSbdFJwMECcWKGenNFcuSgGN5gyaG0rXcA4T0sZrnj+97ditXGAZ0d0BhrhMrk2nLKdqwv4zaEXIBZkHSDZUYQOXBT5ssqnD/Iba+XI1jpytTwAk9AEe3095QoVEOwSLokiRuG0eZyU5qU+VHhdrgM/jyVK4NtiR/P2sMWIGk3yAr04WvQiWmUfd8EXDeyuXlRZa0DAtT19cvM6NysIH2W4faDjWDjcHci1VFTdIvR5emXWV8WpcsplpKleP3vjDrQbXRxFUKBljPKhoUvUaji5JAE7hP3tMvOCk6AVvotOQAC0hzzSVogqBrPze+6Noei2Ax41m2gFakzFGjvSpb9vXuxQcri0j/1xQxJhwQrE6tHz2xW5laLZ2kegWzYEtJPX2deZWgenhRUp13X8wI38oWXEQdigZZQqr7DlWOiQrI4aMmBCkiK5VRjH/MfVbcY3GaZyOJUbzYXDHwHnC++jlk/dXwJJVQJj+wpANQmDLAS+L/M5MjncPj8AOUPyLctWd8To708OZqA9IwvkOuKzzhFoPOMCsO/Q2TE9oNDmUteCPgZwbHYvACvjbBm1eKK2ovScsE3PnV6pPWjOBPDZhTXptvcxc5SGDknE7OPdqB0vXw/0cgFGD8oMtxEVEVcw5zovRPoHdlhK7BOnqwRD7VKdcX5MYpiAVf2vp0s1aTCcmheN+hYJ7fZcYvLsPmjf2tQEn0UmYfQoi5HZAWNGHq2AblMlU/ZYeYMOw/Ya8wg/VxqhX/iY7sMTPsfQ6zsddCKxtf662h5O0IpiNO/Emt74f1ZHp1WmVfGXID5/16/zZgTZlhyzY8CahhgJYOoXef8N1xBRHfOnoFUcj12cDXovKMc96u+RqV4kwmAOZsEnwQDd4uuSqbYkOkHs1ZQOzcgiQq/g7Lxs/S1kchCcbctclStbpznOcsSRu4HK25i1LB5KhqgfPZGIcmKOtZzm0nI8yTJsW/vIA+lmp8uF6eIn7HhuHEO3Bi0BjPrI3MLNHb20xhgqTdvIwNdAkZMLLV8N6RJ+2skQsbEKX5O3tuarkKlNXtWme5XOGu+6b90IuM/KnoP1/fA7yK25cnIMwn/mt6d1tK7dyj3Nnzn33jzwo1U+33Ot99uAoOVpK+o+XZG/L3a+GjSuNF6zADp97sW+45rJfswdQuE/NAD+eNVgv65F5oW4RD5c1NacmQXLhItK4ieJtoOHXNRzZ0qIL07S0Ib2XWq5rXLEUamOTfhCA3Rfb8WHOFcZOI25yuGok9zcB4iWusMBjggR44cOIrBe78Z3et4ajBSrKKN6lZbPYtJ/T6tXgiUywJq+xzteSjxSUnaBM8XdDvA21wYdeNnIykelP7jDmWWSsfajbOZ4tZdiVY5eCYs9lE8LoBns9qYP4MZsY98zgXlT41HnS38CPEeXlbiiaRMZSnKhnQRhRUW/0gdEGOvuD8r5ldUvYaTZeA4xkBc105rwvaflKByF6ZsiQMQZHhjH7MhJ7WdyKiOm51t+mslNVjrl3jSqjgy/Hwi9gITTX/XfCnFhHKUAztzALyHag0OfKFf/4pUOaA+xQV1rft0RfPvzMCC1u1wVNTwoeE0mrjUEQvQZcb7P4LdDD6e3HFwrNByKixScG6C4YoQUrCqZP9IPHtOrYWXK7D9htacSP76s4IxGveJPiLkpyZSgeBddHfI2XRg5uH6irpOw7pzwrco/iTNB++9FFl5n+yzCIHgxX/C6US5w85aepi0ga1A2jsFTr0+3tDe8g62qY5EgcI2vKhn5btqAqS5PVCMbwgvpGCR1mRbKs7ajN2WUosUWHmEci4+kBLGFJYg3OvToNSxD0IGGvdTTVdjAEgaTHgHl8+IPzaR7SjK/j7acSMjOme4khKGkkVTktQP7J9IyDcvuBjRsPqyq0HBP5pA80dsoBJvKuOWCYReHJdTQt3+f8r/71/l7NMIlq2lRTuN4uMGDTyuyVSv8hRN4+4Zlk5qVRNwp9KQjJMgWgY10C/JlqySZWlaPXs9mfV2qV/ePgDvGg4g5c9e5LhYhgMxadZgf5wPR4lj30Qh+YDM5igWRbU1f+RnjcJGyyHBmjx5IOvrXlX9E/01XDxbIq6gm58oaGcUkfuAue6USu4F6l8Ghuchx2Ek2+RVZEu9nlDF8S4JB/u70GvWyU05b26xw5YMGFKxPsqsn49FymyFUEU9P+h+1javgizsCKE89ItL6HmV7cTFjvtfmM1fnCLnmEinrDM+rgSlvnzdaYtmUJ5mTmMoeYdzmAe01YyZBqKkBPTiLciWo0TEY1v5josCNrzITikS/bw3iyYXaIJIoUZLuPsZXGK+aloMyJqMTc+dsWqubBDJT2Ec3rRP5TXJ838bsWeEwg28SneKt9gAYo5d0BAL5+EN3ph5agLNkoHNqFNSboFVGJ0Wk8LIdJplRF7M44e6RQscXKtNCn1IeDcIqq+Bws/omyalCUS6KM7rMKYKUpyrCeNlfNm9vvgmGyn7JrQoSJcDSB04Ns+oPN/AX0XrNERKG0qPMnw/fyeZgbO8ZxfxCALF5gXa5/xAeHa86fkhS8+vKDA76fsuhfXOQt02ygzjxtHAVBI0tbdAz/vO9YDdlfxu8LI+yq87NvnIlt3Jzxup288JhrNvCyAVP8Bz98Noy7bIJjRmVhqznv8BxQ/XCu2k/OluBw/tXb+cl8lnBZm3Eibd0OYn1DgyWR8UhGjjcecN3hj1Sxkaa1xYb9AcuDGBn1dh4UM0bT8DO1q9FmzTsm70LqgThnEeuFsqdzTy6RO3SFafFNB4S4W0NNIVs8yfdAv+fwJtD40UI3WqlgdCZxgkPUCXloDF7bsIEF+c0MFnlfvX+W3u1ZA9ynC5BqWsDcrkSsbzx+qUuwEBNKniqAFf6kd8bEkJwyYEupJS+neySypwTvDCJFox7W+CZoxm1WJoBgKHvdangg7Z8ftLbL9u97jqfZWRVRIDy935JdRoAa2/BU6e1rgRsFW/qp5bBy8SV0csXDjCgbdTlnrvrcOFAkAUFaCfm1M1tlY+cd/sVp82ulHLcAfkVsyye7Vgu7FreZ9YT9z6SrlptAdewkZqud5Snfq59/ql2yuUJFNtg2k+GQtBOZ71GVvsd0RmfTAEtN2l8+w7VtHjgL+oDPY/ctFv5rx6cc+dZvXcty30A7FGOrH2mo+6BBIRlv0sda2vXlCDL1f4AoQoqfKgC+8IHtwezU1a/2aMgEK6JPNpbpi0PqTZaFurlXkqzXa8JlynL3YGam//Dh9hKMxyK1jfbY9PQHSFKPk7ONktDXpQ9tqPfIXh1am+f/5wjv6ot4ji6LKpE40HgRH9ZYzEMwNjEe1gHqctaKaPnK530D3UMRd9jzsrJJQ1JJm4u/kJJOZPym27MItYQJkeSaKJW0Safq9zMeX8YlTTvhR5ryDMNggW9YMF1AgnySjuSAen4QydI5ZPPGH5GhWfeRdCEGDj0CaT3VVtyTxuMhF2ZDEIhEPPVLisbIeRfHL3H5jXNzZgaoTjvUAeBwQ0VhcDeINqF4dko1/XwQzDyj/1+bZHNvyZQyoZhL5N2ozcavEYwzt/wYSz3qJsCGXZ3tE2hTTcKzSw/vHn+cMzFx2yLFBN+wLOcntRcvr0TrFz0KeDspuh2koqPH77zOcBTDO0hvt1xQ8Uej0j/MvCavwN4rEXGdGsZJm5FDeJMHG9MxsyBcKML7/SMces3ncHEivkX9oZlQqFd5LM2DLj7yIZfvoxVR9vm2EeCDuu1nVgvHoRZxK1dAz6rIB4eZBHRO1RKHaW5xhB42bG7PkTIKw5K6c1ppLey0pTKEQIzpTQdxFg9HH+0L0hVfaXONU10YaBpEM9FHdhDkrQhLVDpSI9he92K+RBkMmlSH+a+6+bORhO9CwB+0NGllB+kNdkBu3bX8h12dWsY7gOdyyDyhuFA5Y1BMxRVdiIvr6LFFKfoOfl6w7c85JzvID06BUvGGp9kfHoKVQ26yh2FlNSh7kwP9hjDP7+M6kPT3zn8tl/uG26qMlqknLjYNo5VpOiI+zf9bGEzW22x7M5GavYjhvi0TftYD1DskBWgnU9v3Ze3liFnnOOijLwg7ZvoPEOKVARAZiV9PivdlGy1Gw2vKciC6mCTpbRUni0nsl4ChMhYgJaxu9QqgZVLDL4DFViBytx2VnpqAG8HAz/MU4I4zsDlo8j4aAaR3iN00adM2cbP317gIhbpslqUu4xOLATG5C9Huvd5iR9g57c71VNLORnlwL/JVK03louW4wPi7qmCbmJ7MkJE4jspnD36mjBGtHCtipTu4pHmfsvUbddKv81hY4eT4VwwtnV5rwXCfe9mCs1PoGNJvGNjw51imhSNqih5imSRw2xEIi/QXynThhkEYhFDda2nc539T9NsOf9yQEGev9+3rOaG0w0hXjnEUu97G71QSlpX/IRRSSjZXmOkU077xZTRv+1/e5XkEmbM4JdNnb+0L65rK98sN6MxjpFd5U579+LkwrKJu4+YlJh61B4UY/gq71bOHgWA1bIGQ7RU65N3pOw3JE7iHiBaxLOz4sBF8Z9ofrku+w1fWYaJI6I2vzy4kQt45csFqM6Ppg+aV6u+fzx2eUOlAKQZhlFli3NvA5rPkFa5dZHAZJlFk/UrsIljh2HVr/+HapzsfMLgN613nKsylELrLZRJa6FqdTVEG3PwqUQc/48SDFn6KD5o6uEQRrY/s4lHgwQE6zxIo+5OSp4guW1Ob6PHOJxt8QswyeVG2hQlUrPf6vr0K77wAPOfjT7fyXAVuQfGnUD54q5qmZX4h/MTuPvbls7PPJUzikLwd+wRZTPDNZSy43oDCY2lkXiw36IwoDQVF/7AWD85O+WgoIQKSqHL9BcqX0PBSx4158JyT+8Zwb0yR/QbGCEnElTD2Ih0+O4wbxZxHs7yuLCZMlvO0qCEzl5eoiCSnsMBBUu/vzC8RBG8Azj0dqQhORtxSkGcI6lhVkxqQrf09gq070UzLpUDDomqotlnKtEElPh5x/pEeqt4TT+VyimVbdf5oXxI3c0avF+CNGgtZWZpS3eKkr4IzBM1AqlDRdlh+Spju+4HjMbnIw+EyAmFNP8X0diB0l9+MrGC+RCLCl75HOWL5Us+sZ4sNHc2JmfaNqoEIHLkM+KaT2nj6LayCaB0iSVhzE9FoAZucBuhnHLKHfCs7E4dxfi3bNut5j1gwheFXQ/hGcTULyw3Qj7LRuGlBuL5P9CkVNO4Fb1RV40U3uSNxB93fVOL+aZZA0/n0Y2Vy0EMxdgUEqHZ7Tqawqnrf3RVWiERuE66e+thnDpvpSilj+2yxbb3n6ALLil5iiRx/mVj1AQmWVui2lNkro4/FxL9hltswZxZ3mN3fbVw2S8pwupuiOT9tzuMQbxunROJW8WJmmdtBZFS34wO34g1Vq2Bu9oDrLQLNK7gKpTrk6H4KxdZisWtC3mCDTYtB7/xbGBDigahefw8UfYOtvTy1N3jj40BaE5R3zj/d9+9HtxtlDaL6AgspSWS1HZzVQjc1m9vsXxSgHL6GJp53bH5r4ge3sUZ+b5lVkH1TqhCgTRKT+sAMikDTVbcKgjiwdmvazR0lwz9VHg+UNemqnUk1pTqqH+gotHK306mi6sWjykgcXC+jbd0PJ5/LscuTJSiMVaIiQCqRuiBLQqbCCWWq1Nha4mJOAShxmRErkcvlpA4YG/aHaLYVVmTocgZviQvSdoQw9HmekQXVx1cBGzOePXokrmiY1Dv109qVFJxL+Vjqz9owYGuQGInoAetxUPIGDPDM/fclWA2d5AchjRFg2mEB2LAc2hZcDkb/JQV0+kn1twlioZCckMBhN6TlBC3QhTejunq2/lq7pIz0K5IPkQGjEEiePWDCNMqV8ugZK6jpRXnZ3OqXpxyHUMewRIEN7vWkme2oODbBQMt4mtSwkJocTt3xjN+goykNcI9Qeau+DBpm31MOKgrWO0xhrWyAdoExOW/OWW1yltc7FhUFl2kmsu78g5w5bMoKwopMh3wlKgDJ/ktANq0OzmfP+2mNsZahjkr1gNyzEs2rkXoA6hiah5cSsrwc3okHle6OFPrNYUI3G5ReysGzS+cq1S3icxfGAqfXU+iPOl3o9CXQg5fXY2ckifpvBL0/s579qmzqCzFsJxSb54ZScNhTXoDNbGxrxAnza6KSoFLz5dhKwr7lEtaWYNWfBt82YxXPS/hxlLX/4mgzbbNf3yGjt7cO+NV2eOpGFP18kEzhjLZdtvzReCZAXa58lQ6eIsZZit7KyxX+mfpfCO8cYmjLN+Mf+MLwFncNcbmMS4pGCvWL76S+LEFPJW4LEnNPczsV6nelbhjvKmzoEuUO12ff62j/p9cJygeYp9Kkdts33NOUatfznEyqP5Q0YMFD0IpHB56ffbyK9Lij244eehQuxQZQvDRK7Jje0zKghfDjtXFX1Dv9peYJGeAXhbaKKRMh4z47xICYO08pjJNFkNTz9t+LyhW1QqP0yrSo5bf8nrf9qxTOpIk5oc05i3EKIVVOFawVSNWP5y9zd4FFqMvqBukk/QgEq/7ap+6oi3QKQ0WTan55s7kiO8YaN+d0IdBdvoxGB8PXYEdXdzPgS5i0eSVUmF7CS59QGr8mJLkq5Ud2xXnS7e55uFnCJgIXpQHG+1/Sln34zLyx0dUS0IKNjBX9Z/3/ykPX/S5JTmHG+yHVPN02RZ13IvY6FCsPCo1y99MNTIpia8Fi1v74msu3g6X0CP375FbiBh30DeOuXilmTJmNFsZ+oW3jseDTb16UGGwWgehwaVWsowr9FrcIhvHGvaRPq9XGBpgT7fuYPgt4bkmOx+2aNRyGqNDwPJq/Us+OOq+lkBwKf7oOgCaSF2Ny5cZMtQ66G7PlUD74CTip/ipUJE43W2UnKlHIjhZjIqgWNmelNHzyyKxRTGib6AMnJeIwQxBkVtPrhhXNWCvcDlJ2lLWDTcLmJaEY5tqXxAK92wXbw/hDKV2f5q68fJeKrvTCu7Ex59zh068aJpY8sEzmCvf7bKor3k5SfcFh8/PXg515RhEEw/8XTEoPCM3tihocS+4+MbpKciu4riQuGnh4aXbqYVhMIzKFXNNL3Wk/9cfo/vdoL0AxajONTFBfv7pREmbobOc3nXGvDdZBYUp02cZ115TCdnX/auIjlDcqfzv6PDGGT38fhcSqkCaJETmCoCh8tocRGSlaAn+XMMyAXR65BeqnRE/dhNrNwh72HTy4zkC/Wke7IE/4RlGHG+zrGQDJpZnUccKyohCeurnDdyLToiDHflDKgorGU66e18yd1xmVnkGnCYGEW05xPv+syeuW0kLnJ3Kv7sc5Thjy0OojRWw5gQKkyfb5S0/Zf36rZhtVgJOrt8ftloVcdx+1gDjvoagRqDtLiP5A5J3rngK8/TRqIeEbnlxT2dfTzntU4H4HqQY/ECxz6R0WPQwZ6DcDCNEiIiEDKmFZPDeRjdU0jlPA1Z0na6bRprKoFdOFenuZBT83KMsFewnuowjoRj+YOS+UfMv1d8ZYTbMlcvU7VB/FEEUq3Brg7xumy8NGEhLbQ8NJbC5w0kvaR2MMOZepwNUlsB4fu7vl3Zthggzn6i3U97qELgwm+aHUcSn/Z3iNMatWFKXgCWnq1/yoPks4640BIj/0Th+r8rj/spKDEnRvWXz8uG2sdkck4AD/7jAKs2dYKMzgS5bIa/Vw/ePK5KuH6vD1IWeuTCOyDKz4T+NHzSROR6NaT3o39aGSf/JKrgQ6PPuyK3UXN4CmhKwz+Isbnbr+XKAaOn5gsQEv7Qyu2OCG3oIWmwNt8TD9zex7McR/Ii+0nFuHJapnFka9GFlC0lIYbFDsabbXe4JXhJnqGChc4ZxtImH7a4RHCts4n1gHYxXvUDmVHthZ7/mK4gCqprDQTTagePj3gjdFclXtal4o830areFcePLQYLWEuFE5FJajIFZhzI8BjM4wbS9e93dmwlw67ihoFJphKoMepDmuA0SnjYPDatJDXWJt+XHT503h+CVyXKavLY0jN9ENlwKSMPoZV1JkI4tPpYAiBLlEymW6fu9aIAauVPYON9PpFgoRPvG+LFPuKK4SX64vpXlxZfYfM1kcJte38ODoS6XJbag94Ee1Cjtmy1RrpH0/4h/Q/MIxMnzgCY/D+oX1BfnX8W4n74/JKJle2yU08qvKU1TkPrY0349nwtStnEqHYLgF5CVkFVoVfyliCXn3qeAj8xGQn/O3xys58PCaT3CFydQeoMStMCbRxLOkrNoRlwYM7QClU92D7JpdFmsUZcBeescdIT1I/7RgzJgKOV09wrtWnz27a6W6i9L7TnQ5QTacSvTUi8k3Fco5U0h7og7+PM39fm8FqklyHOaaw+i/35UFr2/uR5Py05012/B9itSreGo0FE215Har/BBGvQRjeKkuEeKOvOhwrsOS+wlJ3yyxoQUCp0Sa42iuu8PynFIMs0G/9BxWXxSe8sHKOiLR55fKsJbGJHFmqwKbBkWHUKniUs+9P6AaLxqYDoOTFXvmRkcO2jdDouxMBVgyltNbnS5/R6l1UyEIc3J9q7yawK5Q4re6lx/UxLlWXca2XDwZcpfcO6QYHc9wSp2d5d939c+E+kfrVnq6XupWk8Jz9MdWntsIYGv435U1dd+zqLpdnX0mzf/T3rhnPUeFGX/7ao91ZaAUyyfJLicYfu5vlQolTx7zaDp8UNu4X1hP3fD9qZcwuGV1kXbNlolhEegMR77Xz3rjP+j6JHyC3ImpJoGP/Xe17sFKM3BXrFnGENtqo9mCqJjUhKxplgYwmYe7l3dCPQI0ZyWvJ9unNeZCRs/JcapwrzGCAS92mfwqhxcR3mlFFh9Dv9vKvnjfY8ByDqdTYdeWu2vQ7oU++jqUY6DgV3FcLo8oAzWDGMITak6yDAqA1tlvzHnlXMpzMLO2c8nygI2uOXDElSjC6zZwuKumi8GEVGQDDLSCCBs7m6kdNXblAHNdwJNC7msBaBUI+eVmKgN7wKeUt7x2XRTfEvEsFODeFR9IuoySBc8cQ0HRer0cBIFZtbOgQejZ60ldHGFKSHlE5D77lp+ryQOugLw0W3kl0IX56dLhrbzKgOp3feob/PnjuSnwIw542/1+pWy2s2ClD/jqtL2acqms9ni+6H6980toQD99q80uCBZt1dnJyFqi2q/T29ybZqCbILgRbwuEjdVx6xKFEwUK92ScM38v4hP8z0fcyWIpm5q/nmfPVlhxW8LBJlpvP5HQ8mqpwkZtAKhWcCxuG5MgCDj1USmMWXdeIkb32QKwaSeDIITzsothBA/cLMsRMpfi31QhbYZFu/Qj+NN4SdzzNndPe9StsivUB0fw/KE5etiogN/Ty9vL5+RMBM6inbSev+1EZG6Ugmbf50DfPv8NXnP43ARZ7NE7thcWcnrdysRDu7xSk3kGBnITIWO7MrCwpLjGJNvB2TpEKUb6L4FrheW3AiA5QK02vejkPlsZksp4Pf2sKj4VteH/xg26amc+liqTTrCTAUBC0SAEgNPmVFXRqRKtDDld3DciRK+Dz9VHmlpnOJFJqdCiV33y0VrQNJCneSaye8FVV2apddp0U/VL7QXZ3HdMSCibcddZcu0z3I/uA6WdnTt95waMM1kjHX5yepHNqCTjsbVZo+lUTBWTGLOotl75Ud3EXVplkIUAjfsJWVNqQxD29qPlbOit8oFscKNjxEsvmuk72w1S2SbBWPqPCdRWsnZSowylPtIbF4YOdmDhgKtE4k0N9wW5XBoT9oKp4/JMWJaHpnDW5PG6MVEQnJSQw9cw3qV6rPdsF6XPRfQMHIgcBaARgKT4LIFfX8jp2YUD6Lh2no8mmnduPcepYeRA4NAC3/FpqNqZEkasUgJ3LniyDV75QleKcw9oEwlgItcGUpV6SuesI0Z0jT81jlqc8i1THjOn6FNRcO4ozDbV+1SRqlgOjGk+qC7OyqAgImiPRgkgFH3u+BZzdlyzS64aI18QgSi/i5+hd6XiBbjinpaz9w93eV9SNwIqUy8kOcHY2rkqorAfeSJk4rGz3YuGLZmzGNo829QJAQ0WKMY6DYFkIeP/5xoeMpP/9FBugWS3pmV9du8IK5SNcgFugdRQb2qQvcxexee4q4w5Dth+JZZfiYhpvMKJtpoIeZGCG5as8U8h5bsRde/JSZXsTVpHNdNOUoOhRvVQAm05pwnf1ItTCQFZTWQZ93trku7PqInRWb0u44C3SxxrVBpXMeO7G+q9o0oKYJCt0SzfExyQXqHvXtWwYNB3Ds2b4rjKFJBS8R5Jv0OilsYI8ZqZbEPwg5Go/6NBnz2Dza2gfUZVapcEeL4FvfTWWUhMO2sTwXE7+Y3kkMF9vGUfJdY6Egyj2aRXV6TtMvtbHfwSCjqB9e2/VvhmJIJ4P7wZDjdvq2M8ByOgTK/PVdHuBjxUzNxCq9UJjI2+/lsTt9Xx3u9jYMHo4EzVnHfYTdezFn1/18bOaHdrjnttzjgxSNtbnk2guBmf8UGf3MbZrJxKOFx2QiSlRQFaxvbgsT6bCbbSRzxTHt0ODShOsW/6VRnf5dQpUmyW6XwlzClY9ZFASu/GBwPABjYgzbWE5MEJddPKhgFjPk0UBe1APKMbmFHNi315tB/SdEt/fIu/ITMuOQ3F1WJM5eoCjBWIoNETCkTbOvHxh+pALKiAKIWdN1Erz3QTp5dcmqOdeHJ7UkkpNcpU0znTNTU3AmagqkMVCP45EGVFofoBvmD13+CbphEWnwqWy0w55beV/Pa/zKi+oqIrjHngq0HPJ+4qf1Pit2eeho+RrJ5zMqA/cbPK0nef3EqUPJzoFEh+7EPbF48RZJX/laJUn4tDhglNhxaFdIsfI/8KPaJBAALAu4ID9vv22FIU8AowOBDtU4i6yvNXcUWrse/s3ueGGw1xQYTzp2MgySPz8unFw8xOyitrrdWcCVZW8D15F2tlCQCZD5DZDu38sNkb2TLtBlqYArRLTGfECK4DuYlPN2F++ZiRPKlD2eI6pFFodam6nGev48edFhK5U7+IlZRl5EQS18qUWDqr7uFkwgJHqYdjm+eE9t05z0+XOCm7qpEL51gs0IrV/1mGeVPqSaFqbfevhbl7mW24VrrtUiPAetX8GA23HJ8XoYBPZzkZDqJ/Gb0uEOzY3kHlOmCBec4uSm7Vhdmb8euSJyS5ul+lg3+cNDwULdCZzIOPsyplpq4MRJKu05tWfSKp9O2QjwKI5Lu0WVVCm8rFFF5fnDqdQ3KrnZvHA43mu8goqR5wENT6Aev6r6YH6hMJaIH4FK6iMGGP5P8XtZj565eBHylsA/yJu3C+eIwRmRuVwcrBFj/P5iAVDjNSvJ/OdGyO5D/CtHOpdMxFABs7tr01v1bKfNUkXILIWLIW0gaA9hPFDxFhPOjIcFlbXHmh3ROGYeu7jZ6twGula5NNTFK/3WdpIzlwp4DxF1flBQ7EEqWdq//OkHXm1YN8790IKyA8u1XCkoXsGLuA2h8RmlMteBnAV8jrbX56MDjvbP+Ow36twlMaRXDhCG480azDocB4B4euro/C7fX+NAvX+jZBNCcb7GNoowQOCx3vB3lt0ufmLK8aQ0nP7feWxaLqYPIBxO/Bl7yRjGO5YQlpp76P0HwkFHgQTHpz5XQ2GKh/riMuMcT/9bS9kb15Y2GcFPbWLby6MCdH2ucjnhPPoI/61Jqmyuh0435NC7EOidgoOOjniQeO1CQE/XKvBC1NntAHDptvKYggq84/AA08BYyJgiSAJJoXk6tdkpm07tL8UqqKzkhnUJVcO7/2iJ/y8BZ7YAhhvgp7gxF9o0vl5sB8VY8BZNCOa1PjEROmHzyj1sMh+CchFaKjtNkfdxcPlkt54e5lkhUbpC1hc4loCAHjQIk+fYLw8SuMKzVWNeRjZslKBELAex2DjYf91NLwWIZhA0OI73i77TKGkhCzuCOo7wPq0yo68COZ3v4EmVXE4dnm9qqcTpkgA4yNpEk4XFjkkG6xh0Be0sQkOS/2d15DSeMBsVMvJJjs3Tl2ZOYwuEBQLUjLA7lDkW0ZyjXRKSRxeXavY3h1CwZDwNAKOnB9KEPgMF8qbHrC25sKpfAXOU7ZiiVZj5uyeDw31rdy8pssPxbFZ5BhojyauVNfFLuPhhAIiydr8rGWy6zL9T38zXEwkxRF++OCtYVt8icFHXbbom2UjEVXAsvska2uRTS0BOIQVqZEsGMALRCHakYXI6RW595pnxv4lyN23LbesL5gN5dOIGAbNpTjPYc1XUSTGRsQy1VVPtIsgS0HQkfgUwDL7XHMWYqLMWcCRAZ/jPqr5GnAFIMO1vKGFBVl39BIzPYeJ1ISU7PrffMox9B2YgDcARVZ4XBLOrPFOatP9rWQ4OgX3ISmfRn/UtLD0+KSIRVDrKNlc4+WiOOKXNNmktgi9pOjjvv5rqzJvDjxChbYSsM66QipFaLpWwCM6hkLIKvD3LSyitpb3WyHyladK9tNI1EQHeYj+isRtuzLhaeEsrbidjp7Co9TQGc85stmqKpPu9gBcxqJ3beSDedgc3CoVKi0R6qH3ppICZWq8zmqidRpZ2vE2D/h6915YmakmZtquBlMIZt97FvvVLs9mBHW6XdKo1hLS9qCajOqB+dnuniQ49JmpRDqi0R6BUuwqcD/4tW8CAwfy5Zm/l0QCNQDDiJ8+noq/HDzFITbx4iG/Jzy5xQ/ZkxzNy89fAhClkIlxVQXatGKht+5Q6T1UFuqV06kBMdA7K90v7grvW0/V3zSp+O1hMwL2vN62V3vmLZ4q5lbLlJlbZLO2h4uffU19UuC6COPAZO+hrJcZDC2u6fqJVLxi/HPpwc3jkKceYzR61TIxDqMU3f/sjiDqHfSGTiNnKwSpsF+a1flawTHUePU/3UbW/5klJQjG0KTucB4agmvRxdK9nOp3AaMyu5k3v2MzZObsJTE3Jglulsna9eP3JlmX+GeIJTlqyy6TAQBJ4iljvOR+ESr+CYpM5BwQPoFMB8qdgRWi2ATaOjNsOm+xGSmzlYs1XToyMAY92I5kAsAYB44rs8RV3Fl1ywciir8GUOR6YA89dIMXvftUW2II2Lc5jf4gyeX1OlO6uW/CqgRvrQxy8dan/Eu0ZFl7tchaCSCIigW6ywIanbAl3QIkBB7fmfnKh9IDL35e8sErEE5GMFkkpCkUR/hAWXw62hH/j4Gb71llpTyEakRjPVfzDuTuv/pvJzQIgnFNov7YwTKH76dAWxd5rApq7z73RIabqTwIQ4syWCh0O3aDfuuH7WK537sgZZ+7jCCxOLXGtE1LZpWU0ehH8dA9igMzxaZ346nuCTQ1W1GnZ32l3U2feN7AIUZfPXWe38wH+3nMsCKolgvc5H+/Av2nouf+bbHWN3glTeQ/fxbY88YCi9posvb3IgQRM7TZgQtV2tuqREWUAajx+JWfyZY72zoua+hdgXrh1K7T5Dpl1rxD05RCElKn4jNaspCDn2Aj1jxZ2n/7kTyEGFUZVi5ujvNMrTgx9OGR+OQUAAHpfzRpluCOnQDJBuLlIcP+JsbUZCDByQz/C/kWNqIlABA8N/Gvb+iwHS//yxJBp9ug9Z7mc49BFCJIERX4lqKawJuF92ie6NFDaMovk2D0tKpQAn6AICYi+Vazdx34hHmtSCQGwASdc8p/xfphueDX6z5CS19pqVfrOMwY8I1Sa+sWDeTh+bU/ni3w6kUYDLYeo4yxGwp7V/uHLNh3kGFcUr9vPUdNryOCrjzCnutOnVAd9DDmaWiDgwXNax3KXGHs3zNXp3B8YzoY1Vo/dnOMa58PIYR3E3BroHS6xX8GcrFFIx0GYSnO+VdgKEoWI9ZMSb8QG/6JmFD5Bi6kQRIqfOzhX+VMlf5P3FbU6V7iTFZRc34/zJfxqaq1E1lAZOXM3gWRFPpyTXYPGrI7G1lx/UxSKrWCZjXdrkrGB47Qd6yneMRei5JG8/cby32nWYCWk0j98nnNX4rvd3kPEKYxdX9B17IwArwebOGEr5rTxW2GDMzI+3MId3YNU/F1oGDvgLv2ebQI99mh8YOAKpAqJoLJlh2i6LapzHWQy2/+Joa4R7h0XRf2DH5ypgyMS7Qf+OcxuIIR5byEJU0ZotRTkVU3ij2X2YYVI4//a3udiohcCe3Opv2pkVDvKiWwB/5W/HrwpBuLBMXdFJK4NbWQQbNMqulTsiEAHR8x5KIqIeWfJvBxv8MEHndCRRUAclOQak2HLQywkQeLSQ07Ax3tbJr0C2PAvTOarjd7kFFKHSwSr03Pn838DM46GOdjL8gD+Uf/RvL+cqCxnKzN5PIbSjP1aUY3LIrBNIA8O4V1t4WhSTWgyM4xNU0wNIpsBRgz/qTxDX7OqXhO0Qi6OLV+fyivbWm4cOdZ2NKwkbmBkxwBhUM0v/oSyES0TZ/ti5gozoafmIoZW5fv6HujUIFGXPDIovIz+06Md6XftW4rEqxyIjOiUg3eS4+jIleHAiRa5ZWgD4MQiKtk5yojuEivQJXK4SRITj8xpKgsP9byrTU/gubY223QLVT66+wtJBMWyPdwb00RHOAdCqW4JVFQXvOpqbDI5vwkHlHG43Ll1Bo/CDztaWXknjv0Hxdi+gJl/ZzkLKQIrv4X5cz3LwDQTGvCZCuz89QNbzfyVpYZJamdILk9oy4FVNc5caqdynRdc6cYPmhnf9gZdkPOVLaZqzsCLpJtOw4hbDn9kohDyxPt3pFDJ2dmX+ra+mJfVXG4sA1Yaux5DtxZdp6YR86/wdVfupulbEB+y0MFZ/yvWjtWEjmsxIOH6H2AOva410xiorxkYb1fNigoXtwtU9WI4ECBvX1q2RFu1KqpojPhHzLbkkBkChlmFGULyLUGnGP/0Skt5SoEpcLI2msw/L+UofAC/ZwlnoyY29Woy3f2Abmbx7h6zeyaxq2CgeDjLH6QAPdbCFekgPeJrolEwDMMNxuBMTMiz6Of6gHucCzGOoVUMxbNp82G55m7Iyq2bvoZGRvCB9VHurVJzZ6YkVMkXznTTPndeoq3D2omYIMpMnrN8lU5g4WfzBSYZHu25iB+OjX3PVkbBYh6KfX9we5qkByA63UYis2UKmEmqhcgaUpm3m/UXlGQidDeSEeBrF8/DyLkk5PHnlIJgb9+NWRxHXLSy9b7yHh8vXrDHl16nm23y22A83AACECuCnLGOFyJvn/W0Nmk6jN00T6HhU7SVDoW2hHlbxpxgTPwKPuJcW2QqcjzAOZKHYn2akQ4UiQLTfqJNdf8v2RY74ty6eMZjgucDlZAXDV77q6UrXeDmWU7dV/FFAaIcmz+FIAo5e/6GTvDJZb86q5k32Na3XUiq3JtA5ezXrfexf2GQ412InLTdGbgJ3h66bFV99oe6kdJLi3YuwQyuYVYaoVQ0oY7dfBEH6GuYVjrzL/VJ8ahsoaXpytnssDfl2ScKhrr31lpIeCOvk83FlUzzPSPuHWdQECRP8PZ449o2LEsdU9SsjGDwgoszOhlkracmBoA6xfYIWgO0EyJH5TwqlgHANJ+sTtCI5GhDj/9hScjd/OVwmOEpu2WZmVMpxuwjqb/R/hk0mb8LI1fulWu0Fkfu5MHw/rs/KrHHoCfZhTPSLvifDhfep3Gd5+jm497heqyffSnWxxujExXwkRfJ2RO017WTIItSgKks3+m0yXgEsQBHmKpjJQJfOSWsqMP3h0PoQHA0M7kj5AoKJD6VVYJ+5QZnG+K9NByA5xf/UFJBgl3UloBrION5rXaOO+IiyG+bZof9tglj7i46zf6jKIfgKhYAbvvZ8MCCnviXsSP2sKqzi01hULFOmwvWWR352TkyY4OAO3PvyCqxubF3e7LigTtCCQN/+C0t8UPnGBazqp3ZZNBPgY+qbcMWCtnCQWVAmZ/GQF08F4oxPYsOLDDd6Z11ck8a1P+8Dc9WJLqhn63qg3Le48A+7dRgC5Lbgz1Kqm6j45Zg0RPqNzZvbowBE+BH8E8p7XjRsCfal5KmUUnYtv9UXv628f95A01U6Ven1SQrRno7ilw8Vn54RLv4JfFUekI1Vgo0PLewMuc2apigck79u0b1kbwx5CmAZ/2Zf2iiviIaiEd5SsZbwW5kQidhNJSpVkj86mwUQgEUmkdY4YKsfVk5377uWQi5M/Mxm9j3N+1S1RQIyksP393hAK1wwfUh4iUodKLLJegdEzJGpHMwmyWXPA5zjFhfAjQh3HFTXyc1MnrVAerNIvcjljkI70jc+1MXasFyoMO1GRTwtdIW8CPynZn2hE9uTZb+kA0cLV4jn3gz7iruxradM4V9YXAAOmGIlzXKzWmIglIPWa+snIsHXto8U9ciy6aBoo5bTAfG59aymGvKYcvIraEhKW30EUTzrpUT6oGGFTEYYTZzbE1jkiOpxhpfVZ21EJDqD5297ySPhjXXAglEQqiVTfjd9Q1yWvj4Yxd+muBGy80dpDAGSDtqlhR5owOpJQA42Qnlxyhrl26XiBizrX3Y1hwkLyBI66FBOv5lbKHGZEn8CIQgqu16fcdj2Nz3jWp6EGdKKE3uAKLYjmYa8i4ib7Mg0gTw8Kg3k3bEYslOA8WcquKJFzBDkbIkk6lVwFivi8eMGWix52l81iPuKToStdjEgmRLArOwPj6JqVdgyVYEhHHvKaEgKhEm/b4R+cBCOtuJ1MeRVJNL0USeDXiWKNidp69uOYU5S5VXKZc60DfakOz7IbMYVUylK/l/qqfV1P6vX9BEsYgGIBjRQMg2cGekQ2RS5IVrHq+1aa1n8APQOZnT8EpRiY8arCS/XMXnNZtLaqCVGXEM7GE/iGt7M4qlwl+42FoNAF8vVyV+mnGchV4ajm0cZEO43nfxTswa6KvCSIlYchEhwO6QVmaog4/myFElLkgYe1M2Wzdwh/fjnDSfyzVHr7CJXiYxnyNg3kiqOiV2LafJkA/Uf7PrC9ml7erM2yH796TRhL7tNzShNUFAc3e3uRN1KmxyCVicvcWTwmUPWawmq65shABSPyfPVsjV5NuHWXbifqDRjy/h3y3LZEmZrbpTiVC8uWo59goVZs+kUSyJ2+Z+kmSAqRO6SOiQxJsqz+g44Xh5sk6jNwdpkPqKI8PeDUoHw/D0nKxjOaVPChvTPb0iGp9HpDeDyPYj9ptNAJZhHqXfqHdT34GIfr+9hpk7maB3vxwwR29RbR/0oxpkLZs6ZXQl3Ezevji3UULGOoE3Xsa6urvl/riFbTjQV+guaOLAGjCkVccTlMM84haMwvPxwujULELL6mBQ8kwa9mQZ6prjjjziY3rojiJISVOYUNxNVLnzl01Erd+bZeYOTjjMQC0I8l4iO0C/DP4nhxEFwij+qXkrC/S2hg1lBchiviHI2DOr0fN9P9BU5Q24mTDQ/qA5B7X6TQlflMRzm12LBSngyNL5Vq2Py+xwKTIwyD66F5sFjr3dwYhjS58vS+ZOctDauZKouAWQCuBI43VxTFil4260deVHmJLZ3xSdHOhLkrPWQ7DVSn2XNvkj1TVC+GvShaQLvjgwC09F3RrBI6XuKK0zFhckeTXP50l4p0d9Qqmp1Ki6vxifBokYMCnoL6QPXOhAz05tgyTtZf5+USo7ZjM1BMTl0mvPMatSNkafNQhsN7xVlCKg2B4pSM91gE6jOxtw87HRvK0OtToi4+Pyd6M5DP6RIqjSRsU3AQYOyFv7kMrnGx9xqY3ANCVil2q92X0eo3p217EDPOI05tcniY6Tb1N3J7hpIGOwIeh7FmqbQ/E/hKxdKsU1Iv6tMT32oirqsFn/dZu0gH9p+1cS499yetuow/DXucdrZVpPk8gi/ZhWgQUZgdWk05+fnmn92o7jt8vvB92PzA5R513A3/7TOTmp6v77ksEWvSIY9cpotjIHfeMGxNBX7entHAicjpIbbYfwoyld6d7JvUj4ddSRYC0V4hOIbKTIUszaY5IBl14pBtdznwqDWOlwgTOcsMCdgiFtR0xguZZNhQ4/KndtP6cjxOw2ajq7ZvfBKt0KegEK0gXqbu2cDq+wtnPBOvWtMSZKTntU2oOor1iv1SHnWlj3xkg5WBqRYMj7RbBMOJgDJ1yGl8Rj3NP22r2UjvHn/e0ohfbr0B1Zufpv3y6RGQAnXzizyWLu+jZWps/EO5gcpYxOQbjnQrmgBuXFdOrMSg0sKioEStwWpDkvtD4b5G+l48l69smPClxHceKMPizfm99Sxt+uSrjqnSC/F4LVo8uHfzurXEGfbgIyLfEFevmBEjPNwLRTiey94Th+L7p0sVKNh7vaLJKVhOtQ708rTKyjL49jvALHUBFTlIfOqWRSidpvQKj/iGYiGvyCnaGq38CpSNjbZa07z3+eh7ddVAQ8QzD40i89sBjUAVkwIpaM8B4JvG0WykBs7QC6k+SjLy8D8t+HDqQsFCAL4xo4qz0lgZJn9tffUXaTivMtMJ40cH8Fy60W/HcMdgVOb1cABNRpAd5cdIbrgrOVfc0B7eWcWe9f0GPJWaAAA=',
      avatar: 'data:image/webp;base64,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',
    }

    /** Plugin context captured at apply time: gives access to uiWorkspace. */
    let appContext = null

    /**
     * Resolve a service from the slot-injected props.
     *
     * A missing service must degrade, never take the panel down.
     */
    function service(services, name) {
      try {
        return services?.getService?.(name) ?? null
      } catch {
        return null
      }
    }

    /** Workspace records known to the app, as a plain array. */
    function workspaceRecords(services) {
      try {
        const workspaces = service(services, 'workspaces')
        const snapshot = workspaces?.list?.getSnapshot?.() ?? workspaces?.list?.() ?? []
        return Array.isArray(snapshot) ? snapshot : []
      } catch {
        return []
      }
    }

    /**
     * Open a session in the code workspace and prefill its draft.
     *
     * The prompt is written into the composer, never sent: the user keeps the
     * hand on the send button.
     */
    async function openMissionSession(services, prompt, workspaceId, workspaceRoot) {
      // The reference implementation: resolve the workspace record, then let
      // uiWorkspace create, attach and open the session in one gesture.
      const ui = service(services, 'uiWorkspace')
      const records = workspaceRecords(services)
      const target =
        records.find((record) => record?.path === workspaceRoot) ?? records[0] ?? null
      // The host resolves the id even when the client cannot list workspaces.
      const id = target?.workspaceId ?? target?.id ?? workspaceId

      // Reference path: startSession creates, attaches, opens and prefills in one
      // gesture — the prompt goes into the composer, nothing is sent.
      //
      // It is the only call: connectWorkspace would first create a blank session
      // for startSession to re-target, which costs a Host round-trip and leaves
      // nothing behind.
      if (ui && typeof ui.startSession === 'function' && id) {
        try {
          ui.startSession(id, { prompt })
          return {
            sessionId: null,
            prefilledBy: 'uiWorkspace.startSession',
            openedBy: 'uiWorkspace.startSession',
          }
        } catch (error) {
          return { sessionId: null, prefilledBy: null, openedBy: null, uiError: error?.message ?? String(error) }
        }
      }

      const sessions = service(services, 'sessions')
      if (!sessions || typeof sessions.create !== 'function') {
        throw new Error('the sessions service is not reachable from this panel')
      }

      const created = await sessions.create(workspaceId ? { workspaceId } : {})
      const sessionId = typeof created === 'string' ? created : created?.sessionId
      if (!sessionId) throw new Error('the session was created without an id')

      let prefilledBy = null

      /** Write into the composer through whichever surface actually answers. */
      const prefill = (binding) => {
        const session = binding?.session
        const candidats = ['conversation', 'uiConversation', 'conversation.input']
          .map((nom) => service(services, nom))
          .map((valeur) => valeur?.input ?? valeur)
          .filter((valeur) => valeur && typeof valeur.requestDraftInitialization === 'function')

        for (const candidat of candidats) {
          try {
            candidat.requestDraftInitialization(binding, { prompt, whenDraftExists: 'replace' })
            return 'conversation.input'
          } catch {
            // try the next surface
          }
        }
        if (typeof session?.requestDraftInitialization === 'function') {
          try {
            session.requestDraftInitialization({ prompt, whenDraftExists: 'replace' })
            return 'session.requestDraftInitialization'
          } catch {
            // fall through
          }
        }
        if (typeof session?.setDraft === 'function') {
          try {
            session.setDraft(prompt)
            return 'session.setDraft'
          } catch {
            // fall through
          }
        }
        return null
      }

      await sessions.using(sessionId, { source: 'missions' }, async (reference) => {
        prefilledBy = prefill(reference?.binding)
      })

      if (!prefilledBy && typeof sessions.binding === 'function') {
        prefilledBy = prefill(sessions.binding(sessionId))
      }

      if (!prefilledBy) {
        // The composer is out of reach: put the brief on the clipboard instead of
        // losing it, and say so.
        try {
          await navigator.clipboard.writeText(prompt)
          prefilledBy = 'clipboard'
        } catch {
          // nothing else to offer
        }
      }

      // Navigation is a separate service: creating a Session does not open it.
      // Try every surface that could take the user there, and say which one did.
      let openedBy = null
      for (const nom of ['uiWorkspace', 'workspaceNavigation', 'navigation']) {
        const surface = service(services, nom)
        if (surface && typeof surface.openSession === 'function') {
          try {
            surface.openSession(sessionId)
            openedBy = `${nom}.openSession`
            break
          } catch {
            // try the next surface
          }
        }
      }

      return { sessionId, prefilledBy, openedBy }
    }

    const LIST_URL = 'missions/api/list'
    // The creation form: the options one read at open, the epics of the chosen
    // project, then the canonical payload. The host validates and the tracker
    // writes; the panel never names a tracker field.
    const CREATE_URL = 'missions/api/create'
    const CREATE_EPICS_URL = 'missions/api/create/epics'
    // The Done tab's badge reads this count at mount. The closed lines stay on
    // demand, behind `?done=1` on the list route above.
    const DONE_COUNT_URL = 'missions/api/done/count'
    const DECLARE_URL = 'missions/api/branches'
    // The outline reads every declared checklist once, when the tab opens: a
    // short cache on the host serves the second open, not the first keystroke.
    const CHECKLIST_INDEX_URL = 'missions/api/checklist-index'
    const BLOCKED_URL = 'missions/api/blocked'
    const PRIORITY_URL = 'missions/api/priority'
    const POINTS_URL = 'missions/api/points'
    // A pin is this checkout's reading order, not a tracker field: the host
    // writes `missions/pins.yml` and the list lifts the mission to the top.
    const PIN_URL = 'missions/api/pin'
    // The pushpin of a pinned row: a crossbar, a stem, the body, the point.
    // The drawer's button draws its own, wider, from `ActionIcon`.
    const PIN_MARK_PATH = 'M6 2h4M8 2v4M5.3 6h5.4l-1.1 3.4H6.4L5.3 6ZM8 9.4V14'
    // The one gesture that deletes a branch: it sends a key and the host owns
    // the proof, the refusals, and every writing command.
    const LOCAL_CLOSE_URL = 'missions/api/local-close'
    // Archiving moves a done mission's folder out of Done: the host checks the
    // tracker, the panel only sends the key.
    const ARCHIVE_URL = 'missions/api/archive'
    // The batch archive moves what the Done list shows in one request: the
    // panel sends the keys it rendered, the host proves each one `done`.
    const ARCHIVE_BATCH_URL = 'missions/api/archive-batch'
    const JOURNAL_URL = 'missions/api/journal'
    const CHECKLIST_URL = 'missions/api/checklist'
    // The Tolgee import reads the branch's diff and writes the XLIFF in the
    // mission folder: Tolgee itself is never called, the file is the deliverable.
    const TOLGEE_URL = 'missions/api/tolgee'
    const WORKFLOWS_URL = 'missions/api/workflows'
    const WORKFLOW_MODEL_URL = 'missions/api/workflows/model'
    // The playbook pages: the list the section shows, then the page the editor
    // reads and writes. A save carries the version it read, and the host
    // applies the CLI's own rules before writing — the panel never judges.
    const PLAYBOOKS_URL = 'missions/api/playbooks'
    const PLAYBOOK_PAGE_URL = 'missions/api/playbooks/page'
    const REPOSITORIES_URL = 'missions/api/repositories'
    // The dashboard's digest of the root: the same scan, answered from the
    // host's five-minute memory. Its `refresh=1` query is the section's Retry.
    const REPOSITORIES_SUMMARY_URL = 'missions/api/repositories/summary'
    // The tab badge reads this one at mount: the count costs no git process,
    // where the list above pays two calls per entry.
    const REPOSITORIES_COUNT_URL = 'missions/api/repositories/count'
    const REPOSITORY_URL = 'missions/api/repositories/detail'
    const REPOSITORY_HISTORY_URL = 'missions/api/repositories/commits'
    // The one write of the tab: bring a worktree's branch back into its main
    // checkout. A refusal answers 409 with the sentence that says why.
    const REPOSITORY_ADOPT_URL = 'missions/api/repositories/adopt'
    // The tab's other write: delete a worktree's folder and keep its branch.
    // It asks twice when the folder holds ignored entries, then posts again.
    const REPOSITORY_REMOVE_URL = 'missions/api/repositories/remove'
    // The tally of the panel's own gestures. One POST per gesture, never an
    // await: counting is a side note, never a step of what the user asked for.
    const USAGE_URL = 'missions/api/usage'

    /**
     * One gesture, counted — and nothing else.
     *
     * The POST is fired and forgotten: a tally that could refuse a click, or
     * hold it, would be a toll on the panel. No await, no error path, no state;
     * and if `fetch` is missing, the gesture still happens.
     */
    function track(element, detail) {
      try {
        if (typeof fetch !== 'function') return
        const name = detail === undefined || detail === null || detail === ''
          ? null
          : String(detail).slice(0, USAGE_MAX_DETAIL)
        const body = name === null ? { element } : { element, detail: name }
        const posted = fetch(USAGE_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // A gesture that leaves the panel — opening a session, a ticket —
          // must still be counted after the page it was made on is gone.
          keepalive: true,
        })
        if (posted && typeof posted.catch === 'function') posted.catch(() => {})
      } catch {
        // Counting never breaks the gesture it counts.
      }
    }
  // L'ordre de la méthode, connu avant que le serveur ait répondu : il valide
  // l'étape que la session a laissée ouverte.
  const WORKFLOW_STEPS = ['cadrage', 'execution', 'review', 'cloture']
  const WORKFLOW_KIND_LABELS = { etape: 'étapes', statuts: 'statuts' }
  const WORKFLOW_FORM = { title: '', description: '', kind: 'etape', local: false }
    const REFRESH_MS = 60000
    // The pointer rests this long before the bubble opens: fast enough to read
    // as an answer, slow enough that crossing the row opens nothing.
    const TIP_DELAY = 120

    const STATE_LABELS = {
      'to-refine': 'to refine',
      ready: 'ready',
      'in-progress': 'in progress',
      'in-review': 'in review',
      'ready-for-prod': 'ready for prod',
      done: 'done',
      unknown: 'unknown state',
    }
    const TYPE_LABELS = { bug: 'bug', story: 'story' }
    const TYPE_OPTIONS = [
      { id: 'bug', name: 'Bug' },
      { id: 'story', name: 'Story' },
    ]
    const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }
    // Le repère de priorité : le nombre de barres allumées porte le niveau.
    const PRIORITY_LEVELS = { low: 1, normal: 2, high: 3 }
    const PRIORITY_BARS = [
      { x: 0.5, y: 7, height: 4.5 },
      { x: 4.5, y: 4, height: 7.5 },
      { x: 8.5, y: 1, height: 10.5 },
    ]

    // Each tab declares what it reads: the tracker tabs share one read, so one
    // failure speaks for both. `badge` names the count the tab carries: the
    // open missions the list already holds, the root's repositories, read on
    // its own route, or the declared closed missions, counted at mount by their
    // own route. Done also reads the tracker, in its own perimeter — closed
    // missions the machine declares, with a bar and a read of their own, paid
    // when the tab opens.
    // Settings reads neither the tracker nor the open list: its sections carry
    // their own source, so no perimeter is declared here.
    const TABS = [
      { id: 'dashboard', label: 'Dashboard', source: 'tracker' },
      { id: 'missions', label: 'Missions', source: 'tracker', badge: 'missions' },
      { id: 'done', label: 'Done', source: 'tracker', badge: 'done' },
      // The repositories tab reads the host, not the tracker: it declares its
      // own source, so it never wears the tracker's banner.
      { id: 'repositories', label: 'Repositories', source: 'host', badge: 'repositories' },
      // Settings gathers the views that read neither the tracker nor the open
      // list: each section below declares its perimeter instead.
      { id: 'settings', label: 'Settings' },
    ]

    // The views Settings gathers, in the order the navigation shows them: a
    // section's `source` is the perimeter the panel reads for it, so the banner
    // and the 60 s tick follow the section, never the Settings tab.
    const SETTINGS_VIEWS = [
      { id: 'usage', label: 'Usage', source: 'host' },
      { id: 'workflows', label: 'Workflows', source: 'files' },
      // The playbook is the method itself: the five pages a session reads and
      // the panel can now edit, next to the workflows that name them.
      { id: 'playbook', label: 'Playbook', source: 'files' },
    ]
    const SETTINGS_IDS = SETTINGS_VIEWS.map((entry) => entry.id)

    // A widget shows this many rows at most, then hands the rest to the list:
    // the dashboard answers "what now", it is not a smaller copy of the list.
    const WIDGET_ROWS = 10

    // What the tab state may hold: the ids the bar actually renders, so a
    // stored tab that no longer exists falls back to the first one.
    const TAB_IDS = TABS.map((entry) => entry.id)

    // The drawer keeps its own sections: the panel tabs above switch views, these
    // switch what a single mission shows. 'details' is the resting tab.
    const DRAWER_TABS = [
      { id: 'details', label: 'Details' },
      { id: 'journal', label: 'Journal' },
      { id: 'checklist', label: 'Checklist' },
    ]

    // The repository drawer has its own sections: the repository as a whole
    // and one branch's history.
    const REPOSITORY_TABS = [
      { id: 'details', label: 'Details' },
      { id: 'history', label: 'History' },
    ]

    const THEMES = [
      { id: 'default', label: 'Default' },
      { id: 'manga', label: 'Naruto' },
    ]
    const THEME_KEY = 'missions.theme'

    /** The persisted theme; a storage failure must never take the panel down. */
    function readTheme() {
      try {
        if (typeof localStorage === 'undefined') return 'default'
        const stored = localStorage.getItem(THEME_KEY)
        return THEMES.some((theme) => theme.id === stored) ? stored : 'default'
      } catch {
        return 'default'
      }
    }

    /**
     * The session storage the filter bar lives in, or null.
     *
     * Session storage is the app's lifetime: the bar survives a view switch and
     * a reload, and the window closing is what clears it. A storage that is
     * missing or throws leaves the panel working, on the empty bar.
     */
    function filterStorage() {
      try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage
      } catch {
        return null
      }
    }

    const CSS = `
.missions-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; line-height: 1.5; }
.missions-head { display: flex; align-items: center; gap: 12px; padding: 24px 28px 0; flex: none; }
.missions-title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.015em; }
.missions-scope { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12px; }
.missions-actions { margin-left: auto; display: flex; gap: 8px; }
.missions-btn { height: 30px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary, #4a4a4a); font: inherit; font-size: 12px; cursor: pointer; }
.missions-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-btn:disabled { opacity: .55; cursor: default; }
.missions-tabs { display: flex; gap: 24px; margin-top: 16px; padding: 0 28px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); flex: none; overflow-x: auto; scrollbar-width: none; }
/* A third tab plus its badge can outgrow a narrow panel: the row scrolls instead of clipping a label, and the bar it would draw is hidden. */
.missions-tabs::-webkit-scrollbar { display: none; }
.missions-tab { height: 36px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 12.5px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.missions-tab:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); border-bottom-color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-tab-count { min-width: 18px; padding: 0 5px; border-radius: 9px; background: color-mix(in srgb, currentColor 10%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; font-weight: 500; text-align: center; }
.missions-tab-count-loader { display: inline-flex; align-items: center; justify-content: center; height: 1lh; }
.missions-tab-count-loader svg { display: block; animation: missions-tab-count-spin 1.1s linear infinite; }
@keyframes missions-tab-count-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .missions-tab-count-loader svg { animation: none; } }
/* A tab's drawing sits in front of its label, 16 px high, taking the tab's own
   colour: a selected tab inks its icon too. */
.missions-tab-icon { flex: none; display: block; }
/* Settings: a vertical list of the views that read nothing tracked, then the
   section itself. Both columns start at the top; the nav never scrolls alone. */
.missions-settings { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 20px; align-items: start; padding-top: 8px; }
.missions-settings-nav { display: flex; flex-direction: column; gap: 2px; padding: 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 10px; }
.missions-settings-tab { display: flex; align-items: center; gap: 8px; height: 31px; padding: 0 9px; border: 0; border-radius: 7px; background: none; color: var(--dsw-alias-label-secondary, #4a4a4a); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.missions-settings-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-settings-tab[aria-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 8%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-settings-tab:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-settings-panel { min-width: 0; container-type: inline-size; }
/* The Usage tab's note moves inside its section: a note under the report, not
   a second column that would steal the width of the graph next door. */
.missions-settings-note { margin-top: 18px; padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 9px; }
.missions-settings-note-text { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; line-height: 1.5; }
/* A narrow panel keeps the two sections reachable: the nav folds above them. */
@media (max-width: 860px) {
  .missions-settings { grid-template-columns: minmax(0, 1fr); }
  .missions-settings-nav { flex-direction: row; flex-wrap: wrap; }
}
.missions-toolbar { display: flex; flex-direction: column; gap: 10px; padding: 16px 28px 0; flex: none; }
.missions-toolbar-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
/* The view's own command: one icon, its name carried by aria-label and data-tip. */
.missions-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #4a4a4a); cursor: pointer; }
.missions-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-icon-btn:disabled { opacity: .55; cursor: default; }
.missions-icon-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-icon-btn svg { display: block; }
/* The panel's one tooltip: a layer at the root, placed from the trigger's box
   and kept inside the panel's, so neither the list's scroll nor the drawer's
   clips it. It never takes the pointer: the trigger underneath keeps the
   hover. An icon whose button can be disabled sits in a wrapper, because a
   disabled control receives no pointer event at all. */
.missions-tip { position: absolute; z-index: 40; max-width: 260px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2, GrayText); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, Canvas); color: var(--dsw-alias-label-primary, CanvasText); font-size: 11.5px; line-height: 1.45; box-shadow: 0 6px 16px color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 16%, transparent); pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(2px); transition: opacity .1s ease, transform .1s ease; }
.missions-tip[data-side="top"] { transform-origin: 50% 100%; }
.missions-tip[data-side="bottom"] { transform-origin: 50% 0; transform: translateY(-2px); }
.missions-tip[data-shown="true"] { opacity: 1; visibility: visible; transform: none; }
@media (prefers-reduced-motion: reduce) { .missions-tip { transition: none; } }
/* The wrapper of a gesture that can be disabled: it is what receives the
   pointer and the focus, the button keeps its look and its place in the row. */
.missions-tip-anchor { display: inline-flex; flex: none; }
/* The batch archive: the list's gesture, wider than an icon because its label
   carries the number of rows it names. Armed, it keeps the danger family of
   the drawer's archive so the second click reads as the one that moves. */
.missions-batch-btn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #4a4a4a); cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
.missions-batch-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-batch-btn:disabled { opacity: .55; cursor: default; }
.missions-batch-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-batch-btn svg { display: block; }
.missions-batch-btn--armed { border-color: transparent; background: var(--dsw-alias-label-danger, #b42318); color: #fff; }
.missions-batch-btn--armed:hover { background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 86%, #000); color: #fff; }
.missions-batch-note { margin: 8px 2px 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary, #4a4a4a); }
.missions-batch-note--error { color: var(--dsw-alias-label-danger, #b42318); }
.missions-icon-shuriken { animation: missions-shuriken-spin 7s linear infinite; }
@keyframes missions-shuriken-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .missions-icon-shuriken { animation: none; } }
.missions-icon-seal { animation: missions-seal-stamp 6s ease-in-out infinite; transform-box: view-box; transform-origin: center; overflow: visible; }
@keyframes missions-seal-stamp {
  0% { transform: scale(1.32) rotate(-10deg); }
  6% { transform: scale(.95) rotate(0deg); }
  12% { transform: scale(1) rotate(0deg); }
  50% { transform: scale(1.32) rotate(10deg); }
  56% { transform: scale(.95) rotate(0deg); }
  62% { transform: scale(1) rotate(0deg); }
  100% { transform: scale(1.32) rotate(-10deg); }
}
@media (prefers-reduced-motion: reduce) { .missions-icon-seal { animation: none; } }
/* The stamp: the pen's gesture, replayed by the drawing's key after a
   successful write — the click lands before the list moves. The wrapper
   presses in then springs back; the pin itself drops and straightens. */
.missions-pin-icon { position: relative; display: inline-flex; }
.missions-pin-icon--stamped { animation: missions-pin-stamp 340ms cubic-bezier(.2,.72,.3,1) both; }
@keyframes missions-pin-stamp {
  0% { transform: scale(1); }
  28% { transform: scale(.88); }
  62% { transform: scale(1.07); }
  100% { transform: scale(1); }
}
.missions-pin-icon--stamped .missions-icon-pin { animation: missions-pin-drop 340ms cubic-bezier(.2,.72,.3,1) both; }
@keyframes missions-pin-drop {
  0% { transform: translateY(-3px) rotate(-9deg); }
  55% { transform: translateY(0) rotate(2deg); }
  100% { transform: translateY(0) rotate(0deg); }
}
/* The click's ring opens around the button, then dies out. Its box is the
   button's (the icon sits 9.5 px inside it), so it reads at the same size. */
.missions-pin-icon--stamped::before { content: ""; position: absolute; inset: -9.5px; border: 1.5px solid currentColor; border-radius: 9px; opacity: 0; pointer-events: none; animation: missions-pin-ring 340ms ease-out both; }
@keyframes missions-pin-ring {
  0% { opacity: .4; transform: scale(.94); }
  60% { opacity: .16; }
  100% { opacity: 0; transform: scale(1.32); }
}
@media (prefers-reduced-motion: reduce) {
  .missions-pin-icon--stamped { animation: none; }
  .missions-pin-icon--stamped .missions-icon-pin { animation: none; }
  .missions-pin-icon--stamped::before { animation: none; }
}
/* Planted, the pin sways on its mark, and a quiet ring passes at the end of
   each cycle: the drawing moves, the row does not. */
.missions-action--pinned .missions-icon-pin { animation: missions-pin-sway 3.6s ease-in-out infinite; transform-box: view-box; transform-origin: center; overflow: visible; }
@keyframes missions-pin-sway {
  0%, 100% { transform: rotate(-4deg); }
  50% { transform: rotate(4deg); }
}
.missions-action--pinned .missions-pin-icon::after { content: ""; position: absolute; inset: -9.5px; border: 1.5px solid currentColor; border-radius: 9px; opacity: 0; pointer-events: none; animation: missions-pin-ping 3.6s ease-out infinite; }
@keyframes missions-pin-ping {
  0%, 66% { opacity: 0; transform: scale(.96); }
  70% { opacity: .32; }
  100% { opacity: 0; transform: scale(1.34); }
}
/* Stamped and pinned at once: the fall finishes, then the sway takes over.
   Without this rule the sway (declared later, same specificity) would cancel
   the fall on the pinning gesture — the two would never compose. */
.missions-action--pinned .missions-pin-icon--stamped .missions-icon-pin { animation: missions-pin-drop 340ms cubic-bezier(.2,.72,.3,1) both, missions-pin-sway 3.6s ease-in-out 340ms infinite; }
@media (prefers-reduced-motion: reduce) {
  .missions-action--pinned .missions-icon-pin { animation: none; }
  .missions-action--pinned .missions-pin-icon--stamped .missions-icon-pin { animation: none; }
  .missions-action--pinned .missions-pin-icon::after { animation: none; }
}
.missions-search { flex: 1 1 240px; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12.5px; }
.missions-search input::placeholder { color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.missions-select { position: relative; display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 8px 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #4a4a4a); font: inherit; font-size: 11.5px; max-width: 300px; cursor: pointer; }
.missions-select-label { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.missions-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-select svg { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-select[data-active="true"] { border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 32%, transparent); background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 3%, var(--dsw-alias-bg-layer-1, #ffffff)); }
.missions-select[data-active="true"] .missions-select-value { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-select:focus-within { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-select:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-select select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.missions-clear { flex: none; height: 30px; padding: 0 6px; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.missions-clear:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
/* Statut et priorité prennent plusieurs valeurs : un bouton ouvre leur menu. */
.missions-multi { position: relative; display: inline-flex; }
.missions-status-menu { position: absolute; top: calc(100% + 5px); left: 0; z-index: 30; min-width: 216px; padding: 5px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: 0 12px 28px -10px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.06); }
.missions-status-list { margin: 0; padding: 0; list-style: none; }
.missions-status-option { display: flex; align-items: center; gap: 8px; height: 27px; padding: 0 7px; border-radius: 6px; font-size: 11.5px; cursor: pointer; }
.missions-status-option:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 6%, transparent); }
.missions-status-option input { flex: none; width: 13px; height: 13px; margin: 0; cursor: pointer; }
.missions-status-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-status-count { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.missions-status-option[data-state="urgent"] input { accent-color: #cf222e; }
.missions-status-option[data-state="high"] input { accent-color: #bf8700; }
.missions-status-option[data-state="normal"] input { accent-color: #0969da; }
.missions-status-option[data-state="low"] input { accent-color: #7a7168; }
.missions-status-actions { display: flex; gap: 14px; margin-top: 4px; padding: 6px 7px 2px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.missions-status-actions button { padding: 0; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 10.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.missions-status-actions button:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-switch { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 4px; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; cursor: pointer; }
.missions-switch-track { position: relative; display: inline-block; width: 28px; height: 16px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 10%, transparent); transition: background .15s ease, border-color .15s ease; }
.missions-switch-thumb { position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1, #ffffff); box-shadow: 0 1px 2px rgba(0,0,0,.18); transition: transform .15s ease; }
.missions-switch[aria-checked="true"] .missions-switch-track { background: var(--dsw-alias-label-primary, #1f1f1f); border-color: transparent; }
.missions-switch[aria-checked="true"] .missions-switch-thumb { transform: translateX(12px); }
.missions-switch:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { .missions-switch-track, .missions-switch-thumb { transition: none; } }
.missions-errors { display: flex; flex-direction: column; gap: 6px; padding: 14px 28px 0; flex: none; }
.missions-error { display: flex; gap: 8px; padding: 8px 10px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, #cf222e 10%, transparent); border: 1px solid color-mix(in srgb, #cf222e 35%, transparent); }
.missions-error b { font-weight: 600; }
/* The banner owns the retry: while it shows, the toolbar's icon is gone. */
.missions-retry { align-self: flex-start; height: 26px; padding: 0 10px; border: 1px solid color-mix(in srgb, #cf222e 45%, transparent); border-radius: 6px; background: color-mix(in srgb, #cf222e 8%, transparent); color: #cf222e; font: inherit; font-size: 11.5px; cursor: pointer; }
.missions-retry:hover { background: color-mix(in srgb, #cf222e 16%, transparent); }
.missions-content { display: flex; flex: 1; min-height: 0; align-items: stretch; }
.missions-body { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 6px 28px 32px; }
.wf-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 0 14px; }
.wf-steps { display: flex; gap: 6px; flex-wrap: wrap; }
.wf-step { height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.wf-step[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); border-color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.wf-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #7a7168); margin: 0; }
.wf-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: start; }
.wf-canvas-wrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; background: var(--dsw-alias-bg-base, #fbfaf8); padding: 4px; }
.wf-canvas { display: block; }
.wf-node { fill: var(--dsw-alias-bg-base, #fbfaf8); stroke: var(--dsw-alias-border-l2, rgba(0,0,0,.18)); stroke-width: 1; }
.wf-node--geste { cursor: pointer; }
.wf-node--geste:hover { stroke: var(--dsw-alias-label-primary, #1f1f1f); }
.wf-node--etat { fill: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.wf-node--decision { cursor: pointer; stroke-width: 1.2; }
.wf-node--decision:hover { stroke: var(--dsw-alias-label-primary, #1f1f1f); }
.wf-node--selected { stroke: var(--dsw-alias-label-primary, #1f1f1f); stroke-width: 2; }
.wf-node-label { font-size: 11.5px; fill: var(--dsw-alias-label-primary, #1f1f1f); pointer-events: none; }
.wf-node-section { font-size: 10px; fill: var(--dsw-alias-label-tertiary, #7a7168); pointer-events: none; }
.wf-link { fill: none; stroke: var(--dsw-alias-border-l2, rgba(0,0,0,.34)); stroke-width: 1.4; }
.wf-link--back { stroke-dasharray: 4 3; }
.wf-link-label { font-size: 9.5px; fill: var(--dsw-alias-label-tertiary, #7a7168); paint-order: stroke; stroke: var(--dsw-alias-bg-base, #fbfaf8); stroke-width: 3px; stroke-linejoin: round; }
.wf-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wf-card { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; padding: 12px; }
.wf-card-title { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); margin-bottom: 8px; }
.wf-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; }
.wf-field > span { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-field input, .wf-field select, .wf-field textarea { font: inherit; font-size: 12px; height: 28px; padding: 0 7px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: transparent; color: inherit; }
.wf-field textarea { height: auto; min-height: 3lh; padding: 6px 7px; resize: vertical; }
.wf-field-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wf-arc { display: flex; align-items: center; gap: 6px; padding: 2px 4px; margin: 0 -4px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.wf-arc:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.wf-arc-when { color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-arc-del { border: 0; background: none; padding: 0 3px; color: #a33a2a; cursor: pointer; font-size: 13px; line-height: 1; }
.wf-error { color: #a33a2a; font-size: 12px; margin: 2px 0; }
.wf-ok { color: #3f7a4b; font-size: 12px; margin: 2px 0; }
.wf-toolbar-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-right: auto; }
.wf-overview-title { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
.wf-primary { background: var(--dsw-alias-label-primary, #1f1f1f); border-color: transparent; color: var(--dsw-alias-bg-base, #fbfaf8); }
.wf-primary:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 86%, var(--dsw-alias-bg-base, #fbfaf8)); color: var(--dsw-alias-bg-base, #fbfaf8); }
.wf-primary:disabled { background: var(--dsw-alias-label-primary, #1f1f1f); }
.wf-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; margin: 0 0 16px; padding: 0; list-style: none; }
.wf-pick-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wf-pick-title { font-size: 13px; font-weight: 600; }
.wf-pick-badges { display: flex; align-items: center; gap: 4px; flex: none; }
.wf-pick-local { flex: none; padding: 1px 7px; border: 1px solid color-mix(in srgb, #8250df 35%, transparent); border-radius: 999px; color: #8250df; background: color-mix(in srgb, #8250df 9%, transparent); font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; }
.wf-pick-kind { flex: none; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 999px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; }
.wf-pick-summary { font-size: 12px; color: var(--dsw-alias-label-secondary, #4a4a4a); white-space: pre-line; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wf-pick-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-pick-flow { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-pick-flow code { padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, currentColor 8%, transparent); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; }
.wf-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }
.wf-tabs { display: flex; gap: 6px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.wf-tab { height: 28px; padding: 0 12px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.wf-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.wf-tab--active { border-color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.wf-panel { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; padding: 14px; }
.wf-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }

.wf-detail-title { margin: 0; font-size: 15px; font-weight: 650; }
.wf-empty { display: grid; gap: 6px; padding: 30px 16px; text-align: center; }
.wf-legend { display: flex; align-items: center; gap: 6px 14px; flex-wrap: wrap; padding: 8px 4px 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-swatch { display: inline-block; width: 14px; height: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.18)); border-radius: 3px; background: var(--dsw-alias-bg-base, #fbfaf8); }
.wf-swatch--initial { border-color: #1a7f37; background: color-mix(in srgb, #1a7f37 18%, transparent); }
.wf-swatch--terminal { border-color: #8250df; background: color-mix(in srgb, #8250df 18%, transparent); }
.wf-swatch--back { width: 18px; height: 0; border: 0; border-top: 1.5px dashed var(--dsw-alias-label-tertiary, #7a7168); border-radius: 0; background: none; }
.wf-node-id { fill: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 8.5px; pointer-events: none; }
.wf-node-label--center { text-anchor: middle; }
.wf-node-badge { fill: var(--dsw-alias-label-tertiary, #7a7168); font-size: 8px; letter-spacing: .08em; text-transform: uppercase; pointer-events: none; }
.wf-link-hit { fill: none; stroke: transparent; stroke-width: 12; }
.wf-link-group { cursor: pointer; }
.wf-link-group:focus-visible .wf-link { stroke: var(--dsw-alias-label-primary, #1f1f1f); }
.wf-link--selected { stroke: var(--dsw-alias-label-primary, #1f1f1f); stroke-width: 2; }
.wf-link-label--selected { fill: var(--dsw-alias-label-primary, #1f1f1f); }
.wf-props { margin: 8px 0; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.wf-prop { display: flex; justify-content: space-between; gap: 10px; margin: 3px 0; font-size: 11.5px; }
.wf-prop > span { color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-prop code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.wf-map-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 11px; }
.wf-map-table th { padding: 2px 0; text-align: left; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.wf-map-table td { padding: 3px 0; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.07)); vertical-align: top; }
.wf-map-table code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-drawer-close { flex: none; padding: 0 2px; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 20px; line-height: 1; cursor: pointer; }
.wf-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
.wf-form-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
/* Playbook: the five pages on the left, the open page's markdown on the right. */
.pb-view { padding-top: 8px; }
.pb-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; align-items: start; }
.pb-pages { display: flex; flex-direction: column; gap: 4px; }
.pb-page { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.pb-page:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.pb-page[aria-current="true"] { border-color: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary, #1f1f1f); }
.pb-page-title { font-size: 12.5px; font-weight: 600; }
.pb-page-meta { display: flex; align-items: baseline; gap: 8px; }
.pb-page-step { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); }
.pb-page-lines { font-size: 10px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.pb-confirm { padding: 8px 10px; border: 1px solid color-mix(in srgb, #a33a2a 35%, transparent); border-radius: 9px; }
.pb-confirm-text { margin: 0 0 8px; font-size: 12px; }
.pb-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.pb-page-missing { font-size: 10.5px; color: #a33a2a; }
.pb-editor { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pb-editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.pb-title { margin: 0; font-size: 15px; font-weight: 650; }
.pb-note { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.pb-dirty { flex: none; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 999px; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); }
.pb-field { display: flex; flex-direction: column; gap: 6px; }
.pb-field > span { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); }
.pb-text { box-sizing: border-box; width: 100%; min-height: 420px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: inherit; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.55; resize: vertical; }
.pb-actions { display: flex; gap: 8px; justify-content: flex-end; }
.pb-primary { background: var(--dsw-alias-label-primary, #1f1f1f); border-color: transparent; color: var(--dsw-alias-bg-base, #fbfaf8); }
.pb-primary:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 86%, var(--dsw-alias-bg-base, #fbfaf8)); color: var(--dsw-alias-bg-base, #fbfaf8); }
.pb-primary:disabled { background: var(--dsw-alias-label-primary, #1f1f1f); }
.pb-status { padding: 8px 10px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.pb-status--ok { border-color: color-mix(in srgb, #3f7a4b 40%, transparent); }
.pb-status--error { border-color: color-mix(in srgb, #a33a2a 40%, transparent); }
.pb-status-text { margin: 0; font-size: 12px; }
.pb-status--ok .pb-status-text { color: #3f7a4b; }
.pb-status--error .pb-status-text { color: #a33a2a; }
.pb-errors { margin: 6px 0 0; padding-left: 18px; font-size: 11.5px; color: #a33a2a; }
@media (max-width: 720px) { .pb-layout { grid-template-columns: minmax(0, 1fr); } .pb-pages { flex-direction: row; flex-wrap: wrap; } .pb-page { width: auto; } }
/* One card, one frame: border, radius and background are shared by every list.
   Geometry and interior belong to the variant; a static card draws no
   affordance, an interactive one owns its hover, focus ring and pressed state. */
.missions-card { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #ffffff); transition: border-color .15s ease, background-color .15s ease; }
.missions-card[data-interactive="true"] { cursor: pointer; }
.missions-card[data-interactive="true"]:hover { border-color: color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 3%, var(--dsw-alias-bg-layer-1, #ffffff)); }
.missions-card[data-interactive="true"]:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-card[data-interactive="true"][aria-pressed="true"] { border-color: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary, #1f1f1f); }
.missions-card--pick { width: 100%; gap: 6px; padding: 12px; text-align: left; font: inherit; color: inherit; }
.missions-card[data-priority="urgent"] { border-left: 3px solid #cf222e; padding-left: 14px; }
@media (prefers-reduced-motion: reduce) { .missions-card { transition: none; } }
.missions-card-top { display: flex; align-items: center; gap: 6px; }
.missions-prio { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-prio svg { display: block; width: 100%; height: 100%; }
.missions-prio[data-priority="urgent"] { width: 14px; height: 14px; color: #cf222e; }
.missions-prio[data-priority="high"] { color: #bf8700; }
.missions-prio[data-priority="normal"] { color: var(--dsw-alias-label-secondary, #4a4a4a); }
.missions-prio .prio-bar, .missions-prio .prio-mark { fill: currentColor; }
.missions-prio .prio-bar--off { opacity: .22; }
.missions-prio .prio-chip { fill: currentColor; opacity: .13; }
.missions-prio .prio-none { fill: none; stroke: currentColor; stroke-width: 1.25; stroke-dasharray: 2.4 2; }
:root[data-ds-dark-theme] .missions-prio[data-priority="urgent"], body[data-ds-dark-theme] .missions-prio[data-priority="urgent"] { color: #ff7b72; }
:root[data-ds-dark-theme] .missions-prio[data-priority="urgent"] .prio-chip, body[data-ds-dark-theme] .missions-prio[data-priority="urgent"] .prio-chip { opacity: .2; }
:root[data-ds-dark-theme] .missions-prio[data-priority="high"], body[data-ds-dark-theme] .missions-prio[data-priority="high"] { color: #e3b341; }
.missions-card-title { font-size: 13.5px; font-weight: 550; line-height: 1.4; letter-spacing: -.005em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.missions-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; }
.missions-loader { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: 300px; padding: 40px 0; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-loader-label { font-size: 11.5px; letter-spacing: .02em; }
.missions-spinner { width: 26px; height: 26px; border: 2.5px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 14%, transparent); border-top-color: var(--dsw-alias-label-primary, #1f1f1f); border-radius: 50%; animation: missions-spin .8s linear infinite; }
@keyframes missions-spin { to { transform: rotate(360deg); } }
@keyframes missions-run { from { transform: translateY(0) rotate(-4deg); } to { transform: translateY(-7px) rotate(4deg); } }
@keyframes missions-lines { from { transform: translateX(0); } to { transform: translateX(-9px); } }
@media (prefers-reduced-motion: reduce) { .missions-spinner { animation: none; } .missions-sharingan-tomoe { animation: missions-sharingan-spin 4s linear infinite; } .missions-sharingan { animation: none; } }
/* Dashboard: a section per domain, a card per widget inside it. */
.missions-dashboard { display: flex; flex-direction: column; gap: 14px; padding-top: 2px; container-type: inline-size; }
.missions-sect { padding: 14px; border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 4%, transparent); }
.missions-sect-head { display: flex; align-items: baseline; gap: 10px; }
.missions-sect-title { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.missions-sect-scope { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.missions-sect-link { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; cursor: pointer; }
.missions-sect-link:hover, .missions-sect-link:focus-visible { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-sect-arrow { transition: transform .15s ease; }
.missions-sect-link:hover .missions-sect-arrow { transform: translateX(2px); }
.missions-sectgrid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-top: 11px; align-items: stretch; }
.missions-dash-card--flight { grid-column: span 2; }
.missions-dash-card--queue { grid-column: span 4; }
.missions-dash-card--bugs, .missions-dash-card--stories { grid-column: span 3; }
.missions-card-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 13px 4px; }
.missions-card-head-title { margin: 0; font-size: 12px; font-weight: 600; }
.missions-card-meta { margin-left: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.missions-card-sub { margin: 3px 13px 0; max-width: 62ch; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; line-height: 1.35; }
.missions-card-body { flex: 1; padding: 5px 13px 11px; }
.missions-dash-card--flight .missions-card-body { display: flex; flex-direction: column; }
.missions-card-empty { margin: 8px 0 6px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-card--widget .missions-card-foot { display: flex; align-items: baseline; gap: 10px; margin: auto 0 0; padding: 10px 13px 11px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.missions-dash-card-note { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-dash-link { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary, #4a4a4a); font: inherit; font-size: 10.5px; white-space: nowrap; cursor: pointer; }
.missions-dash-link:hover, .missions-dash-link:focus-visible { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-dash-link:focus-visible { outline: 2px solid color-mix(in srgb, #0969da 78%, transparent); outline-offset: 2px; }
.missions-dash-link-arrow { transition: transform .15s ease; }
.missions-dash-link:hover .missions-dash-link-arrow { transform: translateX(2px); }
.missions-dash-empty { padding: 16px 2px 4px; }
.missions-dash-empty p { margin: 0; font-size: 12.5px; }
.missions-dash-empty .missions-dash-empty-hint { margin-top: 4px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-rows { margin: 0; padding: 0; list-style: none; }
.missions-rowitem { border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.07)); }
.missions-rowitem:last-child { border-bottom: 0; }
.missions-row { display: grid; grid-template-columns: 6px 56px minmax(0, 1fr) 42px 66px; align-items: center; gap: 9px; width: 100%; height: 33px; padding: 0 1px; border: 0; border-radius: 4px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.missions-dash-card--flight .missions-row, .missions-dash-card--bugs .missions-row, .missions-dash-card--stories .missions-row { grid-template-columns: 6px 56px minmax(0, 1fr) 46px; }
.missions-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 5%, transparent); }
.missions-row:focus-visible { outline: 2px solid color-mix(in srgb, #0969da 78%, transparent); outline-offset: -2px; }
.missions-rowdot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-rowkey { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-rowtitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.missions-rowage { justify-self: end; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #7a7168); font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-rowage[data-quiet="true"] { color: #a06a00; font-weight: 600; }
.missions-rowverb { display: inline-flex; align-items: center; gap: 5px; justify-self: end; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #7a7168); white-space: nowrap; }
.missions-row:hover .missions-rowverb { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-rowarrow { transition: transform .15s ease; }
.missions-row:hover .missions-rowarrow { transform: translateX(2px); }
.missions-row[data-state="in-review"] .missions-rowdot { background: #0969da; }
.missions-row[data-state="ready-for-prod"] .missions-rowdot { background: #0e7c86; }
.missions-row[data-state="in-progress"] .missions-rowdot { background: #bf8700; }
.missions-row[data-state="ready"] .missions-rowdot { background: #1a7f37; }
.missions-row[data-state="to-refine"] .missions-rowdot { background: #8250df; }
/* A repository row: the repository, its branch, why it is there, its age. */
.missions-dash-card--branches, .missions-dash-card--checkouts { grid-column: span 3; }
.missions-row--repo { grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr) auto 42px; }
.missions-rowwhy { justify-self: end; max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 7%, transparent); color: var(--dsw-alias-label-secondary, #4a4a4a); font-size: 10px; font-variant-numeric: tabular-nums; }
.missions-rowwhy[data-reason="never-pushed"] { background: color-mix(in srgb, #bf8700 18%, transparent); color: #8a5a00; }
.missions-rowwhy[data-reason="error"] { background: color-mix(in srgb, #cf222e 14%, transparent); color: #b31d28; }
.missions-rowpoints { justify-self: end; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* A section whose read failed: the sentence and its Retry, never a zero. */
.missions-sect-error { display: flex; align-items: baseline; gap: 10px; margin-top: 11px; padding: 8px 12px; border: 1px solid color-mix(in srgb, #cf222e 32%, transparent); border-radius: 8px; background: color-mix(in srgb, #cf222e 7%, transparent); font-size: 11.5px; }
.missions-sect-error-text { min-width: 0; overflow-wrap: anywhere; color: #b31d28; }
.missions-sect-error .missions-retry { flex: none; margin-left: auto; }
@media (prefers-reduced-motion: reduce) { .missions-sect-arrow, .missions-rowarrow { transition: none; } }
@container (max-width: 820px) { .missions-sectgrid { grid-template-columns: minmax(0, 1fr); } .missions-dash-card--flight, .missions-dash-card--queue, .missions-dash-card--bugs, .missions-dash-card--stories, .missions-dash-card--branches, .missions-dash-card--checkouts { grid-column: auto; } }
.missions-drawer { flex: none; width: 380px; max-width: 46%; display: flex; flex-direction: column; gap: 16px; padding: 16px 22px 24px; overflow: auto; border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); animation: missions-slide .14s ease; }
@keyframes missions-slide { from { opacity: 0 } to { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .missions-drawer { animation: none; } }
.missions-drawer-head { display: flex; align-items: flex-start; gap: 12px; }
.missions-drawer-key { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-drawer-title { margin: 6px 0 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.missions-drawer-close { margin-left: auto; width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-tertiary, #7a7168); cursor: pointer; }
.missions-drawer-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-drawer-tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.missions-drawer-tab { height: 30px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; display: inline-flex; align-items: center; cursor: pointer; }
.missions-drawer-tab:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-drawer-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); border-bottom-color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-drawer-panel { display: flex; flex-direction: column; gap: 16px; }
.missions-drawer-panel .missions-props, .missions-drawer-panel .missions-journal, .missions-drawer-panel .missions-checklist { padding-top: 0; border-top: 0; }
/* The creation form pairs the two short vocabularies and reuses the drawer's
   properties grid for the two lines the host owns. */
.missions-create-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.missions-create-pair .wf-field { margin-bottom: 9px; }
.missions-drawer--fill .missions-drawer-panel { flex: 1; min-height: 120px; }
.missions-drawer--fill .missions-drawer-panel > section { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.missions-drawer--fill .missions-journal-text, .missions-drawer--fill .missions-checklist-body { max-height: none; flex: 1; min-height: 0; }
.missions-drawer--fill .missions-checklist-body { align-content: start; }
.missions-drawer--fill .missions-journal-text:focus-visible, .missions-drawer--fill .missions-checklist-body:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.missions-props { display: grid; grid-template-columns: 96px 1fr; gap: 9px 12px; margin: 0; font-size: 12px; }
.missions-props dt { color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-props dd { margin: 0; color: var(--dsw-alias-label-primary, #1f1f1f); overflow-wrap: anywhere; }
/* The foot stacks only the names that must stay readable — a destructive
   gesture confirms with its own text — then one row of icon gestures: each
   icon carries its name in data-tip and aria-label, and the gestures a
   blocker can disable sit in a wrapper that takes the events. */
.missions-drawer-foot { display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.missions-drawer-actions { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px; }
.missions-action { height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12.5px; text-decoration: none; cursor: pointer; }
.missions-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
/* The session gestures sit in one row: a square icon button keeps the family's
   colour, primary state and disabled state instead of borrowing another one. */
.missions-action--icon { width: 34px; height: 34px; flex: none; padding: 0; gap: 0; }
.missions-action--icon svg { display: block; }
.missions-action:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-action--primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1f1f1f); color: var(--dsw-alias-label-primary-foreground, #ffffff); font-weight: 600; }
.missions-action--primary:hover { filter: brightness(1.06); background: var(--dsw-alias-button-primary-fill, #1f1f1f); }
.missions-action:disabled { opacity: .55; cursor: default; }
/* Closing the local checkout deletes a branch: the colour says so, and the
   second click is the confirmation. */
.missions-action--danger { border-color: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 38%, transparent); color: var(--dsw-alias-label-danger, #b42318); }
.missions-action--danger:hover { background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 7%, transparent); }
/* The first click of a destructive gesture arms it: the drawing turns into a
   check and the button fills with the danger colour, so the armed state is
   visible without reading a tooltip. */
.missions-action--danger-armed { border-color: transparent; background: var(--dsw-alias-label-danger, #b42318); color: #fff; }
.missions-action--danger-armed:hover { background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 86%, #000); }
.missions-action--armed { border-color: transparent; background: var(--dsw-alias-label-primary, #1f1f1f); color: #fff; }
/* Planted, the pin is drawn in the button's own ink: an outer frame and an
   inner filet on the panel's ground, no fill. The drawing names the state;
   the ink names the action, so a host theme without our skin keeps it legible. */
.missions-action--pinned { position: relative; border: 1.5px solid var(--dsw-alias-label-primary, #1f1f1f); background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: none; }
.missions-action--pinned:hover { background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-action--pinned::before { content: ""; position: absolute; inset: 4px; border: 1.5px solid currentColor; border-radius: 4px; opacity: .9; pointer-events: none; }
/* Waiting, the pin keeps no frame: the double filet is the planted state's
   mark. The frame keeps the planted width (1,5 px) while transparent, so the
   button's border box and inner box do not move when it plants. */
.missions-action--pin:not(.missions-action--pinned) { border: 1.5px solid transparent; }
.missions-drawer-note--error { color: var(--dsw-alias-label-danger, #b42318); }
.missions-drawer-note { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-drawer-note--blocked { color: var(--dsw-alias-label-secondary, #5c534b); }
.missions-declare { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.missions-declare-field { display: grid; gap: 4px; }
.missions-declare-label { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; }
.missions-declare-input { height: 28px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; }
.missions-declare-input:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 40%, transparent); outline-offset: 1px; }
.missions-declare-save { height: 28px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; cursor: pointer; }
.missions-declare-save:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-declare-save:disabled { opacity: .55; cursor: default; }
.missions-declare-note { margin: 0; color: var(--dsw-alias-label-secondary, #5c534b); font-size: 11.5px; }
.missions-declare-note--error { color: var(--dsw-alias-label-danger, #b42318); }
/* The Tolgee report: the keys the branch's changed files call that a locale
   misses, then the keys that cannot be imported before they are written in
   the reference. */
.missions-tolgee { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.missions-tolgee-block { display: grid; gap: 6px; }
.missions-tolgee-title { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; }
.missions-tolgee-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: 11.5px; }
.missions-tolgee-key { display: flex; gap: 6px; justify-content: space-between; align-items: baseline; }
.missions-tolgee-key code { overflow-wrap: anywhere; }
.missions-tolgee-missing { color: var(--dsw-alias-label-tertiary, #7a7168); white-space: nowrap; }
.missions-tolgee-note { margin: 0; color: var(--dsw-alias-label-secondary, #5c534b); font-size: 11.5px; }
.missions-tolgee-note--error { color: var(--dsw-alias-label-danger, #b42318); }
/* Blocked: a label of the tracker, whose reason is a comment of the ticket. */
.missions-blocked { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 8px; }
.missions-blocked[data-blocked="true"] { border-color: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 38%, transparent); background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 6%, transparent); }
.missions-blocked-head { display: flex; align-items: center; gap: 8px; }
.missions-blocked-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-blocked-head .missions-switch { margin-left: auto; }
.missions-blocked-field { display: grid; gap: 4px; }
.missions-blocked-label { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; }
.missions-blocked-input { width: 100%; min-height: 56px; padding: 6px 8px; resize: vertical; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; line-height: 1.45; }
.missions-blocked-input:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 40%, transparent); outline-offset: 1px; }
.missions-blocked-actions { display: flex; gap: 6px; }
.missions-blocked-apply, .missions-blocked-cancel { height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; cursor: pointer; }
.missions-blocked-apply { border-color: transparent; background: var(--dsw-alias-label-danger, #b42318); color: #ffffff; font-weight: 600; }
.missions-blocked-apply:hover:not(:disabled) { filter: brightness(1.06); }
.missions-blocked-cancel:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-blocked-apply:disabled, .missions-blocked-cancel:disabled { opacity: .55; cursor: default; }
.missions-blocked-hint, .missions-blocked-note { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-blocked-reason { display: grid; gap: 4px; min-width: 0; }
.missions-blocked-reason-meta { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; }
.missions-blocked-reason-text { margin: 0; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.missions-blocked-reason-link { width: fit-content; color: #0969da; font-size: 11.5px; text-decoration: underline; }
.missions-blocked-reason-note { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-blocked-note--error { color: var(--dsw-alias-label-danger, #b42318); }
/* The dependencies that hold a mission: a key to open, the state it waits at. */
.missions-blocked-by { display: grid; gap: 4px; min-width: 0; }
.missions-blocked-by-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.missions-blocked-by-item { display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #ffffff); font-size: 11.5px; }
.missions-blocked-by-link { color: #0969da; text-decoration: underline; }
.missions-blocked-by-state { color: var(--dsw-alias-label-tertiary, #7a7168); }
/* La priorité s'édite dans la ligne : le select garde la taille du volet. */
.missions-priority-select { max-width: 100%; height: 24px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; }
.missions-priority-select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 40%, transparent); outline-offset: 1px; }
.missions-priority-select:disabled { opacity: .6; }
.missions-priority-note { margin: 0 0 10px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-priority-note--error { color: var(--dsw-alias-label-danger, #b42318); }
/* Les points suivent la même ligne : même taille, même focus, même note. */
.missions-points-select { max-width: 100%; height: 24px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; }
.missions-points-select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 40%, transparent); outline-offset: 1px; }
.missions-points-select:disabled { opacity: .6; }
.missions-points-note { margin: 0 0 10px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-points-note--error { color: var(--dsw-alias-label-danger, #b42318); }
.missions-journal { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.missions-journal-head { display: flex; align-items: baseline; gap: 8px; }
.missions-journal-meta { min-width: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-journal-text { max-height: 220px; margin: 0; padding: 9px 10px; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #5c534b); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.missions-journal-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-checklist { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.missions-checklist-head { display: flex; align-items: baseline; gap: 8px; }
.missions-checklist-meta { color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; white-space: nowrap; }
.missions-checklist-body { display: grid; gap: 4px; max-height: 260px; padding: 9px 10px; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); }
.missions-checklist-title { margin-top: 6px; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 11.5px; font-weight: 600; }
.missions-checklist-title:first-child { margin-top: 0; }
.missions-checklist-subtitle { margin-top: 4px; color: var(--dsw-alias-label-secondary, #5c534b); font-size: 11px; font-weight: 600; }
.missions-checklist-item { display: grid; grid-template-columns: 12px 1fr; gap: 7px; align-items: start; color: var(--dsw-alias-label-secondary, #5c534b); font-size: 11.5px; line-height: 1.5; }
.missions-checklist-box { width: 11px; height: 11px; margin-top: 3px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.35)); border-radius: 2px; }
.missions-checklist-box[aria-checked="true"] { border-color: var(--dsw-alias-label-primary, #1f1f1f); background: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-checklist-box[aria-checked="true"]::after { content: '✓'; display: block; color: var(--dsw-alias-bg-layer-1, #ffffff); font-size: 9px; line-height: 10px; text-align: center; }
.missions-checklist-box[aria-checked="mixed"] { border-color: var(--dsw-alias-label-tertiary, #7a7168); background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #7a7168) 30%, transparent); }
.missions-checklist-box[aria-checked="mixed"]::after { content: '–'; display: block; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 9px; line-height: 9px; text-align: center; }
.missions-checklist-item[data-state="checked"] .missions-checklist-text { color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-checklist-bullet { padding-left: 19px; color: var(--dsw-alias-label-secondary, #5c534b); font-size: 11.5px; line-height: 1.5; }
.missions-checklist-text, .missions-checklist-note { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; line-height: 1.5; }
.missions-checklist-hint { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-drawer--empty { justify-content: center; align-items: center; border-left: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.missions-drawer-hint { max-width: 220px; margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12px; text-align: center; }

/* Repositories: one row per clone the host found in the workspace root. The
   commit column gives way first when the panel gets narrow. */
.missions-repos { padding-top: 14px; }
.missions-repo-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .95fr) 86px minmax(0, 1.55fr) 58px; gap: 12px; align-items: center; }
.missions-repo-head { display: flex; align-items: center; gap: 4px; padding: 0 0 7px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase; }
.missions-repo-headgrid { flex: 1 1 auto; min-width: 0; padding: 0 10px; }
.missions-repo-headgrid > span:last-child { justify-self: end; }
.missions-repo-headmain { flex: none; width: 52px; }
.missions-repo-rowitem { display: flex; align-items: center; gap: 4px; margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.07)); }
.missions-repo-rowitem:last-child { border-bottom: 0; }
.missions-repo { flex: 1 1 auto; min-width: 0; height: 36px; padding: 0 10px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.missions-repo-main-slot { flex: none; width: 52px; }
.missions-repo-main, .missions-repo-remove { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); cursor: pointer; }
.missions-repo-main:hover:not(:disabled), .missions-repo-remove:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 7%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-repo-main:focus-visible, .missions-repo-remove:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-repo-main:disabled, .missions-repo-remove:disabled { opacity: .4; cursor: default; }
.missions-repo-remove:hover:not(:disabled) { color: #cf222e; }
.missions-repo:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 5%, transparent); }
.missions-repo:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: -2px; }
.missions-repo-name { display: flex; align-items: center; gap: 0; min-width: 0; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; font-weight: 550; }
.missions-repo-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-repo-kind { flex: none; margin-left: 7px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 4px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase; vertical-align: 1px; }
.missions-repo-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #4a4a4a); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; }
.missions-repo-state { justify-self: start; padding: 1px 7px; border-radius: 9px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; white-space: nowrap; }
.missions-repo-state[data-dirty="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-repo-state[data-error="true"] { color: #cf222e; font-weight: 600; }
.missions-repo-commit { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.missions-repo-age { justify-self: end; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-repos-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.missions-repos-headtools { display: flex; align-items: center; gap: 10px; min-width: 0; }
.missions-repos-filters { margin: 0 0 10px; }
.missions-repos-total { color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; font-weight: 600; }
.missions-repos-root { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; }
.missions-repos-gesture { margin: 0 0 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 14%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 4%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; line-height: 1.45; }
.missions-repos-gesture.is-done { border-color: color-mix(in srgb, #1a7f37 32%, transparent); background: color-mix(in srgb, #1a7f37 8%, transparent); }
.missions-repos-gesture.is-partial { border-color: color-mix(in srgb, #bf8700 40%, transparent); background: color-mix(in srgb, #bf8700 10%, transparent); }
.missions-repos-gesture.is-error { border-color: color-mix(in srgb, #cf222e 35%, transparent); background: color-mix(in srgb, #cf222e 8%, transparent); }
.missions-repos-note { margin: 12px 2px 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; line-height: 1.5; }
.missions-repos-error { margin: 14px 0 0; padding: 10px 12px; border: 1px solid color-mix(in srgb, #cf222e 35%, transparent); border-radius: 6px; background: color-mix(in srgb, #cf222e 8%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; }
.missions-drawer-section { display: grid; gap: 9px; }
.missions-drawer-section-title { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }

/* Repository drawer: two sections behind two tabs — the repository, and one
   branch's history. */
.missions-repo-tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.missions-repo-tab { height: 30px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; cursor: pointer; }
.missions-repo-tab:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-repo-tab[aria-selected="true"] { border-bottom-color: var(--dsw-alias-label-primary, #1f1f1f); color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-history { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.missions-history-bar { display: flex; align-items: center; gap: 10px; }
.missions-history-branch { min-width: 0; max-width: 62%; height: 26px; padding: 0 22px 0 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background-color: transparent; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237a7168' stroke-width='1.4' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; background-size: 9px; appearance: none; -webkit-appearance: none; color: var(--dsw-alias-label-secondary, #4a4a4a); font: inherit; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.missions-history-total { min-width: 0; margin-left: auto; overflow: hidden; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.missions-history-lines { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.missions-history-commit { display: grid; grid-template-columns: 58px 44px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 11.5px; }
.missions-history-hash { color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; }
.missions-history-age { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.missions-history-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-history-more { align-self: flex-start; width: auto; }
.missions-usage { display: flex; flex-direction: column; gap: 16px; }
.missions-usage-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.missions-usage-total { color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.missions-usage-window { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; font-variant-numeric: tabular-nums; }
.missions-usage-head .missions-btn { margin-left: auto; width: auto; }
.missions-usage-note { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; line-height: 1.5; }
.missions-usage-section { display: flex; flex-direction: column; gap: 8px; }
.missions-usage-title { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.missions-usage-rows, .missions-usage-top { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.missions-usage-row, .missions-usage-top-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 5px 0; border-bottom: 1px solid color-mix(in srgb, currentColor 7%, transparent); }
.missions-usage-row:last-child, .missions-usage-top-item:last-child { border-bottom: none; }
.missions-usage-rank { flex: none; width: 14px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; font-variant-numeric: tabular-nums; }
.missions-usage-label { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.missions-usage-count { flex: none; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.missions-usage-when { flex: none; min-width: 42px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; font-variant-numeric: tabular-nums; text-align: right; }
.missions-usage-verdict { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 600; white-space: nowrap; }
.missions-usage-verdict--grow { background: color-mix(in srgb, #1f883d 15%, transparent); color: #116329; }
.missions-usage-verdict--keep { background: color-mix(in srgb, #0969da 12%, transparent); color: #0a4e9e; }
.missions-usage-verdict--improve { background: color-mix(in srgb, #bf8700 18%, transparent); color: #7d4e00; }
.missions-usage-verdict--remove { background: color-mix(in srgb, #cf222e 13%, transparent); color: #a40e26; }
.missions-usage-verdict--none { background: color-mix(in srgb, currentColor 7%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-usage-values { flex: 1 1 100%; display: flex; flex-wrap: wrap; gap: 4px; }
.missions-usage-value { padding: 0 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 7%, transparent); color: var(--dsw-alias-label-secondary, #4a4a4a); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; }
.missions-usage-empty { display: grid; gap: 6px; padding: 26px 0; }
.missions-usage-empty p { margin: 0; }
.missions-usage-empty-hint { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; }
/* The outline: a field and a two-level tree, one column, full width. */
.missions-tree-view { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.missions-toolbar-label { margin-right: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
.missions-workbench { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; flex: 1 1 auto; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.missions-wb-column { display: flex; flex-direction: column; min-width: 0; }
.missions-wb-field { display: flex; align-items: center; gap: 7px; padding: 10px 14px 6px; }
.missions-wb-filters { padding: 0 14px 9px; }
.missions-wb-kbd { flex: none; padding: 1px 5px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 4px; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size: 9.5px; line-height: 1.4; }
.missions-wb-input { flex: 1 1 auto; min-width: 0; height: 26px; border: none; outline: none; background: none; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12.5px; }
.missions-wb-input::placeholder { color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-wb-count { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-wb-count[data-query="true"] { color: var(--dsw-alias-label-secondary, #4a4a4a); font-weight: 600; }
.missions-band { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; padding: 0 14px 9px; }
.missions-band-track { display: flex; flex: 1 1 180px; gap: 2px; min-width: 0; }
.missions-band-seg { display: inline-flex; flex: 0 1 auto; align-items: center; justify-content: center; gap: 4px; min-width: 16px; height: 15px; padding: 0 4px; border: none; border-radius: 2.5px; color: #ffffff; font: inherit; font-size: 8.5px; font-weight: 650; overflow: hidden; cursor: pointer; }
.missions-band-seg[data-state="to-refine"] { background: #8250df; }
.missions-band-seg[data-state="ready"] { background: #1a7f37; }
.missions-band-seg[data-state="in-progress"] { background: #bf8700; }
.missions-band-seg[data-state="in-review"] { background: #0969da; }
.missions-band-seg[data-state="ready-for-prod"] { background: #0e7c86; }
.missions-band-seg[data-state="done"] { background: #57606a; }
.missions-band-seg[data-active="false"] { opacity: .4; }
.missions-band-seg[data-active="true"] { box-shadow: inset 0 0 0 1px rgba(255,255,255,.9), 0 0 0 1px rgba(0,0,0,.16); }
.missions-band-name, .missions-band-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-band-n { flex: none; opacity: .85; font-variant-numeric: tabular-nums; }
/* The scrollport starts flush with the tree: the 2px of air above the first
   row lives outside it, so a scrolling row cannot show through a strip above
   the pinned band. */
.missions-wb-tree { min-height: 140px; max-height: 62vh; overflow: auto; margin-top: 2px; padding: 0 6px 10px; }
.missions-wb-group { display: flex; flex-direction: column; }
.missions-wb-rows, .missions-wb-actions { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.missions-wb-row { min-width: 0; }
/* The pinned rows hold the top of the scrollport: the list keeps them in
   sight while the rest of the tree scrolls under them. The band brings its
   own air, a stronger rule and a soft edge, so it reads as a section of its
   own instead of one more row. */
.missions-wb-pins { position: sticky; top: 0; z-index: 2; padding-bottom: 8px; background: var(--dsw-alias-bg-base, #fbfaf8); border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.16)); box-shadow: 0 8px 10px -10px rgba(0,0,0,.35); }
.missions-wb-actions { padding: 2px 0 6px; }
.missions-wb-actions-head { display: block; padding: 6px 8px 3px 10px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.missions-wb-action { display: flex; align-items: center; width: calc(100% - 12px); margin: 0 6px; height: 24px; padding: 0 8px; border: none; border-radius: 5px; background: none; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 11.5px; text-align: left; cursor: pointer; }
.missions-wb-action:hover, .missions-wb-action[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); }
.missions-tree-row { box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; min-height: 38px; margin-left: 12px; padding: 3px 8px; border-radius: 5px; cursor: pointer; }
.missions-wb-row + .missions-wb-row > .missions-tree-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.missions-tree-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04)); }
.missions-tree-row[data-selected="true"] { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.07)); }
.missions-tree-prio { flex: none; display: inline-flex; width: 14px; }
.missions-tree-pin { flex: none; color: var(--dsw-alias-label-secondary, #4a4a4a); }
.missions-tree-key { flex: none; width: 48px; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size: 9.5px; }
.missions-tree-epic-ref { flex: none; width: 52px; overflow: hidden; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size: 9.5px; text-overflow: ellipsis; white-space: nowrap; }
.missions-tree-title { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.missions-tree-blocked { flex: none; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, #cf222e 12%, transparent); color: #a40e26; font-size: 9px; font-weight: 600; }
.missions-tree-age { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-tree-points { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-tree-anchors { flex: 1 1 100%; display: flex; flex-direction: column; gap: 1px; padding: 1px 0 2px 60px; }
.missions-tree-anchor { display: flex; align-items: baseline; gap: 5px; min-width: 0; color: var(--dsw-alias-label-secondary, #4a4a4a); font-size: 10px; }
.missions-tree-anchor-mark { flex: none; width: 9px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-tree-anchor-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-tree-anchor-count { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-tree-overflow { flex: 1 1 100%; padding-left: 60px; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size: 10px; font-weight: 700; }
.missions-wb-empty, .missions-wb-failed { margin: 0; padding: 12px 14px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-wb-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 7px 14px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; font-variant-numeric: tabular-nums; }
.missions-wb-foot-note { text-transform: uppercase; letter-spacing: .06em; }
@media (max-width: 860px) {
  .missions-tree-anchors, .missions-tree-overflow { padding-left: 12px; }
}
@media (max-width: 900px) {
  .missions-tree-points { font-size: 9px; }
}
@media (max-width: 720px) {
  .missions-wb-field { padding: 8px 10px 4px; }
  .missions-band { padding: 0 10px 8px; }
  .missions-wb-tree { padding: 0 2px 8px; }
  .missions-tree-row { margin-left: 8px; padding: 3px 6px; }
  .missions-tree-key { width: 44px; }
}
@media (max-width: 860px) {
  .missions-repo-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr) 78px 52px; }
  .missions-col-commit { display: none; }
  .missions-repo-headmain { width: 48px; }
  .missions-repo-main-slot { width: 48px; }
  .missions-repo-main, .missions-repo-remove { width: 22px; height: 22px; }
}
@media (max-width: 900px) {
  .wf-layout { grid-template-columns: minmax(0, 1fr); }
  .wf-list { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
}
@media (max-width: 640px) {
  .wf-toolbar { align-items: flex-start; }
  .wf-list { grid-template-columns: minmax(0, 1fr); }
}
/* The outline dressed in paper: the same rows, ink and rules. */
.missions-panel[data-skin="paper"] .missions-toolbar-label { color: var(--skin-ink-3); font-family: var(--skin-mono); font-size: 10px; letter-spacing: .1em; }
.missions-panel[data-skin="paper"] .missions-workbench { border-top: 1.5px solid var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-wb-kbd { border: 1.5px solid var(--skin-ink); border-radius: 5px; background: var(--skin-page-2); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-wb-input { color: var(--skin-ink); font-family: var(--skin-display); }
.missions-panel[data-skin="paper"] .missions-wb-count { color: var(--skin-ink-3); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-band-seg { border: 1px solid var(--skin-ink); border-radius: 3px; }
.missions-panel[data-skin="paper"] .missions-wb-pins { background: var(--skin-page); border-bottom: 1.5px solid var(--skin-ink); box-shadow: none; }
.missions-panel[data-skin="paper"] .missions-tree-row:hover { background: color-mix(in srgb, var(--skin-accent) 14%, var(--skin-page)); }
.missions-panel[data-skin="paper"] .missions-tree-row[data-selected="true"] { background: var(--skin-page-3); }
.missions-panel[data-skin="paper"] .missions-tree-epic-ref, .missions-panel[data-skin="paper"] .missions-tree-key { color: var(--skin-accent-strong); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-tree-title { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-tree-age, .missions-panel[data-skin="paper"] .missions-tree-points, .missions-panel[data-skin="paper"] .missions-tree-anchor-count { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-tree-anchor { color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-tree-anchor-mark { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-tree-blocked { background: var(--skin-danger-strong); color: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-tree-overflow { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-wb-action { color: var(--skin-ink); font-family: var(--skin-display); }
.missions-panel[data-skin="paper"] .missions-wb-action:hover, .missions-panel[data-skin="paper"] .missions-wb-action[aria-selected="true"] { background: color-mix(in srgb, var(--skin-accent) 16%, var(--skin-page)); }
.missions-panel[data-skin="paper"] .missions-wb-actions-head { color: var(--skin-ink-3); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-wb-foot { border-top: 1px solid var(--skin-line); color: var(--skin-ink-3); font-family: var(--skin-mono); }

@container (max-width: 560px) {
  .wf-layout { grid-template-columns: minmax(0, 1fr); }
  .pb-layout { grid-template-columns: minmax(0, 1fr); }
  .pb-pages { flex-direction: row; flex-wrap: wrap; }
  .pb-page { width: auto; }
  .wf-list { grid-template-columns: minmax(0, 1fr); }
  .wf-prop code, .wf-pick-title { overflow-wrap: anywhere; }
}
`

    const HERO_MOTES = {
      count: 9,
      period: 9,
      left: { base: 6, step: 31, span: 74 },
      bottom: { base: 6, step: 23, span: 44 },
      delay: { step: 1.7, decimals: 2 },
    }

    const THEME_CSS = `
/* Theme picker: unchanged in the default panel, paper-and-ink in the manga theme. */
.missions-theme { position: relative; display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 22px 0 9px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #4a4a4a); font-size: 11.5px; cursor: pointer; }
.missions-theme:focus-within { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-theme-label { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
.missions-theme-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-theme svg { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-theme select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }

/* Illustrated skin: one structure, per-theme tokens.
   Naruto theme. */
.missions-panel[data-skin="paper"][data-theme="manga"] {
  --skin-page: #fbf4e6; --skin-page-2: #fffaf0; --skin-page-3: #f3e7d3;
  --skin-ink: #2c2621; --skin-ink-2: #5e554b; --skin-ink-3: #756b60;
  --skin-line: #ddccb2; --skin-line-strong: #c8b69a; --skin-shadow: #d9c6a8;
  --skin-accent: #f2a26f; --skin-accent-strong: #a85526;
  --skin-good: #aec7a7; --skin-good-strong: #4f6d53;
  --skin-info: #a9c8db; --skin-info-strong: #4f7488;
  --skin-alt: #8fbfae; --skin-alt-strong: #3f6b66;
  --skin-quiet: #cdbcdd; --skin-quiet-strong: #6d5587;
  --skin-warn: #f3d38c; --skin-danger: #e88a7d; --skin-danger-strong: #a8453a;
  --skin-display: "Avenir Next", "Futura", ui-rounded, "Trebuchet MS", sans-serif;
  --skin-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --skin-grain: rgba(44, 38, 33, .07);
  --skin-accent-ink: #2c2621;
  --skin-warn-ink: #8a6a1f; --skin-attention: #8a5a00;
  --skin-select-arrow: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23201b17' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
  --skin-hero-fade: linear-gradient(90deg, var(--skin-page) 0%, var(--skin-page) 30%, color-mix(in srgb, var(--skin-page) 88%, transparent) 44%, transparent 64%);
  --skin-hero-wash: linear-gradient(165deg, rgba(242,162,111,.16), rgba(251,244,230,.16) 55%, rgba(169,200,219,.12));
  background: var(--skin-page); color: var(--skin-ink); font-size: 12.5px; line-height: 1.45;
  container-type: inline-size;
}
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"][data-theme="manga"],
body[data-ds-dark-theme] .missions-panel[data-skin="paper"][data-theme="manga"] {
  --skin-page: #1e2330; --skin-page-2: #252c3b; --skin-page-3: #2d3547;
  --skin-ink: #f5ecdf; --skin-ink-2: #cfc4b5; --skin-ink-3: #a89d8f;
  --skin-line: #3d4659; --skin-line-strong: #566176; --skin-shadow: #0f1420;
  --skin-grain: rgba(245, 236, 223, .075);
  --skin-attention: #e3b341; --skin-accent-ink: #2c2621;
}

:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-hero-frame,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-hero-frame { filter: saturate(.45) brightness(.55) contrast(1.02); }
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-tab-count,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-title-mark,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-drawer::before,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-tab-count,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-title-mark,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-drawer::before { color: var(--skin-accent-ink); }
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-declare-note--error,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-declare-note--error,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-tolgee-note--error,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-tolgee-note--error { color: var(--skin-danger); }

/* The select, in the themed header. */
.missions-panel[data-skin="paper"] .missions-theme { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-theme-label { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-theme-value { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-theme svg { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-btn { height: 29px; padding: 0 10px; border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); color: var(--skin-ink); font-size: 11px; }
.missions-panel[data-skin="paper"] .missions-btn:hover { background: var(--skin-page-3); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-icon-btn { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 1px 1px 0 var(--skin-shadow); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-batch-btn { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 1px 1px 0 var(--skin-shadow); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-batch-btn:hover { background: var(--skin-page-3); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-batch-btn--armed { border-color: var(--skin-ink); background: var(--skin-ink); color: var(--skin-page-1); box-shadow: none; }
.missions-panel[data-skin="paper"] .missions-icon-btn:hover { background: var(--skin-page-3); color: var(--skin-ink); }
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-icon-btn,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-icon-btn { background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-retry { border: 1.5px solid var(--skin-danger-strong); border-radius: 8px; background: color-mix(in srgb, var(--skin-danger) 20%, var(--skin-page-2)); box-shadow: 1px 1px 0 var(--skin-shadow); color: var(--skin-ink); font-family: var(--skin-display); }

/* Hero: the photograph, the paper wash, the portrait and the speech bubble. */
.missions-panel[data-skin="paper"] .missions-hero { position: relative; flex: none; height: 172px; overflow: hidden; border-bottom: 1.5px solid var(--skin-ink); background: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-hero-frame { position: absolute; inset: 9px 9px 0; z-index: 0; box-sizing: border-box; width: calc(100% - 18px); height: calc(100% - 7.5px); overflow: hidden; border: 1.5px solid var(--skin-ink); border-radius: 6px; filter: saturate(.62) contrast(1) brightness(1.08); }
.missions-panel[data-skin="paper"] .missions-hero-frame::before { content: ""; position: absolute; top: -8%; bottom: -8%; left: 0; width: 200%; z-index: 2; background-image: radial-gradient(closest-side at 50% 66%, rgba(255,255,255,.42), rgba(255,255,255,0) 70%), radial-gradient(closest-side at 50% 30%, rgba(255,255,255,.26), rgba(255,255,255,0) 72%); background-size: 50% 100%, 25% 100%; background-repeat: repeat-x; mix-blend-mode: screen; opacity: .5; -webkit-mask-image: linear-gradient(#000 0 62%, rgba(0,0,0,0) 92%); mask-image: linear-gradient(#000 0 62%, rgba(0,0,0,0) 92%); animation: missions-hero-mist 60s linear infinite; }
.missions-panel[data-skin="paper"] .missions-hero-frame::after { content: ""; position: absolute; inset: 0; z-index: 3; pointer-events: none; background: linear-gradient(100deg, rgba(255,255,255,0) 38%, rgba(255,246,224,.5) 50%, rgba(255,255,255,0) 62%); mix-blend-mode: screen; animation: missions-hero-sweep 12s linear infinite; }
.missions-panel[data-skin="paper"] .missions-hero-photo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 54%; transform-origin: center; --hero-scale: 1.12; --hero-pan: 4%; transform: scale(var(--hero-scale)); animation: missions-hero-drift 14s ease-in-out infinite alternate; }
.missions-panel[data-skin="paper"] .missions-hero-air { position: absolute; inset: 9px 9px 0; z-index: 2; overflow: hidden; border-radius: 6px; pointer-events: none; }
.missions-panel[data-skin="paper"] .missions-hero-air i { position: absolute; width: 3px; height: 3px; background: rgb(255 249 235 / .82); opacity: 0; animation: missions-hero-mote 9s linear infinite; }
.missions-panel[data-skin="paper"] .missions-hero::before { content: ""; position: absolute; inset: 9px 9px 0; z-index: 1; border-radius: 6px; background-image: radial-gradient(var(--skin-ink) 1px, transparent 1.15px); background-size: 5px 5px; opacity: .2; mix-blend-mode: multiply; pointer-events: none; }
.missions-panel[data-skin="paper"] .missions-hero::after { content: ""; position: absolute; inset: 9px 9px 0; z-index: 2; border-radius: 6px; pointer-events: none; background: var(--skin-hero-fade), var(--skin-hero-wash); }
.missions-panel[data-skin="paper"] .missions-hero-avatar { position: absolute; z-index: 3; right: 21px; bottom: 10.5px; width: 112px; height: 112px; border-radius: 50%; overflow: hidden; border: 3px solid var(--skin-page); background: var(--skin-page-2); box-shadow: 0 0 0 1.5px var(--skin-ink), 4px 4px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-hero-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-skin="paper"] .missions-hero-bubble { position: absolute; z-index: 3; right: 149px; bottom: 69.5px; display: flex; flex-direction: column; gap: 1px; min-width: 118px; padding: 8px 11px; border: 1.5px solid var(--skin-ink); border-radius: 9px; background: var(--skin-page-2); color: var(--skin-ink); box-shadow: 2px 2px 0 var(--skin-shadow); transform: translateY(50%); }
.missions-panel[data-skin="paper"] .missions-hero-bubble::after { content: ""; position: absolute; right: -7px; bottom: calc(50% - 6.25px); width: 11px; height: 11px; background: var(--skin-page-2); border-right: 1.5px solid var(--skin-ink); border-bottom: 1.5px solid var(--skin-ink); transform: rotate(-45deg); }
.missions-panel[data-skin="paper"] .missions-hero-bubble b { font-size: 11px; line-height: 1.2; }
.missions-panel[data-skin="paper"] .missions-hero-bubble span { font-size: 8.5px; color: var(--skin-ink-3); }
@keyframes missions-hero-drift { from { transform: scale(var(--hero-scale, 1.12)) translateX(calc(-1 * var(--hero-pan, 4%))); } to { transform: scale(var(--hero-scale, 1.12)) translateX(var(--hero-pan, 4%)); } }
@keyframes missions-hero-mist { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-50%, 0, 0); } }
@keyframes missions-hero-sweep { 0% { transform: translateX(-130%); } 45% { transform: translateX(130%); } 100% { transform: translateX(130%); } }
@keyframes missions-hero-mote { 0% { transform: translate3d(0, 16px, 0) scale(.7); opacity: 0; } 18% { opacity: .5; } 72% { opacity: .32; } 100% { transform: translate3d(6px, -54px, 0) scale(1.05); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .missions-panel[data-skin="paper"] .missions-hero-photo { animation: none; transform: none; }
  .missions-panel[data-skin="paper"] .missions-hero-frame::before,
  .missions-panel[data-skin="paper"] .missions-hero-frame::after,
  .missions-panel[data-skin="paper"] .missions-hero-air i { animation: none; }
}

/* Header over the hero: kicker, title, scope, actions. */
.missions-panel[data-skin="paper"] .missions-head--hero { position: absolute; z-index: 4; inset: 0; height: 172px; display: block; padding: 0 30px; pointer-events: none; }
.missions-panel[data-skin="paper"] .missions-kicker { position: absolute; top: 17px; left: 30px; display: flex; align-items: center; gap: 8px; color: var(--skin-ink-3); font-size: 8.5px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-kicker-rule { width: 20px; height: 2px; border-radius: 2px; background: var(--skin-accent-strong); transform: rotate(-2deg); }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-title { position: absolute; left: 30px; bottom: 30px; margin: 0; color: var(--skin-ink); font-family: var(--skin-display); font-size: 38px; font-weight: 800; letter-spacing: -.035em; line-height: 1; pointer-events: auto; }
.missions-panel[data-skin="paper"] .missions-title-mark { display: inline-grid; place-items: center; width: 31px; height: 31px; margin-left: 11px; vertical-align: middle; border: 1.5px solid var(--skin-ink); border-radius: 8px 9px 8px 10px; background: var(--skin-accent); color: var(--skin-ink); font: 800 17px/1 var(--skin-display); box-shadow: 2px 2px 0 var(--skin-shadow); transform: rotate(2deg); }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-scope { position: absolute; left: 31px; bottom: 8px; color: var(--skin-ink-3); font-size: 11px; }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-scope::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: var(--skin-good); vertical-align: 1px; }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-actions { position: absolute; top: 18px; right: 19px; margin: 0; pointer-events: auto; }

/* Tabs, toolbar, search and filters. */
.missions-panel[data-skin="paper"] .missions-tabs { height: 44px; margin-top: 0; padding: 0 30px; gap: 26px; border-bottom: 1.5px solid var(--skin-ink); background-color: var(--skin-page); background-image: radial-gradient(var(--skin-grain) .55px, transparent .6px); background-size: 9px 9px; }
.missions-panel[data-skin="paper"] .missions-tab { height: 44px; color: var(--skin-ink-3); font-size: 11.5px; letter-spacing: .02em; }
.missions-panel[data-skin="paper"] .missions-tab[aria-selected="true"] { color: var(--skin-ink); border-bottom: 3px solid var(--skin-accent-strong); font-weight: 700; }
.missions-panel[data-skin="paper"] .missions-tab-count { display: grid; place-items: center; flex: none; width: 24px; height: 24px; min-width: 0; padding: 0; border: 1.5px solid var(--skin-ink); border-radius: 50%; background: var(--skin-accent); color: var(--skin-ink); font: 700 11px/1 var(--skin-mono); }
/* Settings wears the same ink as the bar: the nav is a card of the page, the
   selected section takes the orange of a chosen tab. */
.missions-panel[data-skin="paper"] .missions-settings-nav { border: 1.5px solid var(--skin-ink); border-radius: 9px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-settings-tab { color: var(--skin-ink-2); font-family: var(--skin-display); font-size: 11px; letter-spacing: .03em; }
.missions-panel[data-skin="paper"] .missions-settings-tab[aria-selected="true"] { background: color-mix(in srgb, var(--skin-accent) 55%, var(--skin-page-2)); color: var(--skin-ink); font-weight: 800; }
.missions-panel[data-skin="paper"] .missions-settings-note { border: 1.5px dashed var(--skin-line-strong); border-radius: 9px; background: var(--skin-page-2); }
.missions-panel[data-skin="paper"] .missions-settings-note-text { color: var(--skin-ink-3); font-family: var(--skin-display); font-size: 11px; }
.missions-panel[data-skin="paper"] .missions-toolbar { padding: 11px 30px 8px; gap: 7px; background-color: var(--skin-page); background-image: radial-gradient(var(--skin-grain) .55px, transparent .6px); background-size: 9px 9px; }
.missions-panel[data-skin="paper"] .missions-search { height: 32px; border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); color: var(--skin-ink-3); box-shadow: 1px 1px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-search input { color: var(--skin-ink); font-size: 12.5px; }
.missions-panel[data-skin="paper"] .missions-search input::placeholder { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-select { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 1px 1px 0 var(--skin-shadow); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-status-menu { border: 1.5px solid var(--skin-ink); border-radius: 9px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-status-option:hover { background: color-mix(in srgb, var(--skin-ink) 8%, transparent); }
.missions-panel[data-skin="paper"] .missions-status-actions { border-color: var(--skin-line); }
.missions-panel[data-skin="paper"] .missions-dash-link { font-family: var(--skin-display); }
.missions-panel[data-skin="paper"] .missions-select-label { color: var(--skin-ink-3); font-size: 9px; }
.missions-panel[data-skin="paper"] .missions-select-value { color: var(--skin-ink); font-weight: 600; }
.missions-panel[data-skin="paper"] .missions-select[data-active="true"] { border-color: var(--skin-accent-strong); background: color-mix(in srgb, var(--skin-warn) 52%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-switch { color: var(--skin-ink-2); font-size: 10.5px; }
.missions-panel[data-skin="paper"] .missions-switch-track { border: 1.5px solid var(--skin-ink); background: var(--skin-page-2); box-shadow: 1px 1px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-switch-thumb {
  border-radius: 0;
  box-shadow: none;
  background: var(--skin-ink);
  clip-path: polygon(50% 0%, 72.6% 27.4%, 100% 50%, 72.6% 72.6%, 50% 100%, 27.4% 72.6%, 0% 50%, 27.4% 27.4%);
}
.missions-panel[data-skin="paper"] .missions-switch-thumb::after {
  content: "";
  position: absolute;
  inset: 0;
  width: 4px;
  height: 4px;
  margin: auto;
  border-radius: 50%;
  background: var(--skin-page-2);
}
.missions-panel[data-skin="paper"] .missions-switch[aria-checked="true"] .missions-switch-track { background: var(--skin-accent); border-color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-switch[aria-checked="true"] .missions-switch-thumb { background: var(--skin-accent-ink); }
.missions-panel[data-skin="paper"] .missions-switch[aria-checked="true"] .missions-switch-thumb::after { background: var(--skin-accent); }
.missions-panel[data-skin="paper"] .missions-blocked .missions-switch[aria-checked="true"] .missions-switch-track { background: var(--skin-danger); border-color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-blocked .missions-switch[aria-checked="true"] .missions-switch-thumb::after { background: var(--skin-danger); }
.missions-panel[data-skin="paper"] .missions-clear { height: 29px; padding: 0 9px; border: 1.5px dashed var(--skin-line-strong); border-radius: 7px; color: var(--skin-ink-3); text-decoration: none; font-size: 10px; }
.missions-panel[data-skin="paper"] .missions-clear:hover { border-color: var(--skin-ink); color: var(--skin-ink); }

.missions-panel[data-skin="paper"] .missions-sect { background: color-mix(in srgb, var(--skin-ink) 6%, transparent); }
.missions-panel[data-skin="paper"] .missions-card-sub { color: var(--skin-ink-3); font-family: var(--skin-display); letter-spacing: .01em; }
.missions-panel[data-skin="paper"] .missions-card--widget .missions-card-foot, .missions-panel[data-skin="paper"] .missions-rowitem { border-color: var(--skin-line); }
.missions-panel[data-skin="paper"] .missions-rowage[data-quiet="true"] { color: var(--skin-attention); }
.missions-panel[data-skin="paper"] .missions-row { font-family: var(--skin-display); }
.missions-panel[data-skin="paper"] .missions-rowkey { font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-row[data-state="in-review"] .missions-rowdot { background: var(--skin-info-strong); }
.missions-panel[data-skin="paper"] .missions-row[data-state="ready-for-prod"] .missions-rowdot { background: var(--skin-alt-strong); }
.missions-panel[data-skin="paper"] .missions-row[data-state="in-progress"] .missions-rowdot { background: var(--skin-warn-ink); }
.missions-panel[data-skin="paper"] .missions-row[data-state="ready"] .missions-rowdot { background: var(--skin-good-strong); }
.missions-panel[data-skin="paper"] .missions-row[data-state="to-refine"] .missions-rowdot { background: var(--skin-quiet-strong); }
.missions-panel[data-skin="paper"] .missions-rowwhy { font-family: var(--skin-display); border: 1px solid var(--skin-line-strong); background: var(--skin-page); color: var(--skin-ink-2); }
:root[data-ds-dark-theme] .missions-rowage[data-quiet="true"],
body[data-ds-dark-theme] .missions-rowage[data-quiet="true"] { color: var(--skin-attention); }

/* Cards: ink frame and offset print shadow. */
/* The paper skin frames the two remaining variants; the pick keeps its geometry. */
.missions-panel[data-skin="paper"] .missions-card { position: relative; border: 1.5px solid var(--skin-ink); border-radius: 12px 12px 13px 3px; background: var(--skin-page-2); box-shadow: 3px 3px 0 var(--skin-shadow); transition: background-color .12s ease, box-shadow .12s ease; }
.missions-panel[data-skin="paper"] .missions-card[data-interactive="true"]:hover { border-color: var(--skin-ink); background: color-mix(in srgb, var(--skin-accent) 8%, var(--skin-page-2)); box-shadow: 5px 5px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-card[data-interactive="true"]:focus-visible { outline: 2px solid var(--skin-accent-strong); outline-offset: 2px; }
.missions-panel[data-skin="paper"] .missions-card[data-interactive="true"][aria-pressed="true"] { border-color: var(--skin-accent-strong); background: color-mix(in srgb, var(--skin-accent) 22%, var(--skin-page-2)); box-shadow: 3px 3px 0 var(--skin-accent-strong); }
.missions-panel[data-skin="paper"] .missions-card[data-priority="urgent"] { border-left: 4px solid var(--skin-danger-strong); padding-left: 12px; }
.missions-panel[data-skin="paper"] .missions-card-top { gap: 6px; }
.missions-panel[data-skin="paper"] .missions-prio { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-prio[data-priority="normal"] { color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-prio[data-priority="high"] { color: var(--skin-accent-strong); }
.missions-panel[data-skin="paper"] .missions-prio[data-priority="urgent"] { color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-prio[data-priority="urgent"] .prio-chip { fill: var(--skin-danger); opacity: 1; }
.missions-panel[data-skin="paper"] .missions-prio[data-priority="urgent"] .prio-mark { fill: var(--skin-ink); }
/* Le bloc sombre manga ne redéfinit pas --skin-accent (palette claire) : c'est
   cet orange clair qui tient le contraste du high sur --skin-page-2. */
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-prio[data-priority="high"] { color: var(--skin-accent); }
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-prio[data-priority="urgent"] .prio-chip { fill: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-card-title { color: var(--skin-ink); font-size: 14.5px; font-weight: 600; line-height: 1.35; }
.missions-panel[data-skin="paper"] .missions-card-head-title { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-card-meta { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-card-foot { color: var(--skin-ink-3); font-size: 10.5px; }

/* Drawer: an orange spine, a portrait, inked actions. */
.missions-panel[data-skin="paper"] .missions-drawer { position: relative; width: 404px; max-width: 46%; padding: 16px 22px 24px 40px; border-left: 1.5px solid var(--skin-ink); background: var(--skin-page); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-drawer::before { content: "WORKSPACE MISSIONS"; position: absolute; left: 0; top: 0; bottom: 0; width: 20px; display: flex; align-items: center; justify-content: center; writing-mode: vertical-rl; transform: rotate(180deg); background: var(--skin-accent); border-right: 1.5px solid var(--skin-ink); color: var(--skin-ink); font-size: 8px; font-weight: 800; letter-spacing: .16em; }
.missions-panel[data-skin="paper"] .missions-drawer-head { gap: 10px; align-items: flex-start; }
.missions-panel[data-skin="paper"] .missions-drawer-portrait { flex: none; width: 56px; height: 56px; border-radius: 50%; overflow: hidden; border: 2px solid var(--skin-ink); background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-drawer-portrait img,
.missions-panel[data-skin="paper"] .missions-drawer-portrait svg { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-skin="paper"] .missions-drawer-key { color: var(--skin-ink-3); font-size: 10px; }
.missions-panel[data-skin="paper"] .missions-drawer-title { color: var(--skin-ink); font-family: var(--skin-display); font-size: 19px; line-height: 1.15; }
.missions-panel[data-skin="paper"] .missions-drawer-close { border: 1.5px solid var(--skin-ink); border-radius: 7px; background: var(--skin-page-2); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-drawer-tabs { gap: 20px; border-bottom: 1.5px solid var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-drawer-tab { height: 32px; color: var(--skin-ink-3); font-size: 10.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-drawer-tab:hover { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-drawer-tab[aria-selected="true"] { color: var(--skin-ink); border-bottom: 3px solid var(--skin-accent-strong); }
.missions-panel[data-skin="paper"] .missions-drawer-panel .missions-props { border-top: 0; }
.missions-panel[data-skin="paper"] .missions-props { grid-template-columns: 92px 1fr; gap: 0 12px; border-top: 1.5px solid var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-props dt, .missions-panel[data-skin="paper"] .missions-props dd { padding: 6px 0; border-bottom: 1px dashed var(--skin-line); }
.missions-panel[data-skin="paper"] .missions-props dt { color: var(--skin-ink-3); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-props dd { color: var(--skin-ink); font-size: 11.5px; }
.missions-panel[data-skin="paper"] .missions-action { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); color: var(--skin-ink); box-shadow: 2px 2px 0 var(--skin-shadow); font-size: 11.5px; }
.missions-panel[data-skin="paper"] .missions-action--primary { background: var(--skin-ink); color: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-action:focus-visible { outline-color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-action--danger-armed { background: var(--skin-accent-strong); color: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-action--armed { background: var(--skin-ink); color: var(--skin-page); }
/* Pinned, the frame and its inner filet take the skin's ink on paper: the
   pin is planted, and the state reads before the tooltip. The hover keeps
   the paper and the ink. */
.missions-panel[data-skin="paper"] .missions-action--pinned { border: 1.5px solid var(--skin-ink); background: var(--skin-page-2); color: var(--skin-ink); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-action--pinned:hover { background: var(--skin-page-2); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-drawer-note { padding: 6px 9px; border-left: 3px solid var(--skin-accent); background: color-mix(in srgb, var(--skin-accent) 12%, var(--skin-page)); color: var(--skin-ink-2); font-size: 10.5px; }
.missions-panel[data-skin="paper"] .missions-declare { gap: 7px; border-top: 1.5px solid var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-blocked { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-blocked[data-blocked="true"] { border-color: var(--skin-danger-strong); background: color-mix(in srgb, var(--skin-danger) 10%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-blocked-title { font-family: var(--skin-display, inherit); letter-spacing: .01em; }
.missions-panel[data-skin="paper"] .missions-blocked-reason-meta, .missions-panel[data-skin="paper"] .missions-blocked-reason-note { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-blocked-reason-text { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-blocked-reason-link { color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-blocked-input { border: 1.5px solid var(--skin-ink); border-radius: 6px; background: var(--skin-page); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-priority-select { border: 1.5px solid var(--skin-ink); border-radius: 6px; background: var(--skin-page); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-priority-note { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-priority-note--error { color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-points-select { border: 1.5px solid var(--skin-ink); border-radius: 6px; background: var(--skin-page); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-points-note { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-points-note--error { color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-blocked-apply { border: 1.5px solid var(--skin-danger-strong); border-radius: 6px; background: var(--skin-danger); color: var(--skin-page); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-blocked-cancel { border: 1.5px solid var(--skin-ink); border-radius: 6px; color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-declare-label { color: var(--skin-ink-3); font-family: var(--skin-mono); font-size: 9.5px; letter-spacing: .08em; }
.missions-panel[data-skin="paper"] .missions-declare-input { height: 30px; border: 1.5px solid var(--skin-ink); border-radius: 7px; background: var(--skin-page-2); color: var(--skin-ink); font-size: 11.5px; box-shadow: 1px 1px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-declare-input:focus { outline: 2px solid var(--skin-accent-strong); outline-offset: 1px; }
.missions-panel[data-skin="paper"] .missions-declare-save { height: 30px; border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); color: var(--skin-ink); box-shadow: 2px 2px 0 var(--skin-shadow); font-size: 11.5px; font-weight: 600; }
.missions-panel[data-skin="paper"] .missions-declare-save:hover:not(:disabled) { background: var(--skin-page-3); }
.missions-panel[data-skin="paper"] .missions-declare-note { color: var(--skin-ink-3); font-size: 10.5px; }
.missions-panel[data-skin="paper"] .missions-declare-note--error { color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-tolgee-note { color: var(--skin-ink-3); font-size: 10.5px; }
.missions-panel[data-skin="paper"] .missions-tolgee-note--error { color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-journal-meta { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-journal-text { border: 1.5px solid var(--skin-line); border-radius: 8px; background: var(--skin-page-2); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-journal-hint { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-checklist-meta { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-checklist-body { border: 1.5px solid var(--skin-line); border-radius: 8px; background: var(--skin-page-2); }
.missions-panel[data-skin="paper"] .missions-checklist-title { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-checklist-item, .missions-panel[data-skin="paper"] .missions-checklist-bullet { color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-checklist-text, .missions-panel[data-skin="paper"] .missions-checklist-note, .missions-panel[data-skin="paper"] .missions-checklist-hint { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-checklist-box { border: 1.5px solid var(--skin-line-strong); border-radius: 3px; }
.missions-panel[data-skin="paper"] .missions-checklist-box[aria-checked="true"] { border-color: var(--skin-ink); background: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-checklist-box[aria-checked="true"]::after { color: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-drawer--empty { border-left: 1.5px dashed var(--skin-line-strong); }
.missions-panel[data-skin="paper"] .missions-drawer-hint { color: var(--skin-ink-3); }

/* Repositories: the workspace root as a paper ledger, ink names, a stamped row. */
.missions-panel[data-skin="paper"] .missions-repos { padding-top: 12px; }
.missions-panel[data-skin="paper"] .missions-repo-head { border-bottom: 1.5px solid var(--skin-line-strong); color: var(--skin-ink-3); font-size: 9px; }
.missions-panel[data-skin="paper"] .missions-repo-rowitem { border-bottom: 1px solid var(--skin-line); }
.missions-panel[data-skin="paper"] .missions-repo { border-radius: 6px; color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo:hover { background: color-mix(in srgb, var(--skin-accent) 22%, transparent); }
.missions-panel[data-skin="paper"] .missions-repo-main, .missions-panel[data-skin="paper"] .missions-repo-remove { color: var(--skin-ink-3); border-radius: 6px; }
.missions-panel[data-skin="paper"] .missions-repo-main:hover:not(:disabled) { background: color-mix(in srgb, var(--skin-accent) 22%, transparent); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-remove:hover:not(:disabled) { background: color-mix(in srgb, var(--skin-danger) 18%, transparent); color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-repo-main:focus-visible, .missions-panel[data-skin="paper"] .missions-repo-remove:focus-visible { outline-color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-name { font-family: var(--skin-mono); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-kind { border-color: var(--skin-line-strong); color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-repo-branch { color: var(--skin-ink-2); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-repo-state { border: 1px solid var(--skin-line-strong); background: var(--skin-page-2); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-repo-state[data-dirty="true"] { border-color: var(--skin-accent-strong); color: var(--skin-accent-strong); }
.missions-panel[data-skin="paper"] .missions-repo-state[data-error="true"] { border-color: var(--skin-danger-strong); color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-repo-age { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-repos-gesture { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repos-gesture.is-done { border-color: var(--skin-good-strong); background: color-mix(in srgb, var(--skin-good) 28%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-repos-gesture.is-partial { border-color: var(--skin-accent); background: color-mix(in srgb, var(--skin-warn) 30%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-repos-gesture.is-error { border-color: var(--skin-danger-strong); background: color-mix(in srgb, var(--skin-danger) 22%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-repos-note { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-repos-error { border: 1.5px solid var(--skin-danger-strong); background: color-mix(in srgb, var(--skin-danger) 22%, var(--skin-page-2)); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-usage-title { color: var(--skin-ink-3); font-family: var(--skin-display); letter-spacing: .12em; }
.missions-panel[data-skin="paper"] .missions-usage-row, .missions-panel[data-skin="paper"] .missions-usage-top-item { border-bottom-color: var(--skin-line); }
.missions-panel[data-skin="paper"] .missions-usage-label, .missions-panel[data-skin="paper"] .missions-usage-count { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-usage-verdict { border: 1px solid var(--skin-line-strong); }
.missions-panel[data-skin="paper"] .missions-usage-verdict--grow { background: var(--skin-good); border-color: var(--skin-good-strong); color: var(--skin-good-strong); }
.missions-panel[data-skin="paper"] .missions-usage-verdict--keep { background: var(--skin-info); border-color: var(--skin-info-strong); color: var(--skin-info-strong); }
.missions-panel[data-skin="paper"] .missions-usage-verdict--improve { background: var(--skin-warn); border-color: var(--skin-warn-ink); color: var(--skin-warn-ink); }
.missions-panel[data-skin="paper"] .missions-usage-verdict--remove { background: var(--skin-danger); border-color: var(--skin-danger-strong); color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-usage-verdict--none { background: var(--skin-page-3); border-color: var(--skin-line); color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-usage-value { background: var(--skin-page-3); color: var(--skin-ink-2); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-usage-note { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-drawer-section-title { color: var(--skin-ink-3); font-family: var(--skin-display); font-size: 9px; letter-spacing: .08em; }
.missions-panel[data-skin="paper"] .missions-repo-tabs { gap: 20px; border-bottom: 1.5px solid var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-tab { height: 32px; color: var(--skin-ink-3); font-family: var(--skin-display); font-size: 10.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-repo-tab[aria-selected="true"] { border-bottom: 3px solid var(--skin-accent-strong); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-history-branch { border: 1.5px solid var(--skin-ink); border-radius: 6px; background-color: var(--skin-page-2); background-image: var(--skin-select-arrow); color: var(--skin-ink); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-history-total { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-history-hash { color: var(--skin-accent-strong); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-history-age { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-history-subject { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-history-more { padding: 4px 10px; border: 1.5px solid var(--skin-ink); border-radius: 6px; background: var(--skin-page-2); color: var(--skin-ink); }

/* The tooltip under the illustrated skin: a slip cut from the page's paper,
   ink border and offset print shadow, like the drawer's own cards. */
.missions-panel[data-skin="paper"] .missions-tip { border: 1.5px solid var(--skin-ink); border-radius: 7px; background: var(--skin-page-2); color: var(--skin-ink); box-shadow: 2px 2px 0 var(--skin-shadow); font-family: var(--skin-display); }
/* Dark keeps the same tokens: the skin's own dark values carry it, and only
   the shadow deepens so the bubble still lifts off the page. */
:root[data-ds-dark-theme] .missions-tip,
body[data-ds-dark-theme] .missions-tip { box-shadow: 0 8px 20px color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 26%, transparent); }

.missions-panel[data-skin="paper"] .missions-loader { color: var(--skin-ink-3); min-height: 340px; }
.missions-panel[data-skin="paper"] .missions-loader-label { font-family: var(--skin-display); font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-sharingan { width: 86px; height: 86px; filter: drop-shadow(0 0 16px color-mix(in srgb, var(--skin-danger) 50%, transparent)); animation: missions-sharingan-pulse 1.6s ease-in-out infinite alternate; }
.missions-panel[data-skin="paper"] .missions-sharingan svg { width: 100%; height: 100%; overflow: visible; }
.missions-panel[data-skin="paper"] .missions-sharingan-tomoe { transform-box: view-box; transform-origin: 60px 60px; animation: missions-sharingan-spin 1.6s linear infinite; }
@keyframes missions-sharingan-spin { to { transform: rotate(360deg); } }
@keyframes missions-sharingan-pulse { from { opacity: .8; } to { opacity: 1; } }

/* Narrow panel: keep the header, lose the bubble and shrink the portrait. */
@media (prefers-reduced-motion: reduce) {
  .missions-panel[data-skin="paper"] .missions-card { transition: none; }
  .missions-panel[data-skin="paper"] .missions-card[data-interactive="true"]:hover { transform: none; }
}

@container (max-width: 760px) {
  .missions-panel[data-skin="paper"] .missions-hero { height: 150px; }
  .missions-panel[data-skin="paper"] .missions-head--hero { height: 150px; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-title { font-size: 30px; bottom: 24px; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-scope { bottom: 8px; font-size: 10px; }
  .missions-panel[data-skin="paper"] .missions-hero-avatar { width: 84px; height: 84px; }
  .missions-panel[data-skin="paper"] .missions-hero-bubble { display: none; }
  .missions-panel[data-skin="paper"] .missions-hero-photo { --hero-scale: 1.28; --hero-pan: max(6%, 28px); }
  .missions-panel[data-skin="paper"] .missions-tabs, .missions-panel[data-skin="paper"] .missions-toolbar { padding-left: 22px; padding-right: 22px; }
  .missions-panel[data-skin="paper"] .missions-body { padding-left: 22px; padding-right: 22px; }
  .missions-panel[data-skin="paper"] .missions-head--hero { padding: 0 22px; }
  .missions-panel[data-skin="paper"] .missions-kicker, .missions-panel[data-skin="paper"] .missions-head--hero .missions-title { left: 22px; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-scope { left: 23px; }
}

@container (max-width: 300px) {
  .missions-panel[data-skin="paper"] .missions-hero-photo { --hero-scale: 1.36; --hero-pan: max(6%, 28px); }
}


`

    /** Tab icon: a list of tickets. */
    function MissionsGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
        'aria-hidden': 'true',
      },
        h('rect', { x: 2.2, y: 2.8, width: 11.6, height: 10.4, rx: 1.8 }),
        h('path', { d: 'M5.2 6.6h5.6M5.2 9.2h3.8' }),
      )
    }

    /**
     * The one card of the plugin: an ink frame, then the slots each list fills.
     * The frame (border, radius, background) is shared; the geometry, the paper
     * skin and the interior belong to the variant.
     *
     * `interactive` is what makes a card a control: it takes the click and
     * says so with `data-interactive`, so the stylesheet never draws an
     * affordance a static card would lie about. The pick is a native `button`:
     * it brings the focus ring, the keys and the pressed state by itself.
     */
    function Card({
      as = 'article',
      variant,
      className = '',
      interactive = false,
      pressed,
      onActivate,
      head,
      top,
      title,
      sub,
      body,
      foot,
      children,
      ...rest
    }) {
      const props = { ...rest, className: ['missions-card', `missions-card--${variant}`, className].filter(Boolean).join(' ') }
      if (interactive) {
        props['data-interactive'] = 'true'
        props.onClick = onActivate
      }
      if (pressed !== undefined) props['aria-pressed'] = pressed
      const slot = (value) => (Array.isArray(value) ? value : [value])
      return h(as, props,
        head != null ? h('header', { className: 'missions-card-head' }, ...slot(head)) : null,
        top != null ? h('div', { className: 'missions-card-top' }, ...slot(top)) : null,
        title != null ? h('div', { className: 'missions-card-title' }, title) : null,
        sub != null ? h('p', { className: 'missions-card-sub' }, sub) : null,
        body != null ? h('div', { className: 'missions-card-body' }, ...slot(body)) : null,
        ...slot(children ?? null),
        foot != null ? h('div', { className: 'missions-card-foot' }, ...slot(foot)) : null,
      )
    }

    /**
     * One card of a dashboard section: a title, an optional line saying what
     * the card is for, a count, a body, and an optional footer that keeps the
     * total when the card is taller than its rows.
     */
    function DashboardCard({ title, sub, meta, className, footer, children }) {
      return h(Card, {
        variant: 'widget',
        className,
        head: [
          h('h3', { className: 'missions-card-head-title' }, title),
          h('span', { className: 'missions-card-meta' }, meta),
        ],
        // What the card is for, under its title: the title alone assumes the
        // rule is known, and the rule is exactly what a first read misses.
        sub,
        body: children,
        foot: footer,
      })
    }

    /**
     * One row of a dashboard card: state dot, key, title, age, and — in the
     * queue only — the verb the state asks for. The whole row is the button:
     * the dashboard's job is to get the mission open, not to act on it.
     */
    function DashboardRow({ mission, now, verb, onOpen }) {
      const age = missionAge(mission.updatedAt, now)
      const verbLabel = verb ? actionVerb(mission.state) : ''
      return h('li', { className: 'missions-rowitem' },
        h('button', {
          type: 'button',
          className: 'missions-row',
          'data-state': mission.state,
          onClick: () => onOpen(mission),
          title: `Open ${mission.key}`,
          'aria-label': `${mission.key} ${mission.title}${age.label ? `, ${age.label}` : ''}${
            age.quiet ? ', not updated for a week' : ''
          }${verbLabel ? `, ${verbLabel}` : ''}`,
        },
          h('span', { className: 'missions-rowdot', 'aria-hidden': 'true' }),
          h('span', { className: 'missions-rowkey' }, mission.key),
          h('span', { className: 'missions-rowtitle' }, mission.title),
          h('span', { className: 'missions-rowage', 'data-quiet': age.quiet ? 'true' : 'false' }, age.label),
          verb
            ? h('span', { className: 'missions-rowverb' },
                verbLabel,
                h('span', { className: 'missions-rowarrow', 'aria-hidden': 'true' }, '→'),
              )
            : null,
        ),
      )
    }

    /**
     * The foot of a widget: what the card does not show, and the way to the
     * list. The link only appears when the card holds more rows than it shows;
     * its label carries the card's total — every unblocked row, shown or not.
     * The list it opens is wider than the card: it keeps the blocked missions
     * of these states, so it can hold more rows than the number the link was
     * opened with. The note is the card's own — points, hidden rows — and when
     * the card fits with nothing to note, the foot returns nothing at all: no
     * empty rule under the last row.
     */
    function widgetFoot({ note, total, onViewAll, cap = WIDGET_ROWS }) {
      const more = total > cap
      if (!note && !more) return null
      return h(React.Fragment, null,
        note ? h('span', { className: 'missions-dash-card-note' }, note) : null,
        more
          ? h('button', { type: 'button', className: 'missions-dash-link', onClick: onViewAll },
              `View all ${total}`,
              h('span', { className: 'missions-dash-link-arrow', 'aria-hidden': 'true' }, '→'),
            )
          : null,
      )
    }

    /**
     * The header of a dashboard section: its title, what it counts, and the tab
     * it opens. The link is the digest's way out, and it is the only way the
     * section acts on the panel.
     */
    function SectionHead({ id, title, scope, label, tab, onOpen }) {
      return h('header', { className: 'missions-sect-head' },
        h('h2', { className: 'missions-sect-title', id }, title),
        h('span', { className: 'missions-sect-scope' }, scope),
        h('button', { type: 'button', className: 'missions-sect-link', onClick: () => onOpen(tab) },
          label,
          h('span', { className: 'missions-sect-arrow', 'aria-hidden': 'true' }, '→'),
        ),
      )
    }

    /**
     * One row of a repository card: what the row is about — a repository, or a
     * mission whose branch lingers — the branch, the reason it is there, and
     * the age of the checkout's last commit. The row opens the repository
     * drawer, where the gesture lives.
     */
    function DigestRow({ row, now, onOpen }) {
      const age = missionAge(row.repository?.lastCommit?.date, now)
      const name = row.repository?.name ?? ''
      const key = row.mission?.key ?? name
      const title = row.branch ?? row.repository?.branch ?? ''
      const reason = row.reason ?? 'other'
      return h('li', { className: 'missions-rowitem' },
        h('button', {
          type: 'button',
          className: 'missions-row missions-row--repo',
          'data-reason': reason,
          onClick: () => onOpen(row.repository),
          title: `Open ${name}`,
          'aria-label': `${key} ${title}, ${row.label}${age.label ? `, last commit ${age.label} ago` : ''}`,
        },
          h('span', { className: 'missions-rowkey' }, key),
          h('span', { className: 'missions-rowtitle' }, title || row.label),
          h('span', { className: 'missions-rowwhy', 'data-reason': reason }, row.label),
          h('span', { className: 'missions-rowage', 'data-quiet': age.quiet ? 'true' : 'false' }, age.label),
        ),
      )
    }

    /**
     * The dashboard: a section per domain, a card per widget. Missions opens on
     * the four lenses the list makes you filter by hand; Repositories digests
     * the read its own tab makes — the root's cached scan — so no section pays
     * for a second read. A section whose read failed keeps what it already
     * showed and names the failure: the digest never turns a broken read into a
     * zero.
     */
    function DashboardView({
      missions = [],
      loading,
      theme,
      failed,
      now = Date.now(),
      onOpen,
      onOpenAll,
      onViewAll,
      summary = null,
      summaryError = null,
      onOpenSection,
      onOpenRepository,
      onRetrySummary,
    }) {
      const queue = needsYou(missions)
      const flight = inFlight(missions)
      const bugs = assignedBugs(missions)
      const stories = highPriorityStories(missions)
      const scope = dashboardScope(missions)
      const points = pointsTotal(flight)

      // In flight is sorted oldest first, so the first row carries the oldest
      // age; it formats like the rows do (hours below a day, empty when the date
      // is unreadable) so the foot never claims "oldest 0 d".
      const oldest = flight.length > 0 ? missionAge(flight[0].updatedAt, now).label : ''

      const scopeLabel = [
        `${scope.needYou} ${scope.needYou === 1 ? 'needs' : 'need'} you`,
        `${scope.open} open`,
        `${scope.projects} ${scope.projects === 1 ? 'project' : 'projects'}`,
      ].join(' · ')

      const foot = []
      if (points.counted > 0) foot.push(`${points.total} pt${points.total > 1 ? 's' : ''} in flight`)
      if (oldest) foot.push(`oldest ${oldest}`)
      const flightNote = foot.length > 0 ? foot.join(' · ') : null

      // The cards show the head of their list; the foot says how many rows stay
      // behind and opens them in the list, filtered on the states the card
      // shows. That is the whole point of the cap: the dashboard stays a digest,
      // and the list stays the place where everything is reachable.
      const queueShown = queue.slice(0, WIDGET_ROWS)
      const flightShown = flight.slice(0, WIDGET_ROWS)
      const bugsShown = bugs.slice(0, WIDGET_ROWS)
      const storiesShown = stories.slice(0, WIDGET_ROWS)
      const queueHidden = queue.length - queueShown.length
      const bugsHidden = bugs.length - bugsShown.length
      const storiesHidden = stories.length - storiesShown.length

      // A failed read is not an empty queue: the panel's banner says what broke,
      // so the digest stays quiet instead of claiming there is no work. A warm
      // refresh keeps what it already shows; only a cold mount has nothing.
      const body = missions.length === 0
        ? failed
          ? null
          : loading
            ? h(PanelLoader, { theme })
            : h('div', { className: 'missions-dash-empty' },
                h('p', null, 'No mission is assigned to you yet.'),
                h('p', { className: 'missions-dash-empty-hint' }, 'This is where your queue will appear as soon as the tracker returns one.'),
              )
        : h('div', { className: 'missions-sectgrid' },
              h(DashboardCard, {
                title: 'Bugs',
                sub: 'Unresolved, not ready to ship. Oldest first.',
                meta: bugs.length,
                className: 'missions-dash-card--bugs',
                footer: widgetFoot({
                  note: bugsHidden > 0 ? `${bugsHidden} more ${bugsHidden === 1 ? 'bug' : 'bugs'}` : null,
                  total: bugs.length,
                  onViewAll: () => onViewAll({ type: 'bug', state: stateOptions(bugs) }),
                }),
              },
                bugs.length === 0
                  ? h('p', { className: 'missions-card-empty' }, 'No unblocked bug before its release.')
                  : h('ul', { className: 'missions-rows' },
                      bugsShown.map((mission) => h(DashboardRow, { key: mission.key, mission, now, verb: false, onOpen })),
                    ),
              ),
              h(DashboardCard, {
                title: 'High-priority stories',
                sub: 'Urgent or high, not ready to ship. Oldest first.',
                meta: stories.length,
                className: 'missions-dash-card--stories',
                footer: widgetFoot({
                  note: storiesHidden > 0 ? `${storiesHidden} more ${storiesHidden === 1 ? 'story' : 'stories'}` : null,
                  total: stories.length,
                  onViewAll: () => onViewAll({ type: 'story', priority: ['urgent', 'high'], state: stateOptions(stories) }),
                }),
              },
                stories.length === 0
                  ? h('p', { className: 'missions-card-empty' }, 'No unblocked high-priority story before its release.')
                  : h('ul', { className: 'missions-rows' },
                      storiesShown.map((mission) => h(DashboardRow, { key: mission.key, mission, now, verb: false, onOpen })),
                    ),
              ),
              h(DashboardCard, {
                title: 'In flight',
                sub: 'Started, not shipped.',
                meta: flight.length,
                className: 'missions-dash-card--flight',
                footer: widgetFoot({
                  note: flightNote,
                  total: flight.length,
                  onViewAll: () => onViewAll({ state: stateOptions(flight) }),
                }),
              },
                flight.length === 0
                  ? h('p', { className: 'missions-card-empty' }, 'Nothing in progress is unblocked.')
                  : h('ul', { className: 'missions-rows' },
                      flightShown.map((mission) => h(DashboardRow, { key: mission.key, mission, now, verb: false, onOpen })),
                    ),
              ),
              h(DashboardCard, {
                title: 'Needs you',
                sub: 'Waiting on your next move, most urgent first.',
                meta: queue.length,
                className: 'missions-dash-card--queue',
                footer: widgetFoot({
                  note: queueHidden > 0 ? `${queueHidden} more waiting` : null,
                  total: queue.length,
                  onViewAll: () => onViewAll({ state: stateOptions(queue) }),
                }),
              },
                queue.length === 0
                  ? h('p', { className: 'missions-card-empty' }, 'Nothing unblocked is waiting on you.')
                  : h('ul', { className: 'missions-rows' },
                      queueShown.map((mission) => h(DashboardRow, { key: mission.key, mission, now, verb: true, onOpen })),
                    ),
              ),
            )

      // The repository digest. A cold failure has no rows to keep, so its cards
      // stay empty and the section's line names the root's failure; a warm one
      // keeps the rows it had. `summary` is null exactly when no read has ever
      // come back, and that is the only case where a card says "—" rather than
      // a number: the panel never invents a zero.
      const repositories = Array.isArray(summary?.repositories) ? summary.repositories : []
      const branches = branchesToPush(missions, repositories)
      const checkouts = checkoutsToFix(repositories)
      const neverPushed = branches.filter((row) => row.neverPushed).length
      const commitsAhead = branches.reduce((total, row) => total + row.ahead, 0)
      const cold = repositories.filter((repository) => {
        const days = ageDays(repository?.lastCommit?.date, now)
        return days !== null && days > COLD_CHECKOUT_DAYS
      }).length
      const scanAge = summary?.scannedAt ? missionAge(summary.scannedAt, now).label : ''
      const scanNote = scanAge ? `scanned ${scanAge} ago` : ''
      const branchFoot = [branches.length > 0
        ? `${neverPushed} never pushed · ${commitsAhead} commit${commitsAhead === 1 ? '' : 's'} ahead`
        : null, scanNote].filter(Boolean).join(' · ')

      const repositoriesSection = summary || summaryError
        ? h('section', { className: 'missions-sect', 'aria-labelledby': 'missions-sect-repositories' },
            h(SectionHead, {
              id: 'missions-sect-repositories',
              title: 'Repositories',
              scope: summary ? repositoryScope(summary).label : 'scan failed',
              label: 'Open Repositories',
              tab: 'repositories',
              onOpen: onOpenSection,
            }),
            // The failure keeps its own line: the section still shows what it
            // has, and the Retry is one gesture that pays a new scan.
            summaryError
              ? h('div', { className: 'missions-sect-error', role: 'alert' },
                  h('span', { className: 'missions-sect-error-text' }, `The repository scan failed: ${summaryError}`),
                  h('button', { type: 'button', className: 'missions-retry', onClick: onRetrySummary }, 'Retry'),
                )
              : null,
            h('div', { className: 'missions-sectgrid' },
              h(DashboardCard, {
                title: 'Branches to push',
                sub: 'Open missions whose branch is not on the remote yet.',
                meta: summary ? branches.length : '—',
                className: 'missions-dash-card--branches',
                footer: summary ? branchFoot : null,
              },
                !summary
                  ? null
                  : branches.length === 0
                    ? h('p', { className: 'missions-card-empty' }, 'Every open mission branch is pushed.')
                    : h('ul', { className: 'missions-rows' },
                        branches.map((row) => h(DigestRow, {
                          key: `${row.repository.name} ${row.branch}`,
                          row,
                          now,
                          onOpen: onOpenRepository,
                        })),
                      ),
              ),
              h(DashboardCard, {
                title: 'Checkouts to fix',
                sub: 'Unreadable, behind, or dirty: the gravest reason wins.',
                meta: summary ? checkouts.length : '—',
                className: 'missions-dash-card--checkouts',
                footer: summary
                  ? [`${cold} cold ${cold === 1 ? 'clone' : 'clones'}`, scanNote].filter(Boolean).join(' · ')
                  : null,
              },
                !summary
                  ? null
                  : checkouts.length === 0
                    ? h('p', { className: 'missions-card-empty' }, 'No checkout needs a gesture.')
                    : h('ul', { className: 'missions-rows' },
                        checkouts.map((row) => h(DigestRow, {
                          key: row.repository.name,
                          row,
                          now,
                          onOpen: onOpenRepository,
                        })),
                      ),
              ),
            ),
          )
        : null

      return h('div', { className: 'missions-dashboard' },
        h('section', { className: 'missions-sect', 'aria-labelledby': 'missions-sect-missions' },
          h('header', { className: 'missions-sect-head' },
            h('h2', { className: 'missions-sect-title', id: 'missions-sect-missions' }, 'Missions'),
            h('span', { className: 'missions-sect-scope' }, scopeLabel),
            h('button', { type: 'button', className: 'missions-sect-link', onClick: onOpenAll },
              'Open Missions',
              h('span', { className: 'missions-sect-arrow', 'aria-hidden': 'true' }, '→'),
            ),
          ),
          body,
        ),
        repositoriesSection,
      )
    }

    /**
     * Le repère de priorité d'une carte : trois barres dont le nombre allumé
     * porte le niveau, un carré « ! » pour urgent, un carré pointillé quand la
     * priorité manque. La forme se lit sans la couleur ; l'infobulle et le
     * libellé lecteur d'écran donnent le mot.
     */
    function PriorityMark({ priority }) {
      const level = PRIORITY_LEVELS[priority] ?? 0
      const label = priority ? `Priority: ${PRIORITY_LABELS[priority]}` : 'No priority'
      const mark = {
        className: 'missions-prio',
        'data-priority': priority ?? 'none',
        role: 'img',
        'aria-label': label,
        title: label,
      }
      if (!priority) {
        return h('span', mark,
          h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' },
            h('rect', { className: 'prio-none', x: 1.6, y: 1.6, width: 8.8, height: 8.8, rx: 2.6 }),
          ),
        )
      }
      if (priority === 'urgent') {
        return h('span', mark,
          h('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' },
            h('rect', { className: 'prio-chip', x: 0, y: 0, width: 14, height: 14, rx: 3.5 }),
            h('rect', { className: 'prio-mark', x: 6.25, y: 3.1, width: 1.5, height: 5.2, rx: 0.75 }),
            h('rect', { className: 'prio-mark', x: 6.25, y: 9.5, width: 1.5, height: 1.5, rx: 0.75 }),
          ),
        )
      }
      return h('span', mark,
        h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' },
          PRIORITY_BARS.map((bar, index) => h('rect', {
            key: index,
            className: index < level ? 'prio-bar' : 'prio-bar prio-bar--off',
            x: bar.x, y: bar.y, width: 3, height: bar.height, rx: 1,
          })),
        ),
      )
    }

    /**
     * A filter with several values, as a list of check boxes.
     *
     * A native select carries one value, and a dashboard widget opens the list
     * on every value it showed — so these dimensions get a menu of their own.
     * The chip keeps the bar tight ("Ready", "4 selected"), the menu carries a
     * count per value and a shortcut to clear, and every choice is a real
     * checkbox: the keyboard reaches it without a custom key handler.
     */
    function ChecklistFilter({ label, value, options, labels = {}, counts = {}, allLabel, onChange }) {
      const [open, setOpen] = React.useState(false)
      const box = React.useRef(null)
      const selected = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
      const entries = [...options, ...selected.filter((option) => !options.includes(option))]

      // A click outside closes the menu. The listener only lives while the menu
      // is open, and unmounting the panel takes it with the wrapper.
      React.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (box.current && !box.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
      }, [open])

      // The chip stands alone, unlike a sentence, so its label starts with a
      // capital: "In progress" reads as a value, "in progress" as a fragment.
      const labelOf = (option) => {
        const text = labels[option] ?? option
        return text.charAt(0).toUpperCase() + text.slice(1)
      }
      const display = selected.length === 0
        ? 'All'
        : selected.length === 1
          ? labelOf(selected[0])
          : `${selected.length} selected`

      // The list arrives in the panel's order, never in click order: the chip,
      // the session and the list then agree on what "these values" means.
      const choose = (next) => {
        const ordered = entries.filter((entry) => next.includes(entry))
        onChange(ordered.length > 0 ? ordered : null)
      }
      const toggle = (option) => {
        choose(selected.includes(option) ? selected.filter((chosen) => chosen !== option) : [...selected, option])
      }

      const chevron = h('svg', { width: 9, height: 9, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 4 5 6.5 7.5 4' }),
      )

      return h('div', {
        className: 'missions-multi',
        ref: box,
        onKeyDown: (event) => {
          if (event.key === 'Escape' && open) setOpen(false)
        },
      },
        h('button', {
          type: 'button',
          className: 'missions-select',
          'data-active': selected.length > 0 ? 'true' : 'false',
          'data-open': open ? 'true' : 'false',
          'aria-haspopup': 'true',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': `Filter by ${label.toLowerCase()} (${display})`,
          onClick: () => setOpen((was) => !was),
        },
          h('span', { className: 'missions-select-label' }, label),
          h('span', { className: 'missions-select-value', title: display }, display),
          chevron,
        ),
        open
          ? h('div', { className: 'missions-status-menu' },
              h('ul', { className: 'missions-status-list', role: 'group', 'aria-label': label },
                entries.map((option) => h('li', { key: option, className: 'missions-status-item' },
                  h('label', { className: 'missions-status-option', 'data-state': option },
                    h('input', {
                      type: 'checkbox',
                      checked: selected.includes(option),
                      onChange: () => toggle(option),
                    }),
                    h('span', { className: 'missions-status-name', title: labelOf(option) }, labelOf(option)),
                    h('span', { className: 'missions-status-count', 'aria-hidden': 'true' }, String(counts[option] ?? 0)),
                  ),
                )),
              ),
              // « All » is the absence of a filter, not the list of the values
              // known today: a value that appears tomorrow must not be filtered
              // out by a bar saved yesterday.
              allLabel
                ? h('div', { className: 'missions-status-actions' },
                    h('button', { type: 'button', onClick: () => onChange(null) }, allLabel),
                  )
                : null,
            )
          : null,
      )
    }

    function PriorityFilter({ missions, value, onChange }) {
      const counts = {}
      for (const mission of missions) {
        if (mission.priority) counts[mission.priority] = (counts[mission.priority] ?? 0) + 1
      }
      return h(ChecklistFilter, {
        label: 'Priority',
        value,
        options: priorityOptions(missions),
        labels: PRIORITY_LABELS,
        counts,
        allLabel: 'All priorities',
        onChange,
      })
    }

    function TypeFilter({ missions, value, onChange }) {
      const counts = {}
      for (const mission of missions) {
        if (mission.type) counts[mission.type] = (counts[mission.type] ?? 0) + 1
      }
      return h(ChecklistFilter, {
        label: 'Type',
        value,
        options: TYPE_OPTIONS.map((option) => option.id),
        labels: TYPE_LABELS,
        counts,
        allLabel: 'All types',
        onChange,
      })
    }

    function EpicFilter({ missions, value, onChange }) {
      const counts = {}
      for (const mission of missions) {
        if (mission.epic) counts[mission.epic] = (counts[mission.epic] ?? 0) + 1
      }
      return h(ChecklistFilter, {
        label: 'Epic',
        value,
        options: epicOptions(missions),
        counts,
        allLabel: 'All epics',
        onChange,
      })
    }

    function ProjectFilter({ missions, value, onChange }) {
      const counts = {}
      const labels = {}
      for (const mission of missions) {
        if (!mission.project) continue
        counts[mission.project] = (counts[mission.project] ?? 0) + 1
        labels[mission.project] = mission.projectName ?? mission.project
      }
      return h(ChecklistFilter, {
        label: 'Project',
        value,
        options: projectOptions(missions).map((project) => project.id),
        labels,
        counts,
        allLabel: 'All projects',
        onChange,
      })
    }

    /** Native select under a styled label, next to Refresh. */
    function ThemeSelect({ value, onChange }) {
      const current = THEMES.find((theme) => theme.id === value) ?? THEMES[0]
      return h('label', { className: 'missions-theme' },
        h('span', { className: 'missions-theme-label' }, 'Theme'),
        h('span', { className: 'missions-theme-value', title: current.label }, current.label),
        h('svg', { width: 9, height: 9, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' },
          h('path', { d: 'M2.5 4 5 6.5 7.5 4' }),
        ),
        h('select', {
          'aria-label': 'Theme',
          value,
          onChange: (event) => onChange(event.target.value),
        }, THEMES.map((theme) => h('option', { key: theme.id, value: theme.id }, theme.label))),
      )
    }

    /** A boolean filter as a switch, pushed to the right of the bar. */
    function Switch({ label, checked, onChange, disabled = false }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        className: 'missions-switch',
        disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
      },
        h('span', { className: 'missions-switch-track', 'aria-hidden': 'true' },
          h('span', { className: 'missions-switch-thumb' }),
        ),
        h('span', { className: 'missions-switch-label' }, label),
      )
    }

    /**
     * What holds a mission without the label: its incoming `Blocks` links.
     *
     * The links are the panel's own read of the dependency's state, so the
     * entry names the mission, the state it waits at, and opens its ticket: a
     * blocker is another mission, and the reader may have to go and unblock it.
     */
    function BlockedBy({ blockers }) {
      const one = blockers.length === 1
      return h('div', { className: 'missions-blocked-by' },
        h('span', { className: 'missions-blocked-label' },
          one ? 'Bloquée par cette mission' : 'Bloquée par ces missions',
        ),
        h('ul', { className: 'missions-blocked-by-list' },
          blockers.map((blocker) => h('li', { className: 'missions-blocked-by-item', key: blocker.key },
            blocker.url
              ? h('a', {
                  className: 'missions-blocked-by-link',
                  href: blocker.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  title: blocker.title,
                }, blocker.key)
              : h('span', { title: blocker.title }, blocker.key),
            h('span', { className: 'missions-blocked-by-state' }, STATE_LABELS[blocker.state] ?? blocker.state),
          )),
        ),
      )
    }

    /**
     * The reason of a block, as the ticket holds it: who wrote it, when, what.
     *
     * The list carries it (the host reads the ticket's newest comment), and a
     * write carries it too, straight from the answer. `empty` and `unavailable`
     * say why no text is shown; a blocked mission with no reason at all keeps
     * the label's own hint.
     */
    function BlockedReason({ reason }) {
      if (!reason) {
        return h('p', { className: 'missions-blocked-hint' },
          'Le label `blocked` est posé sur le ticket ; sa raison est en commentaire.',
        )
      }
      if (reason.state === 'found') {
        const meta = `${reason.author || 'Commentaire du ticket'}${reason.createdAt ? ` · ${relativeAge(reason.createdAt)}` : ''}`
        return h('div', { className: 'missions-blocked-reason' },
          h('div', { className: 'missions-blocked-reason-meta' }, meta),
          h('p', { className: 'missions-blocked-reason-text' }, reason.body),
          reason.url
            ? h('a', {
                className: 'missions-blocked-reason-link',
                href: reason.url,
                target: '_blank',
                rel: 'noreferrer',
              }, 'Voir le commentaire')
            : null,
        )
      }
      return h('p', { className: 'missions-blocked-reason-note' },
        reason.state === 'empty'
          ? "Aucun commentaire sur le ticket : la raison n'y est pas écrite."
          : "Raison illisible pour l'instant ; nouvelle tentative au prochain rafraîchissement.",
      )
    }

    /**
     * The list: the chassis (search, filters, refresh) stays mounted while a
     * read runs, so the command never vanishes under the hand. The body says
     * what the read is doing; a failed read says nothing here because the
     * panel's banner speaks for it — and the icon is gone, since the banner
     * carries the retry.
     */
    /**
     * The list's batch archive: one button, two clicks, no dialog. The arm is
     * kept in a ref — the second click must see the first click's decision even
     * before React re-renders the label — and the state only paints it. The
     * armed state carries the signature of the keys it names: when the list
     * changes (a filter, a search, a silent refresh, the 60 s tick), the next
     * click arms the new list instead of sending the old one.
     */
    function ArchiveBatchButton({ keys = [], signature = '', onConfirm }) {
      // One state for the whole gesture — arm, busy, note — so the list below
      // the toolbar has one hook whose order stays put.
      const [gesture, setGesture] = React.useState({ arm: null, busy: false, note: null })
      const armRef = React.useRef(null)
      const count = keys.length
      const armed = count > 0 && gesture.arm !== null && gesture.arm.signature === signature
      const label = gesture.busy
        ? 'Archiving…'
        : armed
          ? `Confirm — archive ${count} mission${count === 1 ? '' : 's'}`
          : `Archive ${count} mission${count === 1 ? '' : 's'}`
      // The arm's note follows the list it was written for; the result's note
      // (signature null) outlives the rows it removed and says what refused.
      const note = gesture.note && (gesture.note.signature === null || gesture.note.signature === signature)
        ? gesture.note
        : null

      const activate = async () => {
        if (count === 0 || gesture.busy) {
          return
        }
        const armedNow = armRef.current
        // The first click only arms: it says where the folders go, sends
        // nothing, and counts nothing. A click on a list that changed since the
        // arm re-arms the new list instead of confirming a selection nobody
        // sees any more.
        if (armedNow === null || armedNow.signature !== signature) {
          armRef.current = { signature, keys }
          setGesture({
            arm: { signature, keys },
            busy: false,
            note: {
              signature,
              error: false,
              text: `This moves ${count} mission folder${count === 1 ? '' : 's'} to missions/archives/. Click again to confirm.`,
            },
          })
          return
        }
        armRef.current = null
        setGesture({ arm: null, busy: true, note: null })
        try {
          const { archived, refused } = await onConfirm(keys)
          setGesture({
            arm: null,
            busy: false,
            note: refused.length === 0
              ? {
                  signature: null,
                  error: false,
                  text: `Archived ${archived.length} mission folder${archived.length === 1 ? '' : 's'} to missions/archives/.`,
                }
              : {
                  signature: null,
                  error: true,
                  text: `Archived ${archived.length} of ${archived.length + refused.length}; ${refused.length} refused: ${refused.map((entry) => `${entry.key} (${entry.error})`).join('; ')}`,
                },
          })
        } catch (error) {
          // A failed request removes nothing: the note says so, and the button
          // is ready to arm again.
          setGesture({ arm: null, busy: false, note: { signature: null, error: true, text: `Archive failed: ${error?.message ?? error}` } })
        }
      }

      return h('div', { className: 'missions-batch' },
        h('button', {
          type: 'button',
          className: `missions-batch-btn${armed ? ' missions-batch-btn--armed' : ''}`,
          title: label,
          'aria-label': label,
          onClick: activate,
          disabled: gesture.busy || count === 0,
          'aria-busy': gesture.busy ? 'true' : 'false',
        },
          h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': 'true' },
            armed
              ? h('path', { d: 'M3 8.5 6.5 12 13 4.5', strokeLinecap: 'round', strokeLinejoin: 'round' })
              : h(React.Fragment, null,
                  h('path', { d: 'M2 5h12v2H2z' }),
                  h('path', { d: 'M3.5 7v5.5h9V7' }),
                  h('path', { d: 'M6.5 9.5h3', strokeLinecap: 'round' }),
                ),
          ),
          armed ? `Confirm (${count})` : `Archive (${count})`,
        ),
        note
          ? h('p', {
              className: `missions-batch-note${note.error ? ' missions-batch-note--error' : ''}`,
              role: 'status',
            }, note.text)
          : null,
      )
    }

    /**
     * The band: the counts of the rows the list shows, one segment per state.
     *
     * It *is* the tab's Status filter — the outline has no room for a select —
     * so the counts follow the filters and the field, and the status selection
     * itself stays out of them: picking a state must leave the other segments
     * readable. `perimeter` holds the states to show (the portfolio's), so a
     * state the filters exclude keeps its segment, named, in the workflow's
     * order, with a zero. A click toggles one state; the values keep that same
     * order, which is what the drawer and the rest of the panel read.
     */
    function StateBand({ missions = [], perimeter = missions, value = null, onChange = () => {} }) {
      const options = stateOptions(perimeter, { allowDone: false })
      if (options.length === 0) return null
      const counts = new Map(options.map((state) => [state, 0]))
      for (const mission of missions) {
        const state = stateFilterValue(mission.state)
        if (counts.has(state)) counts.set(state, counts.get(state) + 1)
      }
      const selected = Array.isArray(value) ? value : value ? [value] : []
      const toggle = (state) => {
        const next = selected.includes(state)
          ? selected.filter((entry) => entry !== state)
          : [...selected, state]
        const ordered = stateOptions(perimeter, { allowDone: false }).filter((entry) => next.includes(entry))
        onChange(ordered.length === 0 ? null : ordered)
      }
      return h('div', { className: 'missions-band' },
        h('div', { className: 'missions-band-track', role: 'group', 'aria-label': 'Open missions by state' },
          options.map((state) => h('button', {
            type: 'button',
            key: state,
            className: 'missions-band-seg',
            'data-state': state,
            'data-active': selected.includes(state) ? 'true' : 'false',
            'aria-pressed': selected.includes(state) ? 'true' : 'false',
            style: { flexGrow: String(counts.get(state)) },
            title: `${STATE_LABELS[state] ?? state} — ${counts.get(state)} open`,
            onClick: () => toggle(state),
          },
            h('span', { className: 'missions-band-name' }, STATE_LABELS[state] ?? state),
            h('span', { className: 'missions-band-n' }, String(counts.get(state))),
          )),
        ),
      )
    }

    /** The DOM id an ARIA attribute can name: `mission:MIS-2` is not one. */
    function outlineDomId(id) {
      return `missions-wb-${String(id ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-')}`
    }

    /**
     * The workbench: one field and one two-level tree, nothing beside it.
     *
     * It is generic on purpose: it receives groups of rows, a cursor, the
     * actions and two renders, and reads no mission's fields. What is a
     * result, in what order, and with which count belongs to `lib/view.js`; a
     * second outline would receive its own groups and its own renders.
     */
    function Workbench({
      groups = [],
      query = '',
      onQuery = () => {},
      onQueryEnd = () => {},
      cursor = null,
      onCursor = () => {},
      onActivate = () => {},
      onAction = () => {},
      actions = [],
      // A drawer already open beside the tree owns the keyboard's escapes: it
      // closes first, and the query it was showing is the next one's business.
      drawerOpen = false,
      theme = 'default',
      label = 'Missions outline',
      placeholder = 'Search a key, a title, a checklist line…',
      loading = false,
      failed = false,
      emptyText = 'No mission matches these filters.',
      filters = null,
      header = null,
      footer = null,
      renderRow = () => null,
      renderGroup = () => null,
      // A flat list renders its rows straight under the tree, with no group
      // header: the Missions tab is one list since the pins arrived.
      flat = false,
      // The order of the rows inside each group, applied after the match: a
      // pinned mission stays first under a query too (D4).
      orderRows = null,
    }) {
      const field = React.useRef(null)
      // The field is reachable from anywhere in the panel: the platform's own
      // shortcut opens it, and the browser keeps its find-in-page untouched.
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onShortcut = (event) => {
          if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'k') return
          event.preventDefault()
          field.current?.focus()
        }
        document.addEventListener('keydown', onShortcut)
        return () => document.removeEventListener('keydown', onShortcut)
      }, [])

      const matched = matchOutline(groups, query)
      // The rows a query keeps are still ordered by their group's own order:
      // the pins are lifted here, after the match, so the count never changes.
      const result = orderRows === null
        ? matched
        : { ...matched, groups: matched.groups.map((group) => ({ ...group, rows: orderRows(group.rows) })) }
      const offered = matchActions(actions, query)
      const entries = outlineEntries(result, offered)
      const count = outlineCount(result, { esc: String(query ?? '').trim() !== '', actions: offered.length })
      const current = entries.find((entry) => entry.id === cursor) ?? null

      const move = (delta) => {
        if (entries.length === 0) return
        const at = current === null ? -1 : entries.indexOf(current)
        const next = at < 0
          ? (delta > 0 ? 0 : entries.length - 1)
          : Math.max(0, Math.min(entries.length - 1, at + delta))
        onCursor(entries[next])
      }

      // Highlighting and opening are two gestures: the arrows move the cursor,
      // a click or Enter asks for the mission the row names.
      const open = (entry) => {
        onCursor(entry)
        onActivate(entry)
      }

      // Arrow keys walk the visible rows, Enter opens the highlighted one and
      // Escape empties the query without leaving the tree.
      const onKeyDown = (event) => {
        if (event.target && typeof event.target.closest === 'function' && event.target.closest('.missions-drawer')) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Escape') {
          if (drawerOpen) return
          if (String(query ?? '') !== '') {
            event.preventDefault()
            onQuery('')
            onQueryEnd('')
          }
        } else if (event.key === 'Enter' && current !== null) {
          event.preventDefault()
          if (current.kind === 'action') onAction(current.action, current)
          else onActivate(current)
        }
      }

      return h('div', { className: 'missions-workbench', 'data-theme': theme, onKeyDown },
        h('div', { className: 'missions-wb-column' },
          h('div', { className: 'missions-wb-field' },
            h('span', { className: 'missions-wb-kbd', 'aria-hidden': 'true' }, '⌘K'),
            h('input', {
              ref: field,
              type: 'search',
              className: 'missions-wb-input',
              value: query,
              placeholder,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': label,
              'aria-describedby': 'missions-wb-count',
              'aria-controls': 'missions-outline',
              'aria-activedescendant': current === null ? undefined : outlineDomId(current.id),
              onChange: (event) => onQuery(event.target.value),
              onBlur: (event) => onQueryEnd(event.target.value),
            }),
            h('span', {
              className: 'missions-wb-count',
              id: 'missions-wb-count',
              'aria-live': 'polite',
              'data-query': String(query ?? '') === '' ? 'false' : 'true',
            }, count),
          ),
          filters,
          header,
          loading
            ? h(PanelLoader, { theme })
            : failed
              ? h('p', { className: 'missions-wb-failed' }, 'The read failed. The tree keeps what it had.')
              : entries.length === 0
                ? h('p', { className: 'missions-wb-empty' }, emptyText)
                : h('div', {
                    className: 'missions-wb-tree',
                    id: 'missions-outline',
                    role: 'tree',
                    'aria-label': `${label}: results`,
                  },
                    offered.length > 0
                      ? h('div', { className: 'missions-wb-actions', role: 'group', 'aria-label': 'Actions' },
                          h('span', { className: 'missions-wb-actions-head' }, 'Actions'),
                          offered.map((action) => h('button', {
                            type: 'button',
                            key: action.id,
                            id: outlineDomId(`action:${action.id}`),
                            className: 'missions-wb-action',
                            role: 'treeitem',
                            'aria-level': 1,
                            'aria-selected': current !== null && current.id === `action:${action.id}` ? 'true' : 'false',
                            onClick: () => onAction(action, current),
                          }, action.label)),
                        )
                      : null,
                    result.groups.map((group) => {
                      const key = group.id === '' ? 'no-epic' : group.id
                      const rowItem = (row) => {
                        const missionKey = row.row.key ?? row.row.id
                        const entry = { id: `mission:${missionKey}`, kind: 'mission', row: row.row, anchors: row.anchors, hidden: row.hidden }
                        return h('div', { className: 'missions-wb-row', role: 'none', key: missionKey },
                          renderRow({
                            entry,
                            rowId: outlineDomId(`mission:${missionKey}`),
                            selected: current !== null && current.id === entry.id,
                            onSelect: () => onCursor(entry),
                            onOpen: () => open(entry),
                          }),
                        )
                      }
                      // A pin keeps its mission in sight while the tree scrolls:
                      // the flat list already lifts the pinned rows to its head,
                      // so their leading run is the one sticky block — a pin a
                      // blocker pushed down no longer sticks alone.
                      const pinned = []
                      if (flat) {
                        for (const row of group.rows) {
                          if (row.row?.pinned !== true) break
                          pinned.push(row)
                        }
                      }
                      const loose = flat ? group.rows.slice(pinned.length) : group.rows
                      const rows = h('div', {
                        className: flat ? 'missions-wb-rows missions-wb-rows--flat' : 'missions-wb-rows',
                        role: 'group',
                        'aria-label': group.label,
                        key,
                      },
                        pinned.length > 0
                          ? h('div', { className: 'missions-wb-pins', role: 'group', 'aria-label': 'Pinned missions', key: 'pins' }, pinned.map(rowItem))
                          : null,
                        loose.map(rowItem),
                      )
                      // A flat list has no group to announce: no header row, no
                      // epic entry in the keyboard's list.
                      if (flat) return rows
                      return h('div', { className: 'missions-wb-group', key: `${key}-group` },
                        renderGroup({
                          group,
                          rowId: outlineDomId(`epic:${group.id}`),
                          selected: current !== null && current.id === `epic:${group.id}`,
                          onSelect: () => onCursor({ id: `epic:${group.id}`, kind: 'epic', group, anchors: [], hidden: 0 }),
                        }),
                        rows,
                      )
                    }),
                  ),
          footer,
        ),
      )
    }

    /** One mission in the tree: key, title, age, and the lines that matched. */
    function MissionOutlineRow({ entry, rowId, selected, onSelect = () => {}, onOpen = () => {} }) {
      const mission = entry.row.mission ?? entry.row
      const pinned = entry.row.pinned === true || mission.pinned === true
      const counts = entry.row.counts ?? { total: 0, checked: 0 }
      const points = pointsText(mission.points)
      return h('div', {
        className: 'missions-tree-row',
        id: rowId,
        role: 'treeitem',
        'aria-level': 1,
        'aria-selected': selected ? 'true' : 'false',
        'data-state': mission.state,
        'data-selected': selected ? 'true' : 'false',
        'data-pinned': pinned ? 'true' : 'false',
        'data-match': entry.kind,
        tabIndex: -1,
        title: `${mission.key} — ${STATE_LABELS[mission.state] ?? mission.state}`,
        onClick: onOpen,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onSelect()
        },
      },
        h('span', { className: 'missions-tree-prio' },
          h(PriorityMark, { priority: mission.priority })),
        // A pin is a local preference, not a field: the mark says it without
        // taking the click or the focus from the row.
        pinned
          ? h('svg', {
              className: 'missions-tree-pin',
              viewBox: '0 0 16 16',
              width: 9,
              height: 9,
              role: 'img',
              'aria-label': 'Pinned',
              focusable: 'false',
            }, h('path', {
              d: PIN_MARK_PATH,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }))
          : null,
        points ? h('span', { className: 'missions-tree-points' }, points) : null,
        h('span', { className: 'missions-tree-key' }, mission.key),
        // The epic is a reference cell, not a group: its key only, empty when
        // the mission has none, so the column never disappears from a row.
        h('span', { className: 'missions-tree-epic-ref' }, epicParts(mission.epic).key),
        h('span', { className: 'missions-tree-title' }, clipTitle(mission.title)),
        mission.blocked ? h('span', { className: 'missions-tree-blocked' }, 'blocked') : null,
        h('span', { className: 'missions-tree-age' }, relativeAge(mission.updatedAt)),
        entry.anchors.length > 0
          ? h('div', { className: 'missions-tree-anchors' },
              entry.anchors.map((line, index) => h('div', { className: 'missions-tree-anchor', key: index },
                h('span', { className: 'missions-tree-anchor-mark', 'aria-hidden': 'true' }, line.state === 'checked' ? '✓' : '·'),
                h('span', { className: 'missions-tree-anchor-text' }, line.text),
                index === 0 && counts.total > 0
                  ? h('span', { className: 'missions-tree-anchor-count' }, `checklist ${counts.checked} / ${counts.total}`)
                  : null,
              )),
            )
          : null,
        entry.hidden > 0 ? h('div', { className: 'missions-tree-overflow' }, `+${entry.hidden}`) : null,
      )
    }

    function scopedOutline({ missions, filters, checklists, allowDone }) {
      // The list is flat: every filter but the query — the field has its own
      // matcher, and that matcher crosses the checklist, which is not a
      // mission field. The epic is a reference cell now, not a group.
      const scoped = sortMissions(filterMissions(missions, { ...filters, query: '', allowDone }))
      // A blocked mission never opens before the dependency holding it: the
      // rule outranks the pin, so it runs once the pins are lifted.
      const lifted = pinnedFirst(scoped.map((mission) => {
        const index = checklists === null ? null : checklists[mission.key] ?? null
        return {
          id: mission.key,
          key: mission.key,
          title: mission.title,
          group: '',
          groupLabel: '',
          pinned: mission.pinned === true,
          mission,
          lines: index?.lines ?? [],
          counts: index?.counts ?? { total: 0, checked: 0, partial: 0, open: 0 },
        }
      }))
      const rows = respectBlockers(lifted, { blockersOf: (row) => row.mission.blockers })
      // One anonymous group: no label, so no epic ever answers as a result
      // and no mission is context. The pins are lifted again by `orderRows`,
      // under a query as well.
      const treeGroups = [{ id: '', label: '', rows }]
      return { scoped, treeGroups }
    }

    function MissionsView({
      missions,
      query,
      onQuery,
      onSearchEnd = () => {},
      filters,
      onFilter,
      onClear,
      onSelect,
      theme,
      loading,
      failed,
      onRefresh,
      // Only the Missions tab passes it: Done and the dashboard render no
      // creation button, and no view creates a mission by accident.
      onNew = null,
      emptyText = 'No open missions assigned to you.',
      archiveAll = null,
      checklists = null,
      // The drawer is the panel's, on the far side of this view: the tree only
      // needs to know one is open, so its own Escape leaves the query alone.
      selected = null,
      actions = [],
      onAction = () => {},
      allowDone = false,
      label = 'Missions outline',
      footLabel = 'open',
    }) {
      // The tree's one selection: the cursor names the highlighted row by id,
      // and stays where it is while the drawer describes it. The cursor never
      // follows the query by itself, so a query that still shows the row does
      // not move it.
      const [cursor, setCursor] = React.useState(null)

      const active = hasActiveFilters(filters)

      const refreshButton = failed
        ? null
        : h('button', {
            type: 'button',
            className: 'missions-icon-btn',
            'aria-label': 'Refresh',
            'data-tip': 'Refresh',
            onClick: onRefresh,
            disabled: loading,
            'aria-busy': loading ? 'true' : 'false',
          }, h(RefreshIcon, { theme }))
      const newButton = onNew === null
        ? null
        : h('button', {
            type: 'button',
            className: 'missions-icon-btn',
            'aria-label': 'Create a mission',
            'data-tip': 'Create a mission',
            onClick: onNew,
          }, h(PlusIcon, { theme }))

      const { scoped, treeGroups } = scopedOutline({ missions, filters, checklists, allowDone })
      // The band counts what the list shows, its own status selection
      // excepted: the same chain runs once more with that dimension
      // neutralized, and the field's matcher keeps its keys.
      const counting = scopedOutline({
        missions,
        filters: { ...filters, state: null },
        checklists,
        allowDone,
      })
      const countedMissions = outlineEntries(matchOutline(counting.treeGroups, query))
        .filter((entry) => entry.kind === 'mission')
        .map((entry) => entry.row.mission)

      const archiveKeys = archiveAll === null
        ? []
        : outlineEntries(matchOutline(treeGroups, query), matchActions(actions, query))
          .filter((entry) => entry.kind === 'mission')
          .map((entry) => entry.row.mission.key)
      const archiveButton = archiveAll === null
        ? null
        : h(ArchiveBatchButton, {
            keys: archiveKeys,
            signature: archiveKeys.slice().sort().join('\n'),
            onConfirm: archiveAll.onConfirm,
          })

      const filtersRow = h('div', { className: 'missions-filters' },
        // The band is the tree's status filter: a select would say the same
        // thing, wider, above a list that already shows every state.
        h(TypeFilter, {
          missions,
          value: filters.type,
          onChange: (value) => onFilter('type', value),
        }),
        h(EpicFilter, {
          missions,
          value: filters.epic,
          onChange: (value) => onFilter('epic', value),
        }),
        h(ProjectFilter, {
          missions,
          value: filters.project,
          onChange: (value) => onFilter('project', value),
        }),
        h(PriorityFilter, {
          missions,
          value: filters.priority,
          onChange: (value) => onFilter('priority', value),
        }),
        active ? h('button', { type: 'button', className: 'missions-clear', onClick: onClear }, 'Clear') : null,
        h(Switch, {
          label: 'Missing',
          checked: filters.missing === 'any',
          onChange: (checked) => onFilter('missing', checked ? 'any' : null),
        }),
      )

      const trackQuery = (value) => {
        const text = String(value ?? '')
        onSearchEnd(text)
        if (text.trim() === '') return
        const result = matchOutline(treeGroups, text)
        track('search.q', searchBucket(text))
        track('search.family', outlineFamily(result, matchActions(actions, text).length))
        if (outlineEntries(result, []).length === 0) track('preview.kind', 'none')
      }

      const moveCursor = (entry) => {
        setCursor(entry.id)
        // An action is a gesture, not a place: it takes the cursor and
        // leaves the rest of the list where it was.
        if (entry.kind !== 'mission') return
        track('preview.kind', 'mission')
      }

      const activate = (entry) => {
        if (entry.kind === 'mission') onSelect(entry.row.mission, 'row')
      }

      return h('div', { className: 'missions-tree-view' },
        h('div', { className: 'missions-toolbar', 'data-tree': 'true' },
          h('div', { className: 'missions-toolbar-top' },
            h('span', { className: 'missions-toolbar-label' }, 'Outline'),
            refreshButton,
            newButton,
            archiveButton,
          ),
        ),
        h(Workbench, {
          groups: treeGroups,
          // The epic no longer heads a group: the rows sit straight under
          // the tree, and a pin keeps them first under a query too.
          flat: true,
          orderRows: (entries) => respectBlockers(
            pinnedFirst(entries, (entry) => entry.row?.pinned === true),
            {
              keyOf: (entry) => entry.row?.key,
              blockersOf: (entry) => entry.row?.mission?.blockers,
            },
          ),
          label,
          query,
          onQuery,
          onQueryEnd: trackQuery,
          cursor,
          onCursor: moveCursor,
          onActivate: activate,
          onAction,
          actions,
          drawerOpen: selected !== null,
          theme,
          loading,
          failed,
          emptyText,
          filters: h('div', { className: 'missions-wb-filters' }, filtersRow),
          header: h(StateBand, {
            missions: countedMissions,
            perimeter: missions,
            value: filters.state,
            onChange: (value) => onFilter('state', value),
          }),
          footer: h('div', { className: 'missions-wb-foot' },
            h('span', null, `${scoped.length} ${footLabel}`),
          ),
          renderRow: (props) => h(MissionOutlineRow, props),
        }),
      )
    }

    function DrawerRow({ label, value }) {
      if (value === null || value === undefined || value === '') return null
      return h(React.Fragment, null, h('dt', null, label), h('dd', null, value))
    }

    /** Read-only checklist: the file is written by the agent, the panel shows it. */
    function ChecklistBlocks({ blocks }) {
      return h('div', { className: 'missions-checklist-body', tabIndex: 0 },
        blocks.map((block, index) => {
          if (block.type === 'heading') {
            return h('div', {
              key: index,
              className: block.level <= 2 ? 'missions-checklist-title' : 'missions-checklist-subtitle',
            }, block.text)
          }
          if (block.type === 'item') {
            const checked = block.state === 'partial' ? 'mixed' : block.state === 'checked'
            return h('div', { key: index, className: 'missions-checklist-item', 'data-state': block.state },
              h('span', { className: 'missions-checklist-box', role: 'checkbox', 'aria-checked': checked, 'aria-disabled': 'true', 'aria-label': block.state === 'checked' ? 'checked' : block.state === 'partial' ? 'not exercised' : 'open' }),
              h('span', { className: 'missions-checklist-text' }, block.text),
            )
          }
          if (block.type === 'bullet') {
            return h('div', { key: index, className: 'missions-checklist-bullet' }, `• ${block.text}`)
          }
          return h('p', { key: index, className: 'missions-checklist-note' }, block.text)
        }),
      )
    }

    function MissionDrawer({ mission, services, workspaceId, workspaceRoot, onClose, onSaved, onPrioritySaved, onPointsSaved, onPinSaved, onArchived, theme }) {
      const [note, setNote] = React.useState(null)
      // A declared branch always wins; otherwise show the convention's name.
      // It stays a suggestion: only Save writes it to mission.yml.
      const [branch, setBranch] = React.useState(branchFieldValue(mission))
      const [base, setBase] = React.useState(mission.base ?? '')
      const [saving, setSaving] = React.useState(false)
      const [declareNote, setDeclareNote] = React.useState(null)
      // The journal is read when the drawer opens: it is a local file, not part
      // of the tracker list, and it changes between two visits.
      const [journal, setJournal] = React.useState(null)
      // The checklist is read with the journal, for the same reason: it is a
      // local file that changes between two visits.
      const [checklist, setChecklist] = React.useState(null)
      // Which tab of the drawer is showing: the drawer rests on the details.
      const [section, setSection] = React.useState('details')
      // Blocked is a label of the tracker, not a field of the panel: the switch
      // shows the label, and the write goes through the host. A mission may
      // also be held by a dependency alone, so `blockedByLabel` is what the
      // switch reads, and `blockers` is the other cause. An older host answer
      // may carry the mark without the flag: `blocked` alone still means the
      // label then.
      const labelBlocked = (value) => value.blockedByLabel ?? Boolean(value.blocked)
      const [blockedNow, setBlockedNow] = React.useState(labelBlocked(mission))
      const [armedBlock, setArmedBlock] = React.useState(false)
      const [reason, setReason] = React.useState('')
      const [writingBlock, setWritingBlock] = React.useState(false)
      const [blockNote, setBlockNote] = React.useState(null)
      // The reason of the block comes with the list — the ticket's newest
      // comment, read by the host. A write keeps it current without a new read.
      const [blockedReason, setBlockedReason] = React.useState(mission.blockedReason ?? null)
      // Priority is a tracker field, not a declaration: the select shows the
      // last answer and the write goes through the host, like the blocked label.
      const [priorityNow, setPriorityNow] = React.useState(mission.priority ?? null)
      const [writingPriority, setWritingPriority] = React.useState(false)
      const [priorityNote, setPriorityNote] = React.useState(null)
      // Points are a tracker field too: the select shows the last answer and
      // the write goes through the host, on the scale the panel declares.
      const [pointsValue, setPointsValue] = React.useState(mission.points ?? null)
      const [writingPoints, setWritingPoints] = React.useState(false)
      const [pointsNote, setPointsNote] = React.useState(null)
      // A pin is a reading preference of this checkout, not a tracker field:
      // the button shows the last answer and the write goes through the host,
      // which owns `missions/pins.yml`.
      const [pinnedNow, setPinnedNow] = React.useState(mission.pinned === true)
      const [writingPin, setWritingPin] = React.useState(false)
      const [pinNote, setPinNote] = React.useState(null)
      // The stamp counts successful writes, not the note: the note is cleared
      // as soon as the refreshed list lands, and an animation keyed on it would
      // be cut after one frame. The count only grows on a success, so opening
      // the drawer and a refusal stamp nothing.
      const [pinStamp, setPinStamp] = React.useState(0)
      // Closing the local checkout deletes the branch: the first click only
      // arms it, the second one sends the key. The host re-checks everything.
      const [armedClose, setArmedClose] = React.useState(false)
      // The guard is a ref: a click must see the previous click's decision even
      // before React re-renders the label.
      const armedCloseRef = React.useRef(false)
      const [closing, setClosing] = React.useState(false)
      const [closeNote, setCloseNote] = React.useState(null)
      // Archiving moves the folder, nothing is deleted: the first click still
      // only arms it, so a stray click never moves a mission.
      const [armedArchive, setArmedArchive] = React.useState(false)
      const armedArchiveRef = React.useRef(false)
      const [archiving, setArchiving] = React.useState(false)
      const [archiveNote, setArchiveNote] = React.useState(null)
      // The Tolgee import: the report stays on screen, the XLIFF is written in
      // the mission folder. Only a project declaring `translations` shows it.
      const [tolgeeNote, setTolgeeNote] = React.useState(null)
      const [tolgeeKeys, setTolgeeKeys] = React.useState(null)
      const [tolgeeUntranslated, setTolgeeUntranslated] = React.useState([])
      const [importingTolgee, setImportingTolgee] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        fetch(`${JOURNAL_URL}?key=${encodeURIComponent(mission.key)}`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => { if (alive) setJournal(data) })
          .catch(() => { if (alive) setJournal({ exists: false, source: '', error: true }) })
        fetch(`${CHECKLIST_URL}?key=${encodeURIComponent(mission.key)}`, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(String(response.status))
            return response.json()
          })
          .then((data) => { if (alive) setChecklist(data) })
          .catch(() => { if (alive) setChecklist({ exists: false, source: '', error: true }) })
        return () => { alive = false }
      }, [mission.key, mission.folder])

      // A refreshed list carries the tracker's answer: the switch follows the
      // label, and the reason follows the read.
      React.useEffect(() => {
        setBlockedNow(labelBlocked(mission))
        setBlockedReason(mission.blockedReason ?? null)
        setArmedBlock(false)
        setReason('')
        setBlockNote(null)
        // A refreshed list is another mission's answer: the close guard
        // disarms rather than carrying to another branch.
        armedCloseRef.current = false
        setArmedClose(false)
        setCloseNote(null)
      }, [mission.key, mission.blocked])

      // A refreshed list carries the tracker's answer: the select follows it,
      // like the blocked switch above.
      React.useEffect(() => {
        setPriorityNow(mission.priority ?? null)
        setPriorityNote(null)
      }, [mission.key, mission.priority])

      // A refreshed list carries the tracker's answer: the points select
      // follows it. The note belongs to the last write, so it stays until the
      // next one, and the write patches the same field without a new read.
      React.useEffect(() => {
        setPointsValue(mission.points ?? null)
      }, [mission.key, mission.points])

      // The pinned flag is the host's answer too: a refreshed list repaints
      // the button, and another mission is another pin.
      React.useEffect(() => {
        setPinnedNow(mission.pinned === true)
        setPinNote(null)
      }, [mission.key, mission.pinned])

      // The archive guard follows the mission shown: a refreshed row must not
      // carry the previous mission's armed click.
      React.useEffect(() => {
        armedArchiveRef.current = false
        setArmedArchive(false)
        setArchiveNote(null)
      }, [mission.key, mission.state])

      // Another mission is another diff: its Tolgee report must not linger.
      React.useEffect(() => {
        setTolgeeNote(null)
        setTolgeeKeys(null)
        setTolgeeUntranslated([])
      }, [mission.key])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const blocker = executionBlocker(mission)
      // The free session plays no step: only `done` closes it, and its button
      // stays live in cadrage, before the branch exists.
      const freeBlocker = freeSessionBlocker(mission)
      const step = missionStep(mission)
      const sessionLabel = step ? `Start a session — ${step}` : 'Start a session'
      // The label says « remontées » without imitating the step session: the
      // review's own gesture stays the primary, and the last of the row.
      const feedbackLabel = 'Check the PR feedback'
      // The review's own gesture: the colleagues validated the PR and the
      // session records it. It replaces the step session in `in-review`.
      const validateLabel = 'PR validated'
      // A free session answers a question without moving the ticket: its label
      // names the gesture, and the row's tooltip shows the same words.
      const freeLabel = 'Start a free session'
      // Every prompt lives in `lib/view.js`, inlined into this bundle: the
      // drawer only picks which one a button sends.
      const prompt = missionSessionPrompt(mission)
      const feedbackPrompt = feedbackSessionPrompt(mission)
      const freePrompt = freeSessionPrompt(mission)

      // DSH tears the panel down the moment a session opens (`replaceMain` closes
      // it), so a note written after a successful click lives under 50 ms: long
      // enough to look like an error, far too short to read it. The happy path
      // therefore says nothing, and every failure stays one short line that the
      // drawer can still show once the gesture is over.
      const openSession = async (sessionPrompt) => {
        try {
          const { prefilledBy, openedBy, uiError } = await openMissionSession(services, sessionPrompt, workspaceId, workspaceRoot)
          if (uiError) {
            setNote(`Session not opened: ${uiError}`)
          } else if (!openedBy && !prefilledBy) {
            setNote(
              `Session created ${workspaceId ? 'in the projects workspace' : 'without a workspace'} — pick it in the sidebar.`,
            )
          }
        } catch (error) {
          setNote(`Session not opened: ${error?.message ?? error}`)
        }
      }

      const startSession = () => {
        track('mission.session')
        return openSession(prompt)
      }
      // Same gesture, same prefill path, other prompt: the session reads the
      // PR's remarks and hands back; the merge stays the requester's.
      const startFeedbackSession = () => {
        track('mission.feedback-session')
        return openSession(feedbackPrompt)
      }
      // Same gesture again, with the prompt that plays no step and writes
      // nothing: a question, not work on the ticket.
      const startFreeSession = () => openSession(freePrompt)

      const saveDeclaration = async () => {
        track('mission.declare')
        setSaving(true)
        setDeclareNote(null)
        try {
          const response = await fetch(DECLARE_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key, branch: branch.trim(), base: base.trim() }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `save failed (${response.status})`)
          setDeclareNote({ error: false, text: `Saved in missions/${data.folder}/mission.yml — local only, nothing to commit.` })
          onSaved?.(data)
        } catch (error) {
          setDeclareNote({ error: true, text: `Save failed: ${error?.message ?? error}` })
        } finally {
          setSaving(false)
        }
      }

      const writeBlocked = async (next) => {
        const message = reason.trim()
        if (next && !message) return
        track('mission.block', next ? 'block' : 'unblock')
        setWritingBlock(true)
        setBlockNote(null)
        try {
          const response = await fetch(BLOCKED_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key, blocked: next, message }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `blocked failed (${response.status})`)
          setBlockedNow(next)
          // The reason just posted is shown at once: the list is refreshed,
          // but the panel already knows the text and the comment's URL.
          setBlockedReason(blockedReasonAfterWrite({ next, message, comment: data?.comment }))
          setArmedBlock(false)
          setReason('')
          setBlockNote({
            error: false,
            text: next
              ? 'Label `blocked` posé et raison postée en commentaire du ticket.'
              : 'Label `blocked` retiré.',
          })
          onSaved?.(data)
        } catch (error) {
          setBlockNote({ error: true, text: `Block failed: ${error?.message ?? error}` })
        } finally {
          setWritingBlock(false)
        }
      }

      // Choosing a value is the write: the select posts the canonical word and
      // waits for the tracker's answer. The local value moves only on success,
      // so a refused write leaves the old priority on screen.
      const writePriority = async (next) => {
        if (!next || next === priorityNow) return
        setWritingPriority(true)
        setPriorityNote(null)
        try {
          const response = await fetch(PRIORITY_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key, priority: next }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `priority failed (${response.status})`)
          setPriorityNow(next)
          setPriorityNote({ error: false, text: `Priorité enregistrée dans le tracker : ${PRIORITY_LABELS[next] ?? next}.` })
          onPrioritySaved?.({ key: mission.key, priority: next })
        } catch (error) {
          setPriorityNote({ error: true, text: `Priority failed: ${error?.message ?? error}` })
        } finally {
          setWritingPriority(false)
        }
      }

      // Choosing a size is the write: the select posts the number and waits
      // for the tracker's answer. The local value moves only on success, so a
      // refused write leaves the old size on screen.
      const writePoints = async (next) => {
        const value = Number(next)
        if (!Number.isFinite(value) || value === pointsValue) return
        setWritingPoints(true)
        setPointsNote(null)
        try {
          const response = await fetch(POINTS_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key, points: value }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `points failed (${response.status})`)
          setPointsValue(value)
          setPointsNote({ error: false, text: `Points enregistrés dans le tracker : ${data?.value ?? value}.` })
          onPointsSaved?.({ key: mission.key, points: value })
        } catch (error) {
          setPointsNote({ error: true, text: `Points failed: ${error?.message ?? error}` })
        } finally {
          setWritingPoints(false)
        }
      }

      // The pin is local: one POST writes `pins.yml`, and the panel's list
      // moves the mission to the top without a new tracker read.
      const writePin = async () => {
        if (writingPin) return
        const next = !pinnedNow
        track('mission.pin', next ? 'pin' : 'unpin')
        setWritingPin(true)
        setPinNote(null)
        try {
          const response = await fetch(PIN_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key, pinned: next }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `pin failed (${response.status})`)
          setPinnedNow(next)
          setPinNote({ error: false, text: next ? 'Mission pinned at the top of the list.' : 'Mission unpinned.' })
          setPinStamp(pinStamp + 1)
          onPinSaved?.({ key: mission.key, pinned: next })
        } catch (error) {
          setPinNote({ error: true, text: `Pin failed: ${error?.message ?? error}` })
        } finally {
          setWritingPin(false)
        }
      }

      // Two clicks, no dialog: the first arms, the second asks the host to
      // close. The button says what it will delete before it does it.
      const closeLocalCheckout = async () => {
        if (!armedCloseRef.current) {
          armedCloseRef.current = true
          setCloseNote({ error: false, text: 'This deletes the branch and its worktrees. Click again to confirm.' })
          setArmedClose(true)
          return
        }
        track('mission.close-checkout')
        armedCloseRef.current = false
        setArmedClose(false)
        setClosing(true)
        setCloseNote(null)
        try {
          const response = await fetch(LOCAL_CLOSE_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `local close failed (${response.status})`)
          const worktrees = Array.isArray(data.worktreesRemoved) ? data.worktreesRemoved.length : 0
          setCloseNote({
            error: false,
            text: `Local checkout closed: ${data.branch} deleted${worktrees > 0 ? `, ${worktrees} worktree(s) removed` : ''}, clone on ${data.base} (${data.cloneSha}).`,
          })
        } catch (error) {
          setCloseNote({ error: true, text: `Local close refused: ${error?.message ?? error}` })
        } finally {
          setClosing(false)
        }
      }

      // Two clicks, no dialog: the folder leaves Done, nothing is deleted. The
      // first click says where it goes; the host re-reads the tracker before
      // moving anything, and the row leaves the list once it agrees.
      const archiveMission = async () => {
        if (!armedArchiveRef.current) {
          armedArchiveRef.current = true
          setArmedArchive(true)
          setArchiveNote({ error: false, text: 'This moves the mission folder to missions/archives/. Click again to confirm.' })
          return
        }
        armedArchiveRef.current = false
        setArmedArchive(false)
        track('mission.archive')
        setArchiving(true)
        setArchiveNote(null)
        try {
          const response = await fetch(ARCHIVE_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `archive failed (${response.status})`)
          setArchiving(false)
          setArchiveNote({ error: false, text: `Archived to ${data.archived}.` })
          onArchived?.({ key: mission.key, folder: data.folder ?? mission.folder })
        } catch (error) {
          setArchiving(false)
          setArchiveNote({ error: true, text: `Archive refused: ${error?.message ?? error}` })
        }
      }

      // One click, one report: the host reads the branch's diff and the declared
      // locales, writes the XLIFF when there is something to import, and answers
      // with the keys. Nothing here talks to Tolgee.
      const importTolgee = async () => {
        track('mission.tolgee')
        setImportingTolgee(true)
        setTolgeeNote(null)
        try {
          const response = await fetch(TOLGEE_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ key: mission.key }),
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(data?.error ?? `tolgee import failed (${response.status})`)
          const keys = Array.isArray(data.keys) ? data.keys : []
          const untranslated = Array.isArray(data.untranslated) ? data.untranslated : []
          setTolgeeKeys(keys)
          setTolgeeUntranslated(untranslated)
          const locales = [...new Set(keys.flatMap((entry) => entry.missing ?? []))]
          const reference = mission.translations?.reference ?? 'fr'
          setTolgeeNote({
            error: false,
            text: keys.length > 0
              ? `${keys.length} clé(s) manquante(s) en ${locales.join(', ')} — fichier écrit dans ${data.file}.`
              : untranslated.length > 0
                ? `${untranslated.length} clé(s) sans valeur ${reference} à écrire d’abord — aucun fichier écrit.`
                : 'Rien à importer : aucune clé du diff ne manque dans les locales déclarées.',
          })
        } catch (error) {
          setTolgeeNote({ error: true, text: `Import Tolgee : ${error?.message ?? error}` })
        } finally {
          setImportingTolgee(false)
        }
      }

      // Turning it on only opens the field; turning it off is the unblock.
      const toggleBlocked = (next) => {
        if (next) {
          setBlockNote(null)
          setArmedBlock(true)
          return
        }
        if (blockedNow) {
          writeBlocked(false)
          return
        }
        setArmedBlock(false)
        setReason('')
      }

      const savedBranch = mission.branch ?? ''
      const savedBase = mission.base ?? ''
      const dirty = branch.trim() !== savedBranch || base.trim() !== savedBase
      const checklistView = checklist?.exists ? parseChecklist(checklist.source) : null

      // The dependencies that hold the mission: a `Blocks` link whose target
      // has not reached the review. They are a cause of their own — no comment
      // to read, no label on the ticket — so the switch never counts them.
      const blockers = Array.isArray(mission.blockers) ? mission.blockers : []
      const heldByDependency = blockers.length > 0
      const markedBlocked = blockedNow || armedBlock || heldByDependency

      const detailsPanel = h(React.Fragment, null,
        h('dl', { className: 'missions-props' },
          h(DrawerRow, { label: 'State', value: STATE_LABELS[mission.state] ?? mission.state }),
          h(DrawerRow, { label: 'Type', value: TYPE_LABELS[mission.type] ?? mission.type }),
          // The priority is the one editable row: a native select, so the
          // keyboard and the platform menu work without a custom widget. The
          // four canonical words keep their order; a value outside the
          // vocabulary is kept and shown rather than silently dropped.
          h('dt', null, 'Priority'),
          h('dd', null,
            h('select', {
              className: 'missions-priority-select',
              'aria-label': 'Priority',
              value: priorityNow ?? '',
              disabled: writingPriority,
              onChange: (event) => {
                track('mission.priority', event.target.value)
                return writePriority(event.target.value)
              },
            },
              priorityNow === null
                ? h('option', { value: '', disabled: true, selected: true }, 'No priority')
                : null,
              (priorityNow !== null && !PRIORITY_ORDER.includes(priorityNow)
                ? [...PRIORITY_ORDER, priorityNow]
                : PRIORITY_ORDER
              ).map((choice) => h('option', {
                key: choice,
                value: choice,
                selected: choice === priorityNow,
              }, PRIORITY_LABELS[choice] ?? choice)),
            ),
          ),
          // The points row is editable for the same reason, on the panel's
          // scale: the current size is selected once, and a size the scale
          // does not offer (`4`, typed by hand) stays offered at the end.
          h('dt', null, 'Points'),
          h('dd', null,
            h('select', {
              className: 'missions-points-select',
              'aria-label': 'Points',
              value: pointsValue === null ? '' : String(pointsValue),
              disabled: writingPoints,
              onChange: (event) => {
                track('mission.points', event.target.value)
                return writePoints(event.target.value)
              },
            },
              pointsValue === null
                ? h('option', { value: '', disabled: true, selected: true }, 'No points')
                : null,
              (pointsValue !== null && !POINTS_SCALE.includes(pointsValue)
                ? [...POINTS_SCALE, pointsValue]
                : POINTS_SCALE
              ).map((choice) => h('option', {
                key: choice,
                value: String(choice),
                selected: choice === pointsValue,
              }, pointsText(choice))),
            ),
          ),
          h(DrawerRow, { label: 'Project', value: mission.projectName ?? mission.project }),
          h(DrawerRow, { label: 'Epic', value: mission.epic }),
          h(DrawerRow, { label: 'Updated', value: relativeAge(mission.updatedAt) }),
        ),

        priorityNote
          ? h('p', {
              className: priorityNote.error ? 'missions-priority-note missions-priority-note--error' : 'missions-priority-note',
              role: priorityNote.error ? 'alert' : 'status',
            }, priorityNote.text)
          : null,

        pointsNote
          ? h('p', {
              className: pointsNote.error ? 'missions-points-note missions-points-note--error' : 'missions-points-note',
              role: pointsNote.error ? 'alert' : 'status',
            }, pointsNote.text)
          : null,

        h('div', { className: 'missions-blocked', 'data-blocked': markedBlocked ? 'true' : 'false' },
          h('div', { className: 'missions-blocked-head' },
            h('span', { className: 'missions-blocked-title' },
              markedBlocked ? 'Mission bloquée' : 'Signaler un blocage',
            ),
            h(Switch, {
              label: 'Bloqué',
              checked: blockedNow || armedBlock,
              disabled: writingBlock,
              onChange: toggleBlocked,
            }),
          ),
          armedBlock && !blockedNow
            ? h('div', { className: 'missions-blocked-form' },
                h('label', { className: 'missions-blocked-field' },
                  h('span', { className: 'missions-blocked-label' }, 'Raison du blocage'),
                  h('textarea', {
                    className: 'missions-blocked-input',
                    rows: 3,
                    value: reason,
                    disabled: writingBlock,
                    placeholder: 'Ce qui empêche la mission d’avancer.',
                    onChange: (event) => setReason(event.target.value),
                  }),
                ),
                h('div', { className: 'missions-blocked-actions' },
                  h('button', {
                    type: 'button',
                    className: 'missions-blocked-apply',
                    disabled: writingBlock || !reason.trim(),
                    onClick: () => writeBlocked(true),
                  }, writingBlock ? 'Envoi…' : 'Bloquer'),
                  h('button', {
                    type: 'button',
                    className: 'missions-blocked-cancel',
                    disabled: writingBlock,
                    onClick: () => { setArmedBlock(false); setReason(''); setBlockNote(null) },
                  }, 'Annuler'),
                ),
              )
            : blockedNow
              ? h(BlockedReason, { reason: blockedReason })
              : null,
          heldByDependency ? h(BlockedBy, { blockers }) : null,
          !blockedNow && !armedBlock && !heldByDependency
            ? h('p', { className: 'missions-blocked-hint' },
                'Le label `blocked` et sa raison partent dans le tracker ; rien n’est gardé ici.',
              )
            : null,
          blockNote
            ? h('p', { className: blockNote.error ? 'missions-blocked-note missions-blocked-note--error' : 'missions-blocked-note', role: blockNote.error ? 'alert' : 'status' }, blockNote.text)
            : null,
        ),

        h('div', { className: 'missions-declare' },
          h('label', { className: 'missions-declare-field' },
            h('span', { className: 'missions-declare-label' }, 'Branch'),
            h('input', {
              type: 'text',
              className: 'missions-declare-input',
              value: branch,
              placeholder: 'gh-49',
              spellCheck: false,
              autoComplete: 'off',
              disabled: saving,
              onChange: (event) => setBranch(event.target.value),
            }),
          ),
          h('label', { className: 'missions-declare-field' },
            h('span', { className: 'missions-declare-label' }, 'Base'),
            h('input', {
              type: 'text',
              className: 'missions-declare-input',
              value: base,
              placeholder: 'main',
              spellCheck: false,
              autoComplete: 'off',
              disabled: saving,
              onChange: (event) => setBase(event.target.value),
            }),
          ),
          h('button', {
            type: 'button',
            className: 'missions-declare-save',
            onClick: saveDeclaration,
            disabled: saving || !dirty,
          }, saving ? 'Saving…' : 'Save'),
          declareNote
            ? h('p', { className: declareNote.error ? 'missions-declare-note missions-declare-note--error' : 'missions-declare-note', role: declareNote.error ? 'alert' : 'status' }, declareNote.text)
            : null,
        ),

        tolgeeNote !== null
          ? h('p', { className: tolgeeNote.error ? 'missions-tolgee-note missions-tolgee-note--error' : 'missions-tolgee-note', role: tolgeeNote.error ? 'alert' : 'status' }, tolgeeNote.text)
          : null,

        tolgeeNote !== null && (tolgeeKeys?.length > 0 || tolgeeUntranslated.length > 0)
          ? h('div', { className: 'missions-tolgee' },
              tolgeeKeys !== null && tolgeeKeys.length > 0
                ? h('div', { className: 'missions-tolgee-block' },
                    h('p', { className: 'missions-tolgee-title' }, 'Clés de traduction du diff'),
                    h('ul', { className: 'missions-tolgee-list' },
                      tolgeeKeys.map((entry) => h('li', { key: entry.key, className: 'missions-tolgee-key' },
                        h('code', null, entry.key),
                        h('span', { className: 'missions-tolgee-missing' }, `manque en ${entry.missing.join(', ')}`),
                      )),
                    ),
                  )
                : null,
              tolgeeUntranslated.length > 0
                ? h('div', { className: 'missions-tolgee-block' },
                    h('p', { className: 'missions-tolgee-title' }, 'À écrire en fr d’abord'),
                    h('ul', { className: 'missions-tolgee-list' },
                      tolgeeUntranslated.map((entry) => h('li', { key: entry.key, className: 'missions-tolgee-key' },
                        h('code', null, entry.key),
                        h('span', { className: 'missions-tolgee-missing' }, (entry.occurrences ?? []).join(', ')),
                      )),
                    ),
                  )
                : null,
            )
          : null,
      )

      const journalPanel = h('section', { className: 'missions-journal', 'aria-label': 'Mission journal' },
        journal?.exists && journal.folder
          ? h('div', { className: 'missions-journal-head' },
              h('span', { className: 'missions-journal-meta' }, `missions/${journal.folder}/journal.md · ${relativeAge(journal.mtimeMs)}`),
            )
          : null,
        journal === null
          ? h('p', { className: 'missions-journal-hint' }, 'Loading the journal…')
          : journal.error
            ? h('p', { className: 'missions-journal-hint' }, 'Journal unavailable: the host did not answer.')
            : journal.exists
              ? h('pre', { className: 'missions-journal-text', tabIndex: 0 }, journal.source)
              : h('p', { className: 'missions-journal-hint' }, journal.folder
                  ? 'No journal yet — it is written at cadrage.'
                  : 'No mission folder yet — declare a branch to create it.'),
      )

      const checklistPanel = h('section', { className: 'missions-checklist', 'aria-label': 'Mission checklist' },
        checklist?.exists && checklistView
          ? h('div', { className: 'missions-checklist-head' },
              h('span', { className: 'missions-checklist-meta' }, checklistView.counts.total > 0
                  ? `${checklistView.counts.checked}/${checklistView.counts.total} · ${relativeAge(checklist.mtimeMs)}`
                  : relativeAge(checklist.mtimeMs)),
            )
          : null,
        checklist === null
          ? h('p', { className: 'missions-checklist-hint' }, 'Loading the checklist…')
          : checklist.error
            ? h('p', { className: 'missions-checklist-hint' }, 'Checklist unavailable: the host did not answer.')
            : checklist.exists
              ? checklistView.blocks.length > 0
                ? h(ChecklistBlocks, { blocks: checklistView.blocks })
                : h('p', { className: 'missions-checklist-hint' }, 'Empty checklist — it is filled at cadrage.')
              : h('p', { className: 'missions-checklist-hint' }, checklist.folder
                  ? 'No checklist yet — it is written at cadrage.'
                  : 'No mission folder yet — declare a branch to create it.'),
      )

      const panelContent = section === 'journal' ? journalPanel : section === 'checklist' ? checklistPanel : detailsPanel

      // A done mission plays no session: the note under the foot says so in one
      // clause and names the gesture that is left, the archive. The blocker
      // sentence alone read like a refusal of the archive click (MIS-174).
      const doneNote = mission.state === 'done'
        ? 'This mission is done: no session. Archive moves the folder to missions/archives.'
        : null

      const drawerTabs = h('div', { className: 'missions-drawer-tabs', role: 'tablist', 'aria-label': 'Mission sections' },
        DRAWER_TABS.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          role: 'tab',
          className: 'missions-drawer-tab',
          id: `missions-drawer-tab-${entry.id}`,
          'aria-selected': section === entry.id ? 'true' : 'false',
          'aria-controls': section === entry.id ? 'missions-drawer-panel' : undefined,
          onClick: () => { track(`mission.tab.${entry.id}`); setSection(entry.id) },
        }, entry.label)),
      )

      // Journal and checklist fill the drawer: the body scrolls on its own and
      // the drawer stops scrolling. Details keeps the drawer's own scroll.
      const filling = section !== 'details'

      return h('aside', {
        className: filling ? 'missions-drawer missions-drawer--fill' : 'missions-drawer',
        role: 'complementary',
        'aria-label': `Mission ${mission.key}`,
      },
          h('div', { className: 'missions-drawer-head' },
            theme === 'manga'
              ? h('div', { className: 'missions-drawer-portrait' }, h('img', { src: ART.avatar, alt: '' }))
              : null,
            h('div', null,
              h('div', { className: 'missions-drawer-key' }, mission.key),
              h('h2', { className: 'missions-drawer-title' }, mission.title),
            ),
            h('button', { type: 'button', className: 'missions-drawer-close', onClick: onClose, 'aria-label': 'Close', 'data-tip': 'Close' },
              h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 },
                h('path', { d: 'M4 4l8 8M12 4l-8 8', 'stroke-linecap': 'round' }),
              ),
            ),
          ),

          drawerTabs,

          h('div', {
            className: 'missions-drawer-panel',
            role: 'tabpanel',
            id: 'missions-drawer-panel',
            'aria-labelledby': `missions-drawer-tab-${section}`,
          }, panelContent),

          note ? h('p', { className: 'missions-drawer-note' }, note) : null,
          closeNote ? h('p', { className: closeNote.error ? 'missions-drawer-note missions-drawer-note--error' : 'missions-drawer-note' }, closeNote.text) : null,
          archiveNote ? h('p', { className: archiveNote.error ? 'missions-drawer-note missions-drawer-note--error' : 'missions-drawer-note' }, archiveNote.text) : null,
          pinNote ? h('p', { className: pinNote.error ? 'missions-drawer-note missions-drawer-note--error' : 'missions-drawer-note' }, pinNote.text) : null,
          doneNote
            ? h('p', { id: 'missions-session-blocked', className: 'missions-drawer-note' }, doneNote)
            : blocker ? h('p', { id: 'missions-session-blocked', className: 'missions-drawer-note missions-drawer-note--blocked' }, `Session blocked: ${blocker}.`) : null,

          h('div', { className: 'missions-drawer-foot' },
            // Every action of the foot shares one row: icon only, its name in
            // `data-tip` for the pointer and in `aria-label` for the screen
            // reader. The gestures a blocker can disable sit in a wrapper, which
            // is what receives the events.
            h('div', { className: 'missions-drawer-actions' },
              // A pin is this checkout's reading order, not the tracker's: the
              // button is offered in every state and says where it stands.
              h('span', {
                className: 'missions-tip-anchor',
                'data-tip': writingPin ? 'Saving the pin…' : pinnedNow ? 'Unpin' : 'Pin',
              }, h('button', {
                type: 'button',
                className: pinnedNow
                  ? 'missions-action missions-action--icon missions-action--pin missions-action--pinned'
                  : 'missions-action missions-action--icon missions-action--pin',
                onClick: writePin,
                disabled: writingPin,
                'aria-pressed': pinnedNow ? 'true' : 'false',
                'data-pinned': pinnedNow ? 'true' : 'false',
                'aria-label': writingPin ? 'Saving the pin…' : pinnedNow ? 'Unpin' : 'Pin',
              }, h('span', {
                // The drawing is re-keyed on every successful write: React
                // remounts it, which replays the stamp — never on opening,
                // where no row has been stamped yet.
                key: `${pinnedNow ? 'pin-up' : 'pin-down'}-${pinStamp}`,
                className: pinStamp > 0
                  ? 'missions-pin-icon missions-pin-icon--stamped'
                  : 'missions-pin-icon',
              }, h(ActionIcon, { name: 'pin', pinned: pinnedNow })))),
              // Only the step that follows the merge may delete the branch: the
              // panel shows the gesture there and nowhere else, and the host
              // re-reads the state before touching anything. It opens the row so
              // it never sits next to the primary; its first click arms it, its
              // second confirms, and the button itself says which state it is in.
              mission.state === 'ready-for-prod'
                ? h('span', {
                    className: 'missions-tip-anchor',
                    'data-tip': blocker ?? (closing ? 'Closing…' : armedClose ? 'Confirm — close the local checkout' : 'Close the local checkout'),
                  }, h('button', {
                    type: 'button',
                    className: closing || !armedClose
                      ? 'missions-action missions-action--icon missions-action--danger'
                      : 'missions-action missions-action--icon missions-action--danger missions-action--danger-armed',
                    onClick: closeLocalCheckout,
                    disabled: closing || blocker !== null,
                    'aria-label': closing ? 'Closing…' : armedClose ? 'Confirm — close the local checkout' : 'Close the local checkout',
                    'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                  }, h(ActionIcon, { name: closing || !armedClose ? 'close' : 'confirm' })))
                : null,
              // A done mission can be archived: its folder moves to
              // missions/archives/. Two clicks, like the close: the first arms
              // it, the second posts, and the button itself shows its state.
              mission.state === 'done'
                ? h('span', {
                    className: 'missions-tip-anchor',
                    'data-tip': archiving ? 'Archiving…' : armedArchive ? 'Confirm — archive the mission' : 'Archive',
                  }, h('button', {
                    type: 'button',
                    className: armedArchive && !archiving
                      ? 'missions-action missions-action--icon missions-action--armed'
                      : 'missions-action missions-action--icon',
                    onClick: archiveMission,
                    disabled: archiving,
                    'aria-label': archiving ? 'Archiving…' : armedArchive ? 'Confirm — archive the mission' : 'Archive',
                  }, h(ActionIcon, { name: armedArchive && !archiving ? 'confirm' : 'archive' })))
                : null,
              mission.url
                ? h('a', {
                    className: 'missions-action missions-action--icon',
                    href: mission.url,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    'data-tip': 'Open on the tracker',
                    'aria-label': 'Open on the tracker',
                    onClick: () => track('mission.open-tracker'),
                  }, h(ActionIcon, { name: 'tracker' }))
                : h('span', { className: 'missions-tip-anchor', 'data-tip': 'No tracker link' },
                    h('button', { type: 'button', className: 'missions-action missions-action--icon', disabled: true, 'aria-label': 'No tracker link' }, h(ActionIcon, { name: 'tracker' })),
                  ),
              mission.translations && stateInRange(mission.state, 'in-progress', 'in-review')
                ? h('span', {
                    className: 'missions-tip-anchor',
                    'data-tip': importingTolgee ? 'Checking the translations…' : 'Tolgee import',
                  }, h('button', {
                    type: 'button',
                    className: 'missions-action missions-action--icon',
                    onClick: importTolgee,
                    disabled: importingTolgee,
                    'aria-label': importingTolgee ? 'Checking the translations…' : 'Tolgee import',
                  }, h(ActionIcon, { name: 'tolgee' })))
                : null,
              // The free session asks a question: it opens in every state but
              // done, and sits before the state's own gestures so those stay
              // neighbours and the primary stays last.
              mission.state === 'done'
                ? null
                : h('span', { className: 'missions-tip-anchor', 'data-tip': freeBlocker ?? freeLabel },
                    h('button', {
                      type: 'button',
                      className: 'missions-action missions-action--icon',
                      onClick: startFreeSession,
                      disabled: freeBlocker !== null,
                      'aria-label': freeLabel,
                      'aria-describedby': freeBlocker ? 'missions-session-blocked' : undefined,
                    }, h(ActionIcon, { name: 'free' })),
                  ),
              // Only a mission in review has remarks to check: the client does
              // not know whether a PR exists, so the state alone decides, and
              // the session stops with a word when `gh` finds none.
              mission.state === 'in-review'
                ? h('span', { className: 'missions-tip-anchor', 'data-tip': blocker ?? feedbackLabel },
                    h('button', {
                      type: 'button',
                      className: 'missions-action missions-action--icon',
                      onClick: startFeedbackSession,
                      disabled: blocker !== null,
                      'aria-label': feedbackLabel,
                      'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                    }, h(ActionIcon, { name: 'feedback' })),
                  )
                : null,
              // The colleagues' validation is the review's own gesture: it
              // replaces the step session, stays next to the remarks, and is
              // the row's primary and last.
              mission.state === 'in-review'
                ? h('span', { className: 'missions-tip-anchor', 'data-tip': blocker ?? validateLabel },
                    h('button', {
                      type: 'button',
                      className: 'missions-action missions-action--icon missions-action--primary',
                      onClick: startSession,
                      disabled: blocker !== null,
                      'aria-label': validateLabel,
                      'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                    }, h(ActionIcon, { name: 'validate' })),
                  )
                : null,
              // Outside review, the step session stays the primary and the last.
              mission.state === 'in-review'
                ? null
                : h('span', { className: 'missions-tip-anchor', 'data-tip': blocker ?? sessionLabel },
                    h('button', {
                      type: 'button',
                      className: 'missions-action missions-action--icon missions-action--primary',
                      onClick: startSession,
                      disabled: blocker !== null,
                      'aria-label': sessionLabel,
                      'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                    }, h(ActionIcon, { name: 'session' })),
                  ),
            ),
          ),
        )
    }

    const CREATE_TYPE_LABELS = { bug: 'Bug', story: 'Story' }
    const CREATE_PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }

    /**
     * The creation drawer: one form over the options the host declares, a
     * canonical payload, and the created key back to the panel.
     *
     * The panel never names a tracker field. The project select carries the
     * vocabulary its own mapping accepts, the epics are read for the chosen
     * project alone, and the two read-only lines say what the host will write:
     * the project's initial status, and the current account.
     */
    function MissionCreateDrawer({ onClose, onCreated }) {
      const [options, setOptions] = React.useState(null)
      const [optionsError, setOptionsError] = React.useState(null)
      const [projectId, setProjectId] = React.useState('')
      const [title, setTitle] = React.useState('')
      const [description, setDescription] = React.useState('')
      const [type, setType] = React.useState('')
      const [priority, setPriority] = React.useState('')
      const [epic, setEpic] = React.useState('')
      const [epics, setEpics] = React.useState([])
      const [epicsLoading, setEpicsLoading] = React.useState(false)
      const [epicsError, setEpicsError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // One POST per click, even before React has rendered the disabled button.
      const busyRef = React.useRef(false)
      const project = (options?.projects ?? []).find((entry) => entry.id === projectId) ?? null

      React.useEffect(() => {
        let alive = true
        fetch(CREATE_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!alive) return
            if (!ok || data?.error) throw new Error(data?.error ?? 'options unavailable')
            const projects = Array.isArray(data?.projects) ? data.projects : []
            setOptions({ ...data, projects })
            const first = projects[0] ?? null
            if (first) {
              setProjectId(first.id)
              setType(first.types?.[0] ?? '')
              setPriority(data.defaultPriority ?? first.priorities?.[0] ?? '')
            }
          })
          .catch((failure) => {
            if (alive) setOptionsError(failure?.message ?? 'options unavailable')
          })
        return () => {
          alive = false
        }
      }, [])

      // The epics belong to the chosen project: another project's tracker is
      // never called, and a late answer for a project already left is dropped.
      React.useEffect(() => {
        if (!projectId) return undefined
        let alive = true
        setEpicsLoading(true)
        setEpicsError(null)
        setEpics([])
        fetch(`${CREATE_EPICS_URL}?project=${encodeURIComponent(projectId)}`, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!alive) return
            if (!ok || data?.error) throw new Error(data?.error ?? 'epics unavailable')
            setEpics(Array.isArray(data?.epics) ? data.epics : [])
          })
          .catch((failure) => {
            if (alive) setEpicsError(failure?.message ?? 'epics unavailable')
          })
          .finally(() => {
            if (alive) setEpicsLoading(false)
          })
        return () => {
          alive = false
        }
      }, [projectId])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !busyRef.current) onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const chooseProject = (nextId) => {
        const next = (options?.projects ?? []).find((entry) => entry.id === nextId) ?? null
        const nextTypes = next?.types ?? []
        const nextPriorities = next?.priorities ?? []
        const wantedPriority = options?.defaultPriority ?? priority
        setProjectId(nextId)
        setType(nextTypes.includes(type) ? type : (nextTypes[0] ?? ''))
        setPriority(nextPriorities.includes(priority) ? priority : (nextPriorities.includes(wantedPriority) ? wantedPriority : (nextPriorities[0] ?? '')))
        setEpic('')
        setEpics([])
        setEpicsError(null)
      }

      const submit = (event) => {
        event.preventDefault()
        if (busyRef.current) return
        if (!projectId) {
          setError('Choose a project.')
          return
        }
        if (!title.trim()) {
          setError('A title is required.')
          return
        }
        if (description.trim().length > 4000) {
          setError('The description is 4000 characters at most.')
          return
        }
        setError(null)
        busyRef.current = true
        setBusy(true)
        fetch(CREATE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            project: projectId,
            title: title.trim(),
            description: description.trim(),
            type,
            priority,
            epic: epic === '' ? null : epic,
          }),
        })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || data?.error) throw new Error(data?.error ?? 'create failed')
            onCreated(data)
          })
          .catch((failure) => {
            // The form keeps what was typed: a refused creation is retried,
            // not retyped.
            setError(failure?.message ?? 'create failed')
            busyRef.current = false
            setBusy(false)
          })
      }

      const projects = options?.projects ?? []
      const projectTypes = project?.types ?? []
      const projectPriorities = project?.priorities ?? []
      const loading = options === null && optionsError === null
      const fieldsDisabled = busy || options === null

      return h('aside', {
        className: 'missions-drawer missions-drawer--fill',
        role: 'complementary',
        'aria-label': 'Create a mission',
      },
        h('div', { className: 'missions-drawer-head' },
          h('div', null,
            h('div', { className: 'missions-drawer-key' }, 'New mission'),
            h('h2', { className: 'missions-drawer-title' }, 'Create a mission'),
          ),
          h('button', { type: 'button', className: 'missions-drawer-close', onClick: onClose, 'aria-label': 'Close', 'data-tip': 'Close', disabled: busy }, '×'),
        ),

        optionsError
          ? h('p', { className: 'missions-drawer-note missions-drawer-note--error', role: 'alert' }, `The creation options failed: ${optionsError}`)
          : null,

        h('form', { className: 'wf-form', onSubmit: submit },
          h('label', { className: 'wf-field' },
            h('span', null, 'Project'),
            h('select', {
              value: projectId,
              onChange: (event) => chooseProject(event.target.value),
              disabled: fieldsDisabled,
              'aria-label': 'Project',
            },
              projects.length === 0
                ? h('option', { value: '' }, loading ? 'Loading…' : 'No project')
                : projects.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
            ),
          ),

          h('label', { className: 'wf-field' },
            h('span', null, 'Title'),
            h('input', {
              type: 'text',
              value: title,
              maxLength: 255,
              onChange: (event) => setTitle(event.target.value),
              disabled: fieldsDisabled,
              autoFocus: true,
              'aria-label': 'Title',
            }),
          ),

          h('label', { className: 'wf-field' },
            h('span', null, 'Description'),
            h('textarea', {
              value: description,
              maxLength: 4000,
              rows: 3,
              onChange: (event) => setDescription(event.target.value),
              disabled: fieldsDisabled,
              'aria-label': 'Description',
            }),
          ),

          h('div', { className: 'missions-create-pair' },
            h('label', { className: 'wf-field' },
              h('span', null, 'Type'),
              h('select', {
                value: type,
                onChange: (event) => setType(event.target.value),
                disabled: fieldsDisabled || projectTypes.length === 0,
                'aria-label': 'Type',
              },
                projectTypes.map((entry) => h('option', { key: entry, value: entry }, CREATE_TYPE_LABELS[entry] ?? entry)),
              ),
            ),
            h('label', { className: 'wf-field' },
              h('span', null, 'Priority'),
              h('select', {
                value: priority,
                onChange: (event) => setPriority(event.target.value),
                disabled: fieldsDisabled || projectPriorities.length === 0,
                'aria-label': 'Priority',
              },
                projectPriorities.map((entry) => h('option', { key: entry, value: entry }, CREATE_PRIORITY_LABELS[entry] ?? entry)),
              ),
            ),
          ),

          h('label', { className: 'wf-field' },
            h('span', null, 'Epic'),
            h('select', {
              value: epic,
              onChange: (event) => setEpic(event.target.value),
              disabled: fieldsDisabled || epicsLoading,
              'aria-label': 'Epic',
            },
              h('option', { value: '' }, epicsLoading ? 'Loading epics…' : 'No epic'),
              epics.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label)),
            ),
          ),
          epicsError ? h('p', { className: 'wf-error', role: 'alert' }, `The epics failed: ${epicsError}`) : null,

          h('dl', { className: 'missions-props' },
            h('dt', null, 'Status'),
            h('dd', null, options?.status ?? 'to-refine'),
            h('dt', null, 'Assigned to me'),
            h('dd', null, 'You'),
          ),

          loading ? h('p', { className: 'missions-drawer-note' }, 'Loading the options…') : null,
          error ? h('p', { className: 'wf-error', role: 'alert' }, error) : null,

          h('div', { className: 'wf-form-actions' },
            h('button', { type: 'button', className: 'missions-btn', onClick: onClose, disabled: busy }, 'Cancel'),
            h('button', {
              type: 'submit',
              className: 'missions-btn wf-primary',
              disabled: busy || options === null || !projectId || !title.trim(),
            }, busy ? 'Creating…' : 'Create'),
          ),
        ),
      )
    }

    /** Theme-specific loading indicator, shared by every view. */
    function PanelLoader({ theme }) {
      const manga = theme === 'manga'
      return h('div', { className: 'missions-loader', role: 'status', 'aria-live': 'polite' },
        manga
          ? h('div', { className: 'missions-sharingan', 'aria-hidden': 'true' },
              h('svg', { viewBox: '0 0 120 120', xmlns: 'http://www.w3.org/2000/svg' },
                h('circle', { cx: 60, cy: 60, r: 56, fill: '#f4ead8', stroke: '#1f1f1f', strokeWidth: 3 }),
                h('circle', { cx: 60, cy: 60, r: 46, fill: '#c9352a', stroke: '#1f1f1f', strokeWidth: 3 }),
                h('circle', { cx: 60, cy: 60, r: 13, fill: '#1f1f1f' }),
                h('g', { className: 'missions-sharingan-tomoe' },
                  h('path', { d: 'M60 24 q11 8 4 19 q-10 1 -10 -8 q0 -7 6 -11 Z', fill: '#1f1f1f' }),
                  h('path', { d: 'M60 24 q11 8 4 19 q-10 1 -10 -8 q0 -7 6 -11 Z', fill: '#1f1f1f', transform: 'rotate(120 60 60)' }),
                  h('path', { d: 'M60 24 q11 8 4 19 q-10 1 -10 -8 q0 -7 6 -11 Z', fill: '#1f1f1f', transform: 'rotate(240 60 60)' }),
                ),
                h('circle', { cx: 45, cy: 38, r: 6, fill: '#ffffff', opacity: 0.4 }),
              ),
            )
          : h('span', { className: 'missions-spinner', 'aria-hidden': 'true' }),
        h('span', { className: 'missions-loader-label' }, 'Loading…'),
      )
    }

    /**
     * The refresh command's drawing, chosen the way `PanelLoader` chooses its
     * indicator: the theme picks the icon, the button keeps one contract. The
     * shuriken turns; the circular arrow holds still, so the icon never reads as
     * a second spinner.
     */
    function RefreshIcon({ theme }) {
      if (theme === 'manga') {
        return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', className: 'missions-icon-shuriken' },
          h('path', { d: 'M12 1.6 14.8 9.2 22.4 12 14.8 14.8 12 22.4 9.2 14.8 1.6 12 9.2 9.2 Z', fill: 'currentColor' }),
          h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'var(--skin-page-2)', stroke: 'currentColor', strokeWidth: 1.2 }),
        )
      }
      return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', className: 'missions-icon-arrow', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M20.4 11.2a8.4 8.4 0 1 1-2.5-6.1' }),
        h('path', { d: 'M20.6 3.8v7.2h-7.2' }),
      )
    }

    /**
     * The creation drawing, chosen like `RefreshIcon` chooses its own: the
     * manga theme stamps a torn-paper seal around a brush plus, in the skin's
     * own paper, ink and accent; the default theme keeps the bare plus. The
     * seal stamps twice, so it never reads as a second spinner.
     */
    function PlusIcon({ theme }) {
      if (theme === 'manga') {
        return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', className: 'missions-icon-seal' },
          h('path', { d: 'M4.6 4.4 L6.9 3.95 L9.2 4.45 L11.6 4 L14 4.35 L16.5 3.9 L18.4 4.3 L19.35 4.15 L19.6 6.3 L19.25 8.6 L19.65 11 L19.3 13.4 L19.6 15.8 L19.5 18 L19.45 19.4 L17.2 19.7 L14.9 19.35 L12.6 19.75 L10.3 19.4 L8 19.75 L5.7 19.5 L4.5 19.55 L4.15 17.3 L4.55 15 L4.2 12.6 L4.5 10.2 L4.25 6.9 Z', fill: 'var(--skin-page-3)', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
          h('path', { d: 'M19 3.1 L19.65 3.12 L20.04 3.65 L20.35 4.25 L19.95 4.8 L19.64 5.36 L19 5.43 L18.34 5.39 L18.03 4.81 L17.74 4.25 L17.96 3.65 L18.35 3.12 Z', fill: 'var(--skin-accent-strong)' }),
          h('path', { d: 'M10.8 5.8 L13.2 5.8 L13.35 9.9 L13.35 14.1 L13.2 18.2 L10.8 18.2 L10.65 14.1 L10.65 9.9 Z', fill: 'currentColor' }),
          h('path', { d: 'M5.8 10.8 L5.8 13.2 L9.9 13.35 L14.1 13.35 L18.2 13.2 L18.2 10.8 L14.1 10.65 L9.9 10.65 Z', fill: 'currentColor' }),
        )
      }
      return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 5v14' }),
        h('path', { d: 'M5 12h14' }),
      )
    }

    /**
     * The switch back to the principal: an arrow that leaves the linked
     * checkout towards the line it came from. Drawn at 13 px, decorative —
     * the button's `title` and `aria-label` carry the name.
     */
    function MainWorktreeIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M13.2 3.4v9.2' }),
        h('path', { d: 'M10.2 8H3.2' }),
        h('path', { d: 'M5.9 5.1 3 8l2.9 2.9' }),
      )
    }


    /**
     * The foot's gesture drawings. No icon library ships here: each one is
     * drawn in place at 15 px, in the action's own colour, and the button's
     * `title` and `aria-label` carry the name — the drawing stays decorative.
     */
    function ActionIcon({ name, pinned = false }) {
      const common = {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }
      if (name === 'tracker') {
        // An external link: a frame the arrow leaves.
        return h('svg', common,
          h('path', { d: 'M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.5' }),
          h('path', { d: 'M9.5 2.5h4v4M13.5 2.5 7.5 8.5' }),
        )
      }
      if (name === 'feedback') {
        // A speech bubble: the PR's remarks.
        return h('svg', common,
          h('path', { d: 'M13.4 9.4A1.6 1.6 0 0 1 11.8 11H5.2L2.6 13.3V3.6A1.6 1.6 0 0 1 4.2 2h7.6a1.6 1.6 0 0 1 1.6 1.6Z' }),
        )
      }
      if (name === 'validate') {
        // A seal: the colleagues' validation, recorded in the ticket.
        return h('svg', common,
          h('circle', { cx: 8, cy: 8, r: 6 }),
          h('path', { d: 'M5.3 8.2 7.2 10.1 10.8 6.1' }),
        )
      }
      if (name === 'close') {
        // A circled cross: the gesture deletes the local checkout.
        return h('svg', common,
          h('circle', { cx: 8, cy: 8, r: 6 }),
          h('path', { d: 'M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8' }),
        )
      }
      if (name === 'confirm') {
        // A check: the second click confirms the gesture.
        return h('svg', common, h('path', { d: 'M3.4 8.7 6.3 11.6 12.6 5' }))
      }
      if (name === 'archive') {
        // A box with its lid: the mission folder moves to missions/archives/.
        return h('svg', common,
          h('path', { d: 'M2.2 5.6h11.6v7.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z' }),
          h('path', { d: 'M1.8 3.4h12.4v2.2H1.8z' }),
          h('path', { d: 'M6.4 8.6h3.2' }),
        )
      }
      if (name === 'tolgee') {
        // A page with an arrow leaving it: the mission's keys go to Tolgee as
        // a file, and nothing is read back.
        return h('svg', common,
          h('path', { d: 'M3.5 2.5h4.5L11.5 6v2.5' }),
          h('path', { d: 'M3.5 2.5v11h4.5' }),
          h('path', { d: 'M8 2.5V6h3.5' }),
          h('path', { d: 'M11.5 14V9M9.7 10.8 11.5 9l1.8 1.8' }),
        )
      }
      if (name === 'free') {
        // A question mark: a free session asks and moves nothing.
        return h('svg', common,
          h('circle', { cx: 8, cy: 8, r: 6 }),
          h('path', { d: 'M6.1 6.1a1.9 1.9 0 1 1 2.8 1.7c-.6.4-1 .9-1 1.5' }),
          h('circle', { cx: 8, cy: 11.5, r: 0.8, fill: 'currentColor', stroke: 'none' }),
        )
      }
      if (name === 'pin') {
        // A pushpin, in two drawings: waiting, it leans and stays outlined;
        // pinned, it stands upright, the head filled in the button's ink, the
        // point planted above a ground line. The tilt is drawn, not animated —
        // the state must read still even with motion reduced.
        const drawing = [
          h('path', { d: 'M5.6 2.2h4.8' }),
          h('path', { d: 'M8 2.2v3.4' }),
          h('path', pinned
            ? { d: 'M4.9 5.6h6.2l-1 3.2H5.9L4.9 5.6Z', fill: 'currentColor' }
            : { d: 'M4.9 5.6h6.2l-1 3.2H5.9L4.9 5.6Z' }),
          h('path', { d: 'M8 8.8v4.6' }),
        ]
        if (pinned) drawing.push(h('path', { d: 'M5.2 13.6h5.6' }))
        return h('svg', { ...common, className: 'missions-icon missions-icon-pin' },
          pinned ? drawing : h('g', { transform: 'rotate(-32 8 8)' }, drawing),
        )
      }
      if (name === 'resolve') {
        // Two branches joining one line: the conflict resolved in place. The
        // fork opens downwards, unlike squash's arms, so the two drawings do
        // not read as one gesture.
        return h('svg', common,
          h('path', { d: 'M3.2 13.2 8 8.4' }),
          h('path', { d: 'M12.8 13.2 8 8.4' }),
          h('path', { d: 'M8 8.4V2.8' }),
        )
      }
      if (name === 'remove') {
        // A bin: the worktree's folder goes, its branch stays.
        return h('svg', common,
          h('path', { d: 'M2.6 4.6h10.8' }),
          h('path', { d: 'M6.4 4.6V2.8h3.2v1.8' }),
          h('path', { d: 'M4.2 4.6l.7 8.6a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.6' }),
          h('path', { d: 'M6.8 7.2v4M9.2 7.2v4' }),
        )
      }
      if (name === 'squash') {
        // Three lines meeting on one line: the branch's commits folded into a
        // single commit, without losing what they carried.
        return h('svg', common,
          h('path', { d: 'M2.5 3.6 7.4 7.6' }),
          h('path', { d: 'M2.5 12.4 7.4 8.4' }),
          h('path', { d: 'M7.4 8h6.1' }),
        )
      }
      // A play triangle: the step that moves the ticket.
      return h('svg', common, h('path', { d: 'M5.2 3.3 12.6 8l-7.4 4.7Z' }))
    }


    // L'onglet Workflows : un workflow se crée en trois champs — le titre, la
    // description et le type. La clé et le document en découlent, personne ne
    // les tape. Le parcours se lit ensuite dans deux onglets : Informations
    // (le modèle et ses bornes) et Graphe (les gestes et les arcs). Le fichier
    // ne porte aucune coordonnée — la géométrie se recalcule à chaque rendu
    // (`layoutWorkflow`), donc deux sauvegardes du même graphe donnent la même
    // image et le modèle reste lisible à la main.
    function WorkflowsView() {
      const [view, setView] = React.useState({ loading: true, error: null, workflows: [], writers: [], states: [] })
      const [step, setStep] = React.useState(() => {
        try {
          return filterStorage()?.getItem?.(STEP_KEY) ?? null
        } catch {
          return null
        }
      })
      const [draft, setDraft] = React.useState(null)
      const [chosen, setChosen] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [arc, setArc] = React.useState({ from: '', to: '', when: '' })
      const [version, setVersion] = React.useState(0)
      const [baseline, setBaseline] = React.useState(null)
      const [selectedArc, setSelectedArc] = React.useState(null)
      const [tab, setTab] = React.useState('infos')
      const [creating, setCreating] = React.useState(false)
      const [form, setForm] = React.useState(WORKFLOW_FORM)
      const [formErrors, setFormErrors] = React.useState({})
      const [creatingBusy, setCreatingBusy] = React.useState(false)
      const [exitText, setExitText] = React.useState('')

      const load = React.useCallback(() => {
        fetch(WORKFLOWS_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data?.error) throw new Error(data.error)
            setView({ loading: false, error: null, workflows: data?.workflows ?? [], writers: data?.writers ?? [], states: data?.states ?? [] })
            setVersion((previous) => previous + 1)
          })
          .catch((error) => setView((previous) => ({ ...previous, loading: false, error: error?.message ?? 'read failed' })))
      }, [])

      React.useEffect(() => { load() }, [load])

      // Le workflow ouvert suit la session, comme l'onglet : fermer le panneau
      // sur la revue le rouvre sur la revue. Une clé que le dossier ne porte
      // plus retombe sur la première entrée de la liste.
      const entry = view.workflows.find((item) => item.workflow === step) ?? view.workflows[0] ?? null

      React.useEffect(() => {
        if (!entry) return
        writeStep(filterStorage(), entry.workflow, view.workflows.map((item) => item.workflow))
      }, [entry && entry.workflow, view.workflows])

      // Le brouillon suit le workflow : la réponse du serveur porte des champs
      // d'affichage (`errors`, `headings`, `file`, `summary`) que le fichier ne
      // contient pas. Un autre workflow rouvert repart sur Informations.
      React.useEffect(() => {
        if (!entry) { setDraft(null); setBaseline(null); setExitText(''); return }
        const model = modelOf(entry)
        setDraft(model)
        setBaseline(model)
        setExitText((model.exit ?? []).join(', '))
        setTab('infos')
        setChosen(null)
        setSelectedArc(null)
        setStatus(null)
        setArc({ from: '', to: '', when: '' })
      }, [entry && entry.workflow, version])

      // Une retouche non enregistrée se voit : le panneau le dit et refuse
      // d'ouvrir la création par-dessus.
      const dirty = Boolean(baseline && draft) && JSON.stringify(draft) !== JSON.stringify(baseline)

      const patchNode = (key, value) => {
        if (!chosen) return
        setDraft((previous) => ({ ...previous, nodes: previous.nodes.map((node) => (node.id === chosen ? { ...node, [key]: value } : node)) }))
        setStatus(null)
      }

      const patchEdge = (from, to, key, value) => {
        setDraft((previous) => ({
          ...previous,
          edges: previous.edges.map((edge) => (edge.from === from && edge.to === to ? { ...edge, [key]: value } : edge)),
        }))
        setStatus(null)
      }

      // Le modèle garde ses bornes en liste ; l'écran les montre séparées par
      // des virgules. Chaque frappe relit la liste, sinon une sauvegarde
      // emporterait la valeur d'avant la dernière virgule.
      const parseExits = (text) => String(text ?? '').split(',').map((value) => value.trim()).filter(Boolean)
      const changeExitText = (value) => {
        setExitText(value)
        setDraft((previous) => (previous ? { ...previous, exit: parseExits(value) } : previous))
        setStatus(null)
      }

      const patchModel = (field, value) => {
        setDraft((previous) => (previous ? { ...previous, [field]: value } : previous))
        setStatus(null)
      }

      const labelOf = (id) => (draft ? draft.nodes.find((node) => node.id === id)?.label ?? id : id)
      const sectionOf = (id) => (draft ? draft.nodes.find((node) => node.id === id)?.section ?? '' : '')
      const writerOf = (id) => (draft ? draft.nodes.find((node) => node.id === id)?.writer ?? '' : '')
      const roleOf = (id) => {
        if (!entry) return null
        if (id === entry.entry) return 'initial'
        if ((entry.exit ?? []).includes(id)) return 'terminal'
        return 'intermédiaire'
      }

      const addGesture = () => {
        if (!draft || draft.kind === 'statuts') return
        track('workflow.gesture.add')
        const id = nextGestureId(draft)
        const heading = entry?.headings?.[0] ?? ''
        setDraft({ ...draft, nodes: [...draft.nodes, { id, label: 'Nouveau geste', section: heading, writer: view.writers[0] ?? 'session' }] })
        setSelectedArc(null)
        setChosen(id)
        setTab('graphe')
        setStatus(null)
      }

      const removeGesture = () => {
        if (!draft || !chosen) return
        track('workflow.gesture.remove')
        setDraft(withoutNode(draft, chosen))
        setChosen(null)
        setStatus(null)
      }

      // Un même couple (départ, arrivée) ne se double pas : l'arc se relit, il
      // ne s'ajoute pas. Réappliquer le couple met la condition à jour.
      const addArc = () => {
        if (!draft || !arc.from || !arc.to) { setStatus({ kind: 'error', message: 'Choisis un départ et une arrivée.' }); return }
        if (arc.from === arc.to) { setStatus({ kind: 'error', message: 'Un arc ne revient pas sur lui-même : passe par un autre point.' }); return }
        const exists = (draft.edges ?? []).some((edge) => edge.from === arc.from && edge.to === arc.to)
        track(exists ? 'workflow.arc.update' : 'workflow.arc.add')
        setDraft(upsertEdge(draft, arc.from, arc.to, arc.when.trim()))
        setArc({ from: '', to: '', when: '' })
        setStatus(null)
      }

      const openArc = (edge) => {
        setChosen(null)
        setSelectedArc({ from: edge.from, to: edge.to })
        setStatus(null)
      }

      const removeArc = (from, to) => {
        if (!draft) return
        track('workflow.arc.remove')
        setDraft(withoutEdge(draft, from, to))
        setSelectedArc(null)
        setStatus(null)
      }

      // Le serveur valide, dit non, et n'écrit rien : le bouton ne fait
      // qu'envoyer, jamais juger.
      const save = () => {
        if (!draft || saving) return
        track('workflow.save')
        setSaving(true)
        setStatus(null)
        const { local, ...model } = draft
        fetch(WORKFLOW_MODEL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ workflow: draft.workflow, model: { ...model, exit: parseExits(exitText) }, local: local === true }),
        })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) {
              setStatus({ kind: 'error', message: data?.error ?? 'save failed', errors: data?.errors ?? [] })
              return
            }
            if (data.entry) {
              const model = modelOf(data.entry)
              setView((previous) => ({
                ...previous,
                workflows: previous.workflows.map((item) => (item.workflow === data.workflow ? data.entry : item)),
              }))
              setDraft(model)
              setBaseline(model)
              setExitText((model.exit ?? []).join(', '))
            }
            setStatus({ kind: 'ok', message: `Enregistré — ${data.file}` })
          })
          .catch((error) => setStatus({ kind: 'error', message: error?.message ?? 'save failed' }))
          .finally(() => setSaving(false))
      }

      // Annuler rend le brouillon au dernier état lu sur le serveur : les
      // retouches non enregistrées partent, le fichier n'a jamais bougé.
      const revert = () => {
        if (!baseline) return
        setDraft({
          ...baseline,
          nodes: (baseline.nodes ?? []).map((node) => ({ ...node })),
          edges: (baseline.edges ?? []).map((edge) => ({ ...edge })),
        })
        setExitText((baseline.exit ?? []).join(', '))
        setChosen(null)
        setSelectedArc(null)
        setStatus({ kind: 'ok', message: 'Modifications annulées.' })
      }

      // La création ne demande que ce que personne ne peut déduire : le titre,
      // la description et le type. La clé est le slug du titre, le document en
      // découle — les deux restent modifiables par l'API, jamais par l'écran.
      const updateForm = (field, value) => {
        setForm((previous) => ({ ...previous, [field]: value }))
        setFormErrors((previous) => ({ ...previous, [field]: undefined }))
      }

      const openCreate = () => {
        setTab('infos')
        if (dirty) {
          setStatus({ kind: 'error', message: 'Enregistre ou annule d’abord : la création partirait sur un brouillon non enregistré.' })
          return
        }
        setForm(WORKFLOW_FORM)
        setFormErrors({})
        setCreating(true)
      }

      const closeCreate = () => {
        setCreating(false)
        setFormErrors({})
      }

      const create = () => {
        if (creatingBusy) return
        const errors = {}
        if (!form.title.trim()) errors.title = 'Le titre est obligatoire.'
        if (form.description.trim().length > 280) errors.description = 'La description fait 280 caractères au plus.'
        if (Object.keys(errors).length) { setFormErrors(errors); return }
        setCreatingBusy(true)
        fetch(WORKFLOWS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            title: form.title.trim(),
            description: form.description.trim(),
            kind: form.kind,
            local: form.local === true,
          }),
        })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) {
              const errors = {}
              for (const error of data?.errors ?? []) errors[error.field] = error.message
              setFormErrors(errors)
              return
            }
            setCreating(false)
            setStep(data.workflow)
            setTab('infos')
            setStatus({ kind: 'ok', message: `Créé — ${data.document}` })
            load()
          })
          .catch((error) => setStatus({ kind: 'error', message: error?.message ?? 'create failed' }))
          .finally(() => setCreatingBusy(false))
      }

      React.useEffect(() => {
        if (!creating) return
        const onKey = (event) => { if (event.key === 'Escape') setCreating(false) }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [creating])

      // La création vit dans le panneau, jamais dans une modale : trois champs
      // seulement, le reste se déduit du titre ou se pose par défaut.
      const createForm = h('form', {
        className: 'wf-form wf-form--create',
        onSubmit: (event) => { event.preventDefault(); create() },
      },
        h('label', { className: 'wf-field' },
          h('span', null, 'Titre'),
          h('input', { value: form.title, autoFocus: true, 'aria-invalid': formErrors.title ? 'true' : 'false', onChange: (event) => updateForm('title', event.target.value) }),
          h('small', { className: 'wf-field-hint' }, 'la clé et le document s’en déduisent'),
          formErrors.title ? h('p', { className: 'wf-error', role: 'alert' }, formErrors.title) : null,
        ),
        h('label', { className: 'wf-field' },
          h('span', null, 'Description'),
          h('textarea', {
            value: form.description,
            rows: 3,
            maxLength: 280,
            placeholder: 'À quoi sert ce parcours',
            'aria-invalid': formErrors.description ? 'true' : 'false',
            onChange: (event) => updateForm('description', event.target.value),
          }),
          h('small', { className: 'wf-field-hint' }, 'trois lignes au moins, 280 caractères au plus'),
          formErrors.description ? h('p', { className: 'wf-error', role: 'alert' }, formErrors.description) : null,
        ),
        h('label', { className: 'wf-field' },
          h('span', null, 'Type'),
          h('select', { value: form.kind, onChange: (event) => updateForm('kind', event.target.value) },
            h('option', { value: 'etape' }, 'Étapes'),
            h('option', { value: 'statuts' }, 'Statuts'),
          ),
          formErrors.kind ? h('p', { className: 'wf-error', role: 'alert' }, formErrors.kind) : null,
        ),
        h('div', { className: 'wf-field' },
          Switch({
            label: 'Versionné',
            checked: form.local !== true,
            onChange: (value) => updateForm('local', !value),
          }),
          h('small', { className: 'wf-field-hint' }, form.local === true
            ? 'rangé sous workflows/local/, ignoré par git'
            : 'rangé sous workflows/model/, versionné'),
        ),
        formErrors.key ? h('p', { className: 'wf-error', role: 'alert' }, formErrors.key) : null,
        formErrors.document ? h('p', { className: 'wf-error', role: 'alert' }, formErrors.document) : null,
        h('div', { className: 'wf-form-actions' },
          h('button', { type: 'button', className: 'missions-btn', onClick: closeCreate }, 'Annuler'),
          h('button', { type: 'submit', className: 'missions-btn wf-primary', disabled: creatingBusy }, creatingBusy ? 'Création…' : 'Créer'),
        ),
      )

      const createPanel = h('div', { className: 'wf-panel' },
        h('div', { className: 'wf-panel-head' },
          h('div', null,
            h('h3', { className: 'wf-card-title' }, 'Nouveau workflow'),
            h('p', { className: 'wf-note' }, 'Le modèle et le document sont écrits sous workflows/, jamais à la place d’un fichier existant.'),
          ),
          h('button', { type: 'button', className: 'missions-drawer-close', 'aria-label': 'Fermer la création', 'data-tip': 'Fermer la création', onClick: closeCreate }, '×'),
        ),
        createForm,
      )

      // Deux attentes : le parcours (la liste) puis le modèle du workflow.
      // Entre les deux, l'entrée existe et le brouillon n'est pas encore posé —
      // lire l'entrée du brouillon ici ferait tomber le panneau entier.
      if (!entry || !draft) {
        return h('div', { className: 'wf-view' },
          h('div', { className: 'wf-toolbar' },
            h('span', { className: 'wf-note' },
              view.loading ? 'Chargement du parcours…'
                : !entry ? view.error ?? 'Aucun modèle de workflow.'
                  : 'Chargement du modèle du parcours…'),
            h('div', { className: 'wf-actions' },
              h('button', { type: 'button', className: 'missions-btn', onClick: () => { track('workflow.reload'); return load() } }, 'Recharger'),
              h('button', { type: 'button', className: 'missions-btn wf-primary', onClick: openCreate }, 'Nouveau workflow'),
            ),
          ),
          creating ? createPanel : null,
        )
      }

      const graph = layoutWorkflow(draft)
      const chosenNode = chosen ? draft.nodes.find((item) => item.id === chosen) ?? null : null
      const chosenEdge = selectedArc
        ? draft.edges.find((edge) => edge.from === selectedArc.from && edge.to === selectedArc.to) ?? null
        : null
      const clip = (text, max) => {
        const value = String(text ?? '')
        return value.length > max ? `${value.slice(0, max - 1)}…` : value
      }
      const headingTexts = (entry.headings ?? []).slice()
      const sectionChoices = chosenNode && chosenNode.section && !headingTexts.includes(chosenNode.section)
        ? [chosenNode.section, ...headingTexts]
        : headingTexts
      const ends = endPoints(draft)
      const statuts = draft.kind === 'statuts'
      const counts = (workflow) => (workflow.kind === 'statuts'
        ? `${workflow.counts?.nodes ?? workflow.nodes.length} états · ${workflow.counts?.edges ?? workflow.edges.length} événements`
        : `${workflow.counts?.nodes ?? workflow.nodes.length} gestes · ${workflow.counts?.edges ?? workflow.edges.length} arcs`)
      const incoming = (id) => draft.edges.filter((edge) => edge.to === id)
      const outgoing = (id) => draft.edges.filter((edge) => edge.from === id)
      const prop = (label, value) => h('p', { className: 'wf-prop' }, h('span', null, label), h('code', null, value ?? '—'))
      const entryChoices = view.states.includes(draft.entry) ? view.states : [draft.entry, ...view.states]
      const panelTab = (name, label) => h('button', {
        type: 'button',
        role: 'tab',
        className: `wf-tab${tab === name ? ' wf-tab--active' : ''}`,
        'aria-selected': tab === name ? 'true' : 'false',
        onClick: () => setTab(name),
      }, label)

      const informations = h('div', { className: 'wf-panel' },
        h('div', { className: 'wf-panel-head' },
          h('div', null,
            h('h3', { className: 'wf-card-title' }, 'Informations'),
            h('p', { className: 'wf-note' }, 'Ce que le parcours dit de lui — la clé et le document en découlent.'),
          ),
          dirty ? h('span', { className: 'wf-pick-kind' }, 'brouillon non enregistré') : null,
        ),
        h('div', { className: 'wf-form' },
          h('label', { className: 'wf-field' },
            h('span', null, 'Titre'),
            h('input', { value: draft.title ?? '', onChange: (event) => patchModel('title', event.target.value) }),
          ),
          h('label', { className: 'wf-field' },
            h('span', null, 'Description'),
            h('textarea', {
              value: draft.description ?? '',
              rows: 3,
              maxLength: 280,
              placeholder: 'À quoi sert ce parcours',
              onChange: (event) => patchModel('description', event.target.value),
            }),
            h('small', { className: 'wf-field-hint' }, 'trois lignes au moins, 280 caractères au plus'),
          ),
          h('label', { className: 'wf-field' },
            h('span', null, 'Entrée'),
            h('select', { value: draft.entry ?? '', onChange: (event) => patchModel('entry', event.target.value) },
              entryChoices.map((state) => h('option', { key: state, value: state }, state)),
            ),
          ),
          h('label', { className: 'wf-field' },
            h('span', null, 'Sorties'),
            h('input', { value: exitText, placeholder: 'done', onChange: (event) => changeExitText(event.target.value) }),
            h('small', { className: 'wf-field-hint' }, 'un ou plusieurs états, séparés par des virgules'),
          ),
          h('div', { className: 'wf-field' },
            Switch({
              label: 'Versionné',
              checked: draft.local !== true,
              onChange: (value) => patchModel('local', !value),
            }),
            h('small', { className: 'wf-field-hint' }, draft.local === true
              ? 'rangé sous workflows/local/, ignoré par git'
              : 'rangé sous workflows/model/, versionné'),
          ),
        ),
        h('div', { className: 'wf-props' },
          prop('Clé', draft.workflow),
          prop('Document', draft.document),
          prop('Type', WORKFLOW_KIND_LABELS[draft.kind] ?? draft.kind),
        ),
        h('p', { className: 'wf-note' }, 'La clé et le document se déduisent du titre : personne ne les tape.'),
      )

      const canvas = h('div', null,
        h('div', { className: 'wf-canvas-wrap' },
          graph.boxes.length === 0
            ? h('div', { className: 'wf-empty' },
                h('p', { className: 'wf-note' }, 'Graphe vide'),
                h('p', { className: 'wf-note' }, statuts
                  ? 'Aucun événement : ajoute un arc entre deux états pour relier le parcours.'
                  : 'Aucun geste : ajoute le premier point du parcours.'),
              )
            : h('svg', {
                className: 'wf-canvas',
                viewBox: `0 0 ${graph.width} ${graph.height}`,
                width: graph.width,
                height: graph.height,
                role: 'img',
                'aria-label': statuts
                  ? `${entry.title} — ${graph.boxes.length} états, ${graph.links.length} événements`
                  : `${entry.title} — ${graph.boxes.length} gestes, ${graph.links.length} arcs`,
              },
                h('defs', null,
                  h('marker', { id: 'wf-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: 'currentColor', opacity: 0.45 })),
                  h('marker', { id: 'wf-arrow-selected', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: 'currentColor' })),
                ),
                graph.links.map((link) => {
                  const selected = selectedArc && selectedArc.from === link.from && selectedArc.to === link.to
                  return h('g', {
                    key: `${link.from}→${link.to}`,
                    className: 'wf-link-group',
                    role: 'button',
                    tabIndex: 0,
                    'data-from': link.from,
                    'data-to': link.to,
                    'aria-label': `Événement de ${link.from} vers ${link.to}${link.when ? ` — ${link.when}` : ''}`,
                    onClick: () => { openArc(link); setTab('graphe') },
                    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArc(link); setTab('graphe') } },
                  },
                    h('path', { className: 'wf-link-hit', d: link.path }),
                    h('path', {
                      className: `wf-link${link.back ? ' wf-link--back' : ''}${selected ? ' wf-link--selected' : ''}`,
                      d: link.path,
                      'marker-end': selected ? 'url(#wf-arrow-selected)' : 'url(#wf-arrow)',
                    }),
                    link.when ? h('text', {
                      className: `wf-link-label ${link.back ? 'wf-link-label--back' : 'wf-link-label--forward'}${selected ? ' wf-link-label--selected' : ''}`,
                      x: link.labelX,
                      y: link.labelY,
                      textAnchor: link.labelAnchor,
                    }, link.when) : null,
                  )
                }),
                graph.decisions.map((decision) => h('g', {
                  key: `decision-${decision.id}`,
                  className: 'wf-node-group wf-node-group--decision',
                  onClick: () => { setSelectedArc(null); setChosen(decision.id); setTab('graphe'); setStatus(null) },
                },
                  h('polygon', {
                    className: `wf-node wf-node--decision${decision.id === chosen ? ' wf-node--selected' : ''}`,
                    points: `${decision.x + decision.width / 2},${decision.y} ${decision.x + decision.width},${decision.y + decision.height / 2} ${decision.x + decision.width / 2},${decision.y + decision.height} ${decision.x},${decision.y + decision.height / 2}`,
                  }),
                )),
                graph.boxes.map((box) => {
                  const state = box.kind === 'etat'
                  const role = entry && box.id === entry.entry ? 'initial' : entry && (entry.exit ?? []).includes(box.id) ? 'terminal' : null
                  return h('g', {
                    key: box.id,
                    className: 'wf-node-group',
                    role: 'button',
                    tabIndex: 0,
                    'data-node': box.id,
                    'data-kind': box.kind,
                    'aria-label': `${state ? 'État' : 'Geste'} ${box.label}`,
                    onClick: () => { setSelectedArc(null); setChosen(box.id); setTab('graphe'); setStatus(null) },
                    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedArc(null); setChosen(box.id); setTab('graphe'); setStatus(null) } },
                  },
                    h('rect', { className: `wf-node wf-node--${box.kind}${box.id === chosen ? ' wf-node--selected' : ''}`, x: box.x, y: box.y, width: box.width, height: box.height, rx: 9 }),
                    state
                      ? [
                          role ? h('text', { key: 'badge', className: 'wf-node-badge', x: box.x + box.width / 2, y: box.y - 6, textAnchor: 'middle' }, role) : null,
                          h('text', { key: 'label', className: 'wf-node-label wf-node-label--center', x: box.x + box.width / 2, y: box.y + 15, textAnchor: 'middle' }, clip(box.label, 22)),
                          h('text', { key: 'id', className: 'wf-node-id', x: box.x + box.width / 2, y: box.y + 27, textAnchor: 'middle' }, box.id),
                        ]
                      : [
                          h('text', { key: 'label', className: 'wf-node-label', x: box.x + 10, y: box.y + 20 }, clip(box.label, 30)),
                          h('text', { key: 'section', className: 'wf-node-section', x: box.x + 10, y: box.y + 36 }, clip(`${sectionOf(box.id)} · ${writerOf(box.id)}`, 30)),
                        ],
                  )
                }),
              ),
        ),
        statuts
          ? h('div', { className: 'wf-legend', 'aria-label': 'Légende' },
              h('span', { className: 'wf-swatch wf-swatch--etat' }), 'état',
              h('span', { className: 'wf-swatch wf-swatch--initial' }), 'initial',
              h('span', { className: 'wf-swatch wf-swatch--terminal' }), 'terminal',
              h('span', { className: 'wf-swatch wf-swatch--back' }), 'arc retour',
            )
          : null,
      )

      const side = h('div', { className: 'wf-side' },
        chosenNode
          ? h('div', { className: 'wf-card' },
              h('div', { className: 'wf-card-title' }, statuts ? 'État' : 'Geste'),
              h('p', { className: 'wf-note' }, chosenNode.id),
              h('label', { className: 'wf-field' }, h('span', null, 'Libellé'), h('input', { value: chosenNode.label ?? '', onChange: (event) => patchNode('label', event.target.value) })),
              statuts
                ? h('label', { className: 'wf-field' }, h('span', null, 'Description'), h('textarea', { rows: 3, value: chosenNode.description ?? '', onChange: (event) => patchNode('description', event.target.value) }))
                : h('div', null,
                    h('label', { className: 'wf-field' }, h('span', null, 'Section du document'), h('select', { value: chosenNode.section ?? '', onChange: (event) => patchNode('section', event.target.value) }, sectionChoices.map((text) => h('option', { key: text, value: text }, text || '—')))),
                    h('label', { className: 'wf-field' }, h('span', null, 'Écrivain'), h('select', { value: chosenNode.writer ?? '', onChange: (event) => patchNode('writer', event.target.value) }, view.writers.map((writer) => h('option', { key: writer, value: writer }, writer)))),
                    h('label', { className: 'wf-field' }, h('span', null, 'Condition'), h('input', { value: chosenNode.condition ?? '', placeholder: 'Quand ce geste a lieu', onChange: (event) => patchNode('condition', event.target.value) })),
                    h('label', { className: 'wf-field' }, h('span', null, 'Artefact'), h('input', { value: chosenNode.artifact ?? '', placeholder: 'Ce que le geste produit', onChange: (event) => patchNode('artifact', event.target.value) })),
                    h('label', { className: 'wf-field' }, h('span', null, 'Porte'), h('input', { value: chosenNode.gate ?? '', placeholder: 'Ce qui doit être vrai pour avancer', onChange: (event) => patchNode('gate', event.target.value) })),
                  ),
              h('div', { className: 'wf-props' },
                prop('Identifiant', chosenNode.id),
                prop('Rôle', roleOf(chosenNode.id)),
                statuts ? prop('Tracker', chosenNode.tracker) : null,
              ),
              h('p', { className: 'wf-note' }, statuts
                ? 'Identifiant, rôle et tracker sont en lecture seule : ils viennent du vocabulaire du workspace.'
                : `Entrants : ${incoming(chosenNode.id).map((edge) => edge.from).join(', ') || '—'} · Sortants : ${outgoing(chosenNode.id).map((edge) => edge.to).join(', ') || '—'}`),
              statuts
                ? null
                : h('div', { className: 'wf-actions' }, h('button', { type: 'button', className: 'missions-btn', onClick: removeGesture }, 'Supprimer le geste')),
            )
          : chosenEdge
            ? h('div', { className: 'wf-card' },
                h('div', { className: 'wf-card-title' }, 'Événement'),
                h('p', { className: 'wf-note' }, `${labelOf(chosenEdge.from)} → ${labelOf(chosenEdge.to)}`),
                h('div', { className: 'wf-props' },
                  prop('De', chosenEdge.from),
                  prop('Vers', chosenEdge.to),
                ),
                h('label', { className: 'wf-field' }, h('span', null, 'Quand (condition)'), h('input', { value: chosenEdge.when ?? '', placeholder: 'ce qui déclenche l’arc', onChange: (event) => patchEdge(chosenEdge.from, chosenEdge.to, 'when', event.target.value) })),
                h('label', { className: 'wf-field' }, h('span', null, 'Écrivain'),
                  h('select', { value: chosenEdge.writer ?? '', onChange: (event) => patchEdge(chosenEdge.from, chosenEdge.to, 'writer', event.target.value) },
                    h('option', { value: '' }, '—'),
                    view.writers.map((writer) => h('option', { key: writer, value: writer }, writer)),
                  )),
                h('label', { className: 'wf-field' }, h('span', null, 'Artefact'), h('input', { value: chosenEdge.artifact ?? '', onChange: (event) => patchEdge(chosenEdge.from, chosenEdge.to, 'artifact', event.target.value) })),
                h('label', { className: 'wf-field' }, h('span', null, 'Porte'), h('input', { value: chosenEdge.gate ?? '', onChange: (event) => patchEdge(chosenEdge.from, chosenEdge.to, 'gate', event.target.value) })),
                h('p', { className: 'wf-note' }, 'Le couple départ/arrivée est en lecture seule : supprime l’arc et repose-le pour le changer.'),
                h('div', { className: 'wf-actions' }, h('button', { type: 'button', className: 'missions-btn', onClick: () => removeArc(chosenEdge.from, chosenEdge.to) }, 'Supprimer l’arc')),
              )
            : h('div', { className: 'wf-card' },
                h('div', { className: 'wf-card-title' }, 'Graphe'),
                h('p', { className: 'wf-note' }, statuts ? 'Clique un état ou un événement pour ouvrir son détail.' : 'Clique un geste ou un arc pour ouvrir son détail.'),
                h('p', { className: 'wf-note' }, `Écrivains : ${view.writers.join(', ') || '—'}`),
                h('p', { className: 'wf-note' }, statuts
                  ? `${draft.nodes.length} états · ${draft.edges.length} événements`
                  : `${draft.nodes.length} gestes · ${draft.edges.length} arcs`),
                statuts
                  ? h('div', null,
                      h('div', { className: 'wf-card-title' }, 'Mapping tracker'),
                      h('table', { className: 'wf-map-table' },
                        h('thead', null, h('tr', null, h('th', null, 'État'), h('th', null, 'Tracker'))),
                        h('tbody', null, draft.nodes.map((node) => h('tr', { key: node.id }, h('td', null, node.label), h('td', null, h('code', null, node.tracker ?? '—'))))),
                      ),
                    )
                  : h('div', { className: 'wf-actions' }, h('button', { type: 'button', className: 'missions-btn', onClick: addGesture }, 'Ajouter un geste')),
              ),

        h('div', { className: 'wf-card' },
          h('div', { className: 'wf-card-title' }, statuts ? 'Événements' : 'Arcs'),
          draft.edges.length === 0
            ? h('p', { className: 'wf-note' }, statuts ? 'Aucun événement.' : 'Aucun arc.')
            : h('div', null, draft.edges.map((edge) => h('div', {
                key: `${edge.from}→${edge.to}`,
                className: 'wf-arc',
                role: 'button',
                tabIndex: 0,
                title: 'Ouvrir le détail de cet arc',
                onClick: () => openArc(edge),
                onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArc(edge) } },
              },
                h('span', null, `${labelOf(edge.from)} → ${labelOf(edge.to)}`),
                edge.when ? h('span', { className: 'wf-arc-when' }, edge.when) : null,
                h('button', { type: 'button', className: 'wf-arc-del', 'aria-label': 'Supprimer l’arc', 'data-tip': 'Supprimer l’arc', onClick: (event) => { event.stopPropagation(); removeArc(edge.from, edge.to) } }, '×'),
              ))),
          h('label', { className: 'wf-field' }, h('span', null, 'Du'), h('select', { value: arc.from, onChange: (event) => setArc({ ...arc, from: event.target.value }) }, h('option', { value: '' }, '—'), ends.map((end) => h('option', { key: `from-${end.id}`, value: end.id }, end.id)))),
          h('label', { className: 'wf-field' }, h('span', null, 'Au'), h('select', { value: arc.to, onChange: (event) => setArc({ ...arc, to: event.target.value }) }, h('option', { value: '' }, '—'), ends.map((end) => h('option', { key: `to-${end.id}`, value: end.id }, end.id)))),
          h('label', { className: 'wf-field' }, h('span', null, 'Quand (facultatif)'), h('input', { value: arc.when, placeholder: 'si …', onChange: (event) => setArc({ ...arc, when: event.target.value }) })),
          h('div', { className: 'wf-actions' },
            h('button', { type: 'button', className: 'missions-btn', onClick: addArc }, draft.edges.some((edge) => edge.from === arc.from && edge.to === arc.to && arc.from && arc.to) ? 'Mettre à jour l’arc' : 'Ajouter l’arc'),
          ),
        ),
      )

      // Le canevas reste visible ; le panneau se docke à droite et ses onglets
      // ne changent que sa colonne, jamais le dessin.
      const dock = h('div', { className: 'wf-side' },
        h('div', { className: 'wf-tabs', role: 'tablist', 'aria-label': 'Sections du workflow' },
          panelTab('infos', 'Informations'),
          panelTab('graphe', 'Graphe'),
        ),
        tab === 'infos' ? (creating ? createPanel : informations) : side,
      )

      return h('div', { className: 'wf-view' },
        h('div', { className: 'wf-toolbar' },
          h('div', { className: 'wf-toolbar-head' },
            h('h2', { className: 'wf-overview-title', id: 'wf-overview-title' }, 'Workflows'),
            h('p', { className: 'wf-note' }, `${view.workflows.length} workflow(s) · le fichier YAML est la source, le panneau l’édite.`),
          ),
          h('div', { className: 'wf-actions' },
            h('button', { type: 'button', className: 'missions-btn', onClick: () => { track('workflow.reload'); return load() } }, 'Recharger'),
            h('button', { type: 'button', className: 'missions-btn', onClick: save, disabled: saving || !baseline }, saving ? 'Enregistrement…' : 'Enregistrer'),
            h('button', { type: 'button', className: 'missions-btn', onClick: revert, disabled: !baseline }, 'Annuler'),
            h('button', { type: 'button', className: 'missions-btn wf-primary', onClick: openCreate }, 'Nouveau workflow'),
          ),
        ),

        entry.errors && entry.errors.length > 0
          ? h('div', null, entry.errors.map((error, index) => h('p', { key: `${error.code}-${index}`, className: 'wf-error' }, `${error.field} — ${error.message}`)))
          : null,
        entry.orphanSections && entry.orphanSections.length > 0
          ? h('p', { className: 'wf-note' }, `Sans geste : ${entry.orphanSections.join(' · ')}`)
          : null,
        status
          ? h('div', null,
              h('p', { className: status.kind === 'ok' ? 'wf-ok' : 'wf-error', role: 'status' }, status.message),
              (status.errors ?? []).map((error, index) => h('p', { key: `${error.code}-${index}`, className: 'wf-error' }, `${error.field} — ${error.message}`)),
            )
          : null,

        h('ul', { className: 'wf-list', 'aria-label': 'Workflows' },
          view.workflows.map((workflow) => h('li', { key: workflow.workflow },
            h(Card, {
              as: 'button',
              variant: 'pick',
              type: 'button',
              interactive: true,
              pressed: workflow.workflow === entry.workflow,
              onActivate: () => { track('workflow.step', workflow.workflow); setStep(workflow.workflow) },
              'data-workflow': workflow.workflow,
              'data-kind': workflow.kind,
            },
              h('span', { className: 'wf-pick-top' },
                h('span', { className: 'wf-pick-title' }, workflow.title || workflow.workflow),
                h('span', { className: 'wf-pick-badges' },
                  workflow.local ? h('span', { className: 'wf-pick-local' }, 'Local') : null,
                  h('span', { className: 'wf-pick-kind' }, WORKFLOW_KIND_LABELS[workflow.kind] ?? workflow.kind),
                ),
              ),
              h('span', { className: 'wf-pick-summary' }, workflow.description || workflow.summary || '—'),
              h('span', { className: 'wf-pick-meta' }, counts(workflow)),
              h('span', { className: 'wf-pick-flow' },
                h('code', null, workflow.entry ?? '?'),
                ' → ',
                h('code', null, (workflow.exit ?? []).join(' / ') || '?'),
              ),
            ),
          )),
        ),

        h('div', { className: 'wf-detail-head' },
          h('div', null,
            h('h3', { className: 'wf-detail-title' }, entry.title || entry.workflow),
            h('p', { className: 'wf-note' }, `${entry.document} — entrée ${entry.entry ?? '?'} · sortie(s) ${(entry.exit ?? []).join(', ') || '?'}`),
          ),
          h('span', { className: 'wf-pick-badges' },
            entry.local ? h('span', { className: 'wf-pick-local' }, 'Local') : null,
            statuts ? h('span', { className: 'wf-pick-kind' }, WORKFLOW_KIND_LABELS.statuts) : null,
          ),
        ),

        h('div', { className: 'wf-layout' }, canvas, dock),
      )
    }

    /**
     * The playbook section: the five pages of the method, read and written
     * here. The panel never judges a page — the host applies the rules the CLI
     * applies, refuses without writing, and the screen shows the refusal as it
     * comes. The index (`playbook/README.md`) is not in the list: the section
     * edits the pages a session reads, and nothing it does creates a file.
     */
    function PlaybookView() {
      const [view, setView] = React.useState({ loading: true, error: null, pages: [] })
      const [chosen, setChosen] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [mtimeMs, setMtimeMs] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      // A page the host refuses to read says so here: the editor never shows
      // the text of the previous page in its place.
      const [pageError, setPageError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      // Recharger re-reads the list AND the page: bumping this key re-runs the
      // page read when the page itself did not change.
      const [attempt, setAttempt] = React.useState(0)

      const load = React.useCallback(() => {
        fetch(PLAYBOOKS_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data?.error) throw new Error(data.error)
            const pages = data?.pages ?? []
            setView({ loading: false, error: null, pages })
            // The session's page takes over on load: a value the list no
            // longer carries falls back to the first page.
            setChosen((current) => current ?? readPlaybookPage(filterStorage(), pages.map((entry) => entry.page)))
          })
          .catch((error) => setView((previous) => ({ ...previous, loading: false, error: error?.message ?? 'read failed' })))
      }, [])

      React.useEffect(() => { load() }, [load])

      // The open page follows the session like the workflow step: a reopened
      // panel lands on the page being edited, and an unknown page falls back to
      // the first — never to an empty editor.
      const page = view.pages.find((entry) => entry.page === chosen) ?? view.pages[0] ?? null

      React.useEffect(() => {
        if (!page) return
        writePlaybookPage(filterStorage(), page.page, view.pages.map((entry) => entry.page))
      }, [page && page.page, view.pages])

      // The text is read again per page: the draft and the version it came
      // from arrive together, or a save would carry the previous version.
      React.useEffect(() => {
        if (!page) {
          setDraft(null)
          setBaseline(null)
          setMtimeMs(null)
          return
        }
        let current = true
        setPageError(null)
        fetch(`${PLAYBOOK_PAGE_URL}?page=${encodeURIComponent(page.page)}`, { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!current) return
            if (!ok) {
              const message = data?.error ?? 'read failed'
              setPageError(message)
              setStatus({ kind: 'error', message })
              return
            }
            setDraft(data.text ?? '')
            setBaseline(data.text ?? '')
            setMtimeMs(data.mtimeMs ?? null)
            setStatus(null)
          })
          .catch((error) => {
            if (!current) return
            const message = error?.message ?? 'read failed'
            setPageError(message)
            setStatus({ kind: 'error', message })
          })
        return () => { current = false }
      }, [page && page.page, attempt])

      // An unsaved edit shows itself and opens the only question the screen
      // asks: abandon or stay. Nothing is sent before Enregistrer — the file
      // does not move on a keystroke.
      const dirty = baseline !== null && draft !== baseline

      // The confirmation is inline, never a system box: Discard loads the
      // asked page, Keep editing changes nothing and keeps the draft.
      const openPage = (next) => {
        if (!next || next.page === page?.page) return
        if (dirty) {
          setPending(next.page)
          return
        }
        setChosen(next.page)
        setDraft(null)
        setBaseline(null)
        setStatus(null)
      }

      const discardDraft = () => {
        setChosen(pending)
        setDraft(null)
        setBaseline(null)
        setPending(null)
        setStatus(null)
      }

      const keepEditing = () => setPending(null)

      // The host judges, says no, and writes nothing: the button only sends
      // the text and the version it read.
      const save = () => {
        if (!page || draft === null || saving) return
        setSaving(true)
        setStatus(null)
        fetch(PLAYBOOK_PAGE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ page: page.page, text: draft, mtimeMs }),
        })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) {
              setStatus({ kind: 'error', message: data?.error ?? 'save failed', errors: data?.errors ?? [] })
              return
            }
            // The answer carries the new version: the next save starts from
            // it, without re-reading the page or losing the cursor.
            setBaseline(draft)
            setMtimeMs(data.mtimeMs ?? null)
            setView((previous) => ({
              ...previous,
              pages: previous.pages.map((entry) => (entry.page === page.page ? { ...entry, ...data } : entry)),
            }))
            const heure = savedAt(data.mtimeMs)
            setStatus({ kind: 'ok', message: `Enregistré — ${data.file}${heure ? ` à ${heure}` : ''}` })
          })
          .catch((error) => setStatus({ kind: 'error', message: error?.message ?? 'save failed' }))
          .finally(() => setSaving(false))
      }

      // Annuler returns the draft to the last saved state: the edits go away,
      // the file never moved.
      const revert = () => {
        if (baseline === null) return
        setDraft(baseline)
        setStatus({ kind: 'ok', message: 'Modifications annulées.' })
      }

      const stepLabel = (entry) => (entry.step ? `Étape ${entry.step}` : 'Workspace')

      const savedAt = (value) => {
        if (!value) return ''
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      }

      // The page the host refused says why, and offers the page a session can
      // open right away: never a spinner that never ends.
      const fallback = pageError
        ? view.pages.find((entry) => entry.exists && entry.page !== page?.page) ?? null
        : null

      if (!page || draft === null) {
        return h('div', { className: 'pb-view' },
          h('p', { className: 'pb-note' },
            view.loading ? 'Chargement du playbook…'
              : view.error ?? pageError ?? (!page ? 'Aucune page de playbook.' : 'Chargement de la page…')),
          h('div', { className: 'pb-actions' },
            h('button', { type: 'button', className: 'missions-btn', onClick: () => { load(); setAttempt((current) => current + 1) } }, 'Recharger'),
            fallback
              ? h('button', { type: 'button', className: 'missions-btn pb-primary', onClick: () => openPage(fallback) }, `Ouvrir « ${fallback.page} »`)
              : null,
          ),
        )
      }

      return h('div', { className: 'pb-view' },
        h('div', { className: 'pb-layout' },
          h('nav', { className: 'pb-pages', 'aria-label': 'Playbook pages' },
            view.pages.map((entry) => h('button', {
              key: entry.page,
              type: 'button',
              className: 'pb-page',
              'aria-current': entry.page === page.page ? 'true' : 'false',
              onClick: () => openPage(entry),
            },
              h('span', { className: 'pb-page-title' }, entry.title ?? entry.page),
              h('span', { className: 'pb-page-meta' },
                h('span', { className: 'pb-page-step' }, stepLabel(entry)),
                h('span', { className: 'pb-page-lines' }, `${entry.lines ?? 0} lignes`),
              ),
              entry.exists ? null : h('span', { className: 'pb-page-missing' }, 'fichier absent'),
            )),
          ),
          h('div', { className: 'pb-editor' },
            h('div', { className: 'pb-editor-head' },
              h('div', null,
                h('h3', { className: 'pb-title' }, page.title ?? page.page),
                h('p', { className: 'pb-note' }, `${page.file} — ${page.lines ?? 0} lignes`),
              ),
              dirty ? h('span', { className: 'pb-dirty' }, 'brouillon non enregistré') : null,
            ),
            h('label', { className: 'pb-field' },
              h('span', null, 'Markdown de la page'),
              h('textarea', {
                className: 'pb-text',
                value: draft,
                spellCheck: false,
                onChange: (event) => { setDraft(event.target.value); setStatus(null) },
              }),
            ),
            h('div', { className: 'pb-actions' },
              h('button', { type: 'button', className: 'missions-btn', disabled: saving || !dirty, onClick: revert }, 'Cancel'),
              h('button', { type: 'button', className: 'missions-btn pb-primary', disabled: saving || !dirty, onClick: save }, saving ? 'Saving…' : 'Save'),
            ),
            pending
              ? h('div', { className: 'pb-confirm', role: 'alertdialog', 'aria-label': 'Unsaved changes' },
                  h('p', { className: 'pb-confirm-text' },
                    `« ${page.page} » a des modifications non enregistrées. Les abandonner pour ouvrir « ${(view.pages.find((entry) => entry.page === pending) ?? {}).page} » ?`),
                  h('div', { className: 'pb-confirm-actions' },
                    h('button', { type: 'button', className: 'missions-btn', onClick: keepEditing }, 'Keep editing'),
                    h('button', { type: 'button', className: 'missions-btn pb-primary', onClick: discardDraft }, 'Discard'),
                  ),
                )
              : null,
            status ? h('div', { className: `pb-status pb-status--${status.kind}`, role: status.kind === 'error' ? 'alert' : 'status' },
              h('p', { className: 'pb-status-text' }, status.message ?? ''),
              (status.errors ?? []).length > 0
                ? h('ul', { className: 'pb-errors' }, (status.errors ?? []).map((error) => h('li', { key: error }, error)))
                : null,
            ) : null,
          ),
        ),
      )
    }

    /**
     * One row of the repositories view: the clone's name, its branch, the
     * state of its working tree, and the commit it last moved on. The whole
     * row is the button — the tab's job is to get a repository open, not to
     * list it completely.
     *
     * A worktree carries its two gestures at the end of the row: bring its
     * branch into the main checkout, then remove its folder. The destructive
     * one comes last, and both wait while either runs.
     */
    function RepositoryRow({ repository, now, onOpen, onAdopt, onRemove, busy = false, locked = false }) {
      const state = repositoryState(repository)
      const branch = repositoryBranch(repository)
      const commit = repositoryCommit(repository)
      const age = repository.lastCommit ? relativeAge(repository.lastCommit.date, now) : ''
      // `main` is the principal of a linked checkout: `{ name, path }`
      // on a worktree, `null` on a clone. A name is only there when the
      // principal is a row of this list — otherwise the switch has no target.
      const main = repository.main ?? null
      const mainName = main?.name ?? null
      const mainPath = main?.path ?? null
      // The title says what the click does, not just where the main checkout
      // is: it moves a branch and removes this folder.
      const switchTitle = mainPath
        ? (mainName ? `Bring ${repository.name} into ${mainName} (${mainPath}) — the worktree folder is removed` : `outside the workspace root : ${mainPath}`)
        : 'main worktree unknown'
      const removeTitle = `Remove ${repository.name} (${branch}) — its branch is kept`
      return h('li', { className: 'missions-repo-rowitem', 'aria-busy': busy ? 'true' : 'false' },
        h('button', {
          type: 'button',
          className: 'missions-repo missions-repo-grid',
          'data-repository': repository.name,
          title: repository.error ? `${repository.path ?? repository.name} — ${repository.error}` : repository.path,
          'aria-label': `${repository.name}, ${branch}, ${state.label}${commit ? `, ${commit}` : ''}`,
          onClick: () => onOpen(repository),
        },
          h('span', { className: 'missions-repo-name' },
            h('span', { className: 'missions-repo-name-text' }, repository.name),
            repository.kind === 'worktree' ? h('span', { className: 'missions-repo-kind' }, 'worktree') : null,
          ),
          h('span', { className: 'missions-repo-branch' }, branch),
          h('span', {
            className: 'missions-repo-state',
            'data-dirty': state.dirty ? 'true' : 'false',
            'data-error': state.error ? 'true' : 'false',
          }, state.label),
          h('span', { className: 'missions-repo-commit missions-col-commit' }, commit),
          h('span', { className: 'missions-repo-age' }, age),
        ),
        repository.kind === 'worktree'
          ? h(React.Fragment, null,
              h('span', { className: 'missions-tip-anchor', 'data-tip': switchTitle },
                h('button', {
                  type: 'button',
                  className: 'missions-repo-main',
                  'aria-label': mainName ? `Bring ${repository.name} into ${mainName}` : 'Bring the worktree into its main checkout',
                  disabled: !mainName || locked,
                  onClick: mainName ? () => onAdopt(repository) : undefined,
                }, h(MainWorktreeIcon)),
              ),
              h('span', { className: 'missions-tip-anchor', 'data-tip': removeTitle },
                h('button', {
                  type: 'button',
                  className: 'missions-repo-remove',
                  'aria-label': `Remove the worktree ${repository.name}`,
                  disabled: locked,
                  onClick: () => onRemove(repository),
                }, h(ActionIcon, { name: 'remove' })),
              ),
            )
          : h('span', { className: 'missions-repo-main-slot', 'aria-hidden': 'true' }),
      )
    }

    /**
     * The repositories tab: the clones and worktrees of the workspace root.
     *
     * The list shows one kind at a time: the clones at rest, because a worktree
     * is a second checkout of a repository already there, then the worktrees
     * alone once the session's switch asks for them. The head keeps counting
     * the whole scan — the filter is about what the rows show, not about what
     * git found; a root with no worktree, switch on, says so instead of falling
     * back to the clones. The switch lives in
     * session storage: a view switch brings the choice back, the window
     * closing drops it.
     *
     * It is the one tab that writes, and only through a worktree row's two
     * buttons: a confirmed gesture, one POST, then the workspace read again.
     * Reading it stays free — the scan is what the list costs, and it runs on
     * every open.
     *
     * The scan starts when the tab opens, not when the panel mounts: forty
     * clones are two git calls each, and a panel that scanned on every mount
     * would pay for a view nobody is looking at. It also means every opening
     * of the tab shows the workspace as it is now — the list is never served
     * from a cache.
     */
    /**
     * The repositories bar: a free-text search and the working-tree states the
     * displayed list answers.
     *
     * The state menu carries a count per state, frozen on the list the switch
     * shows — what the bar can find, not what it found. The Clear button only
     * exists while something is set, so the bar at rest stays two controls.
     */
    function RepositoriesFilters({ filters, counts, onChange, onClear }) {
      return h('div', { className: 'missions-filters missions-repos-filters' },
        h('label', { className: 'missions-search' },
          h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': 'true' },
            h('circle', { cx: 7, cy: 7, r: 4.6 }),
            h('path', { d: 'M10.4 10.4 14 14', strokeLinecap: 'round' }),
          ),
          h('input', {
            type: 'search',
            value: filters.query,
            placeholder: 'Filter by name, branch or commit…',
            'aria-label': 'Filter repositories',
            onChange: (event) => onChange({ ...filters, query: event.target.value }),
          }),
        ),
        h(ChecklistFilter, {
          label: 'State',
          value: filters.state,
          options: REPOSITORY_FILTER_OPTIONS,
          labels: REPOSITORY_FILTER_LABELS,
          counts,
          allLabel: 'All states',
          onChange: (state) => onChange({ ...filters, state }),
        }),
        hasActiveRepositoryFilters(filters)
          ? h('button', { type: 'button', className: 'missions-clear', onClick: onClear }, 'Clear')
          : null,
      )
    }

    function RepositoriesView({ theme, onOpen, onRemoved = () => {} }) {
      const [scan, setScan] = React.useState({ loading: true, data: null, error: null })
      // The tab's writes: the last gesture, its state and the sentence it
      // shows — then the counter that reads the workspace again, because the
      // checkouts it listed before the click are not the ones git now has.
      const [gesture, setGesture] = React.useState(null)
      const [reload, setReload] = React.useState(0)
      // The worktrees are hidden until the session asks: the switch reads its
      // default from the session, never from a setting that outlives the app.
      const [worktreesShown, setWorktreesShown] = React.useState(() => readWorktreesShown(filterStorage()))
      const [filters, setFilters] = React.useState(() => readRepositoryFilters(filterStorage()))

      React.useEffect(() => {
        let alive = true
        fetch(REPOSITORIES_URL, { headers: { accept: 'application/json' } })
          .then(async (response) => {
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data?.error ?? `scan failed (${response.status})`)
            return data
          })
          .then((data) => {
            if (alive) setScan({ loading: false, data, error: null })
          })
          .catch((error) => {
            if (alive) setScan({ loading: false, data: null, error: error?.message ?? String(error) })
          })
        return () => { alive = false }
        // A finished gesture bumps `reload`: the tab then reads the workspace
        // again instead of showing the checkouts as they were.
      }, [reload])

      if (scan.error) {
        return h('div', { className: 'missions-repos' },
          h('div', { className: 'missions-repos-error', role: 'alert' },
            h('b', null, 'The scan failed. '),
            h('span', null, scan.error),
          ),
        )
      }
      if (!scan.data) return h(PanelLoader, { theme })

      const data = scan.data
      const rows = sortRepositories(data.repositories)
      // The sort runs once on the whole scan; splitting the rows afterwards
      // keeps either list in the same order whatever the switch says.
      const clones = rows.filter((repository) => repository.kind !== 'worktree')
      const worktrees = rows.filter((repository) => repository.kind === 'worktree')
      const repositories = worktreesShown ? worktrees : clones
      const counts = repositoryFilterCounts(repositories)
      const visible = filterRepositories(repositories, filters)
      const hiddenWorktrees = !worktreesShown && worktrees.length > 0
      const hiddenLabel = `${worktrees.length === 1 ? 'The only worktree' : `All ${worktrees.length} worktrees`} of the workspace root ${worktrees.length === 1 ? 'is' : 'are'} hidden.`
      const revealHint = `Show worktrees lists ${worktrees.length === 1 ? 'it' : 'them'}.`
      const noWorktree = worktreesShown && worktrees.length === 0
      const noWorktreeLabel = 'No worktree in the workspace root.'
      const noWorktreeHint = `Show worktrees is on: turn it off to see the ${clones.length} ${clones.length === 1 ? 'repository' : 'repositories'}.`
      let emptyLabel = 'No repository in the workspace root.'
      let emptyHint = data.root ? `Scanned ${data.root}.` : 'The host did not name the root it scanned.'
      if (hiddenWorktrees) {
        emptyLabel = hiddenLabel
        emptyHint = `${revealHint}${data.root ? ` Scanned ${data.root}.` : ''}`
      } else if (noWorktree) {
        emptyLabel = noWorktreeLabel
        emptyHint = noWorktreeHint
      }
      const toggleWorktrees = (shown) => {
        setWorktreesShown(shown)
        writeWorktreesShown(filterStorage(), shown)
      }
      const applyFilters = (next) => {
        setFilters(next)
        writeRepositoryFilters(filterStorage(), next)
      }
      const clearFilters = () => applyFilters({ query: '', state: null })
      const now = Date.now()
      const missing = Array.isArray(data.errors) ? data.errors : []
      // The host is the only judge of both writes: it answers the same shape,
      // and a refusal carries the sentence the banner shows.
      const ask = (question) => {
        const scope = typeof globalThis.confirm === 'function' ? globalThis : (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window : null)
        return !scope || scope.confirm(question)
      }
      const post = async (url, name, acceptIgnored) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(acceptIgnored ? { name, acceptIgnored: true } : { name }),
        })
        const body = await response.json().catch(() => ({}))
        return { response, body }
      }
      // Ignored files go with the folder without git saying so: the host names
      // them, and a second yes is what deletes them.
      const ignoredRefusal = (name, body) => {
        const held = Array.isArray(body.files) && body.files.length ? ` (${body.files.join(', ')})` : ''
        const noun = body.files?.length === 1 ? 'entry' : 'entries'
        return {
          noun,
          question: `${name} also holds ignored ${noun}${held} that git deletes with the folder.\n\nRemove them with it?`,
        }
      }

      // Bringing a worktree back is the tab's first write: it asks first, then
      // tells the host what to do and reads the workspace again.
      const adoptWorktree = async (worktree) => {
        if (!worktree || !worktree.main?.name) return
        const mainName = worktree.main.name
        const branch = worktree.branch || 'its branch'
        const question = `Bring ${branch} into ${mainName}?\n\n${mainName} will check out ${branch}, and the worktree ${worktree.name} (${worktree.path}) will be removed. Both trees must be clean: one uncommitted change refuses the switch.`
        if (!ask(question)) return
        track('repository.adopt', worktree.name)
        setGesture({ name: worktree.name, state: 'running', message: `Bringing ${branch} into ${mainName}…` })
        try {
          let { response, body } = await post(REPOSITORY_ADOPT_URL, worktree.name, false)
          if (!response.ok && body?.ignored) {
            const refused = ignoredRefusal(worktree.name, body)
            if (!ask(refused.question)) {
              setGesture({ name: worktree.name, state: 'error', message: `Nothing was removed: ${worktree.name} still holds ignored ${refused.noun}.` })
              return
            }
            ;({ response, body } = await post(REPOSITORY_ADOPT_URL, worktree.name, true))
          }
          if (!response.ok) throw new Error(body?.error ?? `switch failed (${response.status})`)
          const held = body.branch ?? branch
          const where = body.main?.name ?? mainName
          setGesture({
            name: worktree.name,
            state: body.removed === false ? 'partial' : 'done',
            message: body.removed === false
              ? `${where} now holds ${held}, but the worktree ${worktree.name} stayed${body.reason ? `: ${body.reason}` : '.'}`
              : `${where} now holds ${held}; the worktree ${worktree.name} is gone.`,
          })
          // The drawer of that worktree has no folder left to describe — but a
          // folder git kept still has one.
          if (body.removed !== false) onRemoved(worktree)
        } catch (error) {
          setGesture({ name: worktree.name, state: 'error', message: error?.message ?? String(error) })
        }
        // A refusal changed nothing, a partial switch did: read again anyway.
        setReload((value) => value + 1)
      }

      // Removing a worktree's folder keeps its branch: the tab's other write,
      // with the same questions and the same second yes on ignored entries.
      const removeWorktree = async (worktree) => {
        if (!worktree?.name) return
        const branch = worktree.branch || 'its branch'
        const question = `Remove the worktree ${worktree.name} (${worktree.path})?\n\nOnly the folder goes: the branch ${branch} is kept. A worktree with uncommitted changes refuses the removal.`
        if (!ask(question)) return
        track('repository.remove', worktree.name)
        setGesture({ name: worktree.name, state: 'running', message: `Removing ${worktree.name}…` })
        try {
          let { response, body } = await post(REPOSITORY_REMOVE_URL, worktree.name, false)
          if (!response.ok && body?.ignored) {
            const refused = ignoredRefusal(worktree.name, body)
            if (!ask(refused.question)) {
              setGesture({ name: worktree.name, state: 'error', message: `Nothing was removed: ${worktree.name} still holds ignored ${refused.noun}.` })
              return
            }
            ;({ response, body } = await post(REPOSITORY_REMOVE_URL, worktree.name, true))
          }
          if (!response.ok) throw new Error(body?.error ?? `remove failed (${response.status})`)
          setGesture({
            name: worktree.name,
            state: 'done',
            message: `The worktree ${worktree.name} is gone; the branch ${branch} is kept.`,
          })
          // The drawer of that folder has nothing left to describe: the panel
          // closes it, and the scan below drops the row.
          onRemoved(worktree)
        } catch (error) {
          setGesture({ name: worktree.name, state: 'error', message: `Not removed: ${error?.message ?? String(error)}` })
        }
        setReload((value) => value + 1)
      }

      const running = gesture?.state === 'running' ? gesture.name : null

      return h('div', { className: 'missions-repos' },
        gesture
          ? h('div', {
              className: `missions-repos-gesture is-${gesture.state}`,
              role: gesture.state === 'error' ? 'alert' : 'status',
              'aria-live': 'polite',
            }, gesture.message)
          : null,
        h('div', { className: 'missions-repos-head' },
          h('span', { className: 'missions-repos-total' }, scanLabel(data)),
          data.root || worktrees.length > 0 || worktreesShown
            ? h('div', { className: 'missions-repos-headtools' },
                data.root ? h('span', { className: 'missions-repos-root', title: data.root }, data.root) : null,
                worktrees.length > 0 || worktreesShown
                  ? h(Switch, { label: 'Show worktrees', checked: worktreesShown, onChange: toggleWorktrees })
                  : null,
              )
            : null,
        ),
        repositories.length === 0
          ? h('div', { className: 'missions-dash-empty' },
              h('p', null, emptyLabel),
              h('p', { className: 'missions-dash-empty-hint' }, emptyHint),
            )
          : h(React.Fragment, null,
              h(RepositoriesFilters, { filters, counts, onChange: applyFilters, onClear: clearFilters }),
              h('div', { className: 'missions-repo-head', 'aria-hidden': 'true' },
                h('div', { className: 'missions-repo-headgrid missions-repo-grid' },
                  h('span', null, 'Repository'),
                  h('span', null, 'Branch'),
                  h('span', null, 'State'),
                  h('span', { className: 'missions-col-commit' }, 'Last commit'),
                  h('span', null, 'Age'),
                ),
                h('span', { className: 'missions-repo-headmain' }),
              ),
              visible.length === 0
                ? h('div', { className: 'missions-dash-empty' },
                    h('p', null, 'No repository matches these filters.'),
                    h('p', { className: 'missions-dash-empty-hint' },
                      h('button', { type: 'button', className: 'missions-clear', onClick: clearFilters }, 'Clear filters'),
                    ),
                  )
                : h('ul', { className: 'missions-rows' },
                    visible.map((repository) => h(RepositoryRow, {
                      key: repository.name,
                      repository,
                      now,
                      onOpen,
                      onAdopt: adoptWorktree,
                      onRemove: removeWorktree,
                      busy: running === repository.name,
                      locked: running !== null,
                    })),
                  ),
            ),
        missing.length > 0
          ? h('p', { className: 'missions-repos-note' },
              `${missing.length === 1 ? 'One repository was' : `${missing.length} repositories were`} left unreadable: `,
              missing.map((error) => error.name).join(', '),
              '. The scan did not stop for them.',
            )
          : null,
      )
    }

    /**
     * One JSON read of the host. A refusal carries the host's own sentence:
     * the drawer shows "fatal: …", not a status code it cannot explain.
     */
    async function readRoute(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error ?? `read failed (${response.status})`)
      return data
    }

    /**
     * The drawer of one repository: its path, its remote, its upstream, where
     * it stands against it — then, on its own tab, one branch's history.
     *
     * Each section is read when it is opened: the detail is two git calls, a
     * history page one. Reading both at mount would spend them on a tab
     * nobody opened.
     */
    function RepositoryDrawer({ repository, services, workspaceId, onClose, theme }) {
      const [detail, setDetail] = React.useState({ loading: true, data: null, error: null })
      const [section, setSection] = React.useState('details')
      const [history, setHistory] = React.useState({ loading: false, more: false, data: null, error: null })
      // The drawer's one session: the last gesture's failure, said in one
      // short line — a successful open tears the panel down before a note
      // could be read, so the happy path says nothing.
      const [note, setNote] = React.useState(null)

      // Another repository is another drawer: its sections start over.
      React.useEffect(() => {
        setSection('details')
      }, [repository.name])

      React.useEffect(() => {
        let alive = true
        readRoute(`${REPOSITORY_URL}?name=${encodeURIComponent(repository.name)}`)
          .then((data) => {
            if (alive) setDetail({ loading: false, data, error: null })
          })
          .catch((error) => {
            if (alive) setDetail({ loading: false, data: null, error: error?.message ?? String(error) })
          })
        return () => { alive = false }
      }, [repository.name])

      // A page is ten commits wide on the host's side; "Show more" adds the
      // next one to what the tab already holds, never replaces it. Changing
      // branch starts again: the old pages belong to another ref, so the new
      // page replaces them — the selector stays while it is read.
      const historyRun = React.useRef(0)
      const loadHistory = React.useCallback((branch, skip, append = false) => {
        const query = new URLSearchParams({ name: repository.name, skip: String(skip) })
        if (branch) query.set('branch', branch)
        const run = historyRun.current + 1
        historyRun.current = run
        setHistory((previous) => ({ ...previous, loading: !append, more: append, error: null }))
        return readRoute(`${REPOSITORY_HISTORY_URL}?${query}`)
          .then((data) => {
            if (historyRun.current !== run) return
            setHistory((previous) => ({
              loading: false,
              more: false,
              error: null,
              data: append && previous.data
                ? { ...data, commits: [...previous.data.commits, ...data.commits] }
                : data,
            }))
          })
          .catch((error) => {
            if (historyRun.current !== run) return
            setHistory((previous) => ({
              ...previous,
              loading: false,
              more: false,
              error: error?.message ?? String(error),
            }))
          })
      }, [repository.name])

      // The section is read the first time it opens, and kept after: coming
      // back to it must not pay the git calls again.
      React.useEffect(() => {
        if (section !== 'history' || history.data) return
        loadHistory(null, 0)
      }, [section, repository.name])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const shown = detail.data ?? repository
      const state = repositoryState(shown)
      const ahead = Number(shown.ahead ?? 0)
      const behind = Number(shown.behind ?? 0)
      const upstreamLine = shown.upstream ? `${ahead} ahead · ${behind} behind` : 'no upstream'

      // The drawer's one gesture: open a session in the workspace whose path
      // is this checkout, so the session runs where the conflicts are. The
      // panel writes no git: the prompt asks, the session resolves.
      const prompt = repositoryConflictPrompt(repository)
      const openConflictSession = async () => {
        track('repository.resolve')
        try {
          const { prefilledBy, openedBy, uiError } = await openMissionSession(services, prompt, workspaceId, repository.path)
          if (uiError) {
            setNote(`Session not opened: ${uiError}`)
          } else if (!openedBy && !prefilledBy) {
            setNote('Session created — pick it in the sidebar.')
          }
        } catch (error) {
          setNote(`Session not opened: ${error?.message ?? error}`)
        }
      }

      // Le second geste du volet : replier la branche de mission en un commit,
      // dans le workspace dont le chemin est ce dépôt. Le panneau n'écrit pas
      // de git : le prompt demande, la session replie. Le bouton garde sa
      // place tant que le détail est inconnu — le geste ne bouge pas, il
      // attend ou dit pourquoi il ne peut pas.
      const squashLabel = 'Squash the mission branch into one commit'
      const squashBlocker = detail.loading
        ? 'Reading the repository…'
        : detail.error
          ? 'The repository could not be read'
          : shown.detached || !shown.branch
            ? 'Detached HEAD — no branch to squash'
            : null
      const squashPrompt = repositorySquashPrompt(shown)
      const openSquashSession = async () => {
        track('repository.squash')
        try {
          const { prefilledBy, openedBy, uiError } = await openMissionSession(services, squashPrompt, workspaceId, shown.path)
          if (uiError) {
            setNote(`Session not opened: ${uiError}`)
          } else if (!openedBy && !prefilledBy) {
            setNote('Session created — pick it in the sidebar.')
          }
        } catch (error) {
          setNote(`Session not opened: ${error?.message ?? error}`)
        }
      }

      return h('aside', {
        className: 'missions-drawer',
        role: 'complementary',
        'aria-label': `Repository ${repository.name}`,
      },
        h('div', { className: 'missions-drawer-head' },
          h('div', null,
            h('div', { className: 'missions-drawer-key' }, shown.kind === 'worktree' ? 'worktree' : 'clone'),
            h('h2', { className: 'missions-drawer-title' }, repository.name),
          ),
          h('button', { type: 'button', className: 'missions-drawer-close', onClick: onClose, 'aria-label': 'Close', 'data-tip': 'Close' },
            h('svg', { width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
              h('path', { d: 'M3 3l8 8M11 3l-8 8', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }),
            ),
          ),
        ),
        h('div', { className: 'missions-repo-tabs', role: 'tablist', 'aria-label': 'Repository sections' },
          REPOSITORY_TABS.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            role: 'tab',
            id: `missions-repo-tab-${entry.id}`,
            className: 'missions-repo-tab',
            'aria-selected': section === entry.id ? 'true' : 'false',
            'aria-controls': `missions-repo-panel-${entry.id}`,
            onClick: () => { track(`repository.tab.${entry.id}`); setSection(entry.id) },
          }, entry.label)),
        ),
        h('div', {
          className: 'missions-drawer-panel',
          role: 'tabpanel',
          id: `missions-repo-panel-${section}`,
          'aria-labelledby': `missions-repo-tab-${section}`,
        },
          detail.error
            ? h('div', { className: 'missions-repos-error', role: 'alert' }, detail.error)
            : !detail.data
              ? h(PanelLoader, { theme })
              : section === 'history'
                ? h(RepositoryHistory, {
                    history,
                    theme,
                    onBranch: (branch) => { track('repository.branch', branch); return loadHistory(branch, 0) },
                    onMore: () => {
                      track('repository.more')
                      return loadHistory(history.data?.branch ?? null, history.data?.commits?.length ?? 0, true)
                    },
                  })
                : h(React.Fragment, null,
                      h('dl', { className: 'missions-props' },
                        h(DrawerRow, { label: 'Path', value: shown.path }),
                        h(DrawerRow, { label: 'Branch', value: repositoryBranch(shown) }),
                        h(DrawerRow, { label: 'State', value: state.label }),
                        h(DrawerRow, { label: 'Remote', value: shown.remote ?? 'no remote' }),
                        h(DrawerRow, { label: 'Upstream', value: shown.upstream ?? 'none' }),
                        h(DrawerRow, { label: 'Against upstream', value: upstreamLine }),
                      ),
                    ),
        ),
        // The footer is the mission drawer's: the same classes, the same icon
        // family, so the gestures read as one of the panel's actions. Each
        // button stays visible without its precondition — the scan does not
        // read a conflict, and a loading detail has no branch — and the prompt
        // says what to do when there is nothing to resolve or fold.
        h('div', { className: 'missions-drawer-foot' },
          note ? h('p', { className: 'missions-drawer-note' }, note) : null,
          h('div', { className: 'missions-drawer-actions' },
            h('button', {
              type: 'button',
              className: 'missions-action missions-action--icon',
              onClick: openConflictSession,
              'data-tip': 'Resolve conflicts',
              'aria-label': 'Resolve conflicts',
            }, h(ActionIcon, { name: 'resolve' })),
            h('span', { className: 'missions-tip-anchor', 'data-tip': squashBlocker ?? squashLabel },
              h('button', {
                type: 'button',
                className: 'missions-action missions-action--icon missions-action--primary',
                onClick: openSquashSession,
                disabled: squashBlocker !== null,
                'aria-label': squashBlocker ?? squashLabel,
              }, h(ActionIcon, { name: 'squash' })),
            ),
          ),
        ),
      )
    }

    /**
     * One branch's history: the selector, the page of commits, and the total
     * the page belongs to. The total is the branch's, not the page's: it says
     * what "Show more" is walking through, and when it is done.
     *
     * A read that failed is a banner, like the tree's: the error is tested
     * before the missing data, or a first read in trouble would wait forever
     * on "Reading branches…" instead of saying what went wrong.
     */
    function RepositoryHistory({ history, theme, onBranch, onMore }) {
      const data = history.data
      const commits = Array.isArray(data?.commits) ? data.commits : []
      const branches = Array.isArray(data?.branches) ? data.branches : []
      const total = historyLabel(data ?? {})
      const emptyLabel = data || history.error ? 'No local branch' : 'Reading branches…'
      return h('section', { className: 'missions-history', 'aria-label': 'Branch history' },
        h('div', { className: 'missions-history-bar' },
          h('select', {
            className: 'missions-history-branch',
            'aria-label': 'Branch',
            value: data?.branch ?? '',
            disabled: branches.length === 0,
            onChange: (event) => onBranch(event.target.value),
          },
            branches.length === 0
              ? h('option', { value: '' }, emptyLabel)
              : branches.map((branch) => h('option', { key: branch, value: branch }, branch)),
          ),
          total ? h('span', { className: 'missions-history-total' }, total) : null,
        ),
        !data && !history.error
          ? h(PanelLoader, { theme })
          : history.error
            ? h('div', { className: 'missions-repos-error', role: 'alert' }, history.error)
            : history.loading && !history.more
              ? h(PanelLoader, { theme })
              : commits.length === 0
                ? h('p', { className: 'missions-drawer-note' }, 'No commit on this branch.')
                : h('ul', { className: 'missions-history-lines' },
                  commits.map((commit, index) => h('li', { className: 'missions-history-commit', key: `${commit.sha}-${index}` },
                    h('span', { className: 'missions-history-hash' }, commit.sha),
                    h('span', { className: 'missions-history-age' }, relativeAge(commit.date)),
                    h('span', { className: 'missions-history-subject', title: commit.subject }, commit.subject),
                  )),
                ),
        data?.hasMore && !history.loading
          ? h('button', {
              type: 'button',
              className: 'missions-btn missions-history-more',
              onClick: onMore,
              disabled: history.more,
            }, history.more ? 'Loading…' : 'Show more')
          : null,
      )
    }

    /**
     * The tally, read as a report.
     *
     * Every number here comes from the local file: the view never writes it —
     * the gestures already did. Each verdict is printed with the count it was
     * read from, because a recommendation without its number is an order.
     */
    function UsageView({ usage = null, loading = false, error = null, onRefresh = () => {}, theme = 'default' }) {
      const report = usageReport(usage, Date.now())
      const since = report.startedAt ? relativeAge(report.startedAt) : null
      const windowLabel = since
        ? `${report.days} day${report.days === 1 ? '' : 's'} · since ${since}`
        : 'nothing counted yet'
      // The gate is said in numbers, not in warnings: a reader can see how far
      // the tally is from being allowed to judge anything.
      const gateLine = report.gate.open
        ? null
        : `No verdict yet: the tally needs ${USAGE_GATE_DAYS} days and ${USAGE_GATE_EVENTS} gestures, it has ${report.gate.days} and ${report.gate.events}.`
      // A verdict is a pill plus its sentence: the tooltip carries the reasoning,
      // so 'Remove' never reads as a delete button.
      const verdictOf = (entry) => h('span', {
        className: `missions-usage-verdict missions-usage-verdict--${entry.verdict}`,
        title: `${entry.reason ?? ''} ${USAGE_VERDICTS[entry.verdict]?.note ?? ''}`.trim(),
      }, USAGE_VERDICTS[entry.verdict]?.label ?? entry.verdict)
      const detailsOf = (entry) => (entry.details ?? []).length === 0
        ? null
        : h('span', { className: 'missions-usage-values' },
            entry.details.slice(0, 5).map((detail) => h('span', { className: 'missions-usage-value', key: detail.detail },
              detail.count > 1 ? `${detail.detail} ×${detail.count}` : detail.detail)),
          )
      const rowOf = (entry) => h('li', { className: 'missions-usage-row', key: entry.id },
        h('span', { className: 'missions-usage-label' }, entry.label),
        h('span', { className: 'missions-usage-count' }, String(entry.count)),
        h('span', { className: 'missions-usage-when' }, entry.lastUsed ? relativeAge(entry.lastUsed) : '—'),
        verdictOf(entry),
        detailsOf(entry),
      )

      const failed = error
        ? h('div', { className: 'missions-errors', role: 'alert' },
            h('div', { className: 'missions-error' }, h('b', null, 'usage'), h('span', null, error)),
          )
        : null
      // A broken file is not an empty one: the tab says so rather than pretend
      // the panel has never been used.
      const broken = usage && usage.broken === true
        ? h('div', { className: 'missions-errors', role: 'alert' },
            h('div', { className: 'missions-error' },
              h('b', null, 'usage.json'),
              h('span', null, 'could not be read — the tally starts over from the next gesture.'),
            ),
          )
        : null

      let body
      if (!usage && loading) body = h(PanelLoader, { theme })
      else if (!usage) body = failed ?? h('div', { className: 'missions-usage-empty' },
        h('p', null, 'No tally on this machine yet.'),
        h('p', { className: 'missions-usage-empty-hint' },
          'Use the panel — a tab, a drawer, a filter — and the gestures it counts will show up here.'),
      )
      else body = h(React.Fragment, null,
        report.top.length === 0 ? null : h('section', { className: 'missions-usage-section' },
          h('h3', { className: 'missions-usage-title' }, 'Most used'),
          h('ol', { className: 'missions-usage-top' },
            report.top.map((entry, index) => h('li', { className: 'missions-usage-top-item', key: entry.id },
              h('span', { className: 'missions-usage-rank' }, String(index + 1)),
              h('span', { className: 'missions-usage-label' }, entry.label),
              h('span', { className: 'missions-usage-count' }, String(entry.count)),
              verdictOf(entry),
            )),
          ),
        ),
        report.sections.map((section) => h('section', { className: 'missions-usage-section', key: section.title },
          h('h3', { className: 'missions-usage-title' }, section.title),
          h('ul', { className: 'missions-usage-rows' }, section.rows.map(rowOf)),
        )),
        report.idle.length === 0 ? null : h('section', { className: 'missions-usage-section missions-usage-section--idle' },
          h('h3', { className: 'missions-usage-title' }, `Never used (${report.idle.length})`),
          h('p', { className: 'missions-usage-note' }, report.idle.map((entry) => entry.label).join(' · ')),
        ),
        report.retired.length === 0 ? null : h('section', { className: 'missions-usage-section missions-usage-section--retired' },
          h('h3', { className: 'missions-usage-title' }, 'Retired'),
          h('p', { className: 'missions-usage-note' },
            'Counted by a previous build and no longer declared: their number is kept, and still counts in the total.'),
          h('ul', { className: 'missions-usage-rows' }, report.retired.map(rowOf)),
        ),
      )

      return h('div', { className: 'missions-usage' },
        h('div', { className: 'missions-usage-head' },
          h('span', { className: 'missions-usage-total' }, `${report.total} gesture${report.total === 1 ? '' : 's'} counted`),
          h('span', { className: 'missions-usage-window' }, windowLabel),
          h('button', { type: 'button', className: 'missions-btn', onClick: onRefresh, disabled: loading },
            loading ? 'Reading…' : 'Refresh'),
        ),
        h('p', { className: 'missions-usage-note' },
          'Local tally: this machine’s file, nothing leaves the panel.'),
        gateLine === null ? null : h('p', { className: 'missions-usage-note missions-usage-gate' }, gateLine),
        broken,
        failed && usage ? failed : null,
        body,
      )
    }

    /**
     * The Usage tab's one read.
     *
     * The file is small and local, so the tab asks for it when it opens and
     * when Refresh is clicked — no timer, no cache: a panel that counted a
     * gesture a second ago should show that gesture when it is looked at.
     */
    function UsageTab({ theme }) {
      const [state, setState] = React.useState({ loading: true, usage: null, error: null })
      const load = React.useCallback(() => {
        setState((previous) => ({ ...previous, loading: true }))
        return readRoute(USAGE_URL)
          .then((data) => setState({ loading: false, usage: data, error: null }))
          .catch((cause) => setState({ loading: false, usage: null, error: cause?.message ?? 'read failed' }))
      }, [])
      React.useEffect(() => { load() }, [load])
      return h(UsageView, {
        usage: state.usage,
        loading: state.loading,
        error: state.error,
        onRefresh: load,
        theme,
      })
    }

    /**
     * The tab drawings, per theme and per view id. No icon library ships here:
     * each entry is a list of SVG path data, so both bars share one table and a
     * theme adds a set instead of a second component. `default` is a geometric
     * set of strokes; `manga` redraws the same ids around Konoha motifs, heavier
     * so the strokes still read at 16 px.
     */
    const TAB_ICONS = {
      default: {
        dashboard: [
          'M2.6 2.6h4.4v4.4H2.6z', 'M9 2.6h4.4v4.4H9z',
          'M2.6 9h4.4v4.4H2.6z', 'M9 9h4.4v4.4H9z',
        ],
        missions: [
          'M3 4.2h1.6', 'M6.2 4.2H13', 'M3 8h1.6', 'M6.2 8H13', 'M3 11.8h1.6', 'M6.2 11.8H13',
        ],
        done: [
          'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 1 0 8 2.4z',
          'M5.5 8.1l1.8 1.8 3.3-3.6',
        ],
        repositories: [
          'M8 3.1C6.6 2.3 4.8 2.1 2.9 2.5v9.7c1.9-.4 3.7-.2 5.1.6 1.4-.8 3.2-1 5.1-.6V2.5C11.2 2.1 9.4 2.3 8 3.1z',
          'M8 3.1v10.2',
        ],
        settings: [
          'M8 5.9a2.1 2.1 0 1 0 0 4.2a2.1 2.1 0 1 0 0-4.2z',
          'M8 1.9v1.5', 'M8 12.6v1.5', 'M1.9 8h1.5', 'M12.6 8h1.5',
          'M3.7 3.7l1.1 1.1', 'M11.2 11.2l1.1 1.1', 'M12.3 3.7l-1.1 1.1', 'M4.8 11.2l-1.1 1.1',
        ],
        usage: ['M2.4 13.2h11.2', 'M3.6 13V9.4', 'M6.6 13V6.2', 'M9.6 13V8', 'M12.6 13V4.2'],
        workflows: [
          'M3.4 8h2.4', 'M10.2 8h2.4',
          'M5.8 5.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8z',
          'M10.2 5.6a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8z',
        ],
        playbook: [
          'M8 4.1C7.3 3.4 6.2 3 5 3H2.6v9.4H5c1.2 0 2.3.4 3 1.1',
          'M8 4.1c.7-.7 1.8-1.1 3-1.1h2.4v9.4H11c-1.2 0-2.3.4-3 1.1',
          'M8 4.1v9.4',
        ],
      },
      manga: {
        dashboard: [
          'M8 1.2 9.9 6.1 14.8 8 9.9 9.9 8 14.8 6.1 9.9 1.2 8 6.1 6.1Z',
          'M8 6.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z',
        ],
        missions: [
          'M4.6 2.6h6.8', 'M4.6 13.4h6.8', 'M3.2 4.6h9.6v6.8H3.2z',
          'M5.4 7.4h5.2', 'M5.4 9.2h3.2',
        ],
        done: [
          'M8 2.1a5.9 5.9 0 1 0 0 11.8A5.9 5.9 0 1 0 8 2.1z',
          'M4.9 7.7l2 2.1 4.2-4.5',
        ],
        repositories: [
          'M2.6 3.9h10.8', 'M2.6 12.1h10.8', 'M4.1 3.9v8.2', 'M11.9 3.9v8.2',
          'M6.3 6.2h3.4', 'M6.3 9.8h3.4',
        ],
        settings: [
          'M8 2.3a5.7 5.7 0 1 0 0 11.4A5.7 5.7 0 1 0 8 2.3z',
          'M8 4.7v6.6', 'M4.7 8h6.6',
        ],
        usage: [
          'M1.7 8s2.5-3.9 6.3-3.9S14.3 8 14.3 8s-2.5 3.9-6.3 3.9S1.7 8 1.7 8z',
          'M8 6.1a1.9 1.9 0 1 0 0 3.8a1.9 1.9 0 1 0 0-3.8z',
        ],
        workflows: ['M4.2 12.2V6.6a2.6 2.6 0 0 1 2.6-2.6h4.8', 'M11.6 4l-2.1-1.9', 'M11.6 4l-2.1 1.9'],
        playbook: [
          'M2.9 4.2 8 2.7l5.1 1.5v7.2L8 13l-5.1-1.6z',
          'M8 2.7v10.3', 'M4.6 6.4l1.7.5', 'M11.4 6.4l-1.7.5',
        ],
      },
    }

    /**
     * One view's drawing at 16 px, decorative: the label is the button's name.
     * `theme` comes from the panel's state, never from the document, so a theme
     * switch redraws the icon without remounting the bar. An unknown id falls
     * back to the theme's own set, then to the resting theme's.
     */
    function TabIcon({ theme, id }) {
      const paths = TAB_ICONS[theme]?.[id] ?? TAB_ICONS.default[id] ?? []
      return h('svg', {
        className: `missions-tab-icon missions-tab-icon-${id}`,
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: theme === 'manga' ? 1.7 : 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    /**
     * Settings: a vertical list of the views that read nothing tracked, then
     * the section itself. `view` is the section the parent keeps, not a state
     * here: the two bars share one session value, and a remount must reopen the
     * same section. The section's view arrives as `children`, so the panel
     * stays the one that decides which view is mounted.
     */
    function SettingsView({ theme, view, onChange, children }) {
      const active = SETTINGS_VIEWS.find((entry) => entry.id === view) ?? SETTINGS_VIEWS[0]
      return h('div', { className: 'missions-settings' },
        h('div', {
          className: 'missions-settings-nav',
          role: 'tablist',
          'aria-orientation': 'vertical',
          'aria-label': 'Settings views',
        },
          SETTINGS_VIEWS.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            role: 'tab',
            className: 'missions-settings-tab',
            'aria-selected': active.id === entry.id ? 'true' : 'false',
            'aria-controls': `missions-settings-panel-${entry.id}`,
            id: `missions-settings-tab-${entry.id}`,
            onClick: () => onChange(entry.id),
          },
            h(TabIcon, { key: 'icon', theme, id: entry.id }),
            entry.label,
          )),
        ),
        h('section', {
          key: active.id,
          className: 'missions-settings-panel',
          role: 'tabpanel',
          id: `missions-settings-panel-${active.id}`,
          'aria-labelledby': `missions-settings-tab-${active.id}`,
          'data-section': active.id,
        },
          children,
        ),
      )
    }

    function MissionsPanel({ services }) {
      // The bar comes back from the session: the panel is remounted on every
      // view switch, and a reload must not lose the search or the filters.
      // Nothing outlives the app: session storage dies with the window.
      const [restored] = React.useState(() => filterBarState(readFilterSnapshot(filterStorage())))
      const [view, setView] = React.useState({ loading: true, count: null, missions: [], errors: [], workspaceId: null, workspaceRoot: null })
      // The open view is remembered the same way, and opens on the dashboard:
      // the panel lands on what waits, not on the list. `usage` and `workflows`
      // were tabs of their own: a session stored on one of them reopens that
      // Settings section instead of falling back to the dashboard. One read for
      // both parts of the view: the tab, and the section under Settings.
      const initialView = React.useRef(null)
      if (initialView.current === null) initialView.current = readStoredView(filterStorage(), TAB_IDS, SETTINGS_IDS)
      const [tab, setTab] = React.useState(() => initialView.current.tab)
      const [query, setQuery] = React.useState(restored.query)
      const [filters, setFilters] = React.useState(restored.filters)
      const [selected, setSelected] = React.useState(null)
      const [theme, setTheme] = React.useState(readTheme)
      // The repository whose drawer is open, and only while the repositories
      // tab is the open one: the tab switch below clears it.
      const [repository, setRepository] = React.useState(null)
      // Done is a view of its own: its own bar, its own rows, its own failures,
      // and the count its badge carries. These states come after the open
      // list's so the order above — and the session each state restores — does
      // not move.
      const [doneRestored] = React.useState(() => filterBarState(readFilterSnapshot(filterStorage(), DONE_FILTERS_KEY, { allowDone: true }), { allowDone: true }))
      const [doneView, setDoneView] = React.useState({ loading: true, missions: [], errors: [], workspaceId: null, workspaceRoot: null, count: null })
      const [doneQuery, setDoneQuery] = React.useState(doneRestored.query)
      // The status of Done is not a choice: the view is closed work, and its bar
      // fixes the value instead of offering the other states.
      const [doneFilters, setDoneFilters] = React.useState({ ...doneRestored.filters, state: ['done'] })
      // How many repositories the root holds, for the tab badge: null until the
      // first read, so the tab shows no number it cannot prove.
      const [repositoryCount, setRepositoryCount] = React.useState(null)
      // The section open under Settings, restored from the same session value:
      // the stored id is the section while Settings is open. Last in the order
      // so the states above keep the session slot `missions.tab` restores.
      const [settingsView, setSettingsView] = React.useState(() => initialView.current.settingsView)
      // The dashboard's digest of the root: its own read, kept apart from the
      // Repositories tab's scan. The tab pays a live scan when it opens; the
      // digest reads the host's five-minute memory instead, so it is the only
      // read a minute of ticks can afford.
      const [summaryView, setSummaryView] = React.useState({ loading: true, data: null, error: null })
      // The outline's checklist index: one read per opening of the Missions or
      // Done tab, keyed by mission. Last in the order, so the states above keep
      // the session slot they restore. A failed read leaves `null` — the tree
      // then says the index is not there instead of claiming an empty checklist.
      const [checklistIndex, setChecklistIndex] = React.useState(null)

      // The creation drawer, beside the fiche and never with it: the tab opens
      // one or the other, and a tab switch closes what it cannot own.
      const [creating, setCreating] = React.useState(false)

      // The panel's one tooltip. `data-tip` names the gesture on the element
      // that receives the pointer or the focus — the button itself, or its
      // wrapper when the button can be disabled. The layer lives at the root,
      // so no drawer's scroll and no list's scroll can clip it.
      const [tip, setTip] = React.useState(null)
      const tipAnchor = React.useRef(null)
      const tipWait = React.useRef(null)
      const panelBox = React.useRef(null)
      const tipBox = React.useRef(null)

      const dropTip = React.useCallback(() => {
        if (tipWait.current !== null) {
          clearTimeout(tipWait.current)
          tipWait.current = null
        }
        tipAnchor.current = null
        setTip(null)
      }, [])

      // The trigger of an event: the nearest element carrying a name. A
      // wrapper carries it for a button that a blocker disables, because a
      // disabled control receives no pointer event at all.
      const tipTriggerOf = (target) => (target && typeof target.closest === 'function' ? target.closest('[data-tip]') : null)

      const openTip = React.useCallback((trigger) => {
        // A hover that waited out its delay, or a focus, can arrive after the
        // gesture left the panel: a detached trigger has no box to place.
        if (trigger === null || trigger.isConnected === false) return
        const box = trigger.getBoundingClientRect()
        tipAnchor.current = trigger
        setTip({
          text: trigger.getAttribute('data-tip') ?? '',
          trigger: { top: box.top, left: box.left, width: box.width, height: box.height },
          placed: false,
        })
      }, [])

      const onTipOver = (event) => {
        const trigger = tipTriggerOf(event.target)
        if (trigger === null) {
          dropTip()
          return
        }
        if (trigger === tipAnchor.current) return
        if (tipWait.current !== null) clearTimeout(tipWait.current)
        tipWait.current = setTimeout(() => {
          tipWait.current = null
          openTip(trigger)
        }, TIP_DELAY)
      }

      // The pointer and the focus leave the same way: the bubble closes at
      // once, unless the focus or the pointer moved inside the trigger.
      const onTipLeave = (event) => {
        const trigger = tipTriggerOf(event.target)
        if (trigger === null) return
        const next = event.relatedTarget
        if (next && typeof trigger.contains === 'function' && trigger.contains(next)) return
        dropTip()
      }

      const onTipFocus = (event) => {
        const trigger = tipTriggerOf(event.target)
        if (trigger === null) return
        // A click also gives the focus: only a keyboard focus deserves the
        // bubble, the way the native title behaves. The focused node is the
        // button, not the anchor span that carries `data-tip` on a disabled
        // gesture — a span never matches `:focus-visible`.
        const focused = event.target
        if (focused && typeof focused.matches === 'function' && !focused.matches(':focus-visible')) return
        if (tipWait.current !== null) {
          clearTimeout(tipWait.current)
          tipWait.current = null
        }
        openTip(trigger)
      }

      // The pointer leaves the trigger the moment a click fires: the gesture
      // may take the panel elsewhere, or take the trigger away with it, so the
      // bubble closes before the handler runs.
      const onTipDown = () => {
        dropTip()
      }

      // `Escape` closes the bubble without moving the focus: the layer never
      // takes it, so the key arrives on the document.
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') dropTip()
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
        }
      }, [dropTip])

      // A hover waiting out its delay must not open a bubble for a panel that
      // is gone.
      React.useEffect(() => () => {
        if (tipWait.current !== null) clearTimeout(tipWait.current)
      }, [])

      // The layer measures itself once its text is in the DOM: its box depends
      // on the sentence, which the panel cannot know before rendering it.
      React.useEffect(() => {
        if (tip === null || tip.placed) return
        const panel = panelBox.current
        const layer = tipBox.current
        if (panel === null || layer === null) return
        const placed = placeTooltip(tip.trigger, panel.getBoundingClientRect(), layer.getBoundingClientRect(), TIP_GAP)
        setTip({ text: tip.text, trigger: tip.trigger, placed: true, ...placed })
      }, [tip])

      // The view's declared perimeter: a tab carries its own source, Settings
      // reads whatever its open section reads — so the banner and the tick
      // never lie about what the panel touches under Settings.
      const settingsSection = SETTINGS_VIEWS.find((entry) => entry.id === settingsView) ?? SETTINGS_VIEWS[0]
      const tabSource = tab === 'settings' ? settingsSection.source : TABS.find((entry) => entry.id === tab)?.source ?? 'tracker'
      const trackerTab = tabSource === 'tracker'

      // One write per change, the clear included: an empty bar drops its key.
      React.useEffect(() => {
        writeFilterSnapshot(filterStorage(), { query, filters })
      }, [query, filters])

      // Done keeps its own key, and its snapshot accepts the fixed status.
      React.useEffect(() => {
        writeFilterSnapshot(filterStorage(), { query: doneQuery, filters: doneFilters }, DONE_FILTERS_KEY, { allowDone: true })
      }, [doneQuery, doneFilters])

      // The session keeps the view: the tab, and the section standing in for
      // Settings. The resting dashboard still drops the key.
      React.useEffect(() => {
        writeStoredView(filterStorage(), { tab, settingsView }, TAB_IDS, SETTINGS_IDS)
      }, [tab, settingsView])

      // The panel is remounted on every view switch: forcing a fresh read at
      // mount would pay the whole tracker round-trip on every return to
      // Missions. The server cache (60 s) is read instead; only the explicit
      // Refresh button and the 60 s tick ask for a fresh read.
      //
      // Each read takes a generation: a list answer that left before a newer
      // read cannot overwrite the newer view when it lands late (a slow mount
      // read coming back after a creation, for instance).
      const readGeneration = React.useRef(0)
      const load = React.useCallback(({ silent = false, refresh = false } = {}) => {
        if (!silent) setView((previous) => ({ ...previous, loading: true }))
        readGeneration.current += 1
        const generation = readGeneration.current
        const url = refresh ? `${LIST_URL}?refresh=1` : LIST_URL
        return fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            // A stale answer says nothing about the current list: the newer
            // read owns the view, and the created row stays with it.
            if (generation !== readGeneration.current) return data?.missions ?? []
            if (data?.error) throw new Error(data.error)
            const missions = data?.missions ?? []
            const errors = data?.errors ?? []
            setView((previous) => ({
              loading: false,
              count: errors.length === 0
                ? missions.filter((mission) => mission.state !== 'done').length
                : previous.count,
              missions,
              errors,
              workspaceId: data?.workspaceId ?? null,
              workspaceRoot: data?.workspaceRoot ?? null,
            }))
            return missions
          })
          .catch((error) => {
            if (generation !== readGeneration.current) return []
            // A silent refresh that fails must not empty the list.
            setView((previous) => ({
              loading: false,
              count: previous.count,
              workspaceId: previous.workspaceId,
              workspaceRoot: previous.workspaceRoot,
              missions: silent ? previous.missions : [],
              errors: [{ project: 'panel', message: error?.message ?? 'read failed' }],
            }))
          })
      }, [])

      // A created mission is proved by name, not by assumption: the drawer
      // closes, the open list is read with `refresh=1`, and the row the tracker
      // named opens. If the refreshed page does not carry it, no drawer opens.
      const onCreated = (created) => {
        setCreating(false)
        setSelected(null)
        return load({ refresh: true }).then((missions) => {
          const found = (missions ?? []).find((mission) => mission.key === created?.key)
          if (found) setSelected(found)
        })
      }

      // The closed read has its own perimeter and its own cache: `?done=1` asks
      // the server for the declared closed missions, and refresh keeps that
      // perimeter too instead of mixing it with the open list. A read that came
      // back whole proves the badge's number on the same perimeter; a partial
      // or failed one leaves the count where it was.
      const loadDone = React.useCallback(({ silent = false, refresh = false } = {}) => {
        if (!silent) setDoneView((previous) => ({ ...previous, loading: true }))
        const url = `${LIST_URL}?done=1${refresh ? '&refresh=1' : ''}`
        return fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data?.error) throw new Error(data.error)
            const missions = data?.missions ?? []
            const errors = data?.errors ?? []
            setDoneView((previous) => ({
              loading: false,
              missions,
              errors,
              workspaceId: data?.workspaceId ?? null,
              workspaceRoot: data?.workspaceRoot ?? null,
              count: errors.length === 0
                ? missions.filter((mission) => mission.state === 'done').length
                : previous.count,
            }))
          })
          .catch((error) => {
            setDoneView((previous) => ({
              loading: false,
              workspaceId: previous.workspaceId,
              workspaceRoot: previous.workspaceRoot,
              missions: silent ? previous.missions : [],
              errors: [{ project: 'panel', message: error?.message ?? 'read failed' }],
              count: previous.count,
            }))
          })
      }, [])

      // The Done badge's number, read at mount: the tab must answer without
      // being opened. The route asks the Done perimeter and shares the read
      // with the lines — when the panel lands on Done, both effects join one
      // tracker round-trip. Only a whole answer sets it — a failure or a
      // partial read keeps the count already shown, so the tab never blanks or
      // proves a number the panel does not have.
      const loadDoneCount = React.useCallback(() => {
        return fetch(DONE_COUNT_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (Array.isArray(data?.errors) && data.errors.length > 0) return
            const count = Number(data?.count)
            if (Number.isInteger(count) && count >= 0) {
              setDoneView((previous) => ({ ...previous, count }))
            }
          })
          .catch(() => { /* the badge keeps the count it has */ })
      }, [])

      // The badge's count costs no git process, so the panel reads it at mount
      // even while another tab is open. A failed read keeps the count already
      // shown: the tick retries, and the tab never blanks or reports a zero it
      // cannot prove.
      const loadRepositoryCount = React.useCallback(() => {
        return fetch(REPOSITORIES_COUNT_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            const count = Number(data?.count)
            if (Number.isInteger(count) && count >= 0) setRepositoryCount(count)
          })
          .catch(() => { /* the badge keeps the count it has */ })
      }, [])

      // The dashboard's digest, read through the host's five-minute memory.
      // Opening the tab and its tick both pay this cache, so a minute of ticks
      // costs one scan; only the section's Retry asks for a new one.
      const loadSummary = React.useCallback(({ refresh = false } = {}) => {
        const url = refresh ? `${REPOSITORIES_SUMMARY_URL}?refresh=1` : REPOSITORIES_SUMMARY_URL
        setSummaryView((previous) => ({ ...previous, loading: true }))
        return readRoute(url)
          .then((data) => setSummaryView({ loading: false, data, error: null }))
          // A failed read keeps the rows it already has and names the failure:
          // the section shows both, and never a zero it cannot prove.
          .catch((error) => {
            setSummaryView((previous) => ({
              loading: false,
              data: previous.data,
              error: error?.message ?? 'scan failed',
            }))
          })
      }, [])

      // Both counts are read at mount too: a badge must answer without its tab
      // being opened. The repository count pays no git process, and the Done
      // count shares the closed read with the Done tab: no tracker read is paid
      // twice when the two land together.
      React.useEffect(() => {
        load()
        loadDoneCount()
        loadRepositoryCount()
      }, [load, loadDoneCount, loadRepositoryCount])

      // Opening Done pays the closed read once; the server caches it for 60 s
      // and shares the read still in flight with the badge above. A panel that
      // lands on Done reads its lines at mount as well, but any other tab reads
      // no closed lines at all.
      React.useEffect(() => {
        if (tab !== 'done') return undefined
        loadDone()
        return undefined
      }, [tab, loadDone])

      // The dashboard owns its digest: it reads it when the tab opens, and the
      // tick keeps it fresh. Another tab never pays the read.
      React.useEffect(() => {
        if (tab !== 'dashboard') return undefined
        loadSummary()
        return undefined
      }, [tab, loadSummary])

      // The tick keeps the perimeter of the open view: Done refreshes the
      // closed read, the tracker views refresh the open one — Settings reads
      // neither, so its tick only keeps the badge. The repository count is
      // refreshed whatever the tab, Done included.
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.hidden) return
          // The dashboard pays the cached digest, not the scan it answers from.
          if (tab === 'dashboard') loadSummary()
          else if (tab === 'done') loadDone({ silent: true, refresh: true })
          else if (trackerTab) load({ silent: true, refresh: true })
          loadRepositoryCount()
        }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [load, loadDone, tab, trackerTab, loadRepositoryCount, loadSummary])

      // The outline reads the checklists when the Missions or Done tab opens,
      // not on every keystroke: the host keeps a 30 s cache, and the field
      // matches in memory. Leaving the tab drops the read; coming back asks
      // again.
      React.useEffect(() => {
        if (tab !== 'missions' && tab !== 'done') return undefined
        let live = true
        fetch(CHECKLIST_INDEX_URL, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (!live || !data || Array.isArray(data.errors) && data.errors.length > 0) return
            const index = {}
            for (const mission of data.missions ?? []) index[mission.key] = mission
            setChecklistIndex(index)
          })
          .catch(() => { /* the tree shows no lines until the next opening */ })
        return () => { live = false }
      }, [tab])

      const { count, loading, missions, errors, workspaceId, workspaceRoot } = view
      // Done is a perimeter, not a tab looking at the open list: its rows, its
      // failures and its loading come from its own read. The client keeps the
      // promise too — a stale or mixed payload never shows an open mission here.
      const doneTab = tab === 'done'
      const doneMissions = doneView.missions.filter((mission) => mission.state === 'done')
      const activeMissions = doneTab ? doneMissions : missions
      const activeErrors = doneTab ? doneView.errors : errors
      const activeLoading = doneTab ? doneView.loading : loading
      // One read feeds every open tracker tab: Dashboard and Missions share this
      // list, so they share its failure too. The source is declared above, by
      // the tab or by the Settings section, never copied into a condition.
      const failed = activeErrors.length > 0
      // The header and the Missions badge count open work: a done mission the
      // Done view shows is history, not a mission waiting on anyone.
      const openMissions = missions.filter((mission) => mission.state !== 'done')
      const projectCount = new Set(openMissions.map((mission) => mission.project).filter(Boolean)).size
      // One way into a repository drawer, so the tab's row and the dashboard's
      // digest rows count the same gesture from the same place.
      const openRepository = (repository) => {
        if (!repository) return
        track('repository.open', repository.name)
        setRepository(repository)
      }

      const changeTheme = (value) => {
        track('action.theme', value)
        setTheme(value)
        try { localStorage.setItem(THEME_KEY, value) } catch { /* storage is optional */ }
      }

      // The declaration route already wrote the file; reflect it without a
      // full reload so the drawer and the session gate see the new values.
      const applyDeclaration = (saved) => {
        setView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key
              ? { ...mission, folder: saved.folder, branch: saved.branch, base: saved.base }
              : mission
          )),
        }))
        // The Done view is a second copy of the same rows: a save made from
        // its drawer must not leave its own list stale.
        setDoneView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key
              ? { ...mission, folder: saved.folder, branch: saved.branch, base: saved.base }
              : mission
          )),
        }))
        setSelected((previous) => (
          previous && previous.key === saved.key
            ? { ...previous, folder: saved.folder, branch: saved.branch, base: saved.base }
            : previous
        ))
      }
      // A priority write touches one field only: the declaration (folder,
      // branch, base) stays as the tracker list carried it.
      const applyPriority = (saved) => {
        setView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key ? { ...mission, priority: saved.priority } : mission
          )),
        }))
        setDoneView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key ? { ...mission, priority: saved.priority } : mission
          )),
        }))
        setSelected((previous) => (
          previous && previous.key === saved.key ? { ...previous, priority: saved.priority } : previous
        ))
      }
      // A points write touches one field only, like the priority: the
      // declaration stays as the tracker list carried it.
      const applyPoints = (saved) => {
        setView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key ? { ...mission, points: saved.points } : mission
          )),
        }))
        setDoneView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key ? { ...mission, points: saved.points } : mission
          )),
        }))
        setSelected((previous) => (
          previous && previous.key === saved.key ? { ...previous, points: saved.points } : previous
        ))
      }
      // A pin touches one flag only: the tracker list's copy, the Done copy and
      // the drawer all move together, without a new read.
      const applyPin = (saved) => {
        const pinned = saved.pinned === true
        setView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key ? { ...mission, pinned } : mission
          )),
        }))
        setDoneView((previous) => ({
          ...previous,
          missions: previous.missions.map((mission) => (
            mission.key === saved.key ? { ...mission, pinned } : mission
          )),
        }))
        setSelected((previous) => (
          previous && previous.key === saved.key ? { ...previous, pinned } : previous
        ))
      }
      // Archiving takes the folders out of Done: the rows leave both copies at
      // once, the badge drops them without waiting, a drawer showing one of
      // them closes, and the closed read refreshes without asking the tracker
      // for keys the machine no longer declares. One reducer for the drawer's
      // single entry and the list's batch.
      const applyArchive = (archived) => {
        const batch = Array.isArray(archived)
        const entries = batch ? archived : [archived]
        const keys = new Set(entries.map((entry) => entry?.key).filter(Boolean))
        if (keys.size === 0) {
          return
        }
        const drop = (previous) => ({
          ...previous,
          missions: previous.missions.filter((mission) => !keys.has(mission.key)),
        })
        // The count follows the rows at once, then the fresh read confirms it.
        const dropCount = (previous) => ({
          ...previous,
          count: typeof previous.count === 'number' ? Math.max(0, previous.count - keys.size) : previous.count,
        })
        setView(drop)
        setDoneView((previous) => dropCount(drop(previous)))
        // The drawer's single entry keeps its historical gesture — a plain
        // close — and a batch closes the drawer only when it shows an archived
        // mission: an unrelated selection survives the list's gesture.
        if (batch) {
          setSelected((previous) => (previous && keys.has(previous.key) ? null : previous))
        } else {
          setSelected(null)
        }
        loadDone({ silent: true, refresh: true })
      }
      const hero = theme === 'default' ? null : h('div', { className: 'missions-hero', 'aria-hidden': 'true' },
        h('div', { className: 'missions-hero-frame' },
          h('img', { className: 'missions-hero-photo', src: ART.village, alt: '' }),
        ),
        h('div', { className: 'missions-hero-air' },
          ...Array.from({ length: HERO_MOTES.count }, (_, index) => h('i', {
            key: index,
            style: {
              left: `${HERO_MOTES.left.base + ((index * HERO_MOTES.left.step) % HERO_MOTES.left.span)}%`,
              bottom: `${HERO_MOTES.bottom.base + ((index * HERO_MOTES.bottom.step) % HERO_MOTES.bottom.span)}px`,
              animationDelay: `${(-(((index + 1) * HERO_MOTES.delay.step) % HERO_MOTES.period)).toFixed(HERO_MOTES.delay.decimals)}s`,
            },
          })),
        ),
        h('div', { className: 'missions-hero-bubble' },
          h('b', null, `${openMissions.length} mission${openMissions.length === 1 ? '' : 's'}!`),
          h('span', null, `${projectCount} project${projectCount === 1 ? '' : 's'}`),
        ),
        h('div', { className: 'missions-hero-avatar' },
          h('img', { src: ART.avatar, alt: '' }),
        ),
      )
      // The batch gesture is one request for the rendered keys: the child owns
      // the two-click state, this function pays the read and applies the result.
      // `applyArchive` is the one reducer of the removal, single entry or batch.
      const archiveBatch = async (keys) => {
        track('mission.archive.batch', String(keys.length))
        const response = await fetch(ARCHIVE_BATCH_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ keys }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data?.error ?? `archive failed (${response.status})`)
        const archived = Array.isArray(data.archived) ? data.archived : []
        const refused = Array.isArray(data.refused) ? data.refused : []
        if (archived.length > 0) {
          applyArchive(archived)
        }
        return { archived, refused }
      }
      // The view names the keys the tree shows; this function only owns the
      // request. Null outside Done, so the open list and the dashboard count
      // nothing and render no batch button.
      const archiveAll = doneTab ? { onConfirm: archiveBatch } : null
      // One gesture per change of the bar, whatever the dimension: the tally
      // reads which filters people actually reach for, not how many clicks the
      // menu needed.
      const onFilter = (key, value) => {
        track(`filter.${key}`, Array.isArray(value) ? value.join(',') : value)
        if (doneTab) setDoneFilters((previous) => ({ ...previous, [key]: value, state: ['done'] }))
        else setFilters((previous) => ({ ...previous, [key]: value }))
      }
      const onClear = () => {
        track('filter.clear', doneTab ? 'done' : 'open')
        // Done's status is fixed: clearing keeps the view's perimeter.
        if (doneTab) setDoneFilters({ ...EMPTY_FILTERS, state: ['done'] })
        else setFilters({ ...EMPTY_FILTERS })
      }
      const onQuery = (next) => {
        if (doneTab) setDoneQuery(next)
        else setQuery(next)
      }
      // The search box is counted when it is left, not on every keystroke: one
      // intention, one gesture — and the term itself is the useful detail.
      const onSearchEnd = (value) => {
        const term = String(value ?? '').trim()
        if (term) track('filter.search', term)
      }

      // A widget's link opens the list on the rows the widget showed: its
      // states, its type, its priority — no search, no other filter. The bar is
      // reset rather than completed, so the card's count stays what the card
      // counted; the list itself keeps the blocked missions at their stage.
      const onViewAll = (filters = {}) => {
        track('dashboard.view-all', Object.keys(filters).join(','))
        setSelected(null)
        setQuery('')
        setFilters({ ...EMPTY_FILTERS, ...filters })
        setTab('missions')
        setRepository(null)
      }

      // Opening a mission is one gesture wherever the row lives: the list, the
      // Done list and a dashboard widget all come through here.
      // `from` names the gesture, not the row: the tree's Enter or click opens
      // from a row, and every other caller (a dashboard widget, the Done list)
      // is a row too.
      const openMission = (mission, from = 'row') => {
        track('mission.open', from)
        setSelected(mission)
      }

      // The outline offers two ways into the declaration the drawer already
      // owns: the mission it is looking at, and the key the field types. Both
      // open that drawer — no second form, no second route.
      const outlineActions = [
        { id: 'declare-mission', label: 'Declare a mission', keywords: ['declare', 'branch', 'base'] },
        { id: 'declare-tracker', label: 'Declare from a tracker key', keywords: ['declare', 'tracker', 'key'] },
      ]
      const runOutlineAction = (action, entry) => {
        const typed = String(query ?? '').trim()
        const target = action.id === 'declare-tracker'
          ? activeMissions.find((mission) => mission.key.toLowerCase() === typed.toLowerCase())
            ?? activeMissions.find((mission) => outlineQuery(mission.key) === outlineQuery(typed))
          : entry?.row?.mission ?? entry?.row ?? null
        if (target && target.key) openMission(target, 'row')
      }

      // A view gesture counts the view it opens. Settings counts the section it
      // shows, so the registry keeps naming `tab.usage` and `tab.workflows`;
      // one emission point covers the tabs and the section switches.
      const countTab = (next) => {
        const viewed = next === 'settings' ? settingsView : next
        track(`tab.${viewed}`)
      }

      // A tab switch closes the repository drawer: the drawer belongs to the
      // tab that opened it, and a repository selected there has no meaning on
      // the mission tabs.
      const changeTab = (next) => {
        // Clicking the view already open is not using it: a gesture counts when
        // the view really changes.
        if (next !== tab) countTab(next)
        setTab(next)
        setRepository(null)
        // The creation form belongs to the Missions tab: another tab closes it.
        if (creating) setCreating(false)
      }

      // A section switch stays on the Settings tab: it counts like a tab
      // gesture, and does not touch the repository drawer it cannot own.
      const changeSettingsView = (next) => {
        if (next !== settingsView) countTab(next)
        setSettingsView(next)
      }

      // A tab carries the count its badge names, and says whether the panel is
      // still waiting for it. The three counts are `null` until a whole answer
      // proves them — the tab then draws the theme's refresh drawing in the
      // pill the number will take, never a zero nobody proved.
      const tabBadge = (entry) => {
        if (entry.badge === 'missions') return typeof count === 'number' ? { count } : { loading: true }
        if (entry.badge === 'done') return typeof doneView.count === 'number' ? { count: doneView.count } : { loading: true }
        if (entry.badge === 'repositories') return typeof repositoryCount === 'number' ? { count: repositoryCount } : { loading: true }
        return null
      }

      const tabBar = h('div', { className: 'missions-tabs', role: 'tablist', 'aria-label': 'Missions views' },
        TABS.map((entry) => {
          const badge = tabBadge(entry)
          return h('button', {
            key: entry.id,
            type: 'button',
            role: 'tab',
            className: 'missions-tab',
            'aria-selected': tab === entry.id ? 'true' : 'false',
            'aria-controls': `missions-view-${entry.id}`,
            id: `missions-tab-${entry.id}`,
            onClick: () => changeTab(entry.id),
          },
            h(TabIcon, { key: 'icon', theme, id: entry.id }),
            entry.label,
            badge === null
              ? null
              : badge.loading
                ? h('span', {
                    className: 'missions-tab-count missions-tab-count-loader',
                    title: 'Loading…',
                  }, h(RefreshIcon, { theme }))
                : h('span', { className: 'missions-tab-count' }, String(badge.count)),
          )
        }),
      )

      const missionDrawer = selected === null
        ? null
        : h(MissionDrawer, { key: selected.key, mission: selected, services, workspaceId, workspaceRoot, onClose: () => setSelected(null), onSaved: applyDeclaration, onPrioritySaved: applyPriority, onPointsSaved: applyPoints, onPinSaved: applyPin, onArchived: applyArchive, theme })

      const createDrawer = tab === 'missions' && creating
        ? h(MissionCreateDrawer, { key: 'create', onClose: () => setCreating(false), onCreated })
        : null

      const emptyDrawer = h('aside', { className: 'missions-drawer missions-drawer--empty', 'aria-label': 'Mission details' },
        h('p', { className: 'missions-drawer-hint' }, 'Select a mission to see its details and act on it.'),
      )

      const tabDrawer = tab === 'settings'
        ? emptyDrawer
        : tab === 'repositories'
        ? repository
          ? h(RepositoryDrawer, {
              key: repository.name,
              repository,
              services,
              workspaceId,
              onClose: () => setRepository(null),
              theme,
            })
          : h('aside', { className: 'missions-drawer missions-drawer--empty', 'aria-label': 'Repository details' },
              h('p', { className: 'missions-drawer-hint' }, 'Select a repository to see its remote, its upstream and its last commits.'),
            )
        : tab === 'dashboard'
        ? emptyDrawer
        : tab === 'missions'
        ? createDrawer ?? missionDrawer ?? emptyDrawer
        : missionDrawer ?? emptyDrawer

      return h('div', {
        className: 'missions-panel',
        'data-theme': theme,
        'data-skin': theme === 'default' ? undefined : 'paper',
        ref: panelBox,
        onPointerOver: onTipOver,
        onPointerOut: onTipLeave,
        onPointerDown: onTipDown,
        onFocusIn: onTipFocus,
        onFocusOut: onTipLeave,
      },
        hero,
        h('header', { className: theme === 'default' ? 'missions-head' : 'missions-head missions-head--hero' },
          theme === 'default'
            ? null
            : h('div', { className: 'missions-kicker' },
                h('span', { className: 'missions-kicker-rule' }),
                'Konoha · mission log',
              ),
          h('h1', { className: 'missions-title' }, 'Missions',
            theme === 'default'
              ? null
              : h('span', { className: 'missions-title-mark', 'aria-hidden': 'true' }, '忍'),
          ),
          h('span', { className: 'missions-scope' },
            `assigned to me · ${openMissions.length} open · ${projectCount} project${projectCount === 1 ? '' : 's'}`,
          ),
          h('div', { className: 'missions-actions' },
            h(ThemeSelect, { value: theme, onChange: changeTheme }),
          ),
        ),
        tabBar,

        trackerTab && failed
          ? h('div', { className: 'missions-errors', role: 'alert' },
              activeErrors.map((error, index) => h('div', { className: 'missions-error', key: `${error.project}-${index}` },
                h('b', null, error.project),
                h('span', null, error.message),
              )),
              h('button', {
                type: 'button',
                className: 'missions-retry',
                onClick: () => {
                  track('list.retry', doneTab ? 'done' : 'open')
                  return doneTab ? loadDone({ refresh: true }) : load({ refresh: true })
                },
              }, 'Retry'),
            )
          : null,

        h('div', { className: 'missions-content' },
          h('div', {
            className: 'missions-body',
            role: 'tabpanel',
            id: `missions-view-${tab}`,
            'aria-labelledby': `missions-tab-${tab}`,
          },
            tab === 'settings'
              ? h(SettingsView, { theme, view: settingsView, onChange: changeSettingsView },
                  settingsSection.id === 'usage' ? h(UsageTab, { theme })
                    : settingsSection.id === 'workflows' ? h(WorkflowsView, null)
                    : h(PlaybookView, null),
                  settingsSection.id === 'usage'
                    ? h('div', { className: 'missions-settings-note', role: 'note', 'aria-label': 'Usage details' },
                        h('p', { className: 'missions-settings-note-text' },
                          'Every gesture the panel counted, in a file this machine keeps. A recommendation is a reading of the counts, not an order: the panel never deletes anything.'),
                      )
                    : null)
              : tab === 'repositories'
              ? h(RepositoriesView, {
                  theme,
                  onOpen: openRepository,
                  // The tab's two writes remove a folder: a drawer open on it
                  // has nothing left to describe, so it closes with the worktree.
                  onRemoved: (worktree) => { if (repository && repository.name === worktree.name) setRepository(null) },
                })
              : tab === 'done'
              ? h(MissionsView, {
                  missions: doneMissions, query: doneQuery, onQuery, onSearchEnd, filters: doneFilters, onFilter, onClear,
                  onSelect: openMission, theme, loading: doneView.loading, failed,
                  onRefresh: () => { track('list.refresh', 'done'); return loadDone({ refresh: true }) },
                  emptyText: 'No done mission declared on this machine.',
                  allowDone: true, label: 'Done outline', footLabel: 'done',
                  checklists: checklistIndex, selected,
                  // The batch gesture belongs to Done only: the open list and
                  // the dashboard pass no prop, so they render no button.
                  archiveAll,
                })
              : tab === 'dashboard'
              ? h(DashboardView, {
                  missions,
                  loading,
                  theme,
                  failed,
                  summary: summaryView.data,
                  // Only a read that failed carries an error: a warm refresh
                  // keeps the data the section already shows.
                  summaryError: summaryView.error,
                  onOpen: (mission) => { openMission(mission); setTab('missions') },
                  onOpenAll: () => { setSelected(null); changeTab('missions') },
                  onViewAll,
                  onOpenSection: (next) => changeTab(next),
                  // A row of the digest opens what it names: the repository
                  // drawer for a checkout. The tab follows, so the drawer is
                  // not a ghost.
                  onOpenRepository: (repository) => {
                    changeTab('repositories')
                    openRepository(repository)
                  },
                  onRetrySummary: () => { track('list.retry', 'summary'); return loadSummary({ refresh: true }) },
                })
              : h(MissionsView, {
                  missions, query, onQuery, onSearchEnd, filters, onFilter, onClear,
                  onSelect: openMission, theme, loading, failed,
                  onRefresh: () => { track('list.refresh', 'open'); return load({ refresh: true }) },
                  // Only this tab creates: the button opens the form in the
                  // drawer's place, and the form closes onto the new row.
                  onNew: () => { setSelected(null); setCreating(true) },
                  checklists: checklistIndex,
                  actions: outlineActions,
                  onAction: runOutlineAction,
                  selected,
                }),
          ),
          tabDrawer,
        ),
        // The layer is always mounted, empty and hidden: one node for the
        // panel, so a test can prove there is exactly one, and so the box it
        // must measure already exists when a trigger names a gesture.
        h('div', {
          className: 'missions-tip',
          role: 'tooltip',
          ref: tipBox,
          'data-side': tip === null ? 'top' : tip.side,
          'data-shown': tip === null || !tip.placed ? 'false' : 'true',
          'aria-hidden': tip === null || !tip.placed ? 'true' : undefined,
          style: tip === null || !tip.placed ? undefined : { top: `${tip.top}px`, left: `${tip.left}px` },
        }, tip === null ? '' : tip.text),
      )
    }

    exports.apply = function apply(ctx) {
      appContext = ctx
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-missions'
        style.textContent = CSS + THEME_CSS
        document.head.append(style)
        return () => style.remove()
      }, 'dsh-missions: styles')

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'missions', order: -20, label: 'Missions' },
          MissionsGlyph,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: 'missions', inject: () => ({ services: { getService: (name) => { try { return ctx.get(name) } catch { return null } } } }) },
          MissionsPanel,
        ),
      )
    }

    exports.inject = ['slots']

    return module.exports
  },
})
