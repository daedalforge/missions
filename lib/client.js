/**
 * Missions panel — client half.
 *
 * It only shows what the host half gives it: a normalized list and one error
 * per project. No token, no direct call to a tracker.
 *
 * Two views: a Dashboard that has nothing to show yet, and the mission list as
 * cards grouped by state, with a filter bar on top.
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

    /** The filter bar at rest: no text, no dimension, default order. */
    const EMPTY_FILTERS = { type: null, state: null, epic: null, priority: null, project: null, missing: null }

    /** Session key of the bar, next to `missions.theme` for the theme. */
    const FILTERS_KEY = 'missions.filters'

    /**
     * Session key of the Done bar.
     *
     * Done is a view of its own, not a state of the open list: its bar keeps its
     * own search, filters and order, so opening Done never rewrites the bar the
     * Missions list left behind.
     */
    const DONE_FILTERS_KEY = 'missions.filters.done'

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
    function filterMissions(
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
     * States present in the list, in workflow order; unknown states last.
     *
     * `done` is only offered when the caller asks for it (`allowDone`): the open
     * list keeps it out of its Status filter, and the Done view fixes the value
     * itself instead of deriving it from the rows.
     */
    function stateOptions(missions = [], { allowDone = false } = {}) {
      const present = new Set(
        missions.map((mission) => (STATE_ORDER.includes(mission.state) ? mission.state : 'unknown')),
      )
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
    function filterSnapshot({ query = '', filters = {}, sort = null } = {}, { allowDone = false } = {}) {
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
    function filterBarState(snapshot = {}, { allowDone = false } = {}) {
      const flat = filterSnapshot({ query: snapshot?.query, filters: snapshot, sort: snapshot?.sort }, { allowDone })
      const { query, type, state, epic, priority, project, missing, sort } = flat
      return { query, filters: { type, state, epic, priority, project, missing }, sort }
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
      return filterSnapshot({ query: stored.query, filters: stored, sort: stored.sort }, { allowDone })
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

    /** Sort a copy by priority (high -> low) or story points (low -> high). */
    function sortMissions(missions = [], sort = null) {
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
    function groupByState(missions = []) {
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
    function needsYou(missions = []) {
      return missions
        .filter((mission) => !OFF_THE_QUEUE.includes(mission?.state))
        .sort((a, b) => queueRank(a.state) - queueRank(b.state) || oldestFirst(a, b))
    }

    /** The missions already running, the one that has waited longest first. */
    function inFlight(missions = []) {
      return missions
        .filter((mission) => mission?.state === 'in-progress')
        .sort(oldestFirst)
    }

    /** Bugs assigned to you: unresolved only, the one that has waited longest first. */
    function assignedBugs(missions = []) {
      return missions
        .filter((mission) => mission?.type === 'bug' && mission?.state !== 'done')
        .sort(oldestFirst)
    }

    /** Stories of high priority — urgent or high — every open state, oldest first. */
    function highPriorityStories(missions = []) {
      return missions
        .filter((mission) => mission?.type === 'story' && mission?.state !== 'done' && HIGH_PRIORITIES.includes(mission?.priority))
        .sort(oldestFirst)
    }

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

    /** Newest update first; a missing or unreadable date goes last, ties on the key. */
    function newestFirst(a, b) {
      const left = new Date(a?.updatedAt ?? '').getTime()
      const right = new Date(b?.updatedAt ?? '').getTime()
      const gap = (Number.isFinite(right) ? right : -Infinity) - (Number.isFinite(left) ? left : -Infinity)
      return gap || String(a?.key ?? '').localeCompare(String(b?.key ?? ''))
    }

    /** The closed missions the Done digest shows: three, the last updated ones. */
    const RECENT_CLOSED_ROWS = 3

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

    /**
     * The closed missions, newest update first: the Done digest's rows.
     *
     * The model has no closure date, so `updatedAt` — the tracker's last update —
     * is what orders them, and the card says so. Points travel with the row, and a
     * mission without points is still a row.
     */
    function recentlyClosed(missions = [], { limit = RECENT_CLOSED_ROWS } = {}) {
      return missions
        .filter((mission) => mission?.state === 'done')
        .sort(newestFirst)
        .slice(0, limit)
    }

    /**
     * The closed missions whose declared branch still sits in a worktree.
     *
     * The branch outlived the mission: the folder is still on disk, and only the
     * repository drawer may remove it. A clone does not count — a mission branch
     * checked out in the main checkout is that checkout's business, not a leftover.
     */
    function leftBehind(missions = [], repositories = []) {
      const worktrees = new Map()
      for (const repository of repositories) {
        if (repository?.kind !== 'worktree' || !repository.branch) continue
        if (!worktrees.has(repository.branch)) worktrees.set(repository.branch, repository)
      }
      return missions
        .filter((mission) => mission?.state === 'done' && mission?.branch && worktrees.has(mission.branch))
        .sort(newestFirst)
        .map((mission) => ({
          mission,
          repository: worktrees.get(mission.branch),
          branch: mission.branch,
          reason: 'left-behind',
          label: 'closed',
        }))
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

    /** The scope line of the Done section: the closed rows and the points they carry. */
    function doneScope(missions = []) {
      const closed = missions.filter((mission) => mission?.state === 'done')
      const points = pointsTotal(closed)
      return {
        count: closed.length,
        points: points.total,
        label: `${closed.length} closed · ${points.total} pt${points.total === 1 ? '' : 's'}`,
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
        'Tu ne fais que l’exécution : la branche depuis la base, les commits, la PR vers la base avec `Closes #N`, le journal et la checklist à jour ; à la fin, le ticket passe en in-review et tu t’arrêtes.',
      revue:
        'Tu ne fais que la revue : chaque critère avec sa preuve, le diff, le périmètre, les tests, le journal et la checklist ; à la fin, tu approuves et le ticket passe en ready-for-prod, ou tu le renvoies en in-progress ou to-refine.',
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
     * branch/base line — the feedback session adds the project's clone there.
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
    const FEEDBACK_BRIEF =
      'Tu ne fais que les remontées de la PR : retrouve la PR de la branche avec `gh pr list --head <branche> --state all` (si elle ne rend rien, dis-le et arrête-toi), lis ses revues, ses commentaires et ses fils de discussion en ligne (dont `gh api repos/<owner>/<repo>/pulls/<n>/comments`), trie chaque remontée (corriger / répondre / hors périmètre, sans élargir le périmètre), corrige sur la branche et pousse (`<CLÉ>: <impératif>`), mets le journal et la checklist à jour avec les preuves ; tu ne merges pas la PR, tu n’écris pas sur main, tu ne touches pas aux labels, tu ne fermes pas le ticket et tu t’arrêtes.'

    /**
     * The prompt of the feedback session: the same envelope, the feedback brief,
     * and the project's clone after the branch/base line — a session must not have
     * to guess which checkout carries the PR.
     */
    function feedbackSessionPrompt(mission = {}) {
      const brief = FEEDBACK_BRIEF.replace('<branche>', String(mission.branch ?? ''))
      const repoLine = mission.repo ? `\nDépôt du projet : ${mission.repo}.` : ''
      return sessionEnvelope(mission, brief, repoLine, `${PLAYBOOK_DIR}/${PLAYBOOK_WORKSPACE}`)
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
     * when both are declared, the playbook page of workspace gestures, the journal
     * and checklist to keep up to date, then the free brief.
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
      return `Travaille sur la remise en un seul commit du dépôt ${name} — replie sa branche courante sur sa base.\n\nChemin : ${path}.\nBranche courante : ${branch}.\n\nTrouve d’abord la mission qui déclare cette branche : parcours missions/*/mission.yml et retiens celui dont le champ branch vaut exactement ${branch}. Si aucune mission ne la déclare, dis-le et arrête-toi sans geste git. Sinon, lis son ticket avec le CLI, jamais sa page HTML, puis lis son playbook : playbook/execution.md pour les gestes et playbook/workspace.md pour les treize interdits.\n\nReplie ensuite la branche sur sa base déclarée (le champ base de mission.yml), en capturant la pointe avant tout geste :\n\n- \`git fetch origin\` ;\n- \`git rev-parse HEAD\` : sa sortie est l’ancienne tête, la pointe de la branche avant le reset ; c’est elle que la preuve et le lease attendent ;\n- \`git merge-base origin/<base> HEAD\` : sa sortie est la cible du reset, pas l’ancienne tête ;\n- lis les commits à replier avec \`git log --oneline <cible du reset>..HEAD\` ;\n- \`git reset --soft <cible du reset>\`, puis un seul commit : son titre vient de \`gh pr view --json title --jq .title\` s’il existe une PR, sinon du sujet du dernier commit local ; ne le préfixe par '<clé>: ' que s’il ne l’est pas déjà, puis \`git commit -m '<titre>'\`.\n\nAvant de pousser, prouve que l’arbre ne bouge pas : \`git diff <ancienne tête> HEAD\` doit sortir vide.\n\nPuis :\n\n- \`npm test\` ;\n- \`node tools/build.mjs\`, puis \`git diff --exit-code lib/client.js\` doit sortir vide ;\n- mets à jour le journal de mission, la checklist et le corps de la PR (avec \`Closes #N\`) ;\n- \`git push --force-with-lease=<branche>:<ancienne tête>\` — une seule fois, sur cette branche seulement. Si la tête distante a bougé, si la branche n’est pas réductible ou si elle n’a déjà qu’un seul commit au-dessus de la base, arrête-toi et dis-le sans toucher à l’historique.\n\nGarde-fou : tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s’il te le demande. Tu ne touches ni aux labels, ni au statut du ticket, ni à une autre branche, et tu ne demandes pas de revue.\n\nQuand c’est fait, résume le commit obtenu et arrête-toi.`
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

    /**
     * The left padding of a tree row: one step per declared depth.
     *
     * The step is fixed, not read from the file's own indentation: a layout may
     * be indented by two spaces or by a tab, and the tree reads the same.
     */
    function treeIndent(depth) {
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
    const USAGE_ELEMENTS = Object.freeze([
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
      { id: 'repository.tab.worktrees', label: 'Worktrees section', section: 'Repositories' },
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
    const ART = {
      village: 'data:image/webp;base64,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',
      konoha: 'data:image/webp;base64,UklGRu4SAQBXRUJQVlA4IOISAQDwwgSdASroAzICPm0ulEekIiIsphJdQZANiU3FtjuF361fqyApeltQ3cMZKYyode3XUPz//+Dyqfs//DueHfPydQLH/w//B/qPTW5L8CPnnlr4Z/83f77l/4fOF6u+bf5Vf9r1/fsj2Mv2Y8+n2efvR64/3O/dr3PP/L+63snf8j2SP63/qf//2YvpA/uh6q//w/dn4mP6v/2/3U9sPB7vKf6L/r+H/5T9v/xv8h6P2b/2P/V80f51+jv8Hod/6/9n5l/n39Z6Dv51/Zv+h6ssiRxT8V+8P3V+Xb60/q/71etH++f9zy5/PF/ef+D2Ff0v/5v8x7sP+1+4Pq6/S/9x/8/9h8Df86/vn/Z7MfpT/u0Z+olzcuMcm6+R/+XJNfq8VtQzD+EflnzhppCaxH2YrGTBF+pX5dfiNSzyzyTCjzLs0b7yceuaR1r5y0VI+Y/fbz1hy2B9/h/bAEJAtEhb66ta+NDN09FjDz2YW14T2JuMA9LcdtmPFzmexYKO171P4Je1/xVcUAOd+VlWJR8OpA8l1Gg5KYQSRF2CjZAs8GkQBOHBhy1y+bYMEWdCFOe81fXragiINTES0LVKrCzMblhC5KPDmCKFZmzxg9+HQ1rSc8/vUk3GAcD2+9J52Bnl8pANhIB6FACnE+zsABPaTNlYaNZoeRtl4sIH0VS3WbRCXHHPcoeKC2lx0HdYgc+13vIme7B1pMZgmcvTARUKYlcAG+khYVJ3msnYRaZb9Xg/AX0Jn6hWk16rpB9f+LD6f+48WS9Eix4Y9kzBcDi05/Lx6ofXBvbL6GbJ+s84f3/9rtQHJ1oQg1MFWPMQu4EkYUPIHWEmjLD8unDDm2VwBD1dnSL2Gal9LM80abQUqMah6Vk6UK3PdUpVWYghBa9amdtBFqd3sHiT7hGDdIksWp8AIOMYLSUPI/OvWPkN5Jt/UBALaqhueb3Qm045Jidi7LvO+86NWrCFb/s26SvUku4ZjGBCOgqQb1V0MAmX3pZxO6lGT/oVFE77PErt0Y94tsjA4exsSjwCWvD8GIA50nr7Xl0sX4rx3bI7FCIzXwYM251ypsZ85TRqtWG+TRqDgPuPkHKS2zbQZ+c1C+Rpwm9IG97NmXaLUhEt8Pe+CPnNq5mIdAzOs0pgBmf6TK5Y6T2KZ6hV9KQFSnDC/YKPbzgDP0nucyVgKbNN5jdfrR5SL7F82nFCoTpLixmT+YE5gT8IObqyLMBE6mVQZN+H5xYcDhB6SeywY8eEOzqO5yieN9vBrjwVmDMvnXgoxAoaVPw/jTG0ReAt0UAtFPBrrks951igGrCs7lexSbPGuFyg9m2iJOhkxJ1mmIRhVnqiXG3gA1AvvL0Q7C/C2WGqrpziaUcLzdpDMzEHiKQYhKlnKQM3kaV8YsGNZnN/5042+imOgpUcbjkX2YF0MvHo0IF81/90vKprtb9OQXzwq2VeeYN5cLnu6A0K1kdXO8D7r6haphwGw1wBXLji0JuieYW9TQso56JvKopxrbvksTLpDlt2y6MtTLrkKLN7BDUj6EZzsDM4Djfw4QBM5j0NnD5Ip4ZJ0uL4MCp9uKPvZUSzzG4QiQ+Jv4i4P/fvXUu2pQzHEjHxWc9fdQ8G+5aqqml7vthtHhE7qTokEPequa+Vy6zQ0aPjqIXKQzje1e8ZD2W3k9Wx5ul3TqKqvrNGhytGk3xZRRki09aW8Gesq5NVkqLJgw7TnxB1cWrBizApUfk3rQypVcHgwOx2t/u+iex9LElXf86+0u8pSyOzvz3WULdqQHLBe/WLI9y3tnuyvcWNxwRp6ftK1xk5eZl6XNKSv6SXu2ExtNYJ0NdEqzhgAZKtZtoOF4JUCQksOMuEbh8erjzI0hjYmXyVfmuQvJNElmNuqlFNkLV8B+6K+zrYDqcojOBZZLn5TUgLRPPNWD7177qvdFA4VioL+FD6jDyrvHQ7RR3vFNjXkcAw7Hnt7dxsNmY4NemkZPhspkNS3Sr11qTzPkwCpfM6vYJj9lxJD3wwoPa8M+ep8KcucXB9p/KoMUiz8gCxPBC+5sWJROGt+BDKlvUL2+6SR3m2SDSh8XaXGOgM+gJ2hNf98/yOay1hWNDRVqvdOA0C+AgBzM4V9YRl6vyezaWU2N3C4oFDI6GW7OLjgDo5ls6dWVlO6GW+a/u6f7qOVTsCjla9cFRtsFXxXJXia2gUFKD9r4gqqNCEevUjkG5wlQQE/hgTc8Vn7VIppi3nh9ohv7RwwjEya6stN/vqszIyxVJO/ycXvCFpTOJUK9SbZTivuquP9AVE6+3NIrWorVW38ElenBKxxbBQGczEDaEZqlQag6cLQJ1vswvvorUgy35rrPQb5f+5J+fsjzQf/hWcn9ca8pVzvMCZugcW/YClBBqnsiuZSKCBu4dCF4LphEnXLFmaZo+mdQh4/fUxGlY7rYLQj3DCcYlDe/bCLtsEA8VI+wMIUI1rXW8XcMTZCxcgg+abg07MtgyrxmlvGrfnkGB+EXgoB0ehBwcmqlrrPuVKlgddUBy1dTWLp5WrgMDBYWKGammsUz97fEQeJFJP5tY45eBC/TdqtpxLUPQypJuXUuN1akbPKFE917Kdu1xW9DZpHAHo76NSD19g8Hpk2MXL2DB9YwVU6L5ecN3iJT70UQ958VzSAw/8KoAGwKHmZUkwmtcL8uRwAaJnLnIrrqFozZ0slT0z7P0Gp86ZCqL7YteApz630H/26PDKD1ve4quqvHGWHrf9DYdxuIZFNWCEJZepdEN1CQ2A2lPFK9jksxv0LWD/m85GHQdCtIM9Cve8moUlA6LuURtCrk0AWe0E401jYWZFSKkERONDgwm/bDtTYvLf2W5wWs7qiFRF2TrWNktmBq1cP+ev+ZIzQgAjkZYXwRv9ZjM9HjUUHIgXjvM7PeC9rtnPXnL4uwZDnXybpjaCCds97rkX8F7cjAktCAFcQcDuhBaz9ljRUA61WqE7tvvNDwjEpYGHdRpPAVrCG6H5xCLR4+fVook0drMXvzmqOW2FR/258pSf7N/LGfjQKO5zKHbNxaTVQm6KNYCQbqsmodvRryZjcO+MREuTnFZf5kzP7rujSOm7lI+jqHaMMc0lmeVWxPqlv+ZYndF3AW5Y/pAJirrf984WNVqyOzHxzndr9mPWBczL0c8hVjXsxkl4rws3eGY03PWJ/fcd6IOD2fh2C+Dpx8HR0VwxjwL9Ap3ROZ4u4mvod+b4/4TjehMRM72cuzouP7vrS+e4/3HRqRa2UT92nfWMf45lD+IpfWzCuE3dfQehAHN1Lk4J4RW/TVrXKFuQzJ0DQ+jjW/Ye4reD4jqaaO9bmJhtcBmxklmNwWyV1ABx0Esg+r6TEJOJFCgtCKlpHuPQG56Mf5O3N9/Wseonz62k5r1Lw9ApjHPhKt2R2Gw7rdlyJ0Lq290XFXOsmxHzpXB4DNFr/R7letAkmT0E/UX/TymByqJ91LGYPwiOBTE5DfsTKKpqj3V6HYB/ruiX0JL7V5KXhoEkLchkV4w53jgJTc2l90KkxUHo7TgwZ45nW4xgxEyb1CBucppXfMNJJ1fGLW6ZiAZhJiosEAVfHpbe6zEHhpyDHn2UWAifycbqxEwPFQlGdjkNi7unnTUnqc16vwj3j1rmItFbPs02Da2jNLUzamnQM43ZM+NeWG6A6a1hP72euXK8uA9uf65b8Sr71U/VJ7N9L66VPBK2uO0ACdMrXtbH1EWZ/ArL1DkxO8PR9A5v796LzRAoN0kCjPcHF3+cZjmTs/4pQTjnH42JJLZ4ORPDELmY5+NXa6v+OhPGb6hdL+lfpGDtg8cW8b8GQ5q9/SZVBoDhxwF20l9uxZ/eDAfRmJbGkOLZHCdMi07OND1cn+m7kvq4f/oDP0wEsdYKlYT+01BVvOmPUgp4SLeAQPzEKv84vj2++2ZQoelc63JSwFzjcICrYbrReXP0bvhhTQ/tA4CVWJTpR2+RLTUdD+iquJssl0TWpnEnCp+9LZDv/7seqSqdy0XE7wE6GLwpDQzaQ1H+f1F9ScAypJTRGka1+8vRV2WOLtOiMbw+Pl2XZYkaXpIh5CZy2qN8aWwHJiHVSHg34PcbDlT/fdM9p2OaAnOqAOMShuRbKMOuFec0qvPz92BrZbycx2eLijOSE84FzRJeVa6kfRJ8Wpr8VFbbjyT0wVEwNbABfxrFqSPA/vmwLZZSHD6DtymVK0z3qQrLhiD3LZ8dqwaMgMvjwIJuZtT1DrMqeXlMw4tMwhDTPFfLbpPFNyThzxRWzK+rGRE46e1LElsS7tMaGdljJ/B63EzF5AKSFeL4TSmX5aL/xFJWMluRy6qBkeOQH+pMErKYRBJS/I9vs9ROF0x9bh/U7Jadt0MTum+AjvU7FF57A64IrskKGCFzNu2XS90cT0fRgVYj35TeGyBDcWfKxxXJ3anhG2sOUMRGNaX+Vg1CWBeh+2WqvYxLr0DLxp6+opEhvobH+fw5fFLSNITZRW8dF72US7Kj3riLeZfnt5Qv6r3///WtrgiTa6CfXdUrKI+1EUZUA/43lDVygK57hOkDdpTa+XnHqeruD3LXUsx4T3E2fhDOotuNMz8mwzrBSnGavJjOjrSxZqSuBrekHkiHf88VUV5lx7dnb/UG1/+/1b1UA7EPqm+fV7NJFR/ASyYTJzwhuHcAnQgeo+nkoJsY0jHv/8LdLOQVJkTXw7z/pZfYUq9au90eNUTO2iVn8RWgmtGKhXRODafPk/g0UrEbdu4l+HHapCDz/FU6l+t5V7dHNGKd8FngMUtE3RUX3ZVEe/Lem5T3yw9r1lMBfqwwutSyZ8CeWiDX/GbWxg3X7/3OnBZUL/TFZmPE0WZpWuPyek8CwVxxqCzwp+UVCy5bEiDidYG6DlQ67RB5FiF6cpiKTmjwtyfBK0TZdAvR6xik4T+mJTu77LYDZo/K/3uT6jvSU5J8K5lBvNVCPeoZkaG0jXLzRgZgBKymQB3UBLVAhPtRUi8AOxor9mxtrpNYxzkE3VxjnapUS1bDK+Vlh92XuF5MVW26LObG38bYtc98Ta4rn6oi67G4dY2VYcY5Txe7j0tJcQ06tfnfMQhTSr1zfF8F67C8sHtxm/06wCto8J27Y1vXRcFGWpo8zZZ0zhm3xeSjtwdZiM6pdrZtxkbbdBlFLornSAl9MQySQ/0sjsxus/gVCI2EnynesN2TNF5dTJXrbVnEo3kTUyuQH6ApBwJ1G87SwnVSOuPCVUn4hXTMflaqm7TM/fy6fR9dvsnjC3Aht3OhKd/j5knIkUusW7jwWWzKA3/D5hyKwLJQvtUMRI/W7tZ9vm1eBI/pVHV6mPCVO0wcigSd/b4/f+ABb9+kBNhQB5Gd5OumfR2iuaSPl1wMQa7OuxCjoRNI+rsavDMSPg3O4o34UzuUOdFOJ8EHiEg4X2fuHQz1J2wBXWKYTsuqevWuRYBXiMYOpH3FYfjqbGyVyX+2o+yGJrRwh+plVjzuCNEe1GvUhDfrPsHNkhB3hnMqhbx3IUNhj9cEHnOD1pLYzXJ8YqZyIpHTY8Xb6PuhgikU0LitpMU5Sy2Sb9tt8oPBoVpQpZjcOiYNJr8MRAwUSJ+KWBuE8OFUMGfLthMaYntqbeczUOb4kbyiZSIsuOgp+DJhA0j0LtKAVycaJJ5PbWIM+VwxqSWJ6zg4C34WkYMbhoxkG6LH8NCVbi17ZhDazDTUYERyj++6GCwmcwINEO8zTTN7gdjFX+oSsIbu2aCOf4q3qAD4ONEdJzz9W5RVTVZ1KrFVTf/kAnzGacVJViB92I8drKZNNVl68w7rJAB34kzhftX7kRm3ChxZZ4QqaU7nr//20Iid92gdCOyN45bR3uYM0X/lHoIPIx2k468H0komg5nx7lvYxywze0w5vEsA6JgPI8/HaVV4S8PtojnkwTVQs/PknukoMTe8fSRQoU02WxyNQo6k+3G7ntvIz4u1QJPJQe1oy4Hgo+Tcc9ZPZ4pxApAbnWpDEQRCsErhbKGHBNzfZ2KyBExiEwaAA27WuQCgzGif5DVMRgA5eA+sdnAFdT59fP+LJp4U4u2I6SM5yM2S79j/TW03OAnnxJj+cfmp8xQGHABWQDPfHewCEwylLCwQ5lRm2/HBDVxCfvyzDdfy2aBAOWE9bQSjGyt0ENElXrQLEqFM+dvrAzEuSagVZAX16WEReFSNiWf4mMA/uZTIA/m+u4GOY/awOEPbDaijunY+QblasZ505TPGmxUFz7GVDAsywf+JMWCHdwNyvpQUVeyulDGUCiCF3dp06Y9tX06fK3gul2u3JSpi6VZ6FjlS7c0yDnuYD+VUdEOrwY9LyovefU8frwpq/pS9Mice6+iJl8omOX2MoaY4LJVNAMK+GbaVYmBWi8/692K1FGhQxlGOtaov+HhT0W+GwkxyvXngtSWlOfu/aRTOj5bg6dztwI1+UrBEb4yFsuKMgmXeYloKpM1gS19ucwX/xVxQmuT0c5rxqSjeHBJDyYhQ432TeCu262iNOiwoWP48PkUIGIB+nSDhqk2xrQ61J+dmfEbO/ISQbsJI1wc7V0HG/9iW8BlNEYTMsc9tgItom7rDGm96Weqzoe8MP/tv1k5i+E4q7vo93PSqRq0zRrJct/4NHyPOi4qSEBRF+39O88ms9ULIHY2tlFmwaToXph+S+DvB/co2v/MdwV/v7MQv213GpgPsWHaJhpKw0RhKRCuogFQoLLxk7xodAmryLwz3fhdl+XVlO0oNt6FpRZ9bbESKKnU1fc+pTzJumINnV9+NXuCNcWBsiO9pqpSFfAYl648gMFd+GTDBb6a0A/a/+tuHKuDqBOCV3+nEebOAjkA/ZsTynBrZNUgru4r+d+sONpCVmDSuIDkSusebZWGy4a8Lkn13MsySa4SylqaLjMO8SoF59nO45r30NryLblEI8NxeWFlMnT1XBF4GZYiT33ddY8VHXcAXmWQTEdQitQSnNEuv8ivpW9paxk78Arzfl5vsCu5/qWZ5avD/URoOy+eXZhBY7H9sWpefLsl21EZhhw7prcYj3D+UAnaUUUYyYJiRqFvsKsj7gN279IYz5X0iI4JKzATuMVrB1sEek9WhBc0PrLU8euRhUdSSu8kEP09XKOixiaqxrYMPDbitd6zarT/y1+bUUIok/5ulghioAB2lL6upvQI4HUKqo4NComzelddvGCpt+9lFoE4rFUkTP9VHC+8n2tQ1mGV64/eIU6QfO4ijmSvNLJa0NKO0Bx3H13ABHTioqE/yjO0aBR/CYfuU99oYYRju1niAU5XDD4Ltn/phFwELkxAohi+izZmLn8UHJsSeoWo2InPHkGCB1eqvx31sZ1zJAtoGYnncdALwFhJl3eJa0KsuaaLjEW/Wuel1hFvFfp8lmmjKHPrVWflTeKxObY2qrf27X+3xAK5iGSyRSnHi92xVM432tg58BQo+qScic62SJQfxoxRqoNzIwyA6JD42Hxcmq7rLQH26BpRWC9Fus8AccEZfEePpcIMnu07RAZjabA8x1SGgn6b2X4oTcD34KCtYR6G/RpPN5xrY5qW0oeVjsSEpB2mOUEQqUIDlNPn5PRClJ0zrTjWQwRFf/7ak92CNQec45eVFKzViWLezG241fgm/lKUcS9F4c67AyShHutA/56Y/lP/bWf2vgKZXw5XSwysykM1UpKjzU4JQNrl6j6YOiE62dd5zBft8X7O1j/RffUyZJcBjldo8D8ytZYTjvF7XF3WHjHczz9wmHZOd/iz6bOhignJ3puUumSdQndE6dPHDECcBDjQ1OdzooPsE3HnTbcHdhVXlLsuAiTqQdeF5rvQD2JV85EC8UDuRaFFs6B1ZHpxomtEmRYaCNpz1mLtWNPSd9OTWyoIbQ/CslYDS9MwU8UliO/pWPXJemqZqodj9bsFBVv4LPcBduaUAogRl3TfE09AggnMXJAAdTG+uLZ7Xf+cWcW9aypQWEyYkzMkUXKeGw2djSq+rA5w8gpRfak58W2KB6i7bsPDXC/XCBFLOc3o9kXe/DFjFaOUljbarYKTpookeDgkJZOheZKhnQ/YAfIEscIJYxmWDD5W4vw8SBiOICtWdnq2fPdEif0RsiWClsIjj/rQmAjfXQtwwfp4Ag3HjFCp9O8pn8Gpe9Lj40MofgmTV+T7tdk5nvNKPSxuy53zLLmnannPHaLYCs9uLuHcBp3ApzcZA6nYcYJBGVdTvSTc+MLaTRm1lLC63w1vu6JeCxL6kNhotGvuG/hb51194+JXMkNRdkSAvOFLfquazb9dFqDLZEg32eCb6qryhBSQL6c2CwALhz/WR4AIjWE9XiN5cTkkV3pIrwf6ZTs/6GYwV7CqLYDrEwCqu8WDqDle7Sa4Cc+y0U9OsX0xj11R9GuN1mRN6/13BC6PbGC5Nl8VKHJu8GQNSqJPqqI3g/vkCB3oqSkG6LEjyJN62DJp0gPuwMAk8EqxjkCdaF5XI8USPW7dt4LWvfaAtWlxDBGP/+i3c25IHB41m/hUF4arWmBrTtS4EEnipRpMU9HyWnIQyneS6BnaoRERyXHsg6jcPzPndcWF2bG3YajTjhhpYMwE0lo17ofPP3Gu55ZE/u9oelM3uI4DNug6uabMbzum7mZ7jzgBRDRiE87Rg/lYbV3nHcci9nQTZ1O7IGz2Yrx0h9TsQ4XoASId1MzbaCQF3KB48kcXfuXZtigpNHKrIhEQtk6sduh2hzXLDwGxaDIFZSqChRe2spqi7u93iImJ+zcMH6F5IRqGhcGR5hCV5GUd3nh+ZrJmby9dNXRTSbe6wKyQBI5jHn/6Gwv3yDMtvlhxcIedjJZA7G7lesyoG7HWgK6GInp4qBFFlfY62i6Q0fUvQbGbmzdz2fUSvesijx1a75RhK1GRujju9yzCJDVWdyJV962BRcjmM39bWJsa79xnUI2vrrrJG5ojahUliuIX/h45sM9sVXpxz1XQaR9EXNyjefLgZOArahAQAoOpcfIqzUmAvlV515uhjxmK0EvQOh1ah63DnUq8EKsduOHPJ2vQ4e4vqoTVoYa1GFJllNdR/gEtZNKjKNvKo7miVV7+gI6BMEl9BTsrJqRXcCXKRXu/mDH8MpkMZpFwvHjHGiQrnP9g1Hts43opVjL7GX4x4U23JOMbAClq6NaveODeqwBYiZtH4vyvyTvAPQOXON0a05UxYDXFkEWjlp5B/zosuTf441XJZT+SEkMAg/ZjL7Xb89Hxe8rbcgfbiefuiUHrA0r+/OCn9BdtnxRBkFebY6DGZ5VYzpVX/F0ipLSHSd+UCnXP9sGpDAY+d7wQ+DpGrBD1bVPmHeaRQf4W1iYO/d1i06Ga8yj5Tk4XH0TlQJPrjPZ/r3UjXWeGMDNbhuvv4lz9Tij0y7xZcc1IkV28FS9TODlLvADyZ0bBm9bQRZR/X4moKpa4QHRUCIwMLqX0PF6WZrsWBbWorBRSRwflkvXChtjhcMXQasOODwWOhi6q5OpiPcdU64xOcy28oXzGfB9p2B3bsUzMlvPgF43l0DEcd4Zat7LvXHPQEz2bhl95IMP+vTJQKFUN1vtIB1oVV8Herrq7smbcyKOZ+juhCPu0p5jOpN9TwkxM5EFHe7qX6N1V/2dGsanZ2+6h84+mCv9ogjQgSHZoJ52aUhc+ozm2AUYQA00/nYAe8wN66wzYf5lY7zLEB2nVIXFg12gMMIQyth/x8TWDO5FHn2RzShORV8x7bNpvkAL+YJssp94VwmT+xOtee3Y2OYf0wkBQL9Ty3FHW6d08ccuUlCE0Opp3KOodQM77/4G4BskyCDuL4lhrDBi/6VqIJk3ZuByrMTeJ5TuFhn/tLa6oCG3bv61iyD/rNobLo9eyYCiKP46KTgF+sFj93vcMZtpSWtV0p62AlQomQULM6uCRQMcZYe+At83aG7VRuw/sCQMY2stYRAWo30jihUmimyY+FQ9ozXX9KHL04l1742gYzyf8l9ygMO4DTn6JpZiIp1uKZi/lv1RPQSKOYN4cSzC6fffBAcB0OtQdr++hSiyyUIzP+aQwxzhGFgRAIq5I1Ae0cvJZYz6gOSuySaBawxqAdNX/8tR/Q9EOazAqCz86h56jGCZTyAiPYbh7PCYLKVVmQH6FKmkxltQT+98M9tSIk9PeB+qzvin3bw1lubB74E2ESvomSEvXmCLXTv4if+yvOGi8i1zhqwgfLuM6mLw4RUMnZWtdju4VTCTQFpPmjil8C8f/hX6rVMOWvApm7myD/hLhjvF3czF3J9SkF+T74hL/z+15Jt4eOCkeyYq99PShWyY9Bp8AV8nIdsiOqIYeYlN/ZtJz+vV5SlIXBgH4Kx/ws74wFKS5+FATH/JUrcqU23F0D/kQXW3NRwQQVumRTYNvLd4fRbCYr+xbN14E84xkJNdVzkwjmcaqwY9ZMsFQZbyH3lceOK9bt2dFJjcb5d3Lw09/C7GYQoZm+g8KYBWx1X/A5Se6wLRiCPjFJe18KVENLx9Q/lOy1ZnUGe10FLkLUpZt7gF0Oz4uAuana9qiRs8gtLW5tQ9EYsKAAC6UlNJ1Fn6WWnlVSveFqSYVqxwHvKZWfH1kQsz3Ld5ash3FA80xpU1eHQsj85INRmZaENCRsogPibRaJmIphi0NbO8W7yKZUM1qI8ZMZ9fYBRodQm05qJZFjciZXoWjW6AkVnQkVIsj92OpEvs0NUyjg4E08zpuEcBS0EreZ+8qvOy08xRlCOx94DHffck6MaJg2JmUxjIDZPCPsLYJ+Lx7XCXiGMXMzjBrEMAN85H5XhH/WHjlOq209oQBRbIV3J77fRWuRCeMV7EvwnG0WbXbNscttSVKJdrEwt25f//RTehkUcnUCg0wSy4UYJzVbi3961EOAqvrcQzJhqEPv4YeAqzabo+ffsLOJzQozoX2DPE2w9osY93cZdlkP27T/LRlzLuzuukeIOZ+X5YTkZJJaogVuyOa4VvwwXu5cBnBomymJ3qOshyONnvAw6poM4onSh4W+Jiv+89mwqw+qTAhobU5kUvtMV+i/3L9ewZ9RJZLHzFHNUEEdYNdMRZNT/QSn6R3M0NegqWoJn4omkl/lzcr5mDfxeGMPyrf7Aa4/Gxub7nCu7cU8+5u5Yxwizs+xgNSVe4vDk9iatM83AlNVi5jyXog1oopA3MTLjkKzdDTYZ/q0XLPEr++en0Q2wwepR5jak4TIPmQzunMVPkMdXTNpo2DVuzwV5lXNPAIImdptBAkRX2V7FNwzzGZ7vVO6PCseWEao//nkvhu/+Z206MrFf2Th/VYn8dj9gcgUfYhH6FeFzLpwukcjy68kPZxjbZXnX8XhPi6Er4vYZ7gtMZfz+XybpV7ahjZK2EZ6ROySWIrB0PmucHXNUGbE1hWRzFZ0kYf7PhwUQqzD198u6571+XhaUbqYCuVfLod+r32S3JqvhkmI9xvLakxJdf3NgSA+4lH2DVBgXJIL6OjQJwnkaFjjW1ZFaUh3/WlCilPBiSMsgcoMJKGfxfbfl0mJlpivLm+ORFqOGnqWjeGhew1gxpgsjJ1Kkj36y0BrSKe4tc6eXKRE7yO4w0jmET6oQeiBIXBCmciJIwY3//99D/+Xrrpziet3YPijBft6c4xGlycIDxSP/8ATQNqejqvJkQd4FMK/m4g9KIj2qQpSkYOSOOuWN2J60bC4WcyLd/cInqgimbJu5GDC7yG/4qE0RU4S/8nFzs4FCRFTQJgcMMCAHgWYkuZMvvgUHGtZxBS1fIurzjqt6mks5Xpx1LEFRgUa8oelSWA7FoHs9jg0a7+DLH5s8jW8e5egnz/9PSKdFrQAhIkvG2icfGLwUKZCE7qKCliPWfN0du1qHaA8xR8qy3Tx+IolOd1vK2/lAgA4AJJLHujcFdgr5G8vpzvTYTL5OIl1pRBivEQkYXKo2ZMv7Yo0WZpAQv/9mcIKZlQetu7j9jlBc7aihlKoiWbYFXEoTRtT6dZ0tVaakIPr/JJjJXPFxWWE4CVwWZB86xDo7EfIoId9GEfdUYgLgWEOlpncR0qApuIbCOJikwM/WSE0P9+b3Tr4FeUQDA60g23Szbn5eDQP4Wrhl7WEE+r5/K2zDHxePtApinSoDxs7XrRV8Q8Q+TfTTU3l1BgbTXHZ0eJANJe0yvLe9lsDctQlYPEe+S95UcgNesVRmOQVWUXn6E8uluk9HuHlxTLVYYhICcvQh7rSlruaE3xdBfiYruTMAM930X9vgF2XXyS+CdDhbTNGQEcJpK1cWivQ6N4KGZBWy5brSjUBDqq3P4SjOSyXk04yLMitm8nM/+oBH2MvkWWBz1D0pysc1i5brqEJ4Rf4FDUaxGrfzmXJoeqEWWSRqBkxNP+NvFzUTivcNOVbrHzheaG1QO2GQq2ET8xDqDdltKZ85vW3VW3/S+JTdhxzk9IhHKjGtoi3cN5uEt3ewKKxULMgfODC4kl1+gANAIRHpjT7GCfRa/JNdav+ZcjiH2PykMRz+5kyGsZXe7QkvS2Q4nABpd04aA8UlcLzWDgDbKTr9gU8413P3WLsd4Wunb22GI8fM/89tofck4MmBRPHsqDS+/v9D/GIpf/PChyndjuz6lhdHnQJlWxPeORY0BmMoivr98rQN1LXObFB2rZmc0vqLzcTwNbFoMDzZpmDw5fMw3mAFwnT/PNywRlPU6hal3wEsFFyXWtrAULENoBQKepb2QjGxRp7vAu+pFd+YAApoZ8ppl8bpcNaCK1j9VII4QgSUnPQOf6mh2sE1WCJyyoaV6+uO9JmTF4kFjrSX4SUi3Fnvxi+RpsE2a55tCuVe9LI3UTmEsGn9YJN+5P0U0I6yLwnnpGidqahrk+1AlrD61fTvk+q0+CBmeSsfb+QMlJHseTfOaO6o+HDcYBczzqB3VjEc+iwC2LuSw+gZcE3LzJy8UDMsaUaW6bvvz6dmHFu7+ABR0BsgiRYDn7AzZO0VvBFhv6qsowHT7jjaYz2pdUdvsaEZ3O3CRK/NKcSoqwLHpG/LqFqCe4THrq9DgwGibGtXFyO58aAAP7ASWmnKFmpJ9f/swRHP/WRaX/0NIBOZLS/rRd7tdXBZBGLmR9XXoTYl334Dp38K+Oi5R1Ih884478LGKbCKZ6g3SlM4r76iHO3CabiLbWOrppd2Wu/UGAvMKiJrLCRsmEhrQlozLEk+5oQVFR6zqTu4w8cEdjYXRshTAnukhKBTLfGcRZ2aZNL81FR5/ewv+kbKQObmZvniDK5nlOeuvo7RfbADca5//9ozka/Cl2yeSE/xRT6ejq3vtASRUs0d3mo4WCHMqAVzoI3rHJlPtC2hwUkFiL7ooxJLcb4BG0QedVuOQI5hEqwq7kQfybPR0rgrJrzYEemGznmzFeT1vr4GST3PwVRHz5ZaF3G5Jg0NzUXzj2daxiSqKYNjp1Jf3byMm0RXZ3/rovzj2LCWVXACbCukRwuYzg/2cdnsTkPCKzQz7rQhQVQnb/7KAcqTAUgVTfoyBnWPSrcfgLfJXjxcRhW8tiM0LwiXCaCtslnnMk8gJoaztaL3Xz3+YWcReAMF1InVDKkxGJYfDED8k78Se1OcvV0XAnoi4I7xil0AwIM0t/k9TD319QFVc+994NWTAxNGOEMfKpczQh6M5qgQfKgl9ZnLYPbucfpH2dkR4kEUZQGSDVOaAKM0vu3e2E7fWCDUIf9qAnFLNgPgsItLhGGWpXq/43k+OKXMS7wsy3xy3G9eHU6opGZ1hFXbwas9ffrzr1QIYPEbV2WC48XjISGn2AP1ZVA4zuVuttaBR/NKiy6UTsOtCSxk9FNyRm76bbAgNHwypKcd658PcCsKDMqni3BejCT2U4OhSdLtJgU7vHZbAv0eRuvCQAvPGg9ZeE9u2g/vg0fZNkkEXnZ0hWy0S3L0HOBLtbCHTsdJmeiLLHRh+OGurPUYM+yWg1WNv2EWZEICovBFMHeg2RbQr0DjX1cbX75ZptGzSC3AdAIetSKlAEMD5aPKuOJNUiifacK7TyeZDdlI47RybVehfC/4wS2OyHkFY7ur0WaHSs0kTpAHZUvAzC4bkc9UXY0U91+kk+Qvsz1qZDFNezwNfnHrkEORVZspBErMGUMT2deKZk61m9JGgeGG0GlM8v/Q9CkKxsHtTXhZzv4RVj7EzZWGx1Heo9CzJGNTKPKwuwqJx7ofRj0n0TiPZt4I1l5G2TIHWoYzHBCi/FfGfXCm1x9i24zODKWJiu2garpU4RRufHZ0V0StvKux4bM2bdkIqalL7sDQA8Wt0qpAzHoYwf+TO8NnndSXmXd97Kk6aIO/ms/vshncdT48d7IsWSpPwTwIzcsIgyO8Wcj6jwlsO/dFAuaw9MRCxulWBIbXd0tXJ9fSBYf5WIWXESUB9CWiDveKGuGWXlJgz8ccUzoHeBvWCVZo3T+16M8tBf+CMOm3PM6kS55IagxM6yJS5gI9TQjuMMTmbf/MyOsvDyVfS03R42CuPnXe1EWHWiWGht4Z+jblacXFAPRSyHg8ezmfH6GRNSS1tdAb+jhTRAH+pHyPqG8YyztTWjhqsLYgsLzof9Wt2QKcvqqwEjl9GQhbFPccfUQTE9EnpmabBjkiHuayAeNRAWm2QCEWz+Bck0XMSrR4V17uvNMrSBVFXbxWWx8x5jdYZPoOSbAWH4s7CdBUKrGzMU2wWMimyw+BxnHAfRk0XZcpgHak3CxlrAuxQjRXyuKDTbnAI+6I4NeWpTEZqFx0D/i0qDCClFvLkTaA4IBzUKl5oSt24uZ9hTBelBEqIqcFpyPAmGs+T5FXCq0hPRW5SW0Fxnzcz78AiEk60Q2+6oDgbIKpPQsBsf8ZBP2Wjby7JtUP65e4tZ+8vEYadZU0zJsGJHU4dlu3EcMo9OK5FxWv+8yEbjM2gtNMCjbwUru3UsBXCB1/EtP4b1iSeNFZvBMBN8BkikGEKAJzv9rTCYNNJGkGQCwg/wB6rA26dMUcwclNGYBJxN8U5naGlPS6z7F2/qbScf4YU7g3tgLNZ4OlOZKf0snoWIc5AXE//3LHhl3RA2PBGwIQ4aCrfXF8FCsz9Yvtz6A+WBXmeFOvyjj4O+8ctOth4PMolo5DGhr/8o6rlLnzTEvVTFsWsvdkvI8tz05MQFzvQW9ZPtN7m0fpv7reBiUMk4JBIv26yOhW2heSQDUkA6UemciDsg2Qe8IDzEnI3vrJ0KmH8mmWiCP6NA7E1RhK2CeyKAKuWY2AtRVJ/s0oo/vKZ8NZJs9UpOZmUHpaCsG7ZnylULpgCin6srIoS2cTKtWpxOc47AhaHQ4w+dYO8Fy2CU32wb+z+ro02YHM/oSzasQnjAzPF8c8QGT4CfsMHIGzd9DKguRKhTbtA47iY+4qYgd4yKIw8dkGFIXorH6YbJViZAtLwxGKwIK0v0swiiPmsbriw7IZqg2nKdHaBunb2CXJO4a54XZj15+5ztp0pFgYL5V0VYJXe2BxSwZ1rW03tfa7aw7yVG6nR2qHbLCNCIiAagiSMYG3hpWDtl6lCf2kJUNbre7zjn/WMKMDIDwUCqvrgXkh6xoDgAq00kBpLB+H/K74JHh5juB7SA5ZBNN1kfJ6FLzNsBMANPhXqkdww/cWTI5gKWEWS39M3/ywBvnBaOBfidBgqC/zxTk0SRdSkLise4xO3nAsPPGu8YJmq9gpeE+mOJA1g7FB89z8rPquoDPVnM+9Kh9G4fJOg4qmj7lzN4KoqMS7RTzXM5MMXrhR8HgSAADh9jxfmNyVSuiPitmAMWjhLHJ+tcLNlAjlndEDvihTaPYQFHG8qOHan9Ef838y5Z71IORNxEY/keqNERkzuvHTlq5bs+MG0S2SYxZNofS9omb/L92I8lbGVzSRjJCcu6RDThKKpmXUPMs7vkrzZrCMLNWXIjznn7NyZp7KUZDBAAAEs1DLW17LIB3XMeCrdekF/r9I0CPJ1NaCTpD9JNRlRd4tirCBNIhq3B6lFb50Zxq02CtpRLcC22ehQfbgpY7ACoJRcJC9qqT0iuIXf8KkPZnWwFhMLodqrKivSPCtlQi3RiAgmgXDkLjJpVrRzVBxsapJHJtsfsshcowSCHnnERbPNRS9ZeuDsePSPM5TGyXgwDCOmJVELTA95urmsueV2LyGn5ahcKuFlI6PxtsLfHLLdu5lYhby3sw//eU5WfG6UMU2/qLyLLkoSUWl3jltVGT73huslFpXnNQsUyDbfCBzOgF1YOjGyoRjyN+lrfLljNMis+fEdCH1lBi0xZwh0PfqRIvmMm5J8ERJRXNa98cUnZcCvX4oYNo5ff/eG37CLGKLdsLs4G1w0FHUn+Islp/Ns44vpMj5QvcsKFyfUQbY09/KRhhnvn8//BSVPAyhpyGLdEdSmex15G97QvRoEaL1/5VztxPA/nXhG18wwfxfM5G2Yr9vIHyfFS9Pg412oQ/GRd9FlriS0pxmDPzmdxzrjM0aRcSA1OKnZ/G6uioqJ8SuK6uZBQsHEMNfzWwbOpPxjAzelVWzjkfQzcIy5zCLV+bP/nD8j6P/vpPWW3YeW38kclTvByRvWdmm198DX98xHkyh7xs1g3AGfAQ63bqVb1DMzhxVFPL7dCPHBcO1t3R+65r+JXeIzlLsTysDJjUGu9eD5kfJloLRWPj7VWifPbRqPkxUwxaHlf8R5P3o/i4POr+3xRatlHnj7oDjN+/9f+RTBffQnssuCg+n/kzv5sTxTJG+5Su/WhHD0c28uevXNnNP7hOjcYanxQ07O2qj1rX/DgUYmLpcnEyCd8cv2jYH9WaYRY5f/TlYO7aWsGlxC13JkizKn5ajcGmfR3dsnHpYanDQjutxX3UES68YE/00lxiNc79B6/AF5HW6P9crhFioDa/p/glO8fXu2WsZxy23rATSNLVJ9EN5THzY12ewZrWPzZfJKHl/4JjqFRIdNQIhmRIcU5MaVjMc1zrP6gtRqqVpXchnPZgRo64ic+PTunGeiniJ1CgloUxSK9/qQTQtUIeJ/jWwngcWYCU3GHsy48JdBIaVcT0W2S3Ls5+xlXqH3zYyExcYMg5mleV+4b2xXeDTO788WAaBBBth5p9177acNoEVwDXCjlz4znRBn9nxLQjMim+4pCsYGGxxxixpHK+iHKz5ElglieHJtSalNq+mNnTXuvFnqMujvlZjhASz3kzX042gGYgg2MFGNoI33kqxKbKPsHJwGXie8h2aEmOr6WBeeFc16dzTses0yeXWMgMIMCmUCmnz5y/rFjAR3kN+NnpkvJMWEYz7/lcP91M2pXrJb+ffM//feglb+bVlxtfwSENZ9svb8qcz2CI1bPgMGwx9qecYHahCxdX6jOewX1H1ZPKCteuE6pAwdhq0deq9aLzs/EI9SvHbCxvc/cN4sUoCs74D9wvA7QA6O1+gYkllqS2pARBu1ZUHd70hPy95dMU+C8k5WyVtY7h9LThCN4v8Mox4j9DPWDiwaVV+Xep0phULA5gzY4OcWy9x/EWBq50tnUMwe+3F4kW1HTxPdTkTUXR3klpT1CipjqhjqJMfcDVF2cfG15yMmem/OR0hp0ZZdqQfF3fbn9iJ6d+HOx8rXsPv+e4hr8xmJLU0iftVcaM7AY9tg8WZYZOtzWhpF3FJNeLepPjkVkkXbfVdKhjTnpW5lyyifp3bVj7Gcm3GwgkR9QRrOaeAUNa2Sd5dS7kdHmrihAU1R644nN8O6CAPz9ok5iMNCVFUAC+ids5PN8ao7gIUCjkjU8yu2fq4rFh3RpZBmVuq9thALWmwBLit6n9OhCf8+d8uECEkEMh61qQJCot2ClAwtnxm5uReriSGH9ss9ERvaxsD0gNOZKHqcri7nbNOvCdkya02Y+mai3wMiGdHODr9ZyGZP04YaPo+mohSLJgoH7NnYpZGDRKpfXwqnNyGHCq8S3iijaYMnhUlTNtUnhnupq7FiyQ01LZ7JuKNxYB/dXF1VoknU3HqSxsk8qRHQmoYUNosX7uvJVwb7ZtUs0DxUDLogeLDO+eQ8e/9jUZJEFaRKR8lYaLmpej8zQAcMQILVeqDJT1cRLqg2pikX22XdyEBA35UAFn/1aFH80bcbu/TN1ywK9zLpFEXn4ZXvz5pkHlSkyosaS7tInhbiM1yGcmdThG2DtCIjaCwq0pBqS3MKod6tzzA9ZOxVidXgm2i0HJLcWQRXMEAwgKdhhNR1SRJ6aJlSvk7HlWVlWfHM6lbOXZLv9NBJzRFcUEy5eYrZDOFTgpRTee83hqQVEWGQdXxAUAA2feD+lp1s3K/0+a72/kSzneo+yNwiUlyJK0oFvWUsVYmMhEYMcXSZxjGn1kPEAZa530EnkpG/g0uy1znfaI9Pc4XqJYUJENH7nACm5xrxsodYBrZMMPEJlJsBnFWnBWXr/uOkyZJzmADB6wwTPj4A/3g3uIRNQVW24g37rX+wxsgmAF2Gqo6SLKKiui09vrUA5VtxNEtq4srjKHDKXHavMtiJAABnItbT6xAWOKu+SCd7kCUTvf9ML+9TYZGP5I8HOMSBsltSdbsD2JVZokN42yaFvA3ltnHj6kt+H3WQ4tFssEbIbEveHzASxwqnYjzrpMm4EEXprCpO3J1IVnMcESoxetWmGGBU0ekJ6KmT48tBuKJAAfggr+GOQy5jVSU9rUtjWW5TY7TcpIcuaxjDhWoWqlLECDbK/4MUD5l+J0B6q3LuptMwkzKy4PQ2ECbVp2LcN8JRMoygtZPFhxfUuYZ9xA52//3ue3VARpKmWJu8d3TWNnWMq0fy1LztqiyM9uof801KlzziuF6uKt1hxQHO0vkHiZlPxxW2o+9Ne3Q7EJYYkMegu7Khc16kIhwB0A1N8ztwmR6DGI7NgP3JzwiiUGLsQDGJ/iPZCsGCrg5vr8sT5NQP7gwRQh7AWx502wsSI6nsSKoJtfhIU1zT72zsiiP5WWsBO/IeXHzkWi/v4s/ZDzS/c/cJP66lR1QJcy27ImXNhcbN1ahxK7DPZ3DaWRmTNmP3Imz//R0WdJOfqIKwKYDE43Rp7OVzbevnCV5FaX4x4hwk2Lq7xM+i+b8muTIZnhntdpR00BgXwtLMmRFdNiObKdbzpVQIwCoP0bnCf/4te3Ve79mh86nc+TRCrcDdTY18MvRXWJ06jG02/LmV6XOifG4VFuFHMSlZhTsjrymBaOlKA+ICQEmVqCsp3I5VFe7+MNvZgrGBtoMSPj+bK6z70B3KUSVHPaWucnZxiH+UM8vInKRfdaNtSBvygB32yUmQQG6u2UGBqUTvRXyb2Yw5PnkhMshK896Ug7sFVKBXhFGsk9/3CQW2J4hz9RuhH4R2GdXX7XH9kOj+Y0hDhNW3LUbx+ePqO/8w2qIM1Rn82BR+p031X61ynZ7sZ98Yws+XA053I8niD4Rr4atqDw25x6Er+tCcsRqqKO0xjA35D5bmi+W/xZ70UJLnhtJCmoWD82V/UXdTM7xFubzK7r2pD3fR2hxXZIOmkavk3IONx/Vl04g7NqM/1ca8bsLoaa8u93xZ250g8WfkNLA5ECbHJB5fc98ZrNqp1tBAgbWy/EKwGtbnkkak8CXmLDdW1Wo7ik1rt85p23EfmvBgoV3P3+Q/DCMH0V84tjyNpQA4/N9Ib2BzhebjtdUYv5iN/dmB0k7E0yFwAVCJe7/hi0iYjAcaBtZVDeewfhSjZf/hAXRDcEmMVv4TQP6ytTPOJz+sE70f2Qjbwv4LhGGssP51ncDm1Q82/o7sCBeSbuaS6n4Licj6cSlPvmaL6suVNg00m33qM5OPw2+k99GR4YK9hnf2iZk2XzVeR0aG5Ie9e7j1dCcAO45mM+rWLoKybJbneK4of8LA+B9YU8kaNWK12BC7lIP7qP/Rp3fLlcmfdx7brlVUZ5wO6ir57n4C9B/inn6XK6bn/1+1d6RgkMhKFaOkXzSJoAkYnP2JV3XDFJ7r8vVnUnGmme7gTIzaWvQv0ItdHaCStOauteyrqKGE/oMveu1Vd+thJA7S7AhfQDOgG8WxVoI5FP/iw8AZ2r39hqGNddPxNc3O+5AgVfI7crZdRMPsYjrHGdi3+WkHAZwbhVoM9xZ9EWH/ZEGFU+Cfru3E4Y68ctlEZ63IqbwAR88S72r8W4MrzfWnmH53Djg1cJuzJDD6qB1QIej6hjoqHJ7Em9geijK5xuFkhTklH1FqBh9qmDts0FtiHW8JVnPX+60NIecZbnhXo/vTs4Y7EWEilmTjPVBBOv7i6Ilk8TyiHWxtKHbG6+Q7+cBJYtm/Azm2XJ8/8gCjI9ydJUnDr+UMleLMMnjYZl3PSxHp/kQR9nNJ3pazj7PnJhJijFXClJcLI1/E0c0vUbcRrfM8vFpFPMmCt1Mk7eMu2OzkWyJ4IfRVpZnden8CMZUIj1K61V3kN/UpXJSBNSOZviL+lW0vlPi7bERgPCys2cTDkXUzHM3x/gV0PQiYFEW+BH0QSvSgYQ6j77TiCkWi3ZhewM7CKta0nn0GmoBglkNRFvk3lct5SpQcIfEzv2SfrpyYN1mcS7xDhRPklsE0NrYhfjif8QNcCVguLGlcQPJAkZ5gzPmbXPomFamgRY1xzz2xTvnGHMC9xA3voMl5rJWSGCuAi0cpifd1w8DtV7Trjv4Od7Et1eZs3fgSUqgdaJEiHJXZk8BG2KbuHceVdk4HsLM+y9EFj832fRWfpFM1lrnj6KEjoV0JuqwuGX4pIaeWlQLpiREPMu7dWV3fz5+7lROUYJyqtENL8fOxlr44Ujg6KhixkMtJ5dyhqFfMqfAAOz5amLsfQdhViMmLwNuVzea3sGzMW+oDjUZUURxZ9Q0SguZjGvLzF5a5t7ILGKd5+2FJ695du2ermE+tsEH9LBBbQcXFdM3a4poUSCTnvF7qmBGzlXpyPGsR/pvYv1dNdfIoVkrawQ+rnfaPUu9Zwr5ZHxNJ7GMJM0u+N77yZ+lJkUcavxZyEYJXBvbx4CRjFw91SZlC0ebaUufACjS5yCDHoelpmWDTNOOWF7OBw68s1xxkgIj5Paa8L1jrGR3Z9GR0gZq+AC/IP9gJzAW+T/btJhe8HUGKfD8ptNbdzCzG4kR4O60HBpdcoAclnSAiKGxARwCbZWTQ6VbIS2F56srzPUEhHjXSz37dVEXSwmD0dqmOUmIJ0wuHCKS0YnXXczYce45cI5iMS4kqt83qq8xrr7v+TVqUZuZpTWaTrHDluANf69+JxeHZaDTxGfxz5Yny9br2eawvMOm7m38cPKyx5/LMaXq+yb3uvZBpY99+TtJrpQDrnZL+Pgh9NUMWV7QL8pvJv2ObSgM0AI4ZniyZ2J5WICe54r8dE/NhGOAFYbRQPrkC8Na9nB/m02r+1UdcWMA5X93VnbZaov2OvHYwYc6gXGAcG6rVfbDtCRaKGzS2QljygJRBGG6ahSAqitRk/IKgDBpeSdy42jMrP9bbv+jiWqpUV7a+fMll6vZuspGWk5NKci0ZCktkE1zfZD7192DJxjlf2JD2s4eZi20Xx1Gtasgc79exJgGnhYID3xbdm3CJU8+6V6/g9RV9eYeR/eipsBldUWXp2jTxatpzp33Pd2/m9qVOD1oeYyhih+C929MV0QjKk1RxSrDC6gh/lz0iyURBZ0CORIdY4nfmS7GBGPsdk5rU67N+IIt3Jvdwy78ndJZ6MCUETDTFnWE5DPQ02fjiZ5+jghh5YmfcCSiweqIP2LsjU2j1VqwNk/aWbqgdSOPsW/SDsskCcJiEIe+6o5+/SHOzVSQyvSvL4ZbSOXkJFY101Z387cEIVBe9aDUstSLwjYQdmskX5mxxjnx8aICIrHVHffqcSsG5vKOexn7/kFOtFs2Wgt2jOyVeWtar/CsMjI8OGAQAarOWRQn+r0dVn/53Vycahexs0WSCEFXzYdkmTE6CvOYYU/Rpv93tsWitHPr0zvDhbwGJzl49E+EtN2u4lqgYvHMUH7yrFf90Tu/ac4Y+eXNml5go7T9NVMtHqeYlKx4osXJcU3E9cSZW4LfZj9w5p1dCTfJtpRr5x066SMg4ZKPcQj9w1H5lHu9U1e/iFE9rM9DKmiJUAkiHaDoMYBGxDhV1o+Ui5wh2bM+33Gz2ZaBRZd91zScK8/2zbtnWuXrOUQHSPvMi5qWfS0zsSmVJQRdSAgbk0+APE/XZQmqBsPd2YQwoOreCu7t3sPqF02ZvmGoNY+b3PaQvdtD6GkGYKH+DTQi87tkazmLO1pBJd942Mh/7gcM9dlfuuNfaEzQD8scZRfYg409YXZKlcP/GmDKF8hZAxB6t42LOYMwuxSydyKI/fwfWwWK6p1g0a5N6dl/qx1OQotMcuyVX46jOkf+08sF+apbY2n7cIdJ2xH1hkcAHi/UeEplMXrmH3XbCamQbS6EJqEJmzT2+oQDeBJADffy3aE9QPE8tfImu+t61pvamX+DNsbOMTDPF5vp6Tr94+laNQ1yglCmPshh/yuwYZ3OJ3jOe4RCvyS35wQGLiPIDT8cur++dpN8C5p1Zn/QtW2sxi+KwfWPWxGrkdmgyGS+vLNXEm5/bB1FvqpqSRz5384HZHsURMnD7xzN2G34n/82demSGdenuLG4Xo+Ylu3ozv5r5VIwbswxIrwStndtQ/2JcKViCmlgCRBoSUI0l4rMlk9clB1LVoryJFbzfJGkZh1k+jRHHkQegG83XqU5yvvqd9qrBzNaJF1fYuSJ2oIPMJt8brZk94HvGu/oU9PrlOp6V2O6H5pBZH0PhfGsrFlku7OYpue9ocWEn8oyUTahH34B+dje3EG/tARVW8/eoSJYgT36OWL6XhEExcQq8itdc1rZYZWbzLiR9r4Et+wUGJIxzbz+FMcd7EWjkgd/+f/zO8iqTGG3KP6CG+VXh8Xk/bFjI/TcOAonRi4kirUyOMPhQxnW+1qCOjDAW52PM3lRnUCujFZT3fLM44YydLSWCvieimi8qj78YgEV50ajZ8a4NBULcy2gM4y7P2Lgw50J7J37h1DaHPvdPrMNrgnVhHunSkhToNCX+hyK5Edcg1pGRnEFHlmRYu641iziD0kfNUgzH5pFMqLyU9DA5LH2Oo1E4kmsJBKpHgU33lpypzbFbpFZ687XUmT3zLx5xM5QBgl0tcl1zazmZic/CXbjwI/k/MHYxy3Ul+FEd4ZTUDVaDBW3pzMfACeWs0bC7VqD5Nq6ZgeXVoKfVF9AuWqM2d8YNb/YEPqP8QSolvA+nO4o8Qs+zFzA22b6JkZ/Vzz7iMa/raLPC8nBwWlWNku5zW0ogV3KW9tSIMmsJBZX75RnMTQ2YOrID9CJmzwst/UbxqMjCwlvGswfxb/VKw8Z34xhgsUjdRsEHFAhOg9ahO0mXEBYp3avp0zn0eUkJX/bhHhHBS7drTzfSVF+IWoGxPvLDmpHZMXY5DukhWCkQbGT+QIUt09lDzb/yPkxQ4WUGuh4vVgSkccFyvlZsEh/+diUXHKQ7rDMUniiBfAHzXfh8KTvSuoeWZyUftsOiJM2gAbHf0J28XTlDmzVLPFfoHaGh++H3IXjRsVIVk8pBKFYkaRS7AAp1hs1d7fZlaDQNHiTI9FqUyjfUXytocpSHC1zAOB97Fx739fsxrc0d6r/9TObSQ3LOBr/VI9xjwXj68Pq6r0VeaoRSTUYoK/YSpviONK6JR+KCJiTiW4lYuAAbDjnjluj8lP9q6q8ACvF7bbHU2coUBLL/HWR4n+f92QCtmxmhGNKAueGhscYOiVvf43tggWmoT0yAuUrNRpB7i0UeOPWSVs2ETH7Qu1EYkmXiTI3AZq7Ahi8vcr4wcQYkDHfspQfYhf9EoFvQkkWHI9F3Bw5iMNxnhgmgw9bcCOWWEy0tpr/IR8YiV05dzJN9kEdJUTTWAyuMhdeY/QIR9tgtqncjpxNd0lD0X1Vf/7PQrn3yZNWQSSBVThLwh0L85bIVgEDsm4lXjADgkelnEBsOSWZZa3u1oirE/G/pwZQrioZsnzNBMKEq5loNwSSM7XPB4HG9fPguet6RsogQurGy6puLd6D1BQhFyHgWuGOkuPZAHKjPvEjERXDDN29VDhaqS9yu+GehSeKdfoX0z8iDcXUm77iqoNhpLecAP1jh/kQzWo9PDpAipMYicYfuXlfW/Au5i5h5eL6mzqH6m18ZJ/SdnC1v+4KISjiYE+IrF58MDmDRY5vPrAeREQGOFYtoUN4Mc70k1M41AxOAhzLv6MG95QjgnsxEDSFjI3H5kjKqiAUWByLAHBYU3QmltT6NVGh1CT/HSpMis6yLxButImKFjTGq4OviYev7Fkc5jmGEAfVVLyi9noy8Ff+ZSL1P9IGRtZfwqlrl6DaiI7DkTiNtRmw1KFccFySRqt/NQOe2Aa4v/OF67SGZKKKLNXcdMZlv+y89qszR0f7g3eTk8umlac6HGwBbbqDDoH4qu9Dg3VHOrjF/EnV4FGuu6VJrkASV7WkIboJcg+I4xxtDZfoSY/BtGRbCLUSWA9MwR7YN+0pA+bvbcWDM6lPaIvtvH2C9jJ7UzrRVrm0r8ndKk/UoJIREwnnvkIbTz17FlU1N2DHpdc+H0Ju7xP+djIFfKhNvvETzizhuxqzr12tup7bOfreJqKVV3L3Eop/e5b+B9SEgR0Tx9NSi4aoJywnpYNPKRr3ufTcEtNJbQfuCj5JXltg5+xPRVdyzrQQ4ArrKlm5v3dKGeaNaa+qLBd2YHAZSGwxekBjbIj7Cf4cRXUDcNY/iK9qPWTSNE/YyDsLJyho5WY0L+Beh/o4RVE5sGG0Bjt+cnb/li/WBKOLjxd0EoqUNPFugUi3cDIVTzPBJ0m04LVlzT8t/FMPDulzvW9GUWv5kXkuDo2PMrWfNXBf+DerO04l1w5fOQlx3hSKbQAXxMRwgQ2MLpzY0GRie4OfACCzd+tPfTnGS5lNiFkf654fL3cV0FhvajSg9f2g81pfHQj1CxEmfR9slOEw1B8ii0QR5YKNKgcaubLc8CIlAoXmjp1VxgubmygI1MsLGUtvd7qX9jjFz+2SkuYkL4D0J0ahpG5dbVHIXWlOUu9AWB2shfQvDxtLF3TDwxPCHLjeLr9ce3uy7jc1a2ABaaOarh49wg2T3E27t/wG6Cqo6FnEbFydz0AzFVskIrrf0WKi4vN4WDhL+raKmoGnZsAvN3wEeqYaFY9Zebr1pTk6LQeZX8GfAjGRdm0boZAjHKwQEWHNW8IHbc00F9mw+b+GTsfZvR2yvHYn79IPU4CKjjnR5/jsXQK4HefijuqONoCBLas00MnW1QopXTmyMKTsr+0q2tjpd7MypsZdaCCYzibVuqhRF/gXQBYlbP5AOLEtK0PbvWzyi+/XlzT50ZrwD0ooZ+LgubZ+Rk6Tet8UHm6eSEkdH6YJ820X5rUFnmbC3M5jgmPORPUyrA80pzUIJn1/jV9a91SD5OR0vm0nsN7+gfigpEGQa6F90PJE9FJerqnbfz2nCCV+edr5m6E6jDrb1VngFcBDUosj8tVWRz/oNfqJM5pFNTfVh+eC7I5lv2dis+F6F9ZXqI2eYGyaUpf+mjzXfTZK5uvm5nEeyt/fU4IrgItrGfC88uVwo2VPrWNlUN0awSQf9LzjsTIpAvyv+ADZwaEsr9ZHW9t8cQHj8eK1HJOrjngftSUpGenuNaiP3nCrzTv/mHTDMQRoh/X22j/t7zZ/PKheuJsAxe9NZ+8BdfKMRierHqIwKeFMmIr+WrvO+c3ygLQ3QLBfjiMclUWHPLuR4VYDmMRY9lGHX5NEJMBDrYGWp94uJfGb8/Th8b2SjrhfNgoenV6zedEwfgofSbEzaEvXJx/BkHc3rN9YurdzVmNNvOIlafqe8jpZt4lGn7RpB+32IE55z/i6pq3/4z4IBygESJdayUwLDiJuCXAoXmCmLRXvU3+pR9PCpMPGpTBodiHGxrwfDScMrVoonVYnyDHYpRCcBgGJdYhGSTDCT8AZTX7RSXXMqlwLjEU1ZJUlEGtiQZ6Lxg0FCoMiotO1oIov94NxT9TJKk1g/r+b30siOok9eZmP8fXkjKeertwBVA4/Jv86Ijht1b8dVPupW496E30yTBbLatHo2mqCeAgZGz+/eKm+GOR9KUpwJVSUV5Cpar62+kUtRilX7ON9h1PEfjyDFbNUdGXmVB1V29rSdo/L/4uGOYOlstdhU8+tRs18C9mx9Y/lTlAlOa0z5jdk+Dy7jl1eP1YYlcvRlc3dud6UDP6iaQqzYC9lsxHPoVayKHviUky280zP49jWpZGpdxx5RmsP77d1zpKRykVNkJebzTr3ZtEWcBtOnI3YD/483K7yVSIPhzF9jyMlXfwpCpMNX13d3ZLHepwpWkQf0TbtK3yjUHbpLE0dwXYMBsMaEa17yB6nJGlSDYjZeCGRNNmfmMQdLH5ufjC1F7qP2LGW6hqjooZWRpC7hXRauSo5bsW82n7HhTCINBAZjS8gwjGQluJTKdAiVTNWe/zNoQ9K34ZLy9MylNf0pen/zE9jZsvIMwkWF3/FHYoAHNoX5n1nGqaiLUYS7bmg7v/CpzS8Wox/TpLJqPwX9fjdrR4i9V5qUN3VqBkdsyj/TmRHCWkLG5Sgup+W3C6s2cOTVCMMBQE4ZI9g6OEkZF61JZGuI83Wbc4didrS2h8/AzjAN7qWhACup4k1Uu3DKTpv3Q2hClWOTqqWdqy78w5gX5svQMuVHuu53XkoggbruPoKW2KmRQuQacsqLNvOgTH3J2CZvDgQ1dDtSAvGKvvnNIN6JvETX3goA1vUzFnrEqjXZjNeEgdb3ySMGgiinytmaZOWe6FI+LlyPQPFfSv7hN094MZe170+a/e8rN09y3ugyHlxMiVba/AkS/Hh9uckbIxGYgZzn/hIi19+3vnr4tIANZSCQoPKJZszlTKgDw7SOV7IWDVXEeFYXdd2NltqL0Y/mQ3dBZw4pAMfDGr1cWefwAi2OVVQccSLc/+Te11lh6P8/cryUdH6BxHND9sv/oiOMlgCs+PmV6siFOYu4GC5OefBjbJL51bUhzNsjW8AkGq6PgEoLnCxiaSCbxn+sXpCweaslPivNpVZPhBxi8/8ekjq2yB4GG8TyjZCb+kIJUWUgJPVUol8MO1uPozA8PYC2xEVn4XVp1cteioN7FqfKvDNiraZj1zwRSSNlSyY3pKKd/t/K05s1lpW1P0J1TclWAY7GXj3tCaThtp3tOYs0JfyI3QesvyvxTRX4nCD3ItS1JXt12krPjAPpoqVfInascWCNNL0DS8xJz+ENMnTx4uxOaHSRqkr0ahMQhtjzZZceF2GewjRarUBHdJNuYa1M4TuV1f4eKSbYwZyQF8E00vGdGhiKnmiKf4LzNFivm7N5cZ30CMiSXT/8TSt3kQOXttCDcHVbfBj0t/gCtgKxuKYt/B4aJ7MaSs+m3CNshxr8DJ4Z1iiouhryODYKrb8u0EuS6JMfXtXhEXEGdAJSG+SifeY10dirqyA47a54Mk7zgIoc54dUvLLlwNu1h1SVRwyq0bRWNfD40xPRR9P1dVVuQYNNK0BGRLJ+Y43i+gqAoByT6NZOaE8bUK9fEyTPL1X3TCAb5oYtePqnCCo8y5WJCjp4ak47A5iqVBQfFvUTpg45qRnt0sj1TviuHOed2rts1hIICLAqWZ0B2uxHnf6+omVhRmCrXW+LhOAgdUxA/DlYXJtQqjfM2Xqkw3R34M8H3sR7RSFc2vEpHQ7LQkwfr7ML2X1qKegyWgjL25IvtPlS67N9PlMf9mA/Rr0vwGK++mjDLjqkOMSBQYKJoy5+ol16+RmMInO2NBVWb9aLUJ5bjm57P1O+/l40c9BeTFEUcVgy7Jr/wwCYI5wGJ1X4JC67P+8YBhMTlH8wiBejtwHQi2yYYx46qmTT8XMgoRMEcfaTqZ+LBzpPEBIhdwMJ0dy2ZOaA2o6oGiMRiMMR6WXBUkMLpbaz6SKj+uPBUoyeSUL73MKqzeBEPlHpGpuve7SrVgE7y+lCFRXkMOVUdUBTRYmRYXfmOIgbk/mfWxmnkpk+o0u3PqHS/HiZ1qLriZwKmv6bNURcTYZ26xT2eh8OdlxVMPmOWoAey3MadIBbuyfb2cqnKSENvXDnN1swIavsApuF4Af8t53UQ4N5axDXvrm53j9wc+LWQM5vUAkntmPGAS1PELBX0I05nqVLk+oe0PGHw7x1eNyR48kcjG4SDCbonRfOhl9+8dwcBzHyEkq5SAvzpPAgES6nVFpj+9/mJIfpt8NvKW8Th7IKl146TEj9d9MUcXX/60tGvFeSGIg+KtdkmpVTtMVux+a2ZWS72nkEnWmXh7w/x640ZhaJP8sLSMAA62hlianotIQDu7IIaj409wZV9466EpdhndONF+kzKJrH5PfrMFeMCjZvRIHZ8EPPKnZ1f8ZJankhXSGrVr48ob7uhm3xnMNxwxlGfWedsD3BAkvwlWQZS3gGZftuKIS5KnvvbBDNrI2W8RBxJTnGJoOjjn5gc9/v4IXRUKLV0lku7mdTNZQ2kPR6GBzAwB8krG+v8VCSPF6QN6lcxPcoplxbE9hKAcfWtJA6emEmnE1JYtm3Zflw1RhsD2UnfKxMTy/zUYvE4cHUVY9Nqm4fVeedifqrF9mC9o2VnO1UM7nF/zqsTyQFF1YiPJpFmcPjIAOQPsn5JYyk/y9wZBzhVe6p9+NapIrh/DKnq9rkwRv1KoT/k3HS3NjDX2bFowOY9P5+t/s9rcVElGuEVjLtUR7qIzZA0O2sFLqXR2jbwroP0kaa/3hsSgGD+LgV4v8odG4EhPr2IUlGWFvFgpPWe7lzo+6uMhrZVqVExZpTWzzmRBYy0fC09dLRlnTrHCimg91ZsF/m536ByDQ8Q8sR7u8pGnmr20K4Zsi43DEuX/J2B+0QwO3W5aM84t2L99gszX9trdIqgJ3GinCY4PRelzOx0y3py5v6GHgDkBGGdlvspvZR8sX1p7/FX8aFshq58/kO2g8gOa+lzneC/C1S70gaxJTzVVr3chWkUPmfhKf7BZ/t04V9CG5bkyQFyynvSoVioUSh4IIcBh+Jjsv6C2xzLLUeTcmzfh/qoHU/otmyA2YmxLr3g1mPO/2+cXzGI5zLCWe54rlweFEg+R2QRbfXAp6Pa1jxp/a7iKzErJiPoxeOVO7SoSBhKyjywJsHjYJaw8vA04tdFuplfs23L5PJLTgLxnJ+O32ZUdz5T/8ymzs1Kklwlk2c22hfbXownOVo2Wr7Pek0GV0RfcUXHKUVCZDxWCYkdqOl0gDvqAlPewhEnd0UUoY3AFIzlKzXZc1cZ8decPqnhgda/yJmohqQZk6G/jYXmTO1oVBv2xx3QAU/8YN5nvlZno+VQKc0n0OG7dr7l9pCkus5OJQGecUNvy40e5PkzDMXZqIgqTGi7k56ZHUOgviDKa5Iz+VWzcBQ9QxG58ToumU7DWeTC3iECovkEOUQtFuclmJJiiOEvuUqcFTt7KAt4xWdOib597aOVNhWH+63Q9ZxXxREQwpy131bK+iqSCVTquOiWHC57ZBWgpcLT/sdEk5Uf0xrEvaprB77vlBZxPZCiiwhX03SFuoJ5OPsjFD6PSmL0paUNaLFJYAhvIWEVbZmmtI0sdSiYPWM6+qPqj7pUiyUHuTH54IZCjIJj+flimccFKdy23wcr1io/OcyHC51tJ223P8SjQ296nuSWxU5BfhGlbu+AfthnzdO/b+AofnsF1VjVTny952xCXGnJdALitFy7Dd9KRjSHXKpL3f4QJruzDItPaxDNXKzPhcYhV1yKGq+E61bVMPHdaLF4i2GPmJ8IeDxhwIMTPVZYW7xfZtZsjcTAUfZ5GTadFdnsyokju7CsmGSGi/mr8PAt1oFnYeDFI7VwymLNsC4ZTYUWNjqmKs3KXYGeU1apMz90KJIsby9+1GGwoIvub/6jDmdDjU7kbVTBac2aOdPB+h3mRiSPh0cZtTCS+y5IQVmKf/TYutS/yhsUXGj83Kef7X+6oT0BhPHYMxNYJYPXPfOsiTO9VvmOVI8D5fyoT8M7oZkcANKWhG+quQbBbjhof0LUyl/JphS9WWqFL3fPpbFmm0ed65DaSex4Txp6VpmmgQSf86a/RGG49BgwgnRlKujf/e7+BWdlfAYYvwHjyTPQoGIPeT+vM/gv2iNJFdQuCNnklDvGdZ4EL/JwfdGd/9V1+G3goSt6LNPxVRqzrDyuI5fuRjw5UzTK9eq24n7cAr47DTr1xOGELIkA11n033Du0+dk+dlDBHGf9k93h/ARU/tiKWbggYgveDQFpLutPz4oTqiGAQnhXQOj5pPLkJVh4VOaiR+75V3tbwh8Q6UyWF+RDL5cJZnzHkwue/5nUhdm0YkNWzBurb/aVRnumIUETzsupX816igJiHSMHXKZI6BrL7Eo9Wb+/J6+ws+DwE74Dv9oQ0efOCWlio0m8rNSNc4ciQmIblg56mAoTdN4+k+tM1o/1L2VYsEQ+3kCjCCksnOsved6pmHaItSJLJkTgZoj8qTfdICBZWEXI7/M2RjFfxvtDd37ub8h0szKvHDduldc0TBtyyF88Clcr2zsDfNRKsHhPR0rEbdqNFzL/GCBh3nZ1jsfTKMM3zCJcIquFQsF9cfSfamKQ0mCwdMNYAZE8AsoEQI0hgBTrBLhCX3rwAoRfIX4O++QPxrjuVQ066BkUsj6iVz1jf1cO2ceok6vpV6vSHb0xG1xp/4Em1qGS5i6MwMJhTqOVY1vt3iw31w7S2ukUaXcYmzVRl6ITqmK8MAwxRrzSthrt9+no55Xre3HGg1Zt2hfUWyzz8B07ZQdgsWwO1soRL5u33K96zLwmTKEY3n2zfaNo/bTS00V8Ha8qXDWlEsRQ+ExVAfBQS634cSOzT9m0gOYDNRlqi+6tVwu7OdCNiq/BDExuR+P9MRWCE3ngIdI4jgrUZln4b6JMLVd10f8u5K9m/w+dI8fR9TK/Lm+PuUu6LjxtyvyAWoVwBRDO0BTvV92pgmw9ro075mGRufNNvmIRzhy4Wf16diq/YxtoSE3VLf/d1nqOlsDXK0u0V9xqc2tUH34oBHC690QIGMr9n/tzSI+0xDfWAp2QHqvq+VOrgtdsU0ox5ll1s40J5DpIolaiM8nliG3sL6h2v8rId5NY0VtHsqgGuIOyQTLx2hBM7l2uFqK8NRBLhlzjcrKy55NZjTv25zDHQ8mcuKwaPb5DIa1RGJoPNZlJ+lrCALK0cQG72wC9bYQgnvkRSpHffX8X2NtTzOLTutfp66eq26zPOXY5ERi7kvqWlco6psGxwTBkdANKmMsAICccHEns0WqLhhr1PBiSh5nSHiDySe3j/6Ir5tAIyNUmYJLERxkNIxuhINr+NVjXO6k51el8BTkBq9naeiUa+AQLRkzxFkMsuS2I25Risp57NeV9UWd+GS5zY+g/NESzQiIf/VmY7C92jFCBJ1w5tovRmHeyKOLf7zsl4POUX11cIm3aF0I0QyIHXSEh95yIZ58VlfqqHmQ4qoOjJQACxziyjGoe2TP5SbU/uabqj8oOD/QUerIzvEiiyn7uu1OoYW//ICMCToKnqWUx+zIC/A+H0yJBkb/C3oiLD9XrOUaWk/u6JRn8tzWNmCZCEGg+dTqkk5livv45vdTIwMFAYo+LZBkucedXfVShvCgmFcKzZ9ydaIGRxbWQraSM/085hOm0CWvr47bpwwfGJ5Qv4ICn87BV22Df4uuhhquTFdOx1TrLzgnIK11fc5qw2f/sb21rtupya6/rq+ztzL/cZQb1PS1l16frSJViH+GweEYqaZx11MWzHETCIrywkSR+tV5ttKpYE1lVu5W/v/CrC6YieBRDbPIKxT010BN84b7FgmDBCW3FYFu/uWTMVIqgoVOZzxh/ZIaAXPwHlmWBu+TIfGDjTR3xyTJoiYHU9f6EB+cs96w6G0Q4KfCjUR0yjb3FK5pvjwEekaQCv2x8ukHvj96XLVNWgZiGI4XICQiFJc+SOVBbdDiBzqoAP5qF3gsUbbdvdJIPXL49zqdV9ob/7O86IMJP1rCRXbrxD3pYzCEgNf54FLdA6wiraihVgJD2EAmjW10Z+kWr+1XABRr92t7DKjZSIgKNkvd3sPgJ5ykspURNiKDeBlebEsUdfZxxWah8dmfoBAfvLz+X2o0lSINDoGG4ZhIxTaii3DRTYGl9SmiHyFF1Y+lKaXiuxK2xL+nuEU6MuRTtCPuWb266ZIkb1/ZJPLK12f6Lssk12F2qnNOxQ85VAa1tfIJWwuInxyRb5rK3RNZUAJ87W3V12E6VSBDSyDpOgPzcKGGyA/ahX6wdOGLYe22pgNE4X6/eUk/LKU0rZCUNuXlv3lqlAxlD67HvY+zeilWYhwVIinUS8plnCN+06Rmx+e6T8OvPLVk/UqRYocL5fuN7LhzHDr7ik45uuPwsYUIo6iDpOVvpES+7sUD8Gk2ZcVST3e22YYeX5Gazf3ARkQumrXS/eb6GQv1vmP3/kmmtc/j9Ov2ZDjL+xbr423aNfNvtlI+vB8ayPii+m9ybSCIAQtlkQ/xk4HSLSP5BILZtABjPgiFGIz2ePQY1rYxTyXjJchAhWFzMggQtgCCWPbnuGSgX56qA25f4UBTOdlRcMFfCLJ4BTIAJPes2Aol2bEPpnRC4TFkBaKLJ0F3cKEvlPOQ1GbV/+Vnqk2PzQmP2pPe5cZMoCPX3uABjWXiRoqVRiVYKZHQBZvg8y9T3R7ALC603GJY2i6P7uLo06kz6LDA58OBgiNJ5mZ1sAXWNOy2TrV92Aa6eTsOQkt9J0rV+r2fd9sukCYp4JAJoGHN4YbQ/uDCbwV6rEk1R4Zzat7o0MyXwNMseQ1uVPz2b/UpfyPdfKS+3PCd5U+50hn2e3oV2tuauQnUJEzrfaSQG4Z74oaCF1gwfVY34buulWnX6HpvpT7eLkcB08bsQcvJarNsGaA0dTwxo/dvbpy1NETrgxNshEfQI4rGF8u6MVTPTZJ6lCymahQwzpw+VJyHLRnOLLsJqmAxsU3DkiTrqor+6KHfica2q0f3I4z4/omcVG4ztRztkIOQwxVXCFsSDU4QgkIJPG7og04CUHI6BlhI5sa+y8MAOhWIBQh4JT2j9AfNUDF9KVqRJ+cFH+EByEVbdptH8RM4oyY24IFO3EM6bMMLLXpb1NRIEK7mCmeE4nDXtJcc/1JynuXgTtGE/I1fqv1s55nRlZDIH1v2JgwFljZZN+ziLlB4AWsHX4tHlQBzWj5ZYSdwomaqaHk5rXmoaXBLPLTStmxzRRHeQ79Ij0XN7+rlVVP3TsJGi21uWtvpgDaIvwomVjEhnifnjHWMIu6vrPo1+1eVlvGnbuy/m+VOb26fQapq//Oh9Jr959P6SyQxNBBh+4jzud5rafQBRFq2KUUym9HCxj8aGQooKlG3owOSr82QX+f6HNiLC2QpDntKwsF8Fk6vAuPVZDAx9HowamCd1yUuXUhtZh8KARUQG/dZGG1G+nVBtC2AxMgj0vtqPtpwbv5XySuG5AYxz5JyWmR4Avt7xdCf30CPu96ca/QWuDYx9TvphiGU4S9W5XDsVTvkNEepO57x7Z3145jQWqBWgiOlAxUg4O3M4kkN3V8Kdy80RHCkxCvKvP185OfP8IovNZhSXVdF4bzVwgBMxtPmDPm3LSom+D1YjtBu0cltR125GEcqO3ZjmIFem3hMMpMTVYv1qXDXzE2/r9Y8Jm2k/ktTBtYGOKdeMcenqeMdbqyi5WnpnHe4WENmSBQTUM+jomiy3g6xTm5xlA0ldszJcIZobTTABOmNuJODYz1PCPQXOn50Y6o9kUa4dI/0Obi81QV6WXQZwjbJr75AyurmSM4EQbslze1tInDZ18rY8rf+jVwKiezI3u6/kTzCBxUGwKCifheDEFi/xlj3tuCdLxj+FKtWuL1d8RLktFVG0iU+KnmtV1KB5V7GclLDV67oDlOSUZ4REqlwwLAUGEoq6PaE3tD/r61swU58XC3VlohqigyDXlE6rp29tnTt+PJpph+7WJ1apklrAmqCLWK7gusYXZjkK0bm22fjY9OwUr3ZxM9m77u7FDnM6jRzvzRhOsNCh4wxLSFIPhrX9hUqJisvQKaSdHAu9vMEV4jnvRm4zmzWPE5Z2KQURnbrM5erSvVs++e8ew+u23EVud28LzKdcnxfwHmOSkQHyHgIKWvASvSZoZ47hPhi1GPDBqx3w1ibcEzFyRbaVsrgQ2j5mRnzvHpmt7y87oinFQFE8Rqmpr1Q71AzTjILOc1fxZXBECK7MGdbGNo/rc8FI77VNPX8S1FB3ApiIsDJOuNjrLL4T7vqCaLgYnHbGMwYr2UQ+Xtak5cFsL4EsZ96dDqDjV1bhbckmwUi9VeYFESqC108/6YVn+tWoMQ9M6GUjfFQAuLlZ4hzMCEHCJ0QjdkPulBFlr02MyWAiuaQHwyyoG8/Yj3Luk0Q8K9LMWl+hEews/XoARRJ7nDyluAsWgHQ0QtoFw9yseauSzFuKfD4jJfWlyYeNMTUvo76CPultTMfmQOgfSCKe8lGR399HW3rCqWNcMHnY2S+ZzwEJEuVjtJLbk/pTuAyht0wki44f86GtJTEmH4+pbREGTlUCHhM1zXhov4WBQ/D3jOQZm7esHMYDZItfeMGNtpRFT4KNLQCd8k/gX5aWBewn/IwwBytWixdcjRLNkMuVmmBe8YLFIQhzSdB0WAzIzktx1aeKLGGjV5Vi5DAfwQcqxczrwXF4Q6CY7BICcivZNU7AlxgX86g1o3OTnsk6GV+BmdgMT+WtvrHREqZvk6HwfbOLEBlZiPsvHsUm/nwAZmNVMsrHwvdEEb41GpCy23o/TueyjtIDDZwOF/uj/BVS7EfF8DL+8H/+hNFiD2WZQry5GqKPID8G4iLctKw+tERP7yJDRy2WvfSFuY4q6LufhMc7kjCjEcWKUp+JDGSqH/y0A/NEKgyNaOzWyucrOnMpmL8Q4pHGaVU9MNbA1QdxtXgIsvVcxGkcFjHu2yjDUZ1AufcMZfVTUBdnxJ0APHHNb9YkeLT+GluwVvE1lNj2Z4yjl5Un/2Yh6Frh8ZIAEN0ArrO593jf0mgXhLVuDHS/DA3IuDq/f5dLgbN1rlrfgkvBUXM6uOaU9OfvyIReTrCElXMe3BunkX9w0F/ch/ZlYUsPYqUUXrcTLRWm6qIkHVcftqVIK3+6TU41O0Z3S/Z6GB4WF5rugdI0kmKs10hqm4xFoCLC+ZuzmBJMBrNg5ujw6EAPx4r14aFrQPfEMbg2xyyeICxyEKNIl4huzk5FywR+c9j1Wg9cWu8aEweJgv2KnG9dD9r8BHxCXOQVmbLG2ppX3VhhdCtoB0Jsxe1bBAoBuj5ii29FaC0PozWwbrBQchQ0ZaC/enYlIjJDm6tnJL3n1q9P67YlkToWeuNGI434YwGSGB8iMSi4pRarzs8Lhosn5K/5TjHfg038KBqZPMqLsFpLebiU6Ill1Gbmk7ieEYBxa2dQs5jmcXQG0NfTO6INzHd/nyjphI+L7JrghJueX9GszMWGtfPHVnrmHcFU27KY/iPBwnPtJH4p3wGk30eHhgVw3C3eKnqowcX3YwifoBpCa+yMTPlRn8LGVF+rZmiGBHNALrATtTqav8oBnuGwEFAtTXIMkNpomeyBK0eRSpZJTmKa0vlhY0UbZkYO2/+9+TOVR7KFRxahM9ASiP7O8H6fa7LvSxMO9skgALi/CFscImDLHRmnSLOAnc4iqhBglL4orKjTIFuAo53KI+tPrsfD8b31hW/fXe9bgfN3W/LqtXW4k6vcG8EgDy+/5hSFe4h3GgoTiuJmdTYtBdswR6G0ts/EiDjbf2mSrcKac1k18ARbeODv8YyhQfZ+6t/3JuKrJk/Bsz+URgxMqDLCLrj9HICneheZdSoQBnBM17sYMLtNMCbVagiu/kE/5UfvSekhG5mZssEueUyCFL6VSCvE8Z7K9R8E3uYxnMAoxboP0zeIuh5UhIvvLXjd+XPOJPC07L4L3Ead2PkvA6AW3cQ25t9A7y7COHD9YdOLdJcwzSNpCD2h9cRiaWzxE7V1jFJStUeBzVrFwjM+I8BDorjLlNCUti6oHCMieViDQJd202/qlozqDI8l/GFHRqAqVKfklNUym97VMAQMAflNYuHdqvRRSROV4H97Um2ag+ka8p1Oj/jaqt8roEPGb4T6SybCEUFalQveTOcOhKkVlVoWL5RvGepqCZuGgIkADK+yOHjz8CmgmbO4I0pDc9hfd6OlMEa5PIh2uk5DlgyfoyhOAw83yxmNQE1SEJ/Qk/lnY+R5dG+CkQ+GZ958U4T67pvqztWRzUvYFPaAEuyMiZVn2mzVIWUURpGQpyLJ5UHGV5Dgy4LOXjhzH78ze969LUgrwe8wmfV5kbPxODTTEU069NcjkCLqymVIsj8KkN0/7NQpr2ZtGAfp0mqo3P1j3ARBpcMMzRffJhdILCt7LHw2rgoi72xoFzraOnwnNwD/irwks6amNGCoLSDIhUBLW9jOp1jZGX6pDd4Kkg2xOlXgpH/PEBXEW50dhidMjE53QIb1XRC1tEhWmPR1sjx+isM5+2rAxfo4a06hc9xfWGEy50V+8NKxU+0dgf1JZFIVGz828UYWCc8LBid6JEkeEolb1fHXiww+ErnwW/K4bJDCFX833bo4sLzaUXy5fL83Z8JqaPRdZrsHZ85fV1e5w6CoFToMeA0phzpk73tzjjn3oSEfbHEgp2atMfJjwSz7JkUXxSqGFuoTlq0LpIRRBfvKV9oaCG2LgY+ui8zsBOUkMad79KFC/eTQ50bLB0ZEmcg/i5szG+u2T4CjJb7nb7HwDlJTOp7cZSGQFKzy5gnz2MpjNkai8qVu5mv5yo1/kFHR3mF5fBp0mTc+cWexOCjGmYW7r0G4ozehX53ajWf94xu2OVXuZhlmySekD60o8vAPHgFAWoX/SYNddwo1BQonKdqbTSE+K0ACUcd3jBx05eD+aGlEjYWlGe+1QFQ8vCVOu+QYwxqzdstopazRgu5pQcNwZwxrMktnpPR5hrxEwqIG+oraCz6aX9yXQjSBsgvwD+VPc2xmBIJe4nAmq81t+icv8+OvUtaV2TcKHgl+vX039WXr6mVVjHLAvFvlLU66/Rwnk07Id2h3ufz1PPrjdzhIpyK/ScZie+pfTguGIKeQsCz1LF1USTTVQMjPWiuBUsT7PEoo76EnIraDOn2nx8LYn6OHZymmZQZzz1YmVMV9Tc5EUaHrECRWdsaIG6SOImnrUi6/beFgFQWF3slW3MlnRYgtVCFXQ5Il+s/anDwafpzMI6Tk9q02f8zknyxP2i386irc+U4KipF6Q8+wF0czbBTqO8IJcgQUMhfTHyBGSFpPf1hzvwux2yv5tjUJVmN9Au+QDUboc89u3vkJmJwB/vdEMfEIUk/h/Wr6g+U62ewzGJ7pTnP3RgFljSJdeRLYbJzX5iRuJFSyQyZkqHGoIchKM+66MMcx5gc5bJNz5SQoqFB6IOx/MECrRdCnUDKjtu6U0v/S4COgja1mvBed7TOsE4ls/hGDplm/gXSyOwDC8TBb4WdUBpags9mLLjVzQY38c4UKy11Nuv7A3PIvHLv43oNFzwvMJCoZkJDf6w7fpZwxfBWWacf8fjbwlg0CU8tuOfrM0tcN0OCl3QclbG5VWp2h0m//TMkiYsN8McdKwG+4Mb9mUwb7OSDUdRKOSQIpXxzoLTbIWxMF1++73d24iMC305xDekK078RagDVKvhqWFQ0RDiFV+g7TA2gwuaGQb/RU7S8d5xF39Dpa8SeAkPyGmQG3z5FgjYioak1G7D2e4F1vF6ysnw9oJsWopOATlTsLoeetAvDBSKuOgzTFSXlogRiJY+zrN7divavwKbkz6VdSE+Dsgi5sUD9wIuaYC0aX7mrjeiGlQ4HgcTUe/lf84Jk4F1i71iO4OhtKnVq7+OFWU7kEIiphctmTs4DEFOQUYAwaspMoJhAZJFNiol35ymfN0853FhoNgQcAMMRhQ1OW37zAcjNjm4rPh7IM0CFZvu7tuCnVAG6sz/pZL3PVD0CtS02kAqRxGjLPAfdzRywUOljELYgyV6a5w6PzJ9SXs8yPAN8TPFo7+qR0BbsohWyPFr6pO15aCj+KOPRxNZshxzOOasKPk/k5BEV9Tar6Y4OXF1hIshD8n5ZIzhtFgwDKFKlTbYhFSnTvn752KjrZJGKXDRTxn26IpmHGQjU+CPFUYJWvUwx28qcwKPMpLT6Jk8sEmzk+oLBtnIOQ3ljgMtj+j6dmpbmPJQR8R45ziOi/WZFvB5LmnetNyPOb8Uo3mETHvK2lsbWRaC3EEAg1iFbV4qkBTvhTyllzyyKam5kzG0iz/MztpPZ1Lp3YTIcMOMfGAT/69H0fBDpEQSq2+Cxz83f/y876BrIu9OdK0bVwkCP0h+DcuYxxus1We/b8Nntpph+YwvXDKw05LV4D4CR37OUXIIs2c9/xtfvgJBRI5yTp69a0M+HsCqAgC8c6YQRnk9v9GaIzm3Vnsn+stcBxgSlX4KcoaZpv236WOT77wxQ8RWr26zokwvO3fnkwvX5OoOnz04xWSISRO+9fXD+/45vb7Xj0DjUkNIYCE8BJH02pLohhyH1R+0Rm507XRtaTZ9dOghN0g1qNwV9h4INxadCkXAbbpdG5EzyPYX0QslkOfWWqYqwI/on5Y2EtLwoOmueFxVNtrJ8EZpjZt5q0gLlhtB3ZEmig5YwqnMuQcYIvYM0tqbNdFIy8JXiyLCiCbIwkKrzQk+PFFsvoziFHQlNGTDF77VlYjOcff4um1gx0dG47pkgamKA1RFqno2MpxYAg3fEDAp3WurUWIQxo5Rd/L+UDd3UKxQlAeL3UY6Z4bV72yTxIgFMPDzn4I45RkOIQXvpzcg+j1IMTiY9hEIKh1ZkNsn50vKWKE6zstZSsLbOhMVbAxrw7v13Mw87VP0KJzP4o7Q8zaaqENixdhbe6sJxWxDj6oU+iUTvpn/D5ZJW5ZxcTfaGEIXio7keVQTwopeK+LPNlsrlFRndz9xK/TrVq67SJa2alZKeEidQcG8xwWfXEW5HpeS++STPBpWJ0kD4mO/mtCdYJ7Yer3g/wo81UqyduH5JdZVJ9d+60vk9Kh1mm5bb1LROj48ANdVaqOZRJ+YRKfWQI0MFsxZjnV00RVpjt1o0IJq/CSHDFeGEfWaJW0i2JgHd90/LCW0G0U7Ym4EpOzcFqbWrLs7jWz2GyGXaDu0Egtphghii3PD8I7Emc5S6Aq/sNLq6AZlNdseuGNGad5UKB8uFzAKbZxItohokbCp4Qs9qlWIyXHQqqCeUx0/BNOzr6nxG6NZjwRpCep1fFMPPgI60qiali4sg7SxRzfdXXHnpIYbAJkHzG2zFPeTJb1fN8iXeBm/RqZR0TI9TndPAtA2Hvaqle6L+5VWZaRQEgF11wgDfJmWhXjTzMyaPhs8z9snb0ecVP1NBM0DQ1PfebJahyzt6QyVRBTYhwwT7VXy+ZA3tSImtx4QeZBbheP06NeKlp6uUVVyS6Scr4vbHTk5BqTLcbMT8VJgq6L7we7GJ7obPFPSr5sGqazCj6Wdgtrl9t3phbcyNO+OctqNX6euOn9Ne0tfv3ZWTxmN1FH3gS4xZ7fsRtslMCIYsZlZPqNdEQudNZFWGAvGFLCTbNASDI4oZ5CRjE67GZMTIJJ7VTHUBsOTfgYv1oI4bTLDHUXg3OdfXiS3r/QLipzOVxY8/8nRdANpAUgfLjae8TNxmums43hqFch05Ym4qzS/9z6/ThVd4tDfzdB1jfTXo6G1glv0OYUFJOetpNCJVKICL9lvssfvPKPRboVf0I43Mh6Wlsh4X6oTH8AKHgE5GI8UGGQM1oJul1aAnYXz+sSiBAwbqt1oRLPigH8pC/Ii3vYTpVv26WxZTIZ7wLJzz6qgVOlU04Kcfi2zhFrS5ujPiJ5mPsZ0C05nmJlL2Qoit7mwtrzirbBJIXvFrVXfPOW+QD+de8zrLDaiLsuEJILBrE+xe0LjNANq+d1EC2nPcEjAX7j+iRKR9lGlmVDLmvfW5l9I2LmR2CcVMBjNX3NSiTfH52VUfSEllVs7Yx8y2/q5moAAvKV3ua1c8H/u0E9gI7DD3JMRx/9SMvKQ3H6nXYDS6UXR9pb3XauBYZMJmVoFF6u06FEUYW8GlKrdH4/m/fJxI5BO81/q5V/dXRBZu0irWp6lK839GNW3ee9nrep3amUlCyzfj9FqyMAzzh/+GWQ3OP/Stqb1gAndZ7/+7zgpkde7HibHY7aiu9LyT/LWO/Xo/00CjKzhwi/7DO6ooD5FEmttL+ZJczXseG37NofEd/w5RdXAG3W36c/6vPiBZfLWJuBSAbJEbSBUQsMv05gN3CfcEN+FF+OIk4ueZwG3m7tG+fwkjyTbG/dSUoSWwHaAulhb2ffqmd2WGzgOUNdxk+Uc389CNmXJe1SRxdojaoQ6FOsDSjsdo78oaoBcMxms9LZNS2LDXYJiKS3ivnqAbhrJHySlYEhxIJYWYLE/NaUSKx62QOO75L7PSGR3SKPbxcM6ixxPfbGBAtqGSIxk8b0rC1Awp7YbvvCRdp4D2CT9YJFFyWAKRy43U0X5lEI0uqSwRBrPLWUV5veRtoh8+95MkUCBtTyEZ5QmUp3evuLLjwVdZ9jS1LWGjYzeQRkqaXOt7nmmfglfI70LAimc2Hl5agpyAKH0IhxmQ0Qd08UxRRxJf+dGfnzkWC0vPBUfo0uIx07fL+3jdrsPgWjR+bWG6M51ZLCtJY4/8GsdN5olryP2HvqeTV949U1qHnQe1KF0sKYOnW7zCueT4gHKBezQIRf2Vr/ajckDK81ecPrnBeMvFocBC0Vjr6DCdGCQOjf/sUC/1Un8qmJ1Wb6YgM33MLFgfHktSZ+727LDFxm1W63CDe68bon9iJsEsgs+iNqGgXxgBYMnUtsAbpvBqLJWqhATKZ68Fln8OeX1dJMumI+x3DAmP03vm/XAZML6LJBSM4NVNYPXXtYHqJ1QY+G0X7i/zhUMDaHsQf5XrfvWLAyvfLHhb9SM71OTv4PCpHFM3NdZKkWDuYROB3LDr+0sp9qWbyTtz7YFAtyr2fjNHNUm5OjCbsTGTpQp+FxDaAkwAZumtlPOoXwXJxuFyV0W+LExP7y+fQ548wLMW0guX5bhLspQ3nNQ+CqUnuCi8bBQX7reBgtzLpuHFic2KTB8/maWhV6aRKFa6qDZunbyCHqNj3QHpNteyIzCWMiwTuXCkDBsehMAT8Ligp1gD8O1oU3S4fQkSqYDV2CsT8AkR2v8pIkPPBnxeSGIOqUGrB6cjQn2qyDGJdE31+ijHncUX522X/2u75i00byMC695RTciPXq8my2g+2K+Tp27hw2Rjw4mVJw2ObIVWY3JmUP2Vhs/V/9rjcJGiDWEmthaaqNlDmGTIsacWeCuJMPDZU9wCzYP+MP9TjHpQuimRm/Fg1+u4ghic/PDHH7kit745N6mYAPRxS8cmqJMNAxagCjM3wPPOWywhG+a+v5qVCwg2RO5JnWwZcP+aLGEfEOFXZ9/frJEq3Jm/OCJd5SSPg71gACKZYv140ew2yaROCUfzLxT3grrXKFIDxjmNgTB4zUsJ7hNpM978ACHeJggezNbBU8E4AaOYiiWNB02iRPWmU5ttjvYHLR9YvdEBa4FDG490NElHlRri3g5wsbxY376U9QBfvtaPExU+0ZgZ5bxeA1VFNhSTSx+UDA+Y/CGCgH4NYO1sIxk0dCaw09C6a2MOdFdbgyu5DF3xxp1OrWQAfKVdp+w6QL5n3VJTttEhm3RLWDUi16Elo2rVbkHKeqon+EWcshseg+Qk88oLa52lOVxu7AEdMRz3dkeyBAaUcMxa7acuExit8TOib+tbBABdbzGKKIJIrIoq4XY8stNtQzaxqx42/RNhkvAbmWBVoZtco92gzwt+/Wig2FCU2jBiVFipLTM06ERsugSV38t1NsknrpTn5IkWnX/MtOQ8kUKh3y+Vd0qRPdhay3/fvDGImQkqg7bF8nKzQ94zppiX7xEaG8slxef80OXJIyChZyqBnbGQDnrBy8BDxlw9xUA2dfRYoQyXieOw8cQ8W3pM8g7tk9aGQZVu7FwwJ6mF5MtqOU4NLXeDjfaK4DFbwloDLP75RfoJWFtzstObALA+G/DIF63Ic54XGrJNcsdeIvDEtmlN28xV5TUz5XFiFAPtyS2l1ocbQvngS0jGVWHpSCeN7sxW1Y3LkGiXFBGdqm3tHjSLoquWUbv67krzQq9HcGK4cYlvvi/3Bd9hJQ2FlP2xGQ5IFTBH1NW8G0KEge/DTAMl3M/lAJOuzn9g4fYCC7JH7iPEu3UPdW/Zybm5GjGscRa3z9oG13gOSUvCnAQWXswQ8uazvMXbbuUKebWnhepbVGKhWaK0jnGOlWKcBOd7/ukYjKMOARqFN9tWN48owPOsIkFHfyVLIVeAiHXgQcxhe9J+B8tHDBn47n+V7z5OtrGHb/rAHGfujnIWNjmR7vpHy4SxHqW9yrowoeAVu0EfoCb3YMgIClNds61IceeRyizXw0yJRixRpLw5eJsBd5v8uOB1aXCMrmxfNFlTj0FSymP2sFfJXbyU41VKtQKZ1vk3WB9F/4P36quL8SZDlIa5dnSQyUg0H1yidRyg5ZRNccZ6s6wdYND4StPPuJ0Fy6bl74WGgzBfAYwfgTExvPEprJx0X+Q9Wd6M3y8AP57/S5A+3QlivOuZ7XKf0lZMebbrEZ3UzPCj/Wb134tDLTBdioQr/8w+0j26wjCtopxm9q/tB+fUA78G9No9zOT1MCu8Y07qpxlLy/ACGPb0EpHi7sKKzJeQP/A3jIS7LvHY6w4Hpi/n9AE3Jls75lEwIg7Ny0pvUAJEe9ZHfyzQ6dRuYRsTqs6FnuuyXSeHV5On7G3N8l7FKc81eQcTTZc4IcAEAbGGmd4JhSAUNMClCCMrRYL6OpwZV3RQNL6sBeTMFQac6nRNVEwRg87pjbg6l7Kdl4BL7aZ3BhRQknFRSEKYPvu9if8cnXTLjnn6uy3KtMssJ+DQpT6uecuhXCN238E255a4t/y0SXSeCbUqn4aArYPkji5kW1BIgmMrugnZ8VzwkOVS1bjYKurPyheRLudRk/GC+duDNY0/768HKKaa+kZyTzRT+8GybumjNRXi1PoNwiH8zBSnAWsEQdCcfZYWZViJYwHqokBgv3ppgwiQVYj7tU7zjG+M4B3pTMnCidyutv/WGB5I5oG4aw+qD0bMKOS+e9q4tngsuuzSSyE6GPzQAvAW/mBOBLRlHwFAXz7t1rcicyNLTnkX8L9ZV838FhTXxfG21U22EPR+Bs41IScCkO6IAHygfT7qEuMlNVy0ShPXrshfBnCqgU7D5/O7KaMnEYQGL9zg+CQHtTmeN8FoPy/UVUFRCVNYth5gE8nNBHHeSMoaqAvGUoxUPGkC2c+SoyUS0FptHp4G3lkb8PZBRJJzqaU5Tb70OjvJXyKr83xi42mqZXMsFfKv9nYrfBFk8uXSAnqQwLAFDE2StuALeCNOb/bh0iJDKfu1rOB74vnf7yUTzkIsXKHw1xEr/5QRVfroAHyNTjK5X5ETQKwHav73kHRo3/6eSJYJ5ZBg0dE4/XsSQI8VslJ9TH8UAsI60VHvSDLe/az5pcOu9TzVTyq+mXq9vzvcOeM5qs8I2RuYo5I00EOMLiSKVZw5pSXKzO0NxDJ+l88mnSi6mcBhS16iROIq3X43Vl+QFx0tcUCzLimg8QGJVrv3HhMxHTu3/UlbitrVmHpszETp4WW8p8hKWJC5U94KzgRiThnTHSgN3twZK1w/nTetxmy6KhEUPISXKuA0Qwpg+//3sxjQ60eVmEApfzkEN02UmATiEtFvqIXFMIUMMH1VU6BCLryzDDG4d+vtzoHSptTVRZKWvzNdw/PRXwTFcbfmVLaQtSCo/NjBK2YdwJFspq5MCsIEItZj5PSQIe+8rKUdQOyvRr0AgQ/RXwJNlXmpmp3aAnaCWvkYzNkpv9joAQrZtl9rA9PDZWUBo6BGYspOwSNbLs5/pHoFMf37BEcKe25FYNclZPwz/M2aK4TjvWdm4AcfzufVd4yBC5y2WcZb2EuA4NEgYYQlV28yL1dyEQfVuT+aH0Y0dxlX+Av1EwuT7dFksPbAowhSL9cBSXyKl+CShjeXXBVtLsOW105eeQdDJPKsaKdiZ1U5wnWNPwLVeBYkpLhI6ca3uh+wTar9zl+ZyBPT6lR85p5jiYi/c7HeVuA9oSXhaTHR31Eab2qrLJeGQRhzHGRd9JJhAE/1kGA5ONhtmi+ztXgftuR7qMveikVjmBFp9mnDYS+fbpuY7aQa569YuuA2QGZELEi/v+mgImb0mMdQtDo31lpaT34HHYGGkwjLQwMrUz/GOWDbjvcxK5zsSlve4p6eLbx6OYIxfk2wmU6Q3fjWSJmz5EK/whUicsR8D6zgTu4Fyteu0U5AeGDjZSOhIxw8t2aPBdVQ/LloH6bI4PGUnc5eSv5kd3h0wE4jf5/eAxD1FXamx60nuDRhvyvmqOR6M9azmVpA3n+RTB3Dpb3xmSCblZtQewrlgJM8cUxMGPHpoQyCVOfqoAlgYIVkUbNyD0WmCGXqs/HXD6DVF7ZqNkluqR0nFlade2pPzBvK9TMrkkffPhGZmvTaiPwPvh/Jy11FUIHen6G1LPfozINC8Ia2jcbbyAa4xC/+7uIiEwDkj1PzL4jt0FpoyvXSJnBv/iBzpEHTk40yyQCBLhBCe7Uap98VHWcM9lxPz8D9V7XwPPp9vTsg/sjT8o6vYvKanPM2f2qCqlweqfpUEyr53ezs0ShrEgybxtk5cZzGZw+O1KkB/Rd9+DiA1Vpi6HVHmAKewiC3hkZ2YtyVoZ/2c88F9y8cDIyJKMmRKtbtk0f+GMOfNSYBvtS7m9Qz75OXpBoC+DVWiWVuzNoku7eKTXEJ6Mg3vHtENAGRSyzTVgZXvF7UaUiJ4nm108v+k8HNIZ1fZM2HqI7U8u1Y1DA93aaEkeUn/mbU+/ZRkMrl0BS461cD862zViHhtKJv3Ylid+qmpWWzapTP2cRCuCGj3aqJHkEUh3kBedukrEpkE7ORfD8jNB2/WxhMVf+E8HO964e8Gs4aRpGUsqa1RgbZcpPZ9WB1guvgGWiP+uVcTHNPVwqyWR9W6amFhtUdsJSPfQliQMA0eKKEpdjXRUDbglMD3NAiTtcZT/E0M10JR3ZR61K87/7p1zB6U4qwYHFdXwALfymgrGNpkB6zEZevekDiOOftx/7VuTlxWp54H3KRGo2zep7VaiH7wFjRxGRb+v79V16YCLxIetzs0dR2JhYxlOpY734LG2vNPSjnXNbZWvpWThz1O/gsEfeo5lnXqSlSMgpu4dAuVLVI2UUsEmhP05tK2Wki29bqxKmKROVJLjm5S9G4gWJQpGuOd4V3Guu9Uvd7xpxqra3B+qoiF2WZE75NTJtqRE58oV+RorwFucDklNvX4rQTeYv3sORj1iSIPUljCyWcz1qKSvrG/t3DbreBiKdIqh+EAqeNs/tQ220qLD8RK+suSy6EDSD0uQFvm5AHqLPNy5wZdcHalapDznAP6WWSvZ04HwhvR2cgUx49liao6Xhkppn4xDcaNR3gVMwo9dIUDQdvjzMNeaQvT71AT22EXOWibxeo4beOYeVWIwVrFtRgWv8MNNTIAo9ktYNbA5KAglLBItSwbE1UNgnSOiZuOLwFJ4C4baiHDO3fpopZabVrKPvsFh6htSY6UMfiu9EV3CrWXNPXQxEvqxG/I6UWP0F/PXbmOgJ/urXmKWAe45wRwboLkK6a0qAVH7JWEWq8y02nC17LsUqvc5gwy9EYIMKeaV7tT+1q1uUThxi2Uqxl+QinGN6kIsd8KcHN/u8xuU/yxMytnqwHhXJ0pvud1b/lMyAlndNiN+y0Xy0aOKuYXXDv6PsEW3xaYrn0BaQGlluNPV/K7JVLH3nLCIqoSkblkskZYUepO84vSq1wZbSvANT7V7OzzhsQ5UuoHj8X/rjoa21DotF0VnYv1AI8mBmVnKubYfjRDgXhVaBAp5SWq/UYe9H5k/HZUBbz/iDmvuckHxOr+ZZu2OCQHWUlwmOSHzUB9MvGFBdMVAAXjt895JVxUEFqZdSHZx4dBcynw9W2GdvsDZl4finMqQ0YQV0PUu8NKjeen3nVEZjH53S/zLMImdGdBi2DOq5TDn+jgEE5jJsz3kzKji0uq60jQRUtxBIvzeLDKUDcqjGpEioaH1yQwsK+FGGAE3GrdGRKYLG6x4Wqf88E3k48ifW4wVwkXn6Tv8Wl7+PgeUeM/Qa7DR/cgxKqL222v29PJczN6dj4bn+19FKKe1lzMLHSyqmthAnU2bnsqlFgJGHmKGA9QPpGG07M/toBBpw4ZACEhI+lKEuMCecOBrTJXTdDPsrf21VMm9CSk3gJcVNycB3XZO2t/qG48dg1DpCos9kj92tjqWAzU9mAl1+tr5+w4SfBZnKlGSe4zWlkiODdI84EEKj0RjIqRKI5IyOwb59t9/nNE3r2pJNDQysdj8g+VgCLMmoYNAXIAchz5nEKIvxaRjrtZhpMnAKr4DkZqOGxfngyzesPGbM3tRtRGduoNqggnGL8NEL1JcFHrW4G3Wa15E9WoLkuk7mVI8ZJtHF/iCDd44pDrPMME764j9oj+DHEN/zwmI/jiMTX51ex75aNlZY1v/KsSnozfBTT7ycNma7JO6qzvkum1aTHt0Myfgzj+fH+prCeu4PVNpccxsXjnNIAT4eQVnpc0/9L9zQNo6wPwO+xC3Uuy9yu3vy4NeUL5C0kbf7OcjafJhhN/5CyMocVdIjgoH5b8V3v9fSFRsw2jmpK3FQJR1JvlPvmfXquAThxRnQMSLxHbIS6tJ8tSCDEuXzt5kb6dBmnWn54555nNdbXwv0iRBgiWf+mEi0Ee1XLnFBb3cR2N6+0AWlMRvhl5ppx7BokdFJRvip57uiun5sj2/cptpv5aReXUJsdA14YzdU57sxpslRQ9A8nibAiU/wqEf5kzvm7VqVZd5OpfgoJek/lYR7QLkYdfIv+2B0j2h8tKb+Unaue+TcLjfb9ywvSM9TEDrBKHh3Z05iYNXBMyVZiflEmN3OfQLEv3wDaxqjixf06bcLeDW1FnmT9VeS7ldjm75Tzus1if01WLh3d0enSOWMPexPeZezm7waK6JI1840uoD1tHCpH/Eh6DNWtLmwPtCuQHg2GbU91FqD5nV9WGzYoooIg+Ix+HFsdvkluNVa36TC1yu4MqbLBqXT2s83eNGoMphcPJmAKPGyVOvGHhJWqNrQ4LAQpdON1Vm3BjTt09ygfobyviltzkQUNM3xxFlsktSeTsC/Ti3rUuUvQLBdI4hX1Vd9wYzOetjlyp+jjCMzz90J769uLpSeoPjKsLAly8KNcDfHfFvCZYe3CgCjR1K3jhYybZvG2Czn73Z9/TJXl2zXH2Hix1aEDhjFXIhPwgdNfW2f43+6GvUxa2d0/uUGMALpjTL4f/S8/DlhunR13vlJEDefgL055XbnV7IPp/2XCD/fV2587Fjb85CuaqyX+jteHhSEz0/9rxPdDuvlbNGK0tZ4w9ew4hEhbrtayVtG68vba6QNDRY2tq7/hBoeLEy4NXvuxW9l81ODyYNKGqX+F/1z+SRKKP5Nt/9LZ/q+c2PrTucgrmZyXLSF5CdYBFgYBrb3ICIyOLptdTE+QiTgoBS6+RJNxE0kThcrnIgKUxlcthcwKl187qOsGu4iZeBjPmds+s0K5M06GWEjK/csa5pwQAas/qxclFBkI3G/wEkG9C6ZNRjD7Jb6FFPMQucsQdZPyng88DBAGsuphjFn1L1dp3fwi3l/CM7gTEC3xdYiOvRaXikcMolkAtBakMbwdhCjNld5ZQ+eGEGIAga+VkFUcq/R4CnnwmH9hVcj/L+NYBLT9gzjG+dp+GFXADhq1d0WgXexCWXrZz84aFhS2gSjJ+9wVMQb7TweLWkqHcIm8fw76wUSFPyeEcTMZEuVWSz7pPX57BPyfa9F6ECuwkV+DkJaue6jxX7ADJIkuU2apYrVwCjo7L06vy13pbylWXXM3ksblXgjYzEsnKnpHALgMnWb4FTz4EIMq3MP1hymz5m+3xfh2RTCblDTiGt2PvgiUMxF6i12svbFgSUv+4JIIf5VNbVzo8nrqCmc8o+GrALpnGRuhhVOAOwjCEhuGEyI8Q0E/AO+97i+5UG6nFiMKCxbbycW++MJhL7CR6zH+EJwGxnufquskaRDlPP4v++z0oaDoyXf69ZIg6Bnzzqv/ACOlUnqSd9YQ6Tb+OLi9s9Riw4E+LPNOeuDNqvKubuT3MojwHKkXctgucrTXd5X+sCPyWFkvzoFCLL1LEvDopNc8PMXjXcJkt7FYSlYMNI78bhPDTTNc2VtvZnMu4NwSYkzy4HSB58YBCZhk4DsXo6E84sULW71cfXSDvtG7SKCYsb7mlHO3sTpCkF7LB4hSuHowVo0PG8EtEMl6es7eA94VIFdA7psfK7j47kO0x7lIBSWmESpLJUu4q33wibnFfcgYRpVUEYQZeND/Q/43uSdhOpFATOmrAtU2yaY6kpzHgZx5PeCOsij01QZtvCzPOOU3c55I7Kva1Rf79JjTkZQq6UNALJOp7iDiO/hY96h9SniLq8ju2BlXHYN+joiEiM0J2NybfQPOCE5WdCZrf7AWJjrtBflas8p8qvWsm0CcO1oYcWAPeDyQEW36G4Wn4OpiRzj8e8rDFDJD0I1FANhlNjdmi8i1x+V03QmGBqbK7gBLnp19DdNJEnjCbBqTWjIOdf1PhkkUH5g9qKSwXi1si29Oay0AycajXMe0/k/JPYMOZ266N9ByCxX/dkeCge3gUb+XerdBuC6cXgX1N6WPas1Oz5Nc/tM6S0ae265fGryzd7z9hSKZ+C0wNwCvHMkL+HHMG9R405ISkbtcWRUwEKH5qYpA2+7xTMKrvw5kPRm8of/oSaATu+7QomfQcu614ZVe+YTZZDquizPngFdTlly0X5plnauhrXRHKkTUYhIFtNtjfzAfzn2izTe9vM/cg0+NBl2HBEPoqvBZOztFAFO2w1Tmg/AUs7B4Be9WwrECQvEzAl3eq8xxY4+B+47mm8Hnv7WUFqzxncerzpgDnHcaQ4vfWxoDY3cIyCtl2G33W2t6Nj5nMNHPV3rJGq+Hu7v6c/xPi5uUO/wvU/GH8eu2zLXoBnWxkbn4pTq4Y7rNIdfsOqtK0lwTO5Bg+IYFTv+7EStUexacQWsuFZZfbOu07t8DwmkmFn70/8+q5Ljw9+oZul64wpx8fYxRTsXyWXJYTmiHyCugc4Lg2Ob9Z5G2oOtbUwX0WWrkE2v1GOxWnx9SUqhzsyzBWRmXns0DSDsD5XRmE9xULicAqqMc7EAYL5eAOBvftwP665wOJ/zlOMMjl72kBQtZ/MmjwUPMiiTCtdgZgESZQzquf89DrZk2sNsv/9/2VMQyGK675hC8BQfxU3FU2jSibeFkxVL3M7kHUIhZ+yezY8sGaoV1lBziAl9L6G7Kvp9aLsd8s01jqiwygR7f2vjw/c9GyztCuIx0GcJWwM0xKM03UNf3bA19Y9mnjZGgs6CJvV4F3Q2NKyqBBhYNFUbT8qPRg29+UpGhGoN0YeB3AudGDWVwDApj/rVcvP3B6DUR6Kkyct/RItizvG8285BwNxW+xtIdIXSlW8V8fiwzuFt9/O7BilXqEXetqY0Rp+Xxu6yF19eGh7xak6cVMmlAA1+fRUdpRJkZTDj+aP+Gj3qQpAIIsLSEmQm1pWdX2IbXvbt2mCfPm9rPNIc3rtj0VZv6qomXKYgtH4FFOShMT2ytQtM7W59bxF3HYsO2Z4379X6t2xLpHFiF8oBtc03Nf3kiZUrnf/yJjgnF2bAMfNo2QJ2nle6P15PABDQbAmx6fZomfpesBb6wwuYxNDTqYGYkl3Xl14xTkVlCMVpbL2nIOv18eQldJ30TacSPoMFQRAzBw58eIEHgzi//SShF40qbD7XNTEHs0x2749CZxvyRi3X21WRD9KTmO2075HglYKlUNIfalp8NFjh3a0Cr3+4+wyGcR2cULCh7E6N7EHguNpjY7qpVR8wSnGD/OBZUp7llVRkvSQ4qyLHhKt7yu23G2rsiQpsmltSPyimPamv2Lap++JgljxmCx1INOSM0zwp2ag9Oo1f5KiD/9RsgFWrQV8cXQJnDQQ5lOhexb3JsVyDjdti3PeRjV+9iTjjnFBVldaagBFU2KKCfg/acCt7nZGgNum4x6l6pqihM/ryBKqEca+6uo9oOnN7dSsz2ng5iFSn8veVkXaHxi4ttBQ2IQTvXshrRnj0+h5E5hUNPiYdSwxHcIUy79iyagDai0++HD5/vs1ywnS9gLAYrSr2zbpdW7HFgF31/MzxNthKO+9Pcx5maOMdYtvV5V+kzcZ7jbMLQFal10UMzuHwfgsB2S3MVlCtIguEktoCL2yE3JdIAj+1vTNkOX5ghRYQExyH+Hi6spjXtAh/4ezhxWdIZ6XzdDC91LoYL2CY9/hAwBzdVOeOtRwxwA2LShxUGgo/Iu8lBYebELZGXjkIHBLQaNewulUC0JnlLP5CwmpVQQNvlz6R1KQ1uG3qxHLacnep1xFSvs9uHJxr3v/5rtwaK4TthP4Urd7bCgLyMIbwqGyVGkYenUWkzGFqx8y+bfQ1W2hh1Dh5q3G3IDnyp4p/ISdzYf7MGIbPPoO4asVdEE1JqXvdVnD9rG/GVigINePX7TfLQ9u5/7W82nXpBs/H8kaND98k40oBuw8/Thg7gXu2a/hzo6GqWXfb9316dQ2QjduJKx5ym+kRjco9paLsyr/sD1ZOy8C/z/D9c0chfmZ9wfd/xwNBQ7YAq6Fnkzf+QErKrtufiP5Vwd1hsrlCRftmUZOpWlqaGye2nQjmopmNUFm1hZJoXxT9D8nS5F9UBVFzhBr9/7+yPqj12jWCitAFTv+szzOannKJBDuA9vddXjzgZS0tT8lusVi29TFQQlabTdBkoz+v6+3WChE4dIzcOvHw8FNpiUnM118NWPVGgDRYo80EhrWoB/NuN66+0Y0hgiwsftYJPQ2yHvgNxE0rHVY0P0qoZkylfsHsvu3LXH6eUfDtOS6gDAsLQiQTpXlfCoaM68VuXXYCtvSWsN5joC067oRGHhkzjZpE81PFBmKCmeieg25JC7bWlrROnYOu8f+5Jb1htUf2rlskZRLgPC8ge0UGlmaANu5EXwjJtbFxkhH6XrRBLeINdozF7dLpgDB1N5z8r9NBJrfJPNTuw3BC0thSdX39fliMQT4deLgXZAF1pNCpMRrSwu9+ApgaCh52fPctlvduXU3Nd8WmhC0tEz+8vvSI3LM4k6iFa10dDw53Qj1Jk5ZSP+4MtZJtgkNhZlX8F76oEkN0Zpbd67jmvwLEGmpRmnTbMrLxpL3b7zMRiy/Mnmf0J82enaUsen9+HJaiszEfa9YKNxD3CAAJn8I7ZhUTvYZqkWS7Z0cBJfXOart3lIqdwiJVHKq6okCK7VY+x+zQ1vuA9pSA9swHzHCoZxKAbIz5tV6HQ/nCl9qYA4+1aZa4M/DGgdHgGxio5itJN7HF2i3V5uv3QA4qd6kJ3TWG9FIgHOffSppkbHFPtBsfrmwS/QnYnCwfu4fYkcYfVsddi2VRWlBWlf5F5ifCrMkWr4U4bjNEK04wHa9xVPOCHXwpkNjrD25t78uho0ybFj5STuovMmWR0qLGfWy+2MoCBQ4TSdYD+WfuXtS8Ib785aI2xO0+otwidlAzm7awvzufK6Dhf3ZU4itgSuXdW3/WuyWBiwZXOZ2ienZm2kNNroYx3XAVZakdcRstMNoxed8xL8nbJ6JiJ+hgfEYpMX7HqwqNEdfm3bxZybLbvpkKFvQ8tE2222wu8hvD7+e0VW8eVFTicOvzMxtMqsSCQh3DDnGywkXS9TM2hPsbs9+fTyU8hrc+R9YEkHnVWoieEhuuhwNa5N1yqQ2LaFHzDbdGNDjh2Yoo0VTeZ/k60De8mAWAgPnT5A/Q2IIKDBoU3O5tbvd2Tcv+PITMGZmDDq61hxmyMDBPykNt8hVxUAgwJQQ3q1yZlBNXkFCehPUvTBAbu/fHgPpRj8E4O3uPnmu0yaNvhzuaFpwthMCAiq51aOuInBsZikQwFGNO4Mz/tpen5nExH2QNNW0ZppjnE3TPyi3rsi0QB5WpBJHK5lJF7UMimlE7fn4axrh+I4MKEWYIuHmn+ZiWJ4Xhmcj1BTKQxUe4/LspBc51B7oalakWYVAS95BgfIZ+hXYt0jSfX/pwATS6NrXTyLC9Mv3O8uewOJ4BvXTH7RS0NxK8dlPC/3ZCqMhZlhn+xzL4UmwigC086nTzekqOebD+7fVrarN0JBCtOJDhSnY1IMeiDReYkFGxl55vCAUti4rMmdiDB5S+dvkqASU1dy7U7Exr5iroancxsFrkh131pi0OTGyh6Tq+5vryR7QZZUqLmKdsN2xJCd6r9ScX0gpbd8YJVgFlyBAH19NLcFxdZlPzMuJP17u2XgHeRBLci9fE0KVn9O3VehbDtuibgCeP9Klp/i/84rTfNTUR6gdKGwfzZOCPYDMythI+N5XUvsz4O4r0nNH+07aXAhYO7Qp9yviAde94Zo2VLad3kdGyz/xS7Qk0pL9Ljt5r/SZei1nq6oqW/xx6qAc7Dlb52bLchurZmKVrmLEYLoRrpgxvCc+Xaac3G66uSBBO1pZxwhoB+Hch0oEwsqbJr1ljWSYu8ZM8sCCqG22txhQGdWuqbx2R0qKjYcZEAm+2MtS6eHeJ0S34mDoX4J8Iaop30i13GI4kqy+1HZoPR8G+erfbHfyZJJSvw7q74TKINSPF3eA5x3Mw79061R46pg46zVaoLEvqUgTEPjJtQsHSrRreEuzt+Qp22IQ/DmXq/0qUuHR/LpkgUutt4K+845ZXbWxxoUAjkOerbmFBBcYxZ32ke5E016RpbOD4fF5DnXVGg7KkjVK3Ldj0eVg98XTw9FqSD3xl8guYAUwBmM1+txR1tQbjqsmyfMa7wOxz0tl4E5MG+4pCzEU6FhUEfb83EzPDNC0Y6t8Qf1/n28ic7YagG3ZTb4bCnxISb1WSA9/IOWr880DidSp3SSYG5C7v4aHSWUMulKzEW4C+eV9t5QpRJ2TLz67OY5dR9vK3WrTYaY8z/IE+pyAUpEc5k8UmWsQfHohWIswRfQUwTr/iEweuWjoyZfQ2xphnyaTHaKHKD2gSUoQEuj4tRTOjnQac2vaLwoS6BqL6hwobPEGpP6S+R8koADZdmYpRmQxVONacqxpy/aTAc/8SFb7InPZIzeamDK9YGebTLlp9YPRRHLhkGZb3TUSYB7IhAfRMkcmSItI9ZVdWyXUht8to5RVgMb/1ZvEc9fqurDCNrcfK7dpp09mtMgkrnZ3s2uAIVEzLo/7ThH1GlK0GuqMP2Envb1uXORVJTFYa6BLS/jRsDzDzReBZLfFGAF1J8WtKNy+nm9hLu1XWBXWzGKve/9uBQBuAShJRiLJZyUnK32tO+M8VAA80MmjWpJmMRNiwY62cjX0ZPgiKryKuBS/xkstoMryUX448Np8ZVSJNpcPsXyCSpMkoxRe9qfFVNT7IYD4GOFYTt6yK+ZHcG9B2mpJvA9F5tVnwZFAfw3fEP/stu5aCerYwTvT0ySXkH+qd7JKWDGZbtyBpES+2a3X+8VWYmJf/efki6tdt4f6QcdqPYo9iU/jnjYbqx1oEPaOKZyTFEzo4ShI1xYIDKIcoIJZspind0F/bZoFOaHBppzV/G9SwcNkXa7RBFr8v9UT3AObQe3wrDMQCXDqs9bWCciB7c6DmSxdoag0bluzZZrhtopaYse4RvRsV6iT3Y0P0bw78iQ1y7w8BbXKleN5p3ofeSDkzLtKIOIptw/iKNeEzlI5PnEKUCBVSU5RUpllcpBWOBJBeEhuQh5PI4P5k/Hvy6OWrEQaHAAHsxJJ8UC0TO7/UfJlWx8V5wgP1a3X56dBzML3jDQO0jDVSy1ZWFmMZbHtfVG/1yzwuB0IR1bnsK8MxEQYSFRfbaoJ8d+bDQRgf42wLd5Savy16RkXbnyi6vDixMlXPeJZ/phFq+Hfkx/+gheapzekzveWzNnp2a2voiCZAFyEWgqQuI6wqPetOQw3oklMmpadDZsrnPhsRZncmq2qUf01F6KlHQ4N643kYdYlgEIin1lDDsojivpDfVBaiWxdMJc6NJenxlovhbeTvPPxa1G6eZadWOz+lPzm8LEOSRMCgKNSQt3EqWosM1U5jp0/KurYr1hUKZKxBtJO+PpLfkFn8JPLxfd4vgdgPxC/I3STEWmHWREsXdd056O3S33jpPCOGW6hNwbc9FnrHV+vkwFBD7Y72r5X8UH3L91NK30OHZWcQlC5j/oR6jOQx6DiqUnJNl3qgKsGoQL6qJQb44oTMXYpQDQOYL0FPrDI6MzyqaeODKCboYqDSE7JAMTfQR10djKEcC3gRBOI2u6TwugBFnA8I8mArRzkaTVGm8e57k9bFHwOw9nb3f8RnqwviryIheXmQVf2U/AJ2CgsxYelLeDEYiMYAnF+/KKHbXJYVfBfUhs/BF4qlardOS9DrjN/jaaSdxcxj0FF43/5inNbFGdE1idcH+rAQ5FWvgy85nG/uOK2pB9VIg7xjzJE27xNEqxF3liKJ75NBPnz1wAdmauHgt5Ok1xyFPkV8JV4Qn/Ckj+5AXG7QqulY4UUY/if9pguAXwISal4P4oFwZk36XzPMoNWVwAftR07MvI42kSuM1AHyOgfGsJ3UWeXXpaiOGf32+dYb+vTrKy1FZfiBsrvCl7n/o3MYfZ5XcjdVabhddFHIhFWlhfLxinl1OomXQy0ySe3LhGLCLDKuj0gVJZWMFdKFDyn7ClJwzFp0ULpOJsbLLIq8AOA4Q7kR4cnkNDqsFpqpd/hTFwg0HLP62PUi1mhd8hP2etg+KSIZEqawZcdYSsiriNGjPCnf9Xjw/2w6ygCgK31OpL7BbeGpcUgTaFy0ECZ1lIs6HH9JACPyKl2V9KRVWzGZnm5GmwkXPErERbvJeZ4Sc+d8Y+Grz3bodG/uHNrwko03xkRIStOXU3rGr4k/9PmZDjz/MF9O0mqVj3uISlXB/5wV3H3BgIccra3fNYvY8yidfWSkuAIwSw+ww+q2intwOUox0AO9s+RLO2X9Sj93LoHFkfuEUSVRgKryOA83YXdKT5yogvAM6T1NTDsfGWJavajWpO3NYXIRgH/HQwZoHxCyi/OV9fwLEBEg3gIJi+vQFdoWDi5PD/+uqL1supzWaPVifWDj++6hM6TlhiGXUYtqGTF+vZPWNpbss8qHeKjm4FgoIOqRo3xBKwlWBZmZ0d1mP5CLTKp8oHetlargYyQbnYVJbbq5l7/xwLhw/x3QxchcmbbwHmtcpII6iuYbKtyE7rU4OG/Ea5znz0ZARSDSmELOSJyyutu693d8anq/lMTqbqGP+RHDmV9VaTajzbGT53rmZkp9tDirFpzqA/08cJrVc4EIH/ayoa+UvNNdiIAeeT/J3VmpykCK3UPVcSvF4xxaXqERMRxzc5M3EgSBRUSNNP8rTt5MJ4P9sTxzZS0UWSILohuQu0QpkND6wsXHywwqphWGZynYmpmRagb1XFIL9fIrlUKY5dqoPJh7VIvbfiUDVCpYC6T9UOjayFefQ/0HUk9PlSZQMbl3XkaFBhNxEofVwVoHOG+bXpQmAvOMclvPMppm+wxViWNui32ifypiIII+YAX+/xzCcK+QOBd2rRCgCL5e/wcxgUbqoXzdQCmHCeT1qANZ8Tllq55p2sVKrWWK21xVU7Ns32E0/zBnujm18LbBv7PkI/kH89zcPE6UPhYhbxoxAK3k2Ahd07z3r89RqfeJiNv5/L9F05LUh6O1YEhbSK3Hf/0DA5B5jsEH1z4nllWe/SWnf+v26jSF8VNM2G4c3kAsDgn0HSYLovBoNNo6nbkf/x6y6lfChe6CA1hd1bJZNT1GwycT899SmiUUCwqFSFkd8SQRWOsL5R1Atyijre2v78yizVyqj9Q6f1yN5DP37afdmb/u66zDLKIDAmcyhuKSz54CRBrv0iJJEVcULcazI2ZmDbMW9U70TH1SKd+fdxMFTQaJ24g7d+fg0nUaw7JYrguqXFJIqiDQFYsWFi6RtXWradu0RuypA+znWq+9drbogjRvI7g0EXzr+SSWf1xbqI91ARZI+JGj5hYPzSvCf86/K2L11U+Ksr0GYm/LVA3SusOTWBjwx/WLyZz53mP9FgX2fxofs7JcTov9GDN6P8FFzkFEKC+dfImnK/ClCfduIPZHhIo1nPzWXajshkThHNbU7DupK4I4LAugriHaPTsZTO6W5LMKbNIj7QtQqrc1DwJn6TF1IjSF6zu7Csgfy9sNhKCYn09CCNL1SNeLfa9PjFiaPIR4K/BaFHjJlpa0g2Fd8vmZjdMKL+F5aKfYARxqXxbRhC+6QbOIF/U8HQIE5fj57JMBbKBRMWkNziM+kyUf47web3phaCnMXI7InHir/wLvZydDoemQiwCbnji3iiPk34pFpC6l4guhDa+TqaXnEwcwWH5b2ZNqrfQlQWipotsI4r5wpt/n+v4/BScXBTro57SiPewOvWcqSTVdpTbITYo6NKVHCodUcv2O4+sZxnjcU/sjmsDZCFAAycXwwNQgVk0kMFqYufh9eWsPOXUVi6XmIZURGjeJr4QlzP5F4Jh7bBfiqA9O42jaCo82M6/REnkLviEnXRQSoG02++DIB22wniEEcDhBLFsqmLOQQw4b7GnerYMY/v8kU538eHOZ1ljmJ0ldC2ClkqSlvcjfPHYot8MF7G3ZdYxrhbKovGNtNZBhgdrSdM0It1XVej7vb1BjxN8p9TQVI5iJ1AOOqysRZl7eAT7/tAwTprWnbjnSYs7IE0h0PlZH3r+q8RYjaOUWvUCsmamcd1ItPA9zxk0ii5eCx+BMquwcPEz7QHwPJsnqW7zMf8e19bKpKRDjM34WWBrJiTwwaJeLq9nHfV1V3+SmUaN1r4mmHfn62ZON/eQsiXwVCr1Mo10a2bkyoxmhvy8NoQ3hxdqHtl9nqNmtcK7mJQHBeDTOUQoqKQodLBp61WsA8viLS1G27hHZ6ShU+IR3FXuV1KwEwUBy0vaPbuFef3rPOErtlmSmILMBcdd+cXoQkJN9bzJem9iCFOGBLfHPMNs0CtifvENyH0tWMIjM9jBlL39ma7wMqthu4ToHw5KyNkFomAEpWQvgn/7F+HEuTHdS/969L+qt5lUWZZmEdufcaF90wUiCJ9b/wfPRTeHAbCBlbcGyDxeV+3LcNrurd0lJ9zipIXtCQ3n0DOZTmCmoJPcYFOkT6bK1ILfWvgvDaLWibrD2mBXo4+JqQx4TuBRtFn1eZEzwq7K8zk+Tb41v+HzvGjbiygKM1BA8uzg3IKUe8rWQ9f2D24A9ciA66NIUstZ+WfvsqlSLpucRbpcAzIGF7zpDs0ao4aOJQglxP1sFOoQEZrwH/+3qEAGQ9jTkajRPYJJNSLURGyUwT2TbUR1yLKKJA7Iv4lSi0xroWDjde8Ahm0wGrfBZtNQAvynK6w1x6yUZbL5WPGwb5ZLVvQdHtmzwDSanJ3SWZNyGwzdsbo7a3q1pQ6u/BukOOvMuOzMSaA5ztwlqouPFmu/cIJQ3E6rHgFeC3iCR7FcxFhrS42CsdYkA4pkg1JPQfSPOrNksvWdeIYnjEdGDrV/VEKyiTBatY9lPbVN4B6AX6gAl/uIAQlNCU2z9qmhBtlG6OLiSN8zGTCvkl7SJ2rGuxdHXJJXUjlVc8bk3cnsvCUTzptL02wXBjsfY72l3VSeqzzpEc9odgoF5fDMI6S/9VJfPyOOtyHgB5Ha0ohXuhmyKjG/plGTF9gn29kLxOzSPKqrKuR+A5jmobi5Ri0YFhkaV4J6NH2JQwSmcGPibX/qNdTUqbln3EPnCto5ZAeuqkMEOAHZgFy0iJjiXKav2Rn1QG00bFsAQcvc63CeYJxRf8JPT434mNDTjlKB0bkjgLKW2vQZw1Um1P3GQYKlwgGJGZjEuGI1jHvT0mgAVknoJzzfXO0A74vXsYFx58nBHXNXQlh6VH53mIIQQKvK7nZwNE1BHlu2cEcYYeKtGCrUOqG1aJLfkcIMAKptwReq5M40Avkwhe5XffXV+wOHoRWqapmWv0dcEbWoLtB/VQjqkIwarRteFpYkMI1/rr1wt/OtndAbmkbebKpYNrrIOzILpKggUQBzL2TwXp20NfKc8Suackta4GMmtgbgfRaA2iwdojSxWYDtcNCSpwaIfb8NLkPV8joDaoTBaNjU2OcMu9gQFiCngg+YZtLN1bQ1vIDikbGAZMerPo8QJq4SgfJ0Iw9eiHUxT8LQ3Dbu92yIiL8PWlbJE628QXfw5nX4P6fOhtY+VdAQrZjHnC+ryEn0+YfYXGchmWEx7tR6dDk6tXF7kMixlV+UouRSLIob9cdaFg8mPgz7TZgdkTVH8Uy/KijZLS9fGePmYsC06tKNSK+ujlmAprKZJiFdQMaENzixsigeCvml/lZLU0kNR7qK70NCG7bV0Wmh3aE+7RgTx/aHEodpOjKoEnnFeNx1V/8oEbDv/G5xlK1XVgffISd48XN9MLrv31CPvOMutsZ0a2Mqf+q+f9IEyPNqp1rCHdtHrEyhYT8LneeBU5RlmVkOOzzBYCJServi2xQCQR5x/dXO4qpRK4FyZjBhp4f+6mdslzJ1+GRg4e3PASgfAaD17hmJI2BLn6+kx0q+SqlGDHm/b4XekzmQ2q5edA7J1SMpixjr0sAYyMlJBQbr7tRVCmagGuw8X1+IdrvFg7GzdOEgRBSp133kytBN8Rxl1VUY7bRvpALxDe7dfZ3ohwe90hBoVcKgv1Gw9R1mqISdeosk2FvLx3WQQXrY4SbMgSCU1uXKIe8edBDxaZZfgAaPr0voGac9/Zoj/o6XB09TIXcU5iM9TqDIhiuMoWCvM+MVavFaaigEDEdJNYOXh6VVh/PPrnMlmmMRLMqn3vnBhlrWuqOyc9vd0eS2bDag7jOzLUIGLonnzKu5gBybjFxcU4rAZ4qhVjtGtj0oB0gKA3Oz2c0dYmBJFH202QmyqNDdPwgEnIj9CZ3vod6kDvGPGCgaRAWT0wHdNpLuQ7PC+c2CuQjrKCV6FblSIU5FJ0gki/Ivu5ik8laYTeZmTRCWj6i4jxn9TKz38BqUkl6rE7WwzhU/F7rDulZv1zBP7p8IsgiHxU4kccaCRPOuD8mT+4lT+3eGBuXJYC/wXL+370qRez3UIzq7jmpikORbxNZbLH4c43CRy0/p4dTNddcttk7eW9JqP1CgfrdzkP/b/PGvRBdD4MdCgtWXH6W9cSUloTAj7D2bDnRpsn919RQOsNmvrIkV028MAYOrXvBvtl9uje5OJqLquZswKPAvIbej2i9f4k7EFsLYmQ99VO/JySrAI8cfLNeAFL84XpuP1nmMs0Bfxq2B3O3Q+JLFH4XPiLzycf3PtZXdkS9TKcZgpjm3nLjFA2GKMzVdf7iwPzhiyuVg5mn1doHpPRCQDW6/36Eay9Gj1toLQa6tMPg4GnsFW7zD5oIsYJTmuG/erA3OzYhsQCjSWijVimNjAZ7IVtgLlh/g/XBg7uWSsZne5Ezb+6uwfGPdThSNPEOBp1DTFaZIIJ0PGWOLYxWS+UtcKZJANZVWXNByHjY3qSJ1z5q3UQGMFOZPdCiozukuNf/yHpuwOIdLlDxeLb7pAPe0FAuk25t08ZcxCq+prSpFS15VBh0vKgcc6KcsF/ACaJUlvNKZ1+yTOa6KfbaCar7EezTT6QbcQhIdcIddULhx15AKCsHAQlFnMAXJXISJPAv2olZhFdWWwlFPY+fDiFw8GfJeDw2jo/B52hgeA0j6ToQeGYcfJctO2QeITcBgms4Rt8jhAc1epnj//DUyq51ETiyuvjLj7qcqLXT/Pka+tyF5VJFlVPaFQa2/OYxPa8jVLeSAnWnlRGitkfM5TY66SiHqRHQ76iCrpPIhqVwpn2OuR0B9eO74B6ZAAAArFem6pEe3db3X9Di0v9h34mr7qWj/l1XJGv4xoes8qHsL4+pgn0UzqSiunbbGk71aFYwyi5IxTTSqLTU+EtDlXqdW8wUjpWp2GfcYNkSjA5Is65rP91X7AdOmWQj27qJtK7AGa0MJtM9Edue/7Sr9Ry0E+5/nI45kv+qZne3CFKQJmPruMphufTW9/GMiV53MYsPrdmSinqNdWJ6IBlVmN912qCYHUGcJ5OVkhIdxKCczz3bcqerPbuyJG0aJ+VG53iqENgwEaX6a6QdqbU5KU6YrWcfk4ri3hU3bZ22kWW54aq1GFAxC1rNmE/FmTRVhhJ0tp1zxbm5QI7Xwx9uQzYQy7pw1aK0pLurMKkMmIr16B5yRsWtUzsifFWYpgG1vOQiC550Px4FzKSPBjdZnIquzG9cH0FR6DU7p7sk54qJXP99Fy5c60a58VPd5MZELPQ4Zm5zvzHbLWBTGmquFc/tNvtrFRY+q+Q+w2H439zZas/toqz5xTCZz518P1Q1R21QjZvfkdxakZ5+P80hLmCThkWWMvefH0mYveaoWr/QRNXaNE0/xpmfFPR1f/hApOmCKp8jXkRkQGGH5x/i+GWLTF8EHLre83zzaiwVCanfp9aSzBuCyI3kxT6CHuLd44nPP6+GgS4s8L6pVdPaycZe2Ts8k8Fu47XeJI1RJtd9E+SWQeYqE2j3az/m4Dkt/tsOHaDBUyIXrMQhj4BqimL3Vji+brW6t0QyqbkfPQECdzKxR6LFD6JX0KB6/2Ce0D5gyVIAsFx0zmGtxTLXruYKNpLB0/mwJFX4XkiDGWD6jUpcwFT3n5rlRRopxMCOy/AM7IVUExU2uqi/GqbJczwVB3QQDlPdbGjcS02PxyfKFNyaDbnXYV8H5HqDFHGX6lwPbb22AQuNZeCBFuaiWu6J4Q3U2PiDEt/iBKQ1aQw1H4+0RzrK+9ytmIdyhGDKpkv0HZWT+EGQ/XGTZ+mOG8Hw6P07bjmhXJyPyYBb0T50aTyVRP0hrI5LKqeiItspSKpK5f5ENF4h2of1P5eCi+9RMiHLZNt7Opo2Jn4rWmrAN3/uDSN6SVRSOwmrBAesnJwNdMcWTE4gbUME7+upCBtkMd3sc2JMyZAwSgSN1+HBqRLITBYzmDxqf0tlke9GcgDHiBSshbUhXzSZLaG5kB5qnltJHh1JLp6UioF9pVvGPLqafsptc6r/H/qfDVNfzx8dN7Vsbp1TkqAjD/mHBiFO0Kb7Put44ksEKAK1Ah1w8LzT/Hk4eUmOp0vmAbwsdjFVaG3R92Sju8JndCS5MxhjAJVDEslQpGzR1nM/cUr2Ir50r4Z7AczCLMD8e7ywDFE0HrdBtvAlpuxVtNc2O93Im5B9Z2/rFPDRAHqNYZylNJfOmk3m9w+wTqtIIMTXE1M9AvWe8w02ULsXQayZHbA/Nkyns+c3hEzSBO4W4ZR9IK0MujAnsePlCBCSO2LrUMNPqbttsGHpz3hSxCexiOWS24lqEV9fIs9CMqVWK5KF11qxSFhGSAkH1pzj+KMFiBuSdOCkLISYTgxF+4HTbWFPONxdQgxyFG66lmZuxrFtceHTa4BqtZGKEu7asG8z2AQUuHVn7ZjT65zTmTCCb+KkpV6J3CtwZcaOvCDGy3YLwrZNHATFmeVemCUVRYvCLwj3xOKGIQXQWR8KBWo1VxmdIxJom1CJ91MoqqGDBiqFbeVjMyGLIaLYhuiPAKeET4moIEb73mxymMEXGIB10GXflvqZ9KnlvBzP9Feqayo/J9QWZ81C6OA3dzf+tRGGtzRv0tttAHhwtVqEHJrWSzxvqQAoMGPdIwH1FjVeYMvl3+K/De4e6N/FVkKCwvVNxXaPeUKDFBgjBatiN/v7whbfnhniNr4QynyY/8dieWQHWSRqsLLtFALW/gdaqxLDRDXL2LN4I/AcRlFT3JPKnfLBVJ6aPdX/HpN/2p1FFt5mBZjedIVxA+uvb23BiEjw+AW/Zvnz3rGsgWCICKS+AkpGUp5301Wol1mIhQkqMK3+aEKDfX70Yg9tJBoTSdO46MD/ZnxOMNlFlU1XMUaF8BFcUi0vHcEGeZztpoQ1EzM1yVTV+dFJSewO1F/n9/yRcTlBxavK2oepLbGnQ7bl/ftOJYP+JYSyxDf8xcjKTDLyfBypVMljfPf9m5IwzG8L/pQAh9HasDhpydhSvHdpcOVP02A6rhyuN8d0IixpGIa89BU2qoc53GfL3KPD8r9V5BN0uwCMuRJMH04+8evxfUvfQnH5Tg4OBOrvYr3K/aMA5e0r583GiwwBrNY9tRZNRubH2KDHoGDr06iOSfRLCIUazuqiiMTbi9czEq/lV6g3ABrn3pR71w7iJoUCrWCvB6rrhjdKP19AYsl4JDMR/GTE0Nfye6PIzyLP1TvmWRZc23ypDWFSx+pxvegAY4+anUZNMfmYOgvJqPVaAGxsry7v6y9oQirb+RMF9gg4iEL0BD1jMXA2WzJbBkyKlreVoZT0+gmOdaWDix4NKw2F3e9C9NIC8DC0IGQeWIe/aqtcNNAqULSmdiBKYCVOcneuDhEhJ6ZR81rfWGZf8XsuEdXTqxSh+hhtkv8b7zLETRnoKcNsUINrJYX2qsF78Gf+qEiG7igBx+/ifs2mbjRRl/RFf1ZiTOVjAJEZRHASZVBDh87dcktOE7kIw3j5aTR4wzwJzqDMm43R3L1HS7M7zvEa2usl6B+boscu171w08ZJJ3GRJHXhZdQqYQrOdgfq7SknXki98CRUFMEV4DqLuyMR+7WK4jzwa0zH+KfYayjBxHA3dI0DKwZj2P4/K0nwjCSodIRTMGCpoNoXhQjS5GKDOISA3qIFjwVyTGp5oyGWSAiJ30h1QgNuNIDkF7CTRXGv+vWiRieaLWbda/zV7OsOw9VAqO09PW/rhIWWs6NpVeTKr8OxfBIH2ZuUTF76/wiHat/EcrBPf3OAqajNmZOJY4/JkJiqXEbh3/mEGzQCZaNF+wnToJ5j+b4mTVwZ69DHXJ4tVjD9ku1FCHjbs+vmaKcsEoIjQr9fdkIuv5nXOwbeJeU/wAeKQtTFo5K6mB+J9w3t3QFD8uVW4Gvng0khJpnAhexU0njBVZuUpEkmR/Xz3HmxMeyP80CCZBn/kGSQj3wlO4u/uoMWqA1Cb6B/Ix5wUjKw0ZYTwOqiqjp2n+DG36UzDbLLtIBsy7GFlrqN+Qkus72WrD2vKeGWUKlvf6KupvYkjMyBD4ot1Jvb2zNH7sEdLdvOvNYtgVHw/AaLzHuALWxQEFcm9Y48zuFD3gttUuaeXpspmu8bs+qOcuLlhukBC7z8gj+ByT1LGOth+jUcSxo87ERDnImJl1r5M25DGuyXPJTSouUfesBiq/Ex6YkD1n/G9XuEE2LXFAj6R3u5yvxbUOI66V5H5/X9UvemDwcLc7vogr4NZl3v1zy5qUrhVLObax/nWW74g0P2hsqx/yT8MLEPtf5yber+VTEueBh505dx1lPnWC80L64b2axt3HVYa6DY9YgK4Wkw7e2zDecrxvDrqrI485PCwwrm+1JUjFHjwXGLMkSdJDVkRdPNuLt4wBxKkkEbrkRJn/msLm1llf9Plhwp+NoY/Lg/PZMZsj+PBtXReI7+H4bNIfHPQLP7n0XlHC5Yz4+ijCbSCd5kHBlqbSVcYSBSXVoAoGXAmrQKI5UEmk0uDKVGRxwcNkp1/xcw6MMzixtJSihOl0oShK6CVQ//LwERPt810vZn/ktgUkpegBx3z2MUQfHmQFJ/DV+n+YslWBFGSGxY1nEXq4Qkaz0dpajmpMKWKZ106o1VFcBNt0OpH4uK/WEePkxPOLhh7dXsrz6EkxfD1432NNfO5hrmX3ePlCeve/GcAtFBJFerDj0/RlLycnEoFTMUhYGSd8ctmJR7lYOFMGEZGm/Z+WoaEr6tnV8GIvF4/YLrNEbZt2gFrp2yX8FRxyeXNLT32cG4YY+vk2tO7w9eZyzOFlVYZv8u49xQmKOULDKtRvfmOAVP4l7G4aeQ495efLQZ+//vMk+z+JgtokKdOqLNfR99BkB4kr/N86Odt6eTkZn5eZ+IzM6RR0Zb/85Z+EiLNvUsSYgWTKtcQ1Qym1bSd/HxgRCPwr+JTj/BRP7eGFBsOMIFFP1j/sjzWtnxwAD7BPQ28WtDX3CRbWxp01TUAAAAXBffRTxs1qSACSLHud19CrGcSf1wcV6oUCcR2pfZC5q1Vr8EUOSb7uhEYZNWVM9kfYpZObqLmzAQSIUBgxQTX/UKJmKhFHwLBYOp9obUzII9b3bKH+39D0lSrMcR+WwsXpvxG45WgxVjXfAtwrrH9nNqV4OXG4GzDVY6zruAYXvU8zBN1d9BW1ivOwtwCy7G6qn8ktSFDIPet9qVk+DYuSLBpGNZsiQfXuzFhA9YrMJAj8LdmWUYpm/xbJUWcqaYANqinU87igh8qsLPpDewgSwmHuwGa/v1EHHUdpoGN6fe5YHg0L1hdI+5C6T1eoblfyrtWIbzABQYPWiaAzoAAE3DoX/I+r2S5mL19GotBOZsV4UEPEIVMmLD/KJ0/7E7UyzPxi0us0AqzpUmf81zpQWMsyYoAo4DzB9MCBkpoXUjqKuOjHu8RRIpt4N+gcvQViMxENOvhDF6Wg+B5o2YB+FtYSxzfrGLhuSq5Q+bZD2O9WCppxFyqHEl2GIaSoG3U0+uTMUMeZtqpY+m21ZiK38d/Mi8N/B+cMc/gOIvFL5qSxARflGVl3Ee2Ab9RoghyWbeUk+ovYxx7qKtW2L+xJOUnXnI/ymSsXPkfceEKSK9esxcJKSYhv/1X1GtBYyvY9KQQ5/ZQbBVXAXT+JTLBF0Iee+jC/dtSkUoqsZgf2jzF9dE9yk/EkG1wKNYkIgmykZ3MmQDVqeuoRSV4v3KY2XSXzVP6L7a5kBhKTii5wQgH8lldAhk8ExyuPNoPylaG+Odt5VMkz3qNQ1p6Mh4rA1LGmXtSaJVWl1RfiGlhLv4iACE+Yb8xSUw3QcTNneDPkdXu/vtBZjBvOZLBGsCGlA16V50mcjisLLoMcV2w+UH1sXrHoAs6s5/3lCptY9LckPfZODZkMtmNbPIhgUoPNIXM2ynFu1aw2yE+pfjxnL3aPIW6d0Z0iuX6JpKQ3mOMrNjDetecdhD1wgggS8ZrlUVLj6O2vvkMBzq5jqUk9Rtie1z2t96EM6B0MBYzaBs8XFRTi2W0rc/7Rq3HKr7VvmxvKnHsWYeagl8VOMe+YyYEaSAV0YgWw3RPOab2oebESj4Po3f0pHB3rNxsA85n3H2d4UHai0ATHp2QGwg36h8cI9yFtf0YHyu5y6lv6SqlOrb/oVgzkygSIN8yuA76CI5sv/sQjG+a+5TFNf0GQbuANXoOXcYe86nn+lv6wHJJmrGgPAaMZZ+aR+s9chKgwOb3WALLrUN+7DoK6xiyPxb+wU/o40aObgGxO0JU2c/o47LzlN9RHAAI73WFZUl9L6BTcQW/DsJQA/63x02aBNiMtZJ3v+rVSYamqSNtpIehKT38Cqb+Zk7imViT2w+xWO2xWIldSRa7KAK8jUkig8Qac1jlxHt3LXRFDJzk9kIxCFqGyOOtPROKq4odVgSbBcyF7FeupQda9TMgVklrfpBFheY8mi1qot85V9yXUZE3OkGBRTrEndoyMuQnIj6YMn+x98e++u2KJ3NAd602JWhM2xyDDaWKUKxQMHTk1Z97XHhUVxO2Smk+Rnxsmf6onqg4QK2MEPd13hXjxtwdO9Bzc3xwg8Y81yYvSuWB54GmUoHi2+aaqgpilkES4VEGi1k4/T/KB+IExnvNBD5S2P4gN4wgQwTpVBuE1YTXaXTDTwqVJWeCm/E8mBbiwdC2XrP9xgzHHvsywnOhXlEQhZA+/4GRm3X5+x39B3Bqw4RO6i3nCZdILq69c7eL9+E3GcANhRHA6nDIKzJLD3HgfXXSaNqA2j+aWiQlLADJU5NlKIkZRRNSQfQdqfPMIyX81LUfcPztHEWxM5L+AjV+Ts87SRNWyff5qq+/jzIB+F0e8Hb2GR/1q1+NytML2YUaQZYfd4X3+EVlG5SfhwHRNyUeF/EhqeEOaBr/KWkilDM07r7ngAJyGfBbNBfxi3dzbcjZ5BCesQPHfp4gf7MFp8/hWUXrbpuMY5IEiALLa9CoUXiaDlcGWaQULUiO1LVSqOkJPPVhHalRekOWIH7r65i8eB8JLpbdHAC240vHFhbgpalb6s2OWWQrSXcgCaz81MYv80kB02xd3kdoNcTqFGM3nuXKq2hVIiHcw0uYEbE/MHtIfUgsIa+eAKTBxEGQMj130oQZ26lujpB4HxfChrjvpqcPJ6JDI2lvgwL6QwJDyRT/vhSZIi2yw2L4VJp/FS0OpVVXI9tOUiqOztmvfAp1ASbvgMx1GsD/O/AAAABnksi5bdoHfQvjV2J2AYLWYkP67YG7xc8ZjX+saDIV7hnNtMYLw6XQD7hvcoLA3LzBFjMSWnpsQ6HW4Efxpzwole03ZMuTHMZ2EXPDE22ltaOBrNsqI9+fS5YQDPlLRFejOaAZ+HtgNdKzEoLqVMYjgXnvzX+ntYr7zk2j8WyQ5CcydTXZOnWy2TCa73WKTwzxQ/bB/MXodL60rshkJLqbcVZUmYTdJF7tBR6d3/w2KaLPVbWh586cZ+EDugBv37drpGHr6l/OKsvKChF0df21QcWqyvTXJ4UpgqKx0G3/YK3gXd+EOU6aX+Bg/PhdGmfODybehRW1cHFLwAEGNUvoX191x1/gOhvHu1yjjFFoANQWDPCfM4oADY8YLqu4mseWuzVIK+2aPo2cTo2klIG5VZJphz8Z9LeRjswzJtTqGygnPzwSu8L9ooc4PkjAqa1CaJEDhsSZtakjCrHre7GvBJbJp2RfKtufDBvUEFG3GdzWzoDHhrIoAJMFNXdMoqKWX+z3W+Q6y1BF2dqS9lCE/BSC0ZoJnynBVuBtJh4jH0cb6TkDeRisSrL22rsaZiWzIGlBD64j0fZU5SjG+d53JPwW02BdRNnjaFhNMxm7zAyCGEn5077ziodpYuaWkzPsMtcbqvX6ZYH7+MJfWIPcK5jOwdNYaCPrLxyu45otkcxYAV5CMVxdj9J0scxA4olSuQNz4hudyb41ADog4TdKxmnDNepEZV/uZb3vlMxOuHDaTtDO+0qiUM+9Ba2JeCSq7k9BD5zKfOwTuJnb76CR09mfwhamFyfJvs1ErTy2eiDdL3vWInWCBBgBPqqygflGXzZA6Dapwqs+ouWIijhoXNHLjYpVNOhCjMATYzX+vihID9pcaS2kKTySlU31Hit0j2IeFhB4BzwO9gFOhzr8I62LyTo2vs1mpfb+g1mfPq5Ix96iCqnQ6WXZtPzFCYYqTbLR55W8UhYNWPcyjhlnf9/1OSbDyBx43zXl+rTtZFQ2auSiqA0dXed0oWuesIgQpoRnlMGMqK3UZa4B7SwYpfufWhDtG+9FywbPhQfueT0qZGHFcaLF5qmUjqDppqXZjmKbU66RQ1mIaUwIjdbcVtYIz96piXsTCbXo0C1iPcAM2zMyvRPWHflD/ITM/OCVUqsh69dgEmONyYz399NsAxVY+o7zkz/a4YGnhQb/OZ6fr+KeWcgJSDnNq7mKVLuk60D4xax7Qvqr0DcTdwV0zqLRET3xRjbCzVtDiUFcTrNhZ0apyV7pmI8lAw2BEnx71Xe7IKhmtW1Gm/tCqWo5/ElN07XoqIbeAtOfphlV64OjGlZxjQXLJJkygXDfkcZBxPbEBHWlgjUMv+v1hQjNCV9faAyTKSOqK8vOwd8nhHGFaazDjW1Nsxhma8jdgY/IWXTSpyklLbsMffzFpxqb9F8IrzYq4X+W6OTY9yaPtUdwM3a+8imun/G/7PhFle/QbEIANnu1wVIyMEwfjzym0tBmWSAtMjxQ85ucUJrlj60fMHbdLdTX8FpBdp34q5j2K/To9LZK9L7/vVwlJOFyt8VGcdGbN6+AQXP5zKlN9u4EL8UyWDNvSBw9rRLBkGNIhTlwqZBj40WbOlO0WYbPOn4u2uAtB7iaIp0lHN2JA3onDa+oQGkHvhlp2xg4DntvNBPWIXFo+XXph5qG7hRlStFvqzwsmHOJsu5NOIfVWHXu+2P48nt4QaWaSoiQWxsLco3vyVGDoCC67GMuW4tdnuLYPbTCt+BV3R0cosS61/zlPNtxPXNJlx01R6uMfvzYiLd6nJ+d3cW+TSsxxElQWMQrduFfNCZR5bIngb03EVpO8ZyJJT51Fzv+heeyoiZkXze78XQWrhIyFipCAWFZ+hL/T8PIvhZ3/af0U7c2DCjSlEefSCdSAfF6nmLgqhqwxx2349dU+JJ8musDaTz1JzNrdDqhRkdvU6GCJRoIUjvpKuQcoC6b/Xm/j7OXSsM4xEwVa3dRZJbeyPQaUpu4jmWRmxQqADQwvMr510WCXUYyXTAy2dyrOW4JruaBn0Y9qrKDDerUvl7vcxyc6zKmddV9IW3BBdaOEi5xX0nchRxcKzQOaZ3WITBMC4X1joyX/fLkSOCLDYRTPyhjJXEvKDDNflVZkbBqwkRKy0LQsZxlvxrPZIgtJszLyfB7pG3MUWqs0TRLeN/wKSP0LB/cRNKHkIXaXf27HK7Wg/+vCjQQUi+BKAGbGgAAAAAAAT4AOrSev+UHMXbwEekEMGmBmgRrbhNJib46I+famavyVlcKQQqF8KosAxdUFT2dv8W4x8t8Aqxrf6hHb6+UEs3vw5ZuH9vfGmcoI3D2WgkNjj/vxG8seT2T6VbZ2e+6qoHEEL2vGnKarDbczTl6T+/2III32RBliPqcabt6MjxPlLyjSTCHtVkNkzowRpyz2X1dfBr87i7xYTwIt4Cl+Jef8c1gpEPMKH1RFqChWO5sf+iXN51xvOgYqskbTrHV2R3VTQ0w8vOvfEpW3oZjA/1c08IyGFXhjuFEIuX7jrtZKe5diNC1Mo+s7LGR5igigaZVRpeejkrs7T67dY9/YMWdhpptfyAvhmHNeGLYYFf8NoGOzF4qLk/mxFl+pqvJg1g8XCBAkYif0Tq1APetaLjFGCpHuejmXJWDJonF+vBXSRnPsptfXbptYa8EcCXKdyNVCnDdGEMce1ipKIuN1QOZaKpQ4zolnxdK0NXqvgAQGU96C/bISxhuVaBF27j1sjKHfaw0RVNYMArLBqZr04EBW3lBF5kfVx1D8YULPrhx4fYLB2gvoiHAwGcb+cdHQiqBo8EvHCC7IEgEUPiJ23bN6NPLYq+1h7K6bivKrDn0cUpFP2uyGJ71NGEmhWqyHFfR/ijJqx2rhgCiAAAAIdYCNIq2pZP2g84r/ZDV84Ha2H5ngi4K5K8LJrDMdb9YSW+ZKOcDkg6PSWha24ZtZIJMNH3zmt7hH9vIO/mpjqoRrZ4w6kYrAhAVTwddlrYgWbUs1iKJMSagMpXunyGTRuJoKqrVVe2y0qOtwiXJFczdHuGWydv+uqawcnZNsp9XlkYqX5gBFpxppr/+b7snwEH7ebR24ncWcooHhNclH/x7XSRx8hi6GjweEQ1PEyO+tQkcVm4RZ2zSR8WZbAjULcQzRdr6BRuj0HZ8kJMJ70zBY0Ihg7AR4POYYSDD3NCd2jSazP6ITjjc2ePPPxpmsPCHg1CF1xYYutvaUnB16zRBbpGfqtLDpvELF+Yg/r5+OR04GHniBb4BHTTvRv2znpyrdhDPeMh1ZhTM4SemaxcfaX2v5MzeFpwIQuf73nNOB6DkGh3mK51vzpDEq9p5xh9pX7J5YpiOosxEw23kgHOrNb9nYVQHD8gY+lpSy0TnKIYsHNWiCef2t5C82A6mILBoq69fhfr76TkoiH+5LFkJdr2Fx76BVK/VWM3BbYk5P50Gbq1xShz59tpm1AH+U/NeQdpDH8C+nHe60mAk91lWEX4Opazq+y+e6glrNfPJg1huLNSJ0jVvu7ldpR0pxY0PvgoyV9CAptbQ6dwiOGKqPc5QLvjXrf27lYxggc+uZbdPhQVEqFFhifYkvjx/g7wLV3rec3XoNqIYoSjCe4zcsw0F6sjeHkvR8Mc7Idyi/X3HHAxsmyfd0gQPoKCm8MQP1lF8397FtbQ0C/TuYnpiDLYTHfhcMQ/ter4b+CB7b81YtYWTVj/WVdpnm6AurVMw2HSwrV6QYmBmwhih7jsdxfjELGYNPIJM+g9YdYBsUb3hoA0YeYEe+b/RIQvo+265TXTxmUY6Z6/K/8dl0euO09C34WdYccgX/ednFLOaZAq7+TtEMGuMwcrYQ0bo1H8cvbkgZtykhWDqen2wi9QjPd/vuDTwQuK8uXQE2sZ4z9guuHdO16Jj6V9prfx00RnDReJ776YuYTwW6O0ADeKpx5GVOqmKl5V+0jCGePpFs5hGmI6vkwl877NR2JAyUvrVHaD9ZtVeYI91D7o+kLJ9p2HV2mpTMukD659h+BvnleIj05nvZlffF3Xi/5cO1BzXq3eb2eJ/ng5nJWhqJ7owkIZouxpNW7krSeqW4SpKAQtPKbXucdt6DiZsabjmq/say672CsjVHrAUYr/SKAwUA0adyb3DmVWpOW2WHBsO+J9bxVopvzbJRfAZ+hNbC34iIr80DA3i7snGQ+rfBNQnEe1xtWUHQ08sbfwaPFmx4rGSPdDTMmTXLVWQbBBz5YXL+2QA/9UWtt/hwL1lKNHn63JidvwAqCgj/vVsA1swVWtX5/zkL9wkJvGgVQp1eZR1RAUxerWL59lftf1AOvS0DT3oOAt0bwABwhkAAAAAOsX1AyAV83j6QsiyUyjBHLnizJt4ehTvK63UGy63OSGQsNvx95baPwB2MzwOA2I24XOqo8H9ANg2609JEW0YZesTNvaeIEbedlVobz61a7aBC+3pH3onIDW4qjbDwV2ydwDgBgj2HFUAkvd1AAIVvRMX73W3+xMgtsCwUCgNdsYetbWhrshM5V5SwYV8JoZZ5aIYL+FeDVPHy+82uWc1708sOYXpnckQPX5Vkx0Q0x6erWGKQ4M5aqsFnbcFVM4FTqLcaVWsNnWy4EYXeqp48i0YBeDq7Tc93ONJfHkC0yl3SxZ5pUKgb078qkerLCY/lXBPh3KoSjA7udn7xofOPcE92EiaN/7bvpU3UKXATeSpIzDbQBNjJO52cAoZaH10kDXcTtV64npQeHqdealpPlGLVrzyRsYHBnxuqwmUNLiYmIzXDnZKWZ3kqLVn0tm0zCczqPpWKE5FpijPtEqnFKF5tYehZ/z4PdZcPzzfdh8mMHgBhE7/zB6NOebgOXhXmIYts8unjlDnyDnrYB3cuRlbSlNdqYEFL5ywPrEHH9wFIizxkF04/kry8GDmf71pnFuSEABwHWh/cjMQnuUXGAEKB1PiRD+onwqUoEaMbGiusHvhXIGIUMwoN4lihXzHVF5IQr7QH9/xzBxhTngWKI3Aj0Z2zyQd2ELOo/T6bsgoORDm3zZ3SbhWbPr7v7obU0rU9p7mNWFeW4hTQ224AZhUUf/10S3JL37FSDvipX62nvk+534HfZoNHM+mgGQRNYJRSgO1SmqAgV1edB+ZmkCwZep7in/hKP9gA9qZjT9k3vYCK3vAXVBAyalrPZ7qFTSmOd6lL6/hS7r9b2RMEqEiTL49zQWEz2szpT9G9PeJ7ChGnvLeG74XCB5BerWV7Ou2KStsKHOwajrECFqSEXlNmQi478sDr2EEquy8tLhtBAqptzVkdWqoSqo3VTo3n1N1sjLQIv9W/+7dAazm32QC9ZMSP+w6Yjcpu6Smwx8rkGLfxQ9a3J+9BwCF82TH88Nz0HaOlPFxYXysaXxVQJqI+iyERGBDDmVrnb6xdukXWR/HkQFUMoJW/ggfcRKW/lzfOf8CoSlVl/7DhhLJ73H5rB+bnr/X90sEmx7aurO20za2Z7bBhC2f2xkKR8vyLCjwOm4/pBp3zyXFQK7MBBY542Gdl7r044TslHtdD5vInLPZooSUQEWQHmtSXAbJvJi+13ipAQdlqwW4FMc/zv2Wm8DHUftFtXZGCo/RAMx5mmwVytvjGkc1gWagwkK5iaiFFpCbq0ZmYeBzyWksSZ12/Wyi76BxpwSceGCy/Pfyoy47bslRW/pHlZ2BzDa+nk+dAP8mnW+HiMWA4adFq2tmvKYLv+Rx+ryuWLbjBCnCV9B7KVwJqlyv458aAkNoDc+P0NBRVHVyRGlWZKkMlF3GT+nxsb9a1Tss7f1fvwE/TG+HQy2n+B+BJJfdnFTsg1rO/xSZ6pIm7o4+toVnb4N9RhcTrfleVEqvs3KqJLl5w8aN3kGxsLDGdfPP6JJ+G9+thxYDv/mQJ7UGb+KN25KeACZ8UZk5u7IHEo+5YWMdzBaTdrBgpqMSC/Rjla3GnYSqRZbcAaTNSvgB/YDaZ6GGiROWBkW0EbXv8X7erHW0ZeDXIgBK8ECbjrZUMEfLWKa7cV8uCW/X5g66NAVakFzEar2V9v10VGtrH0+WVzAe8ir2OtXUC0zwTuJRQsUszWxlOJac9vSP6E6CG4T03sib5f4MrRnEAcsE3UJQQA9hK46T4uP+IVRfXJLc+Z4QL7QLMJz/ovrVIcfjtM3HrI9MJXqfPvEhndQNVWOwpbgfycAeLiwzmi1qYnzIr7VkXMn9zE9FzrusnDnId327+D/TCO0mQh9860DA+M1fH80rlI/QQjI7y/uSILo2hSSEmD9XcobFGHxLVbAVrdlM4/Hu2g15riDPVRkTpuyauCXL/Pe1f6CB0yUn1sijta3azPDNG5aojjhg8FdtIWJKzSNvnD8lS82tw5cZ4ap5GbkK0tnkDl+O6JHZ/unSJQNqtOBbuvW8KO36UcadpwZwHTK3IwE9kVUpq+ORTNBA/fQYBNGA9Vyy0RLv6bx3ffpCJWnIKWkE9eRCdA/wo5S1pWUn+sf5RyZwZ8/3b4in6C8NyzdopLQWsX4NTMRupfMM9NaZQ30IAW4tryhPcTvqWxt5QSQlqcX0MTN/o9UYxocLAUoAAAACQBgdBAqXI7gR84rWp02O7L0e3dAhVpduT8lRPJiY36TfV0LN1qr45ZOCF81h+r6PV2zMegqTZt0fwOpaK3YI6hsKsCvaCYKAcNK7xsUCqXsMGh5u/iXSpgukmZ0+ncoL3Grbu8ZzktQTl27WqdScNmCA70aHp1LrfTy1CcGFGa7swRAFzF0mprtP6NLFX8e5nf+VmC8Ip8SHMP0P7q6z7uB/jHcHbxbfcjdXUM3Qx+aTJbFacpKpn9QNl135DzUKE7JlazdgjEanHM7assgg/dIbk/19E2BfDEFqaxFuC1/P3u3C7N9ai6hPEAhhjTCW5rxVlaaAXaZc9vAEUoAOk1Z8U7801g2YadqUIisnn2Dn3yH8HxeBf82sweMlRVzv3TnZzL0j+kdnX8Vd0f4Ft5lzzHxs8twL/R1Qrb53O1foChf1YSigR1xs6GdcZBg4u+H3N6r7pYjxs0NZbOuzvCtgOaL28Ns56pRaIlPUH0ooLiDXa8SsjHOYYwOzjkAQ1O/EtdAxFcBtqKGp1IoeaQvEmLXaCACbfDq3T2pozePpDOJwIj2+OFqZBTxDDATxxm0v9CP8337GP5/+9LpNXJIkXf6zEcTrQ7L742ePw82RQwvZD5yhJBcIOnLvlqVhtnUkAJHwZoM/r/O7nRju9fNMNaRrik795d5JavMmXFOBLEVpRoawrI+TtQyUpB/Astqmqh9FSMJffbbZkUA7vnXQRK4ksajR004Ks9c9jlTAqIQQAQ8O8f81dnfKz6QCeA3YtvJRjN1MuHh8CbWrTBE5lq36TOOadK28TnKUSsKYkAMm87w3s9Ueifx0V0EB/iZXGAsq+AO/6S57s5ZVbW4O46lBgAkfIcuy1gco39KT7xtkW0J6DyyamGbu31QpBc2vcmpyqF+EgeSvqO+8R+9hdvRjkdWPFOctUf8/vQU2ez5uVDFTw3be54pNkpe5EY7055Fa68BxzAIBFddzxCoohZ+NFrUrIqJedwQWM2SnT+W3Aq2jCnFUIimLDEcl4wz5rKZWpuvfbLoJwMhAAP3O6qMTaaO+eupzdLvskknOGa7BQBwXMbMXqu49m2wODLiUYuBgQpgZHkNS+bp7ar7oHTFXr0OIqbORo0xnS1RP2c6hz2zCJW04aGLuG3VqZdV2OiG1O+M97l3uk0WIyu7WTC8JMfv0joQghVDVp+B1+z79/Cljx15o9SQ0nzQgFexcj76KEBSTxgldrMfw4b9UYEkrFIWqWFQdsPABAl+SmHl00NzK30tT3OKkCxbLhYz+5esSmxCNpUNElD0bbwsiLb+da+1cCEaM+s3etFADJi0s1TG9BioyvC6F0N7DRUgbuDvKuEwMLA9xib88fUj1ZZ3qV1fLWSpTStLxvIN/YMxksJ6aZeCfYmGTI2VdI7D9e0fKapeSDIg8WpAUQS0k1694cbPm9TSMDO2CFsICQM5SPwozneGRJhBRDO6iRiqCTTEEQo83TyxGFYu/1Il5dMRaefIZQ6nxLgo5TXK0Dr81sSSReZKtD8HaVwY0qt9wROaotdMhKdaOJDI50p3QvbMdu3/sIFFRKvJ1FBcvCMLqkrB5K4Fl1oRzDsXCqf1pMvgON8AwbUa0FJY0C2L+hDq4qOqT0w79+aeYG33MtGiC5SZqXhnbl8xzT6KZv5C6gC27bDxv26hpufkecUqbfiH/BpYD/K4f0r6jtd8gSUFfweKTlFsOm11MNqXeAV43ftXicluPMf0icrGfNYrqd4Gd1K38sg26u5u2Rf5f7wR3Pz9/BEbBMA6kjDaW1t/icWW6W1EApHbc7IMCmA8eYLxskYVUuW3hbLXCkhBrkaD6u8OfjvgxxreYjJerqrB7H2OKVRdqErJrjc8SwTiBdRjyWHY9Ujz1n7lVpXJxu/oouHocPJhBX+yylE55a3aczHZvvmZpy+qF2uIx7OljjVY3Jjzxz7A8K6f/RnVyPXyVJGi6kRAervTW91Ie75BvGzGB2BCrR4hU1mH2G8a1ounl/TLPqyqXvPiH1O//pV2luyRiz3k0RbrnxDbNrbL/V8WnL3fH7afC5pUaeLlNtMSojpZmabUks13B5iYc110ac3MECNJwzLBV5LKUePkj1/fbDgCt3O51FtOcRNRbev9eEQ+L0BSeYaR5nUMZoFFSko/BHYN8oQwLHVg49pXOD26RZS2Hp7J7voGQGDA95mv+h1LJVTB2Mx+5B0znTjC8FYQmwFD4p2TJ0weW16VJiKFMyR0V52wKYzDnM4AAAApE2kIm1ckvT338vzBjivsDB3JQwW7IP0jgwzAAAAM8BuXoXXkDldAbzWpYPI8X3kbgEtfvXicdw4+j2ha/ibO+heW5uIXgvkQ0M7LdRvqKW5sYUKyWPWCn4k/TFG5mM6g9o8KrJxWohGKD3jXZ61FPslxB64JAHmDBtHrvV8nj/kkvhGiYPP6wNj42HJ7njI2cMnAn7Lx0R639clAyIvEapmi83ABHtuDFPxHrIlFQanTMpegNT+4+WiGjgavIxRs/Bwn/1zGtrJIUp2iyDplYTdPn2/20/UbUBclI5bznA+98LJU+vFWf992g8F6w7ZEDboA2UunZOj0Mhmug1ENhpYxo/KNo3zuVWNmjPswhj+dzt26a00j5M1aJu+PsBdjjdE/msb+0xyYBMDQ6DokDUht1HnB5Oh/7TRiArcSFm8mAxYAGIIqjby4cC+8xBBROJFfc+upaGpnskXioJxNg6tVQFha/acLT0avzAN1VGa/3FE+e9mLMSp399WrJbtd8tHs8V3QiOgvbNbGkZZd5mVRbYboNhlvEQbml54+q4mNGUXEGXQVJ0yxVzofzcbkNkHmkLFC69FuOdFG9zCi0IIrrKl3/9MIVgq6etMeS6gnkPeQLyidsKrgAwpbweqMLDYK/UkstLakiNxlANGylUe+3c91hTHecR2MNODN3pF8UnBbQAL4SlmCStpXdeb6gg7OCS4NcKUjC9ESDfcPYqSCzR2iNExd7undb9AqEpbt8560Kymh9q/vkOqIFynNaP6JxGzWyAdeOVp7ObY+fvCAzbDI59DHhT20snOgeYtJzgIqPN2mx1US85chRFmUHL4yH+yDKWc3uH43SwA+2JvNKCodlNIDdxnax1FBqxpbIH4StpPTMMLiOb1FWcPdZOaEGuEAOQtiMC4Rud9FOZIYKImNkNSEaXmgA7lPAm7VE6tQw5gqGufH8B/81s/wfmXZ81mVOFL/sc/pYP0Inz3njmLIzUyKfAWoreRHKet/WdtbmC+fzOa03paOmBKSJNYTX7xUcJe3q76px3cTTfglSBSkrAqPR/SYIbyDLN3oFXdGHsBzNn5MSKaEkInlP2AZP27+ZYsJukS51cMzxJQ/xpPUIJqlIPpEuUpKbaFtIoV1JpFsjWKkL7clfZm9tUo96WtdI4X5CAXKW7W1F5DYfxXjpWXYiDJBQuI/CTo1X5v+3TNHLAC2MU/wxGpJcg/UqNF3BHvEUDq0sqQY6cfMSf12YmaX1jmikTgf1p47/Tbn70Zb2WAqTb4I+BuYnMpbThl20k4GCRMgdurjxWGRfsTLJr4yipmTDaK4g3uSIs/aPi1cL+VZhTlPC3LEZbB5sJtpjK7NKDU3sxaXuMIpQye2hTc6eQOqgXe0jWq3hd0uEjgTNzuqd05meOARmt7hCoKWheDXb8F5r9Me6ALDvVbCFgffx6c1sdYNjjF41i7jvDSIc+Y5C5tOUTygmhs5LWOY1+ejwFWt1xuMCg4k+IQVkO2iLKIkTuklOnsl0+1viYc245YLfrgXzDw2VECPhhA15kF9aW4A68iHPQda68rmUKzG9091JJuFwG8sl6sQVNEMWJT4bx0+HsjVBX0ozLmVA/tk4EGuuoYjkp31lUKKnrTOsrLzYkk+oixxDYd3oXGVRsMUUxk3d5JXkIKKKMoEC3oR86ygdQecGCAP+abxyDBtjBNn5hq/rss9rzwSxYhueNrkK6dXdSfXeaOQualStZldvV+MZnm+/Bhu4dil4+ChS09jrXwXGsEtScybHWOL5kuYU3E99Pfj3VcJitx1LMmwREpwJhg3cfBq/fpA81o1Em4DeMTRq1I5JDYvcAG8vM58ziBsCgYJus84wEoC0gG+KfUpaeuAHmCx2FRhz3C0fL/93WWjX3esJjD3m/iaPSoU6J1RrVtdXsGWTJPdfmPNCgox9VnRxsb/OBzkUVIxX4NRYsVOB0eUqO0wJF30DmDlGc5HHnyffd+Gxfngd3KCaNOQMeFzl4n/+olWMmpsBRllRquD39RrRr8rqRj+bdGi67OQCTXFryRm7q2WBhrCZL/hLcMkfP64eusRaZJD+hjAz6eklML+wLlSg9VGJrQDfzglZI5CAuX78HQEvfDnJd55019g9KbiwdnRIh0CZevkgnMG7P3bFTl/OJH+yoWA9skl/uo/9aDM6lBSVXxpQzUAA3XP6MwiJhN8CYHK5v+NY7sq6mndJhOhZ0LEvb5uGTJuGmm/Lxmsei/txpyBMLg4B4ykGH1o+rgwP+fwXOcdF8zm713IKtWgarpkD759TCkCI6JYMwMMLjzVWi0C3VjVZpNQQkb/kmZk1TGQrEHPdZ9BVeA0uZIR2nHYrkvUJt23Ch1kf54lDdWu+Z7eGkl/CKymcZeyOsbMLOFA6ZYgVV4DHkevplNR19GMmbMwyiVwWMQOL14uWwAOgKFd6jtR7Qj4vKl8eix8n79EPE69zcaUGYH6EoGtipmJAtdxA83zIMp3i/GNJ9OseZO10RQT2NE+LZV8yOgaS7XsUpDmV/5UHMfrZU7suJPXIh0SmCYQwJv27NKRvvRcdNgECx5Ag3AG7S/HId0vRDKPS8FkHUJ1GSa4J4hbGyBB92acMr/qq3o3C2yOLThQAzqeIhnTE7uwIH/jFdkPx9mWjRG4kAMKJp1DrGVCnnCjz5EoL4PtLuQw5Op6s1wncfPOfBqj6L5lvCCGz1cSR2kwWB0TCe7r1p0f1vADxGEp6oeyKcWvP8QkzE7tmILlfbqfbKFRYPptVoL1gZmlmAf7Kgimquu/KzUZiQgNu978tVrxd2V47AcTV7LYU0o3px6Bm4nG37vmRr2fqDDNDPc7qnkU6wx8RmvNW7o9h28DD8DvIphQf+8DVEJbUr5vJF/ai8r955BaLPQkSglRbyjKexh3ahzSr07go20tXkJieac8ZqRjGvTWORzVXW4Hm1YFL2F2h/yvDIxhWJjp0Bzcce7nrW0Wf+BtA9Zt0piFNaWIfSZKrvGemRdfhCaStgjyPBHj9BH3D/HidLzLdIzaitZYfQChORqlAutwRYJ4b9dgfD83F617S+JVaAzxEuxTU5QIqEUB5vruVWXA1gwzu9Rvy0KYx3in3jqhLt1VVzmNAHzsABkQgjMRb7qvR4ZF1fw7spRNej621YP4uXOQaP3sSVsYzSZRDqSxQ6MF7dNmV1KJr3VL94WsP31MAzzml+KzOPxFtzQDYwkUHrsJxItcVivCEJk6Sz4bnIAY9DQVkb/X4eE7S/eaPwZ5QhzTujojLKA+4eiL2OmY8aLCFCFIx2CnNXC3FTLUYwvrkZrIMq6xhYwHr6+mjU3MHtgcep3nmrJzOinDl9OWomyH43sNxTUYJJvUF1isUj1y7ipa/FUIdZN2Tpl3tJ6ycQGKbRq2ffj4X7YfipXEnOCFFf9K33PWQ2WHHrfnyWFj4QMUrzh2eOPeEUwgg3iR1VvbKQ9Ir7ViqN+fvsEOXJmAkT9heIPEhhSZm/G9GqaWeILLkzmOrjQml9gbczJCWrlRDVr58iuk7ELrLzj42s1V68PCfuLbl+vDSpeGWXQW38D1hT74Uajidk4he3N99e4JpB7eNN5zC0FFXnsTCpej2zeCBXA8XVFc4h3GPngKPp4CTmUCnf5t8vQgRkmjU4t4nM0vU6Aq17lJeZTPlv8PkeUv0IBYLCrUFE5Gcyyqt58y35Xs+CPEzXSCtermHK5n0W1/acLJJED8ZchRXhWgOoTy760by3y3Yhc88RPgAIU6TRH9iLehgHwyNEoIGegtD9qLmwUyqwQaoA6nXjJhZk5R3rG2u3+Mmxc1LOEuH2mT+3lRAUA1OSwTx+nH7aHK/2CkbMSR8Xq5+i+Ainzk5Q6kXH0uC2YVcXNaNqcL4YsPcjQEuO5x9XRBNv4F0JBlaIBCYIM+j+dzC32M+IEm0ODpoFFU5omo6ThJ/wACL6oLRkZ92IxcWzZrb/OOgR2bBNIdBGuxBRVn5kVWAFv+6C3P6d60IpdOfN9z5xpaUVlhoqxNz1+qMbtuUENdbZq1UNq/lRNCb0KfE/J0wvtKf82QJrufdP4Xj22/2nY+ipzB4wx9aXdud45QsWGafMVJbbvvFVF9li5aaBJjkDk/wvGrJVSM0oVSSvGyu0gc4Ii5fpM4nWI/oi5xDOdvf/c8pFLTU8WAXWM++6qyjaCCbAXhhYhZIsPYuwLXhQ9iXXnXjrBFj74Aomp9r1N248FiZTwrNwI4pnj2nUv1qkXW5PES3SDshgCvIl1JwFmwiAY9HjUcxBFWgiNeUMq2cDkD85NpA4mRKWfZZPYZ3/EOnWLWzftODwa/HF0KyQsSdyvukNJIqVtbhxPulSDqYwKcX1DoFVV1jheGrUOvC+W5m+vYMGMC8x3yUcPFOoCRbkyAvU2LF1/KmA09yU8ccOubZdaWcse1WvqdnewHBlenLatgjUP/M+Tm0+u3/LzuHoBLX3Vlso6uHUm9ckMCvQcJSt4MwTkE9A0XFv1c4qjubs1s66skmoyePgjK8mFVrJxaJabn2dgOpOfN7EQD8Rh0A27dLEhKImnUPWaR4BJg8/zI2ZaRcvCqGS78u3qSWpQVYypDPY8h1S9QeSmyMHYPcHe1iDYE0P64nocUDkEu84mtZ25C7seUEzoC3xB+23s/jQ0BKZejgyMm4GIaDAi+UJs8REggoik8CYozv7dlpcpKt0RBUoeQzYOhFR9aGSKf3kKKq602Q0b14J9Jw+7aptiSyuzJR+8I8xuE8Zwb65rWDSLWaxjaVOIqcrVYK5o8efNejZ72zYtyJB3inbb8duRphKwqa2ciitQ+PdWQbB+wnpmN4HFHx3sVuRdHQooKDloOyjOYM3dWtrImQuHJ5xOFuCwlOWp6D5GIVHpzm7Ckn3gleZcVosPan2lo+Do2xe0HGux/CB7+Uw9bZQdlT97l/Mhj7ow6NPv7zpeoYchHsf04gdzREe5UzD9wVtMY+RyMJEmff8NTIwoAgx/OWPoyhpYxr+4s27ZOD1a5yY1CtN8C7Zknj6jZKgv7JYd2llQAtp4wvVxRjnCowUSiBfDakRm0snt80jz5CtGQ5E6EYO8gIXO7P/Smha7JCgRsWfaZ6n9r6167YK0COMWWxzxphG2eGkRAD53d6Jg0nffBR3w+hgwuMw7sALacoTwTdVwzrgmt5pHDMHls1dbA/XAdmaoIiJWstDKdJptd6xcw9y4PhRVem7tn3SoPeqLk3PBQedFRik27egesgTkyOMbOuywWfhrvhEcaXj8oTxf6cLaQfBe48RQ1AyeEIkjiTZa0qCpCFoN50IH4Qu01hua49G2ejsvovAZtXZ4PbgDZUCqpf4kd+LjgH6CT5rH1fL+LKNOp3Ky4RRMuTj8CJCa/nDOL6wf7qHk6J4Jrw83mInP0b8Ovj5DEKUAlQNm6NmuP4qirnr8DydLjYKw9CDsCGvbpvOir8ELj0UpynLd6xlVBXWeujWQQfeKzSNSUQWwNGILHT1P8nTDmeU08oVwY5/K6Lc6Mx93fssGWgNUwGLFRz9pQX6sz1btdCfPy1jlu4EHWy1cvBPiyd/kHGwKB9dUBbTLza0IJX4fMG+grOAyXDVnqzFyfLoxj2Zpv8q6YJcMV1tec6C0ZVZhEfgFSdJqOcHTC2z+nDQMCLv9bCJ3Zr7YkxwfcG2udBb7yFh+K+nPLejM1mDpuNTTVhf2ZRdUGKmsb5aA/OjgyLRZGKB7nj5azG9Gs+j+u2aupkxY1BccYGyMs1/tcdpqrdYfpTKjHEkP7cZzQsep3Grt/bcb9H17SxHjJNjiYafvM1TPxWy8i93I5CbmSARrYD4BXlSy7ZxQX2c9xIbTeU7VzI4+2EZbnZpS1OB6T7Svpt1dhzeioXPdjaJU53rFyJ5oa1lRXW5PxlHGOnZGJdQbdB/BJUi7xuBbtEpTytvNiC2zCh6dZhzPP+FQWKT8eL+7lnFYh7fHr1vgAaEvV4L1lA7dq3roivz/YeV5pWxz612RTswmctwQ7SuuhRo1b+WDQWWod8B5liH2k1e7ODkcrsQb5ygPQcs/Lg1nrML8uBcZmxs5o9PDNJNgcsCP5x7DCkzb4LLgBRe4KPkvy4CCLhaBk48sSLVvcFsYCW3EWb6S3cTBRI2vbw2/vwGk92HWQ8jPHu4yDtQGjgpP2aA0AD9CMNX1pqZGC6sC+Og11hoOU3UwFzVNdgRzH/VxumXu9S6OGPldAwlBpMCXgPbh2gtEs+j4sgNu4AKYMkkLR71UgEwG/kgS3zIZDhF+ThtnojrD2LVANygB0QZzzRNBO6Hp2FRZsAGse474BIQRQEdY1otDJAMWCx4AQiIcpNEP3Zaxnr/BjhSxTgCfZjX2YWvfE2DIdlVq0AhWqcNYgQGslye1TPku6LN8uZevHEC1KqFMlmgEz3aSIk5ItfvfWEW5ShL9zoo7uRfr2vIi9VjOYwSXLoDXzc3KqBuVHYW6RdX7GvFksDM9AmRi27/1ZGx5WLpI/+yk6CEX2paICGv0IFhuzJcUNbWZg0Pjfxb/WteKYA2IQSGofh1GKOrJYslIS2naeCUIBIB0/qJveMChNcNBD98kc+ZRoIuzEjE/P3Tmr2UKA/TLbLc6hei83/TmAQjPBa2mmS3v7YEhdM74T8f2m9bQZlbU26yHNOBdoArN++JBQtYJGII2p09zpmxvmhQHyqpRGyvUQRlRtvmmIiTY2xkenrCw7B3zY9UDUCKAx/dxHm6wbRqCB9FpNrrJBISy2YP0DG2ebScQHNtW9YWdiYgtPVRJP+ZLHs5vXlMEMiY6tKEZxNq6RFHp+LJNrvWDLJTYF7Jdr85mo0voua3gtme7acxujQ3WaLMlGK7RvlFqGSAVonB0EmZaMvPUXDujUQwot6iBkfl6YmodTqbgTSlOqJ82eJ5Jt4GVyUiVCtKYmxazYx3m9FdOLX5TAKXZZ6G90qLx29KkBN6DpHJkSIXsPYW/HKtM+R/xwf5b/td6HDTlokNO8QWjuoTiAXr+gSx5+IDPyQBa713EBKmizMbdP4ycXsVAIr7BBddA0HjbcE4bISuCVklLeTKJokgOgjm4TR4lq3AYfKDY3nnUKoM1canrrC/5IAy3fZ1Dta3KqMtQ1icIxsyvdtGjSOezjm9Fi7wZXiFSa9ZxivtmP8PnSWc8LmBI1KQN6T3YHaCKQtfiQq9qFmidEyPA1A+VK5JWCksKFvtR7Qbzf/irRA02gxaFdANn4xcHF/vU4OsVbXMbP0sqrWvzRHodGNfwR0ckp3TGUkvK11JW2IXl08tV6pAKEnLrUGBS2WJkyzqb5YLKKXN+Q0do4Hg2qA9yMHBZt9A4Gh94UWs31+Ff72z7z8OpFfhjrS33QY13jYGxkF2E192jMZRo2p31ZQFMVitP++Ez+yPGj0s3fswEQOWINMT0ytSbejBeT2OiBBgxrna/KrpcLIrekbCrVysc8kKDPyDwjuz8qM6E2HgToJ88KTz0YlOkwK+N0b1gERCWVWjNxvG1SnKvQlR7+moa23uaajK9ngxswzJHEH9KobvGF2tjOrr7QulxIj+DsX4oeviClNtulKlMZhW4POA9g7xrdILihn8QVN4St/15YmMxluMoDDETazW1D/uxhrWBp+3tcyu4JXrgn5+bztUwE9NDua6OgeXJ8JQCEnUp5yD9qjJGsqR93HSfwKCnJLDjAK9yDY7+6HRVjTEVece6QBlh5WkFipmmSt2Qf5xKcoULRC2HrdJRmsraYNurjVZyPf641KgUVCsuzq5RKPSiokdQYcdfC4/89Su8dJ2PUGm7h721+/UkpV27Amnkjlv42pA6bQ4QWDAkCfyuBO07RsCXDjO1pFPi+7IRXalJA7EzWuzFK3Mcr7Zfkjwx1tmvIXV6kTBOZi+NuXzmFieUvV+UgRJytLUebLWprbBEmRqLK8/F36JSzCpjSZkzO9/+k6oCUSdGNO8gVLSM4yeKcNyqJfyCXJnREsfgkxYQaxeR3v7y4fh+//4xmyI0DX4TL7qyk/HZaUDt1M8UDFaPoRoLJ8iu22YVrGBfba/k/ExcNL0976lFmi3lsIRSEoKMwOA5w7En/JypjiZqPMvQWeSNhKnfn1WytvFt8+Si3GD5zFEDafzHcFPWSSFBkho7M7aIVYGFO9bKsOzNCl88+s1zny7FegAABkFhvV/lvBjfEeVh8Oa5ZHgRALMtso3IQbkEwaQWso1Lm/zkVxlXuDYP8o5efdkTVV8Be9z9JMJa4WIHdy6wKMttBEf7UVULFITmC+PJqaw7iZ7vImX0KVGnzCMprbYx5CRO2i2UgG2ga+xOAmPtf2MDd51cj18rURWXEkNHf5ZX1e6cT5tY/FiQcijoXzUzqdbX31Tavw4z3+obZSz4ZM7W6re9LMUV0JAEmUf2vgLvYoLMW7VIMUKmBrGaH4iuocEp37Pio/Zip/Ejbn6jFbAuyLhVgXHdufmgeQUlxhhx+KVGQoVlihdHStT/3lV+PQirFuYw1eJDOoKS620/D2fS2m4oJQsLSwDSLfwQTrnFI5MwNDit0oWzRwbXPXofrNdgTd2qY86o8gGtRiWx4SgDJUIbkOoKe/VHTL518tTNwmShXbeM2XnUX9jvWvfR+ypNzR9mRfOv17tyxlpElDu3KIbgdgOSZuV4x8FXRu3TSNoofzcSamOUeoLQiIsJ8WTjtsGR5JM8nrLkkqJNqCsiMLeAgtrWp6WHU07kUivQWRfydDn81GHHsems37a6c6RZw0pizFtHfw0UdSAsXT+vELsYF3g5KxMC5V7hnMvf77kuOoBgWhkclj9gmghgqmd8W9QDWt+a6bRtcmnyXxq6v50p1pD1fcSd72Png2zlH/3sN0mZG59+aV2MyEJUcZKi7iNBDNqbnJLug79DDhxZaaD7dbHgeRr5vLy0CObHEtM0UEjyLmQWIeXvZXoXqSLRCB3NL9QsL9HJFatcnZO0Y4DNE48VkPo63JEKJIFe96ZDVUPF/qJHFlMO63hXhlDh53ulgvM+ycCY93FXVK7/mJJL7iFhNkLHJGqMolUEN4kOmTu23kRnPyUC8zaq/qJbD7ojE/ZIX9fcTKqlCoXBixm/UKe4EoSg4R+Wo35gJs2zpPVaiCBSMqon9L2r77ypvIUmNZuhQhvp7Ea3URGXTG79/2Oj4vlTxvz7ffOYpMu+q0/dQOrA+PYArh8yKplY404gWNrWNiuny3N0YV+GKcE/v75r5MSPtjoTWHtU64ZeOPyLbskJWINIP7OvMEtlJd5J3OwnfPW91SX2GUARCgVOS/V0T+aZSASZiQIOfXlJrnq7LkHSJcxPe/fEB0snpbjc6OcAnoUb/QZbHcRJCzwi0fUh/I+tv99oMFAnpg7kop7Yro8aljcgz+gcfjfmoZpfcHNwdWtyos+nv4zezca+sCqxLarMDobJxx6tt7DgtT7lvId4ZvTuWLiLvMhTUdbLH6EGzCE5oRlqnr+cA6hMBLw4enYNaL3nYSfUFO4MCOXrEWdg97cxp9ZulyW42uty0DvZWbT3i5O0liv3RmqPAN70YjAK8fa0ya1pw4OxE7j/w9Y/eQcJbDUlGsBBSDsxTKxdvMgCiIW6it4I4iWcbGyh8bNtPRPHrqWWl+q+gTJnVUk1JDCsloCFtogMiyyyTE7nhu8V9gSWXxdDDtVQnlArZfAwVaNbam2TWkWv0Zhbm9p41i3AE/exBtA6dKqKs3Li8E/TRpxt3JARR8AtNLpqnrA+0tcyVDgYcFAVU097UuFPlr2hb49NgR5Zyf7TrIUil9CKP+Wd5h72Hq/09HVcdp41jUxkEIdMOmXpWyzpT+sFFBwHd3wlCOJ2VSjrQMU5wpSskkbynQafjqxBUkeaPLbOGB/19jv/Ncrj3eQKcwjbx+4gP/zhfC+45s+0ix7xa+hEGow3jKjartivBbzfqQQ8NF5dpQjDtzG2ppfn/ln1vH4HBoTaqtshWUtfOSGYRQLDNA9NRMDkmRGndAOTJKFEAO415j5VitnJ9eyOPFOgzh6SnbDhRu5qtAOnPUF7HIaMdevMMqIRjbNQ3UYkQ64vaEYy3W12c85XFV4ALyy43OxLhtkELzo7WuJGj3UcwKqE3woVBDX18LUf9pO5wclmIeVJMYxbmXwvN2L+WvWQmMhoinrXEZ1y5bw3jPq+0lihUws082LZcehoXayewjWTwxPsEbkrQ1K6drOsHQNLIvAmpLypnvaaUVge5jWJ4qY/SmEOqCRfM5GXA8KZqbPpfzQBNXb0hvcsPWiRSwwkjK+jqbH3ryTOINpuix/6Y/ssfog0tyEJFq4ZOQRIRWPO2atP2qTskn3n58OC4HGodmheWS/9Xqd68URHHpNE2lX98fIuQFcBbzz0rQkBrpTNR/K9EDvM5bzlEWQzLVzguq3mWO093EP2Ovs9YE2Ppae4EhjPANSPBbvXMB5ChVssbGXGgbkJeYohUuBgvkYjW0gWNfNIeMyDtPKLJpqmpgs7mtUez/xI9xWhsKscMqMlapnbk4BR8WlDy8FMXAzsEEkVogImL5rsmR8b+RanhdnjEXyYCoZcrR9THvWOlFSU8weRVV4x36jF52qVJUFkIg9DvFewgwB5Ze8gaohmmJY/58zFQTeEv/nbv3ZFJS62wWEUks36MdHTdAgemV6UbQ/m0o4mnecvbGJHvHNwH1AAncAoOoYYHo5ZZbeC2HE3T04xrlu27iTCKzailETpcGSPWuFUicWySJAYMiZwvmkpABnV5JBuxx0u26guMcq5H2XAsbeXivUy1Y/D8W7kj1vIwI34M8D2KhylMuHZiVshSRDwABib98et1Ew842aIcwyHjU8fY1mkR+2kAD0S698CMMdGKUsUpbD18Gpc1cwsc03qaFoVmDZ6yUg1DUGg1z2uYOp6fczLPqiccDEhJGWY9vS0mjM4C1Z/0VeWsbV9u1sjL7SQ+ZwOPcL+eLE4vXKr9kYSaltse+nV/S3BY/yJ4+dDfbaAclPqogcbaE8TFWaje9NVOjHcnQ9MKexUMiELKl4BA0VihL/k+w3M51aLOOTwKtkAlRUlX2v6HHcx+MzBrNulVd5C1eU8Rv9mZEFfnlLXFpMdw1DvWI6yJUe1AWycO9ACNAks+6rB2rsZGjDP3Lsd9cEC8jZ7M4qZu9mgyTpc9XrGJUAU9M5oHk/Jn70KWM5pOXmos9V8DnlRZT5zef6EltMAjoffWH6l+oeHtHG1HN7/nPES4qNoAwnFZsiJtt38bIXsfZNZsAecKoaSgx1rhYbWHk6yXggQsqfu5yzjMQOzAqwgOkDSJLSoUT9p9kC8NE8/uSq5lmEfgipeSRuGlR7MC0aUEc/Xkf5S/B/OZ89ZjI4BqCnw8enHqyRhSPbsWpCNdlWGYp0na6M8e1LembrEHNZoiZAE3ASsYY9O6xbZDoKwHhWfDs2CBNeQrDZuzcG/WkXXgsah9IZ6SBrSIOdTSiYYOA4t8wNyLEyv0MN6OfJd9xYL7tzpBRjfYHwMR4caKVgKPQjC8cwFhbHA0IC+t0Wm7oeejBJFd1trMcgcNPowt1nCsSOHahZPDHD9gRFmXcXH04iwtdjrpbG52Et6+xOGQ0cOaN3V0+LNA7yfZRJjG0/1gtSCA6GyKfjmatZkO9F+1ovGp7SQwZuQrgVWJ7wlsZtHJUNEeSuFKTs5s8vxlcllFDq7r4DESIWnQnIxo0XttQLnFzkoPKDmWvdRCqkLUen9GKOTvvVxef8dqQjVc3m9bypAL65UwarrxEehw62+R3/ykdggFyfQ/NjpiaCep1vKaWIYOow8DGIVluaVPTrfCdVZAy/Uwv6sx/r446UXBt8Tzx8RaqlhXGXrSL7FLtzRgPVp158yCIK1uBKoLBUqzV6KO+231ut5kpB25x7yc2aSoHlxLdNtMk1GmuEBu/8zwWdasyihT4KW6HAolB6+vhI5CLTfwcmnN2XkEUOS7pIz1AfVsaDCelWDMBFsVAeozawY36FpH15HKkzy1HEo6v3YPhU7t4z64BuqRk/G2SR3W1NUtoO0+6gCtpbtwa1FLuS0IqBW7eI9kiHf0bFZrXsixMhTghhT2fVdRAzm/W4r/eoLR9Vs9Tz3M9ZN4wFDjYDU79p+6EO6hK++AhN84Pq3d01GfvmkUwQ6/ksnuylB+1axHdV1jbbUPTTbNoPQcPxB5TvAPe0XE7J0FjEAWUNIu7cZiMFM6Nfh99orC5NuCFf1v9y764PN1dFg8IDMYXDUDi7sRUtO2yD4QOWczHU+MG+LdYkT4HDb/RbZI3qKyrvbQkDE5u2h0xm4QFOF8euiqTCkf9gJAlVWIT5cgJQxTlHv4leSMTw/uDs4nnOCfInbMaEOHWWocLTpW8g5iQ05z24W+5oXu2283glMPTFVdbgJA/iSsWWxZlyazVpAQLygKIyLWAADljTW48ghoW4eVeCU3k1SpLfmS7FLe0DRLGimMFVmAzXoIYM1R7C4hL5//PBX+BQ1HYQCYJBeUBDUkF6RWQQhZLZpzBznmWR0G6sBhhzhDc7UkVYm9uC1yaMzLqZ2uR4huP2LcaIvRd7hx0fAQI+XqmFMfwVeWRmf5+zgtuoz7tRsUQ4bbEQ/YYwjrQF8hwAcGDE04u6ZqsRuKOPDI3JDAvRZySpv6OgrkTRApwMkR6O0pCAjBxd+PPllWNgI//3UqKo2aeILBd5Rc1aE7dbcsCz6JhrKnwHbyRJ9HzLKbunFVVkWTHxBaYvwi+tPwKvhNtzxfRjxbw61bSxXShCeooac3sv5AKhYm86TpfURRjWFyVp5aNVH55pfDoPTOL9IGsxzjL8AXFkAMrdMBnLbpiMXrkRkim3uLJ7F1cQJZV3Gv6AHBVyJKPzHJINDt5rErnmjeOO/MQvVFFTx9kKo49fAUapT8D3l+U3VoDYrIVmFy8yUlGrMGxGvHQEKi10MQGAucQLfnn8TvtCei6JnvAR7q8Elpr1iGnUSVzraT6qw292F6EEdf9CePqesAR3VlkS5UfC1OSwj8RPoFk5lyBUsxbR8SNERl5bwjPl/h/Pq7iWUwhvfs0BRv+njj7uBKJHJMQB5zqRaJhTM4nt+B/LzQED6dJ9VRZ8MKIAGX7GVoGORGBvIZihX8yUsFtc4z/9xmDweNbkllkPYjazTwVGXlELWxiK8UKwS4vI0gzCujlr/OqN/WKOEI+Lklul6U+AO2NVnp5RsVAS2uG1nkTTNoBg8NbHLiZ6WWA7GIKFtaxvd7hkaoCflOQGJGBEqzwM3I2YvpMTlBD0jiRkhCMtcuOuuvsRHgWkYElwWFNFFCmxFniyLDZggbK9JdWu4z7WWG34V51heuTevEbcJD7iBqO8A2capYk1HekrfhVZscuJS02Ch+mXPk4frPYRn4z1D3uMna33s0rixGhmKUkLUwPMdMjA1Av/6nGCX9HVn+LQsUagdAPxIGYViqizjQ5aekcWG+eaq9EhJ7+BbPLLr+tgjvxhgGxqwe4UXAChX9CdQ9rtC0o+gbm8TtIkV1spOe5V0EAOYj7OswmL0nl+YR5tyl2GdU4COfBrrr64RJXBXdLU2heBjLx25+mNJ8//RpdxLtf60wdYRGyc7a1N/INe64Ox88ClwzxhyG1+jnrXp/NzblCY20yJLPoqBzWoNlcwXjmaJY5Wu+j7WCzd1tXkd6jh3/NbfidOXMmyvnbb2K807I6t749WTnBUN1j+jgUlVIkVR+S5RN4k8YZguMc+uOkmUyZ7kRIYSjZgRsNtkkzR+vSq04lw4yl78EyGWNdIN1sglQ2sJgtLs/5YQcIj8GNyaj3koqael6NI5iQTMCgWLZjTczAreuuiCaSGhoLcXW/bmFxvkFKeGi8jlufAAqbmIES65wwJ7OzexmORtjM56gGDFXFNhkDDjQaOx8hDPPMAcYIwqJJRAXU6kmMPmECyK/vdTgbqDOqH15SdXMaAQmLfgccQNlI0CRQEbwyBaX/oYGCQt4uGn/BFtQqwsHR9D7BC52YxbtD0A2N1Xjajmv55hCmLlfo4HNC5DlTmX+4cYjN23wuhoQlTfY3ag5b8f+Ck6H1mt2GL7MBPCQVW2qpHKyYp7JNFt7E2oYchliNOXsW+VMO4fRyQLwXzEihfWB6gC50jdpl9I0inzc62LTNgIkY0qG5+EXU0RNsjo8MB0Y/W7xJiLAbbK6LWhZD60I659B1BgKxELvoyMAyaRxTAx+sTZRPEogZVoUQvAfTk9IgQhG6OUtkz9cex/BTimgnNDbZwQUxjdDeifOMqp+Cnns4iTPZP5Haw5VKKKV2su9ibxV00xKs7QwvoLvSIUMYecUZmeTG0vVQvTjjOzj/z03oYqoliktTednpLc3MdZ7ReHAvGZtdYeY7vlw7Wuc4vHusjoK1FkAnD/aRN4zUI4oQwdFr+bXcjatp6E/OoMVsxhbswJBv6Dge7zYc5le5DZ5Dh5RGB1OlStB628w38ttR7NuyoQuAIZlKKbQp9nz6J4TmFgc8EJ+kVV1ucyGSEjEHsMl5DLO0ZEXa+zfubNxW9Lxwjyn6aXMNhz6n9tATsYMgkIwymN3f9gBlWqv3E7Jl3Z6Y+U1BvRjblh9qIzFLwqOFkBapnwOJAVm/d9ifvEpRlkobw9uV+K3xo7CwmygSd3Xqh8/qunO0zWK3c/Q+d4QnMKWsFEWLrzrFRJ2bRZ2W5qiqSrOL6MocEsW5WOnNO+vR98Jhp4pWUWvSYgpAZ3LigjBqGkF5xPb8MHHlC2vmSyyKNWjR10wSxLmRQfW24DPyocMTW5Bje8FVhG1YIRdc3kcSmp3h7oZ6AvLyuR4xcKpE/8yTr6MAyui0HPkErvCaWruAMIz3JuK2WLnLDQ8Tnsn4Jpo7HirXQ6tKKtrK1P3LLhrftWr7ffgSR0g0och8NMCIaZWa2OAxWe8HMnXM9vEpOhZxAY/Lvy4eODa/gi4AIxT/dJ2tgP47X8w7dx2Kc5Ic5NTYGNtkSzZ0GNktXfaolb05EruEsk3fpHxZMZX4mh9iwv/KEsOqwY9M0YXbWxAc24hiXEPv+tQkGg2xUdFTJoZM9WQT5o0VLs4N4t62Eby5fuQXvEbKICIkw6R4FLa63E3wCrJsZr6MNP+Lp03QA6RUkmz5W3DVkQsSnF6RtUgvBBeLv3DfpaVKf3wzzJlN4uNJ+KIryzTEqQc8wpH+bBHIpxfkisN4dLhHhxg8VmY7WqGUbTLtMX5nQVGBp5f+AyaaDHyo1BAvZavE1pmDKKDUXSSeDw7as6TXg3hbGr3WZ1gA0WGpa2KxVIsjN1Y9qVaGb9TLiFZM19lj6FSZ1NEaGdCFqPhfIvFqyox2oL8eqLYK61OyzTQ8A4k0+BUjUxHl5VhiywlIagJmryUbhwWjGtf9vAWxGwcyibXIdddodfdDZ9DQiYPAQ5cWQF2E5Ih+hiQ8N1RJDLtZ3psmEorlxTJmniwgcOn+46GGGuWfivtAeS8DZ5/W8GALDXpNPEumMZEC/Ij8UyLYMQjQPj4AG7HS3D4FCUzlPngTHqERtMtATVK0r5E0vjg5UXu/dCbzZrDlI9B7JE5jS2eIMbog/L/8f/SURjGw/BG7vwk+IbNs08TDHj/rWUWSqlh1KLwAPDFaANYA4uj9Ee/LtcHMPzi4c/nqvOxrex32gEnxFG0stZfdvG4CfBiPcW/QyJfwK3vDBeXYb95PzMN5EcXrvS24InqDXKRugyfDa/Ajq4Me9XSxWMF6l7dXxeXlOUrHFrpv4Y68iNbNgp+Msub921gKZAtCSBCgUh7lObQWRT1wbKCjblUx3buU7ZbTKV4/m4eDfqSnEE0MDj8ctDIjZhGEKMikl109BKmBVKU+dJDepKyoct10JpwMRcVPsXTdoh49iAw+ABTVsnnUTOQy8T/jJBUGNGXec4fmIBBt5qUqPNwU0d8tsvUavN+etuRl4IPUKSQGuTKa0MYUWW2m1aaEp5tO/e8dvtl4zCSKzBIjdL2E9qv7L994OR8d9MCjkW0XxaJ2WmVyhT1cr3ofTLIHAjAk23Vcy5FPv3wvFhUdENW2Qw7JW2ivDo7yMhX7Dd2CC17SP3fb5m7uLWY9u2hP+l45LEXC/mEpecvSVpEkjr/bnxF8+Ek1W7u2GghWV4hf7i9GAD8Yx3h2DFONVuxYnW9wnwAnAPAHCca9mo4pfNEnUkXHKJ15x4LcmKFYO1t6CITlu9Czs5/dK9DCk7Ju1wbtgBXsslQEN4zye4HDgSVqE3ibwpjoI6bcKopP1QA63JW/iwbNSKeKdQFF6VkaUDjLnH3KmM32NAhH/muup9tHgwDdMA4QIrHQjPI0tSmWrRscwLCyEdu3xsSmkHCLvpJcsMFu0vKa06/ob/Acm0MHWtXGMZTvJWu5KlANEzHAo5vYy58Bhjqm7D8Y3U291VbhmaPHb3vr/Y28fJ+EOX+gO1K+gzbSk8O+ReaQyrPYVdTPdCcT1Ay1tbphJI9nPVSVW9Q0WgOe0eVVZrA8zuZfvud2xJs6gzep9FMsRVK0hfrMnXdHy0x2zSChEpcweKyaFqrXCITvHyNbKHbU+qNL88dt2JrRl0MS0+evMKHPMjs9pdHj8BET9VQX15yVLSL+E14+2zIARk32k913FwL3PLeQodsvVd4AVRQoT2FCyR5rBeCpeWKMRXR7dp9PM+1ObrXVh4ToFraAD9tdz57ZGFN2UHrSRY9rPRDjfHztPgGA0pq6JiYVT/zthiXS7qOnHluvY5savuHlJf8gVtwkp+CpGOAEBIaBIM6qQt992CwFGPvyp7FLJaS+kBK0TqpFmI3qyIHKutsAip6vUNt0qHKq6ifEdFKnY+l8Puq0sGY26k1kmymunridb7JF1B/58szkPeyRLViz+9tYRGXesmADgY27+f0tyWSoMbNOatZh/k0bLFAG0Sj2IAdkf1HgYSN27TM9ZxXYGQjtKtlU3AMS1ub3uMbQmkt8x1QIsxzCdgGkDhCVnjDz3GMgu6OzmOAsEg6fi7QxWAOAVghuhTxwIckAW3sG/A/e0Wv4OR4WKg0A9QtyqagVSU1cJgFsB4UdJQ2F4TVZ01hBCZF3cZqXyOUjcGZjzyIinsGzmXCGD07z2FCOkbxj8/HAliv76pQyD7Awuwc9yUJ2tdEYiQpjXu5B8w8y9J/GqEG7pS5MwZY80dgz/c8bhstwag6WWYmxMc/5Od3Q+Yvu9ha1bhWnTa8IdXRzkckBl+kxsYmr0anwOZ2pbMHGfa8jnDUojSdqy4U8/9OcsodwhuD8jxVo/9SYouk4Kr17o2K3jXQOXaNiW4toDxKM81ARUOSVi3IRnQFNnjpQTXHajAQN5DxJdzCfSgByPQ0jojd9QgI8em/vk+sKu/GKTBbHvXaadOkmWcG2kZIpEf4hbb2RaLK5qwNC/ElW4UyjhA3Pg9nzYcn1KRnGaBeQVaBqpO1EYMj07/fEhSUm7EAM6A26MHstDkAF7Z8+VqQ1OsOX7e4t1rlSu4NURffnGC2kv35iQ08/vDoCARXcqxWuplEtPMK6O6410T64bTnloMd/kvsoryxoyyNTz+b2o8uWJo2Jou9e/vK2+7bQKEdmeCXGeRga3kiMohIVScD+0p0FxvsCD1cuMSKyjdYw46+wUDRRJe6cSlZrZhzfslG8Rqa7mgNnFdHMWNQ/e5MBAHSSQBZphQo1jXhyBamMa1KdyAAAUQVi69Jgmtkp4NlqoqKPQxESrrtkviC7CF6KehXDkE4ct4K8WHvLw55+mwXJGFtBGIBSgVy98dPgud31FzmAEGJLAfotdlL4V2sfFh7URcJSMUNBwu/8kd0dG2Fi95hRRYREfPwaJgpBjvegSqcmHLHsgpro7OWdCr63E4bKQFLUE9NHEva5nEM4Xx5ClQ8l6juZFAoCRl1O+UFgne63bVoCEhX7bBotYDLAU36gL730gAuXH3ONKr4nz8ieb+4F4MQs/4rPM1GKEEY3rVvAL0/rxvvbR/IbeAOU0WXedWCp+4S9pGye/8CrLYokXkyT6WA0TbfNZChpxlBpRUBShgC8oxqekCuT9O9ed3NrBH/yLxxHHTy/DE3oN6ecfEWKqC+oGXwoW9r+ibQGJXwF+1uhzT+uGfpf9sRF0GqO71atJUv0tOUmmbU+3nsBF/fNLTCtum6tcwEl+BGGc2fU/um43cbuLaa/MTItakSY0BW7vRpdncarIyHAeyxh/fr2t92+V4xZDq/C4qAqCqJZiq7AJZD6qymCan+BO4ahOIvllio9CoHPZ8MU31v4/R5yWjHVzggf4cgk5lwVC6XggnAcJ9hafOfHKCfkDrGWVr/4v/99phXR2CNyK9noEb8AERp0ODn/+hQR5jUzUALrQP2keQcxbdTNAjo0YLZXU7Ak2MNIEMd+Pmg7I+N3EACcmZSf0zuqt+V1sYQewG0jpplEAAAAA==',
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
    // The Done tab's badge reads this count at mount. The closed lines stay on
    // demand, behind `?done=1` on the list route above.
    const DONE_COUNT_URL = 'missions/api/done/count'
    const DECLARE_URL = 'missions/api/branches'
    const BLOCKED_URL = 'missions/api/blocked'
    const PRIORITY_URL = 'missions/api/priority'
    // The one gesture that deletes a branch: it sends a key and the host owns
    // the proof, the refusals, and every writing command.
    const LOCAL_CLOSE_URL = 'missions/api/local-close'
    // Archiving moves a done mission's folder out of Done: the host checks the
    // tracker, the panel only sends the key.
    const ARCHIVE_URL = 'missions/api/archive'
    const JOURNAL_URL = 'missions/api/journal'
    const CHECKLIST_URL = 'missions/api/checklist'
    // The Tolgee import reads the branch's diff and writes the XLIFF in the
    // mission folder: Tolgee itself is never called, the file is the deliverable.
    const TOLGEE_URL = 'missions/api/tolgee'
    const WORKFLOWS_URL = 'missions/api/workflows'
    const WORKFLOW_MODEL_URL = 'missions/api/workflows/model'
    const REPOSITORIES_URL = 'missions/api/repositories'
    // The dashboard's digest of the root: the same scan, answered from the
    // host's five-minute memory. Its `refresh=1` query is the section's Retry.
    const REPOSITORIES_SUMMARY_URL = 'missions/api/repositories/summary'
    // The tab badge reads this one at mount: the count costs no git process,
    // where the list above pays two calls per entry.
    const REPOSITORIES_COUNT_URL = 'missions/api/repositories/count'
    const REPOSITORY_URL = 'missions/api/repositories/detail'
    const REPOSITORY_HISTORY_URL = 'missions/api/repositories/commits'
    const REPOSITORY_TREE_URL = 'missions/api/repositories/tree'
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
  const WORKFLOW_FORM = { title: '', description: '', kind: 'etape' }
    const REFRESH_MS = 60000

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
    const SORT_OPTIONS = [
      { id: 'priority', name: 'Priority (high → low)' },
      { id: 'points', name: 'Story points (low → high)' },
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

    // The repository drawer has its own sections: the repository as a whole,
    // one branch's history, and the declared layout with its worktrees.
    const REPOSITORY_TABS = [
      { id: 'details', label: 'Details' },
      { id: 'history', label: 'History' },
      { id: 'worktrees', label: 'Worktrees' },
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
.missions-settings-panel { min-width: 0; }
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
/* The view's own command: one icon, its name carried by aria-label and title. */
.missions-icon-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #4a4a4a); cursor: pointer; }
.missions-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-icon-btn:disabled { opacity: .55; cursor: default; }
.missions-icon-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-icon-btn svg { display: block; }
.missions-icon-shuriken { animation: missions-shuriken-spin 7s linear infinite; }
@keyframes missions-shuriken-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .missions-icon-shuriken { animation: none; } }
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
.missions-status-option[data-state="in-review"] input { accent-color: #0969da; }
.missions-status-option[data-state="ready-for-prod"] input { accent-color: #0e7c86; }
.missions-status-option[data-state="in-progress"] input { accent-color: #bf8700; }
.missions-status-option[data-state="ready"] input { accent-color: #1a7f37; }
.missions-status-option[data-state="to-refine"] input { accent-color: #8250df; }
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
.wf-field textarea { height: auto; padding: 6px 7px; resize: vertical; }
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
.wf-pick { display: flex; flex-direction: column; gap: 6px; width: 100%; text-align: left; font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1, #ffffff); cursor: pointer; }
.wf-pick:hover { border-color: color-mix(in srgb, currentColor 24%, transparent); }
.wf-pick[aria-pressed="true"] { border-color: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary, #1f1f1f); }
.wf-pick-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.wf-pick-title { font-size: 13px; font-weight: 600; }
.wf-pick-kind { flex: none; padding: 1px 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 999px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; }
.wf-pick-summary { font-size: 12px; color: var(--dsw-alias-label-secondary, #4a4a4a); }
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
.wf-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
.wf-form-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08)); }
.missions-group { margin-top: 20px; }
.missions-group-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 10px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); position: sticky; top: 0; background: var(--dsw-alias-bg-base, #fbfaf8); z-index: 1; }
.missions-group-head .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.missions-group-head .n { font-variant-numeric: tabular-nums; opacity: .75; }
.missions-group-head .rule { flex: 1; height: 1px; background: var(--dsw-alias-border-l2, rgba(0,0,0,.07)); }
.missions-group[data-state="in-review"] .missions-group-head { color: #0969da; }
.missions-group[data-state="ready-for-prod"] .missions-group-head { color: #0e7c86; }
.missions-group[data-state="in-progress"] .missions-group-head { color: #bf8700; }
.missions-group[data-state="ready"] .missions-group-head { color: #1a7f37; }
.missions-group[data-state="to-refine"] .missions-group-head { color: #8250df; }
.missions-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(292px, 1fr)); gap: 12px; }
.missions-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #ffffff); cursor: pointer; transition: border-color .15s ease, background-color .15s ease; }
.missions-card:hover { border-color: color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 3%, var(--dsw-alias-bg-layer-1, #ffffff)); }
.missions-card:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-card[data-priority="urgent"] { border-left: 3px solid #cf222e; padding-left: 14px; }
@media (prefers-reduced-motion: reduce) { .missions-card { transition: none; } }
.missions-card-top { display: flex; align-items: center; gap: 6px; }
.missions-project { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 160px; color: var(--dsw-alias-label-secondary, #4a4a4a); font-size: 10.5px; }
.missions-project .dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-project .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-type { display: inline-flex; align-items: center; height: 21px; padding: 0 8px; border-radius: 999px; font-size: 11px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-type[data-type="bug"] { color: #cf222e; background: color-mix(in srgb, #cf222e 10%, transparent); }
.missions-type[data-type="story"] { color: #2da44e; background: color-mix(in srgb, #2da44e 11%, transparent); }
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
.missions-sp { margin-left: auto; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary, #7a7168); padding: 1px 7px; border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
.missions-card-title { font-size: 13.5px; font-weight: 550; line-height: 1.4; letter-spacing: -.005em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.missions-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; }
.missions-key { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.missions-age { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-empty { color: var(--dsw-alias-label-tertiary, #7a7168); padding: 24px 0; }
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
.missions-dash-card { display: flex; flex-direction: column; min-width: 0; background: var(--dsw-alias-bg-base, #fff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 9px; }
.missions-dash-card-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 13px 4px; }
.missions-dash-card-title { margin: 0; font-size: 12px; font-weight: 600; }
.missions-dash-card-meta { margin-left: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.missions-dash-card-sub { margin: 3px 13px 0; max-width: 62ch; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; line-height: 1.35; }
.missions-dash-card-body { flex: 1; padding: 5px 13px 11px; }
.missions-dash-card--flight .missions-dash-card-body { display: flex; flex-direction: column; }
.missions-dash-card-empty { margin: 8px 0 6px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-dash-card-foot { display: flex; align-items: baseline; gap: 10px; margin: auto 0 0; padding: 10px 13px 11px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; }
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
.missions-dash-card--branches, .missions-dash-card--checkouts, .missions-dash-card--closed, .missions-dash-card--left { grid-column: span 3; }
.missions-row--repo { grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr) auto 42px; }
.missions-row--closed { grid-template-columns: 56px minmax(0, 1fr) auto 42px; }
.missions-rowwhy { justify-self: end; max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 7%, transparent); color: var(--dsw-alias-label-secondary, #4a4a4a); font-size: 10px; font-variant-numeric: tabular-nums; }
.missions-rowwhy[data-reason="never-pushed"] { background: color-mix(in srgb, #bf8700 18%, transparent); color: #8a5a00; }
.missions-rowwhy[data-reason="error"] { background: color-mix(in srgb, #cf222e 14%, transparent); color: #b31d28; }
.missions-rowpoints { justify-self: end; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* A section whose read failed: the sentence and its Retry, never a zero. */
.missions-sect-error { display: flex; align-items: baseline; gap: 10px; margin-top: 11px; padding: 8px 12px; border: 1px solid color-mix(in srgb, #cf222e 32%, transparent); border-radius: 8px; background: color-mix(in srgb, #cf222e 7%, transparent); font-size: 11.5px; }
.missions-sect-error-text { min-width: 0; overflow-wrap: anywhere; color: #b31d28; }
.missions-sect-error .missions-retry { flex: none; margin-left: auto; }
@media (prefers-reduced-motion: reduce) { .missions-sect-arrow, .missions-rowarrow { transition: none; } }
@container (max-width: 820px) { .missions-sectgrid { grid-template-columns: minmax(0, 1fr); } .missions-dash-card--flight, .missions-dash-card--queue, .missions-dash-card--bugs, .missions-dash-card--stories, .missions-dash-card--branches, .missions-dash-card--checkouts, .missions-dash-card--closed, .missions-dash-card--left { grid-column: auto; } }
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
   icon carries its name in title and aria-label. */
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
.missions-drawer-note--error { color: var(--dsw-alias-label-danger, #b42318); }
.missions-drawer-note { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
.missions-drawer-note--blocked { color: var(--dsw-alias-label-secondary, #5c534b); }
.missions-drawer--decision { gap: 14px; }
.missions-drawer--decision-empty { justify-content: center; align-items: center; border-left: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.missions-queue-headtext { min-width: 0; }
.missions-queue-position { margin-left: auto; flex: none; padding-top: 6px; color: var(--dsw-alias-label-tertiary, rgba(122,113,104,1)); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-queue-card { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,1)); }
.missions-queue-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.missions-queue-key { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; color: var(--dsw-alias-label-tertiary, rgba(122,113,104,1)); }
.missions-queue-verb { margin-left: auto; flex: none; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-secondary, rgba(74,74,74,1)); font-size: 9.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.missions-queue-title { margin: 0; font-size: 13.5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.missions-queue-cues { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.missions-queue-cue { padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.045)); color: var(--dsw-alias-label-secondary, rgba(74,74,74,1)); font-size: 10.5px; }
.missions-queue-cue[data-quiet="true"] { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, rgba(31,31,31,1)); font-weight: 600; }
.missions-queue-cue--blocked { background: color-mix(in srgb, var(--dsw-alias-label-danger, rgba(180,35,24,1)) 12%, transparent); color: var(--dsw-alias-label-danger, rgba(180,35,24,1)); font-weight: 600; }
.missions-queue-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
.missions-queue-action { height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-primary, rgba(31,31,31,1)); font: inherit; font-size: 11.5px; cursor: pointer; }
.missions-queue-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-queue-action:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, rgba(31,31,31,1)) 45%, transparent); outline-offset: 2px; }
.missions-queue-action--primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, rgba(31,31,31,1)); color: var(--dsw-alias-label-primary-foreground, rgba(255,255,255,1)); font-weight: 600; }
.missions-queue-action--primary:hover { filter: brightness(1.06); background: var(--dsw-alias-button-primary-fill, rgba(31,31,31,1)); }
.missions-queue-action:disabled { opacity: .55; cursor: default; }
.missions-queue-note { margin: 0; color: var(--dsw-alias-label-tertiary, rgba(122,113,104,1)); font-size: 10.5px; overflow-wrap: anywhere; }
.missions-queue-note--error { color: var(--dsw-alias-label-danger, rgba(180,35,24,1)); }
.missions-queue-lines { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.missions-queue-lineitem { min-width: 0; }
.missions-queue-line { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 4px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.missions-queue-line:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-queue-line:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
.missions-queue-linekey { flex: none; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; color: var(--dsw-alias-label-tertiary, rgba(122,113,104,1)); }
.missions-queue-lineverb { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, rgba(122,113,104,1)); font-size: 10.5px; }
.missions-queue-empty { display: flex; flex-direction: column; gap: 10px; }
.missions-queue-empty-text { margin: 0; color: var(--dsw-alias-label-tertiary, rgba(122,113,104,1)); font-size: 12px; line-height: 1.45; }
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
/* La priorité s'édite dans la ligne : le select garde la taille du volet. */
.missions-priority-select { max-width: 100%; height: 24px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12px; }
.missions-priority-select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 40%, transparent); outline-offset: 1px; }
.missions-priority-select:disabled { opacity: .6; }
.missions-priority-note { margin: 0 0 10px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-priority-note--error { color: var(--dsw-alias-label-danger, #b42318); }
.missions-card[data-blocked="true"] { background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 13%, var(--dsw-alias-bg-layer-1, #ffffff)); border-color: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 46%, transparent); }
.missions-card[data-blocked="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 14%, var(--dsw-alias-bg-layer-1, #ffffff)); border-color: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 52%, transparent); }
.missions-lock { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-left: auto; border-radius: 999px; background: var(--dsw-alias-label-danger, #b42318); color: #ffffff; box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 15%, transparent); }
.missions-lock svg { display: block; width: 11px; height: 11px; }
.missions-lock + .missions-sp { margin-left: 0; }
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
.missions-repo-headmain { flex: none; width: 24px; }
.missions-repo-rowitem { display: flex; align-items: center; gap: 4px; margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.07)); }
.missions-repo-rowitem:last-child { border-bottom: 0; }
.missions-repo { flex: 1 1 auto; min-width: 0; height: 36px; padding: 0 10px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.missions-repo-main, .missions-repo-main-slot { flex: none; width: 24px; }
.missions-repo-main { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); cursor: pointer; }
.missions-repo-main:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 7%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-repo-main:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-repo-main:disabled { opacity: .4; cursor: default; }
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
.missions-repos-adopt { margin: 0 0 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 14%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 4%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; line-height: 1.45; }
.missions-repos-adopt.is-done { border-color: color-mix(in srgb, #1a7f37 32%, transparent); background: color-mix(in srgb, #1a7f37 8%, transparent); }
.missions-repos-adopt.is-partial { border-color: color-mix(in srgb, #bf8700 40%, transparent); background: color-mix(in srgb, #bf8700 10%, transparent); }
.missions-repos-adopt.is-error { border-color: color-mix(in srgb, #cf222e 35%, transparent); background: color-mix(in srgb, #cf222e 8%, transparent); }
.missions-repos-note { margin: 12px 2px 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; line-height: 1.5; }
.missions-repos-error { margin: 14px 0 0; padding: 10px 12px; border: 1px solid color-mix(in srgb, #cf222e 35%, transparent); border-radius: 6px; background: color-mix(in srgb, #cf222e 8%, transparent); color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; }
.missions-drawer-section { display: grid; gap: 9px; }
.missions-drawer-section-title { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; }

/* Repository drawer: three sections behind three tabs — the repository, one
   branch's history, the declared layout with its worktrees. */
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
.missions-tree { display: flex; flex-direction: column; gap: 14px; }
.missions-tree-branches, .missions-tree-flat { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.missions-tree-branch { display: grid; gap: 6px; padding-top: 2px; padding-bottom: 2px; }
.missions-tree-branch--missing .missions-tree-name { color: var(--dsw-alias-label-tertiary, #7a7168); text-decoration: line-through; }
.missions-tree-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.missions-tree-name { min-width: 0; overflow: hidden; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.missions-tree-annotation, .missions-tree-tag, .missions-tree-missing { flex: none; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, currentColor 8%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; white-space: nowrap; }
.missions-tree-tag { border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); background: none; }
.missions-tree-missing { font-style: italic; }
.missions-tree-commits { display: grid; gap: 4px; margin: 0; padding: 2px 0 2px 10px; border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); list-style: none; }
.missions-tree-commit { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 10.5px; }
.missions-tree-hash { color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.missions-tree-subject { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-secondary, #4a4a4a); text-overflow: ellipsis; white-space: nowrap; }
.missions-tree-more { justify-self: start; margin-left: 10px; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; font-weight: 700; }
.missions-tree-worktree { display: flex; flex-wrap: wrap; align-items: baseline; gap: 1px 8px; min-width: 0; font-size: 11px; }
.missions-tree-worktree-label { flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-weight: 550; line-height: 1.35; }
.missions-tree-worktree-branch { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-secondary, #4a4a4a); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.missions-tree-worktree-current { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; }
.missions-tree-worktree-main { flex: none; margin-left: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; }
.missions-tree-remove { flex: none; margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--dsw-alias-label-secondary, #4a4a4a); cursor: pointer; }
.missions-tree-remove:hover:not(:disabled) { border-color: color-mix(in srgb, #cf222e 45%, transparent); color: #cf222e; }
.missions-tree-remove:disabled { color: var(--dsw-alias-label-tertiary, #7a7168); cursor: default; }
.missions-tree-worktrees { display: grid; gap: 8px; }
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
@media (max-width: 860px) {
  .missions-repo-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr) 78px 52px; }
  .missions-col-commit { display: none; }
  .missions-repo-headmain { width: 22px; }
  .missions-repo-main, .missions-repo-main-slot { width: 22px; }
}
@media (max-width: 900px) {
  .wf-layout { grid-template-columns: minmax(0, 1fr); }
  .wf-list { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
}
@media (max-width: 640px) {
  .wf-toolbar { align-items: flex-start; }
  .wf-list { grid-template-columns: minmax(0, 1fr); }
  .wf-form { grid-template-columns: minmax(0, 1fr); }
}
`

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

:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-hero-photo,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-hero-photo { filter: saturate(.45) brightness(.55) contrast(1.02); }
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-type,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-group-ring,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-tab-count,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-title-mark,
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-drawer::before,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-type,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-group-ring,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-tab-count,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-title-mark,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-drawer::before { color: var(--skin-accent-ink); }
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-group-name,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-group-name { color: var(--skin-ink-2); }
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
.missions-panel[data-skin="paper"] .missions-icon-btn:hover { background: var(--skin-page-3); color: var(--skin-ink); }
:root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-icon-btn,
body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-icon-btn { background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-retry { border: 1.5px solid var(--skin-danger-strong); border-radius: 8px; background: color-mix(in srgb, var(--skin-danger) 20%, var(--skin-page-2)); box-shadow: 1px 1px 0 var(--skin-shadow); color: var(--skin-ink); font-family: var(--skin-display); }

/* Hero: the photograph, the paper wash, the portrait and the speech bubble. */
.missions-panel[data-skin="paper"] .missions-hero { position: relative; flex: none; height: 172px; overflow: hidden; border-bottom: 1.5px solid var(--skin-ink); background: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-hero-photo { position: absolute; inset: 9px 9px 0; width: calc(100% - 18px); height: calc(100% - 9px); object-fit: cover; object-position: 50% 54%; border: 1.5px solid var(--skin-ink); border-radius: 6px; filter: saturate(.62) contrast(1) brightness(1.08); z-index: 0; }
.missions-panel[data-skin="paper"] .missions-hero::before { content: ""; position: absolute; inset: 9px 9px 0; z-index: 1; border-radius: 6px; background-image: radial-gradient(var(--skin-ink) 1px, transparent 1.15px); background-size: 5px 5px; opacity: .2; mix-blend-mode: multiply; pointer-events: none; }
.missions-panel[data-skin="paper"] .missions-hero::after { content: ""; position: absolute; inset: 9px 9px 0; z-index: 2; border-radius: 6px; pointer-events: none; background: var(--skin-hero-fade), var(--skin-hero-wash); }
.missions-panel[data-skin="paper"] .missions-hero-avatar { position: absolute; z-index: 3; right: 26px; bottom: 16px; width: 112px; height: 112px; border-radius: 50%; overflow: hidden; border: 3px solid var(--skin-page); background: var(--skin-page-2); box-shadow: 0 0 0 1.5px var(--skin-ink), 4px 4px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-hero-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-skin="paper"] .missions-hero-bubble { position: absolute; z-index: 3; right: 152px; bottom: 54px; display: flex; flex-direction: column; gap: 1px; min-width: 118px; padding: 8px 11px; border: 1.5px solid var(--skin-ink); border-radius: 9px; background: var(--skin-page-2); color: var(--skin-ink); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-hero-bubble::after { content: ""; position: absolute; right: -7px; bottom: 12px; width: 11px; height: 11px; background: var(--skin-page-2); border-right: 1.5px solid var(--skin-ink); border-bottom: 1.5px solid var(--skin-ink); transform: rotate(-45deg); }
.missions-panel[data-skin="paper"] .missions-hero-bubble b { font-size: 11px; line-height: 1.2; }
.missions-panel[data-skin="paper"] .missions-hero-bubble span { font-size: 8.5px; color: var(--skin-ink-3); }

/* Header over the hero: kicker, title, scope, actions. */
.missions-panel[data-skin="paper"] .missions-head--hero { position: absolute; z-index: 4; inset: 0; height: 172px; display: block; padding: 0 30px; pointer-events: none; }
.missions-panel[data-skin="paper"] .missions-kicker { position: absolute; top: 17px; left: 30px; display: flex; align-items: center; gap: 8px; color: var(--skin-ink-3); font-size: 8.5px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-kicker-rule { width: 20px; height: 2px; border-radius: 2px; background: var(--skin-accent-strong); transform: rotate(-2deg); }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-title { position: absolute; left: 30px; bottom: 30px; margin: 0; color: var(--skin-ink); font-family: var(--skin-display); font-size: 38px; font-weight: 800; letter-spacing: -.035em; line-height: 1; pointer-events: auto; }
.missions-panel[data-skin="paper"] .missions-title-mark { display: inline-grid; place-items: center; width: 31px; height: 31px; margin-left: 11px; vertical-align: middle; border: 1.5px solid var(--skin-ink); border-radius: 8px 9px 8px 10px; background: var(--skin-accent); color: var(--skin-ink); font: 800 17px/1 var(--skin-display); box-shadow: 2px 2px 0 var(--skin-shadow); transform: rotate(2deg); }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-scope { position: absolute; left: 31px; bottom: 8px; color: var(--skin-ink-3); font-size: 11px; }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-scope::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: var(--skin-good); vertical-align: 1px; }
.missions-panel[data-skin="paper"] .missions-head--hero .missions-actions { position: absolute; top: 18px; right: 24px; margin: 0; pointer-events: auto; }

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
.missions-panel[data-skin="paper"] .missions-status-option[data-state="in-review"] input { accent-color: var(--skin-info-strong); }
.missions-panel[data-skin="paper"] .missions-status-option[data-state="ready-for-prod"] input { accent-color: var(--skin-alt-strong); }
.missions-panel[data-skin="paper"] .missions-status-option[data-state="in-progress"] input { accent-color: var(--skin-warn-ink); }
.missions-panel[data-skin="paper"] .missions-status-option[data-state="ready"] input { accent-color: var(--skin-good-strong); }
.missions-panel[data-skin="paper"] .missions-status-option[data-state="to-refine"] input { accent-color: var(--skin-quiet-strong); }
.missions-panel[data-skin="paper"] .missions-dash-link { font-family: var(--skin-display); }
.missions-panel[data-skin="paper"] .missions-select-label { color: var(--skin-ink-3); font-size: 9px; }
.missions-panel[data-skin="paper"] .missions-select-value { color: var(--skin-ink); font-weight: 600; }
.missions-panel[data-skin="paper"] .missions-select[data-active="true"] { border-color: var(--skin-accent-strong); background: color-mix(in srgb, var(--skin-warn) 52%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-switch { color: var(--skin-ink-2); font-size: 10.5px; }
.missions-panel[data-skin="paper"] .missions-switch-track { border: 1.5px solid var(--skin-ink); background: var(--skin-page-2); box-shadow: 1px 1px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-switch-thumb { background: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-switch[aria-checked="true"] .missions-switch-track { background: var(--skin-danger); border-color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-switch[aria-checked="true"] .missions-switch-thumb { background: var(--skin-page); }
.missions-panel[data-skin="paper"] .missions-clear { height: 29px; padding: 0 9px; border: 1.5px dashed var(--skin-line-strong); border-radius: 7px; color: var(--skin-ink-3); text-decoration: none; font-size: 10px; }
.missions-panel[data-skin="paper"] .missions-clear:hover { border-color: var(--skin-ink); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-empty { margin: 10px 0 0; padding: 14px 16px; border: 1.5px dashed var(--skin-line-strong); border-radius: 9px; background: var(--skin-page-2); color: var(--skin-ink-3); font-size: 11.5px; }

/* Groups: a tinted stamp, a name, a rule. */
.missions-panel[data-skin="paper"] .missions-group { margin-top: 10px; }
.missions-panel[data-skin="paper"] .missions-group-head { position: sticky; top: 0; z-index: 3; gap: 9px; padding: 0 1px 7px; background: var(--skin-page); color: var(--skin-ink-3); font-size: 10px; letter-spacing: .14em; }
.missions-panel[data-skin="paper"] .missions-group-ring { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border: 1.5px solid var(--skin-ink); border-radius: 50%; background: var(--state-tint, var(--skin-quiet)); color: var(--skin-ink); font: 700 11px/1 var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-group-name { flex: none; color: var(--group-ink, var(--skin-ink-2)); font-size: 10px; font-weight: 800; }
.missions-panel[data-skin="paper"] .missions-group-rule { flex: 1; height: 1px; background: var(--skin-line); }
.missions-panel[data-skin="paper"] .missions-group[data-state="in-review"] { --state-tint: var(--skin-info); --group-ink: var(--skin-info-strong); }
.missions-panel[data-skin="paper"] .missions-group[data-state="ready-for-prod"] { --state-tint: var(--skin-alt); --group-ink: var(--skin-alt-strong); }
.missions-panel[data-skin="paper"] .missions-group[data-state="in-progress"] { --state-tint: var(--skin-warn); --group-ink: var(--skin-warn-ink); }
.missions-panel[data-skin="paper"] .missions-group[data-state="ready"] { --state-tint: var(--skin-good); --group-ink: var(--skin-good-strong); }
.missions-panel[data-skin="paper"] .missions-group[data-state="to-refine"] { --state-tint: var(--skin-quiet); --group-ink: var(--skin-quiet-strong); }
.missions-panel[data-skin="paper"] .missions-sect { background: color-mix(in srgb, var(--skin-ink) 6%, transparent); }
.missions-panel[data-skin="paper"] .missions-dash-card { background: var(--skin-page-2); border: 1.5px solid var(--skin-line-strong); border-radius: 11px; }
.missions-panel[data-skin="paper"] .missions-dash-card-sub { color: var(--skin-ink-3); font-family: var(--skin-display); letter-spacing: .01em; }
.missions-panel[data-skin="paper"] .missions-dash-card-foot, .missions-panel[data-skin="paper"] .missions-rowitem { border-color: var(--skin-line); }
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

/* Cards: ink frame, folded corner, speech-bubble type, dashed points. */
.missions-panel[data-skin="paper"] .missions-cards { gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.missions-panel[data-skin="paper"] .missions-card { position: relative; gap: 7px; padding: 11px 14px 9px; border: 1.5px solid var(--skin-ink); border-radius: 12px 12px 13px 3px; background: var(--skin-page-2); box-shadow: 3px 3px 0 var(--skin-shadow); transition: background-color .12s ease, box-shadow .12s ease; }
.missions-panel[data-skin="paper"] .missions-card:hover { border-color: var(--skin-ink); background: color-mix(in srgb, var(--skin-accent) 8%, var(--skin-page-2)); box-shadow: 5px 5px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-card:focus-visible { outline: 2px solid var(--skin-accent-strong); outline-offset: 2px; }
.missions-panel[data-skin="paper"] .missions-card::after { content: ""; position: absolute; top: -1.5px; right: -1.5px; width: 13px; height: 13px; background: linear-gradient(225deg, var(--skin-page) 47%, var(--skin-ink) 48% 53%, transparent 54%); }
.missions-panel[data-skin="paper"] .missions-card[data-priority="urgent"] { border-left: 4px solid var(--skin-danger-strong); padding-left: 12px; }
.missions-panel[data-skin="paper"] .missions-card-top { gap: 6px; }
.missions-panel[data-skin="paper"] .missions-project { max-width: 160px; color: var(--skin-ink-2); font-size: 10px; }
.missions-panel[data-skin="paper"] .missions-project .dot { background: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-type { position: relative; height: 21px; padding: 0 8px; border: 1.5px solid var(--skin-ink); border-radius: 9px 9px 9px 3px; background: var(--skin-good); color: var(--skin-ink); font-size: 9px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-type::after { content: ""; position: absolute; left: 5px; bottom: -5px; width: 7px; height: 7px; background: inherit; border-left: 1.5px solid var(--skin-ink); border-bottom: 1.5px solid var(--skin-ink); transform: skewY(-20deg); }
.missions-panel[data-skin="paper"] .missions-type[data-type="bug"] { background: var(--skin-danger); }
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
.missions-panel[data-skin="paper"] .missions-sp { border: 1px dashed var(--skin-line-strong); background: var(--skin-page); color: var(--skin-ink-2); font-size: 9.5px; padding: 1px 6px; border-radius: 5px; }
.missions-panel[data-skin="paper"] .missions-card-title { color: var(--skin-ink); font-size: 14.5px; font-weight: 600; line-height: 1.35; }
.missions-panel[data-skin="paper"] .missions-card-foot { color: var(--skin-ink-3); font-size: 10.5px; }
.missions-panel[data-skin="paper"] .missions-key { font-size: 10px; }

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
.missions-panel[data-skin="paper"] .missions-blocked-apply { border: 1.5px solid var(--skin-danger-strong); border-radius: 6px; background: var(--skin-danger); color: var(--skin-page); box-shadow: 2px 2px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-blocked-cancel { border: 1.5px solid var(--skin-ink); border-radius: 6px; color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-card[data-blocked="true"] { background: color-mix(in srgb, var(--skin-danger) 12%, var(--skin-page-2)); border-color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-card[data-blocked="true"]:hover { background: color-mix(in srgb, var(--skin-danger) 18%, var(--skin-page-2)); border-color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-lock { background: var(--skin-danger-strong); color: var(--skin-page); box-shadow: 2px 2px 0 var(--skin-shadow); }
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
.missions-panel[data-skin="paper"] .missions-repo-main { color: var(--skin-ink-3); border-radius: 6px; }
.missions-panel[data-skin="paper"] .missions-repo-main:hover:not(:disabled) { background: color-mix(in srgb, var(--skin-accent) 22%, transparent); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-main:focus-visible { outline-color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-name { font-family: var(--skin-mono); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repo-kind { border-color: var(--skin-line-strong); color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-repo-branch { color: var(--skin-ink-2); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-repo-state { border: 1px solid var(--skin-line-strong); background: var(--skin-page-2); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-repo-state[data-dirty="true"] { border-color: var(--skin-accent-strong); color: var(--skin-accent-strong); }
.missions-panel[data-skin="paper"] .missions-repo-state[data-error="true"] { border-color: var(--skin-danger-strong); color: var(--skin-danger-strong); }
.missions-panel[data-skin="paper"] .missions-repo-age { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-repos-adopt { border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-repos-adopt.is-done { border-color: var(--skin-good-strong); background: color-mix(in srgb, var(--skin-good) 28%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-repos-adopt.is-partial { border-color: var(--skin-accent); background: color-mix(in srgb, var(--skin-warn) 30%, var(--skin-page-2)); }
.missions-panel[data-skin="paper"] .missions-repos-adopt.is-error { border-color: var(--skin-danger-strong); background: color-mix(in srgb, var(--skin-danger) 22%, var(--skin-page-2)); }
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
.missions-panel[data-skin="paper"] .missions-tree-name { color: var(--skin-ink); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-tree-annotation { border: 1px solid var(--skin-line-strong); background: var(--skin-page-2); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-tree-tag { border: 1px solid var(--skin-line-strong); color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-tree-missing { color: var(--skin-ink-3); }
.missions-panel[data-skin="paper"] .missions-tree-commits { border-left-color: var(--skin-line-strong); }
.missions-panel[data-skin="paper"] .missions-tree-hash { color: var(--skin-accent-strong); }
.missions-panel[data-skin="paper"] .missions-tree-subject { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-tree-worktree-label { color: var(--skin-ink); font-family: var(--skin-mono); }
.missions-panel[data-skin="paper"] .missions-tree-worktree-branch { color: var(--skin-ink-2); }
.missions-panel[data-skin="paper"] .missions-tree-worktree-current { color: var(--skin-ink-3); }

/* Empty result: a tilted Konoha print, the portrait and a speech bubble. */
.missions-panel[data-skin="paper"] .missions-loader { color: var(--skin-ink-3); min-height: 340px; }
.missions-panel[data-skin="paper"] .missions-loader-label { font-family: var(--skin-display); font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
.missions-panel[data-skin="paper"] .missions-sharingan { width: 86px; height: 86px; filter: drop-shadow(0 0 16px color-mix(in srgb, var(--skin-danger) 50%, transparent)); animation: missions-sharingan-pulse 1.6s ease-in-out infinite alternate; }
.missions-panel[data-skin="paper"] .missions-sharingan svg { width: 100%; height: 100%; overflow: visible; }
.missions-panel[data-skin="paper"] .missions-sharingan-tomoe { transform-box: view-box; transform-origin: 60px 60px; animation: missions-sharingan-spin 1.6s linear infinite; }
@keyframes missions-sharingan-spin { to { transform: rotate(360deg); } }
@keyframes missions-sharingan-pulse { from { opacity: .8; } to { opacity: 1; } }
.missions-panel[data-skin="paper"] .missions-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 420px; padding: 10px 20px 30px; text-align: center; }
.missions-panel[data-skin="paper"] .missions-empty-art { position: relative; width: 300px; height: 196px; margin-bottom: 12px; }
.missions-panel[data-skin="paper"] .missions-empty-photo { position: absolute; left: 0; top: 8px; width: 300px; height: 156px; overflow: hidden; border: 1.5px solid var(--skin-ink); border-radius: 6px; background: var(--skin-page-3); box-shadow: 4px 4px 0 var(--skin-shadow); transform: rotate(-2deg); }
.missions-panel[data-skin="paper"] .missions-empty-photo img { position: absolute; top: 0; left: -100%; width: 200%; height: 100%; object-fit: cover; object-position: 50% 46%; }
.missions-panel[data-skin="paper"] .missions-empty-bubble { position: absolute; right: -6px; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 1px; padding: 6px 9px; border: 1.5px solid var(--skin-ink); border-radius: 9px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); text-align: left; }
.missions-panel[data-skin="paper"] .missions-empty-bubble b { font-size: 10px; }
.missions-panel[data-skin="paper"] .missions-empty-bubble span { color: var(--skin-ink-3); font-size: 8.5px; }
.missions-panel[data-skin="paper"] .missions-empty-avatar { position: absolute; right: 0; bottom: 0; z-index: 3; width: 98px; height: 98px; border-radius: 50%; overflow: hidden; border: 3px solid var(--skin-page); background: var(--skin-page-2); box-shadow: 0 0 0 1.5px var(--skin-ink), 3px 3px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-empty-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-skin="paper"] .missions-empty-title { margin: 0 0 4px; color: var(--skin-ink); font-family: var(--skin-display); font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.missions-panel[data-skin="paper"] .missions-empty-hint { margin: 0 0 12px; color: var(--skin-ink-3); font-size: 11.5px; }
.missions-panel[data-skin="paper"] .missions-empty-clear { height: 29px; padding: 0 11px; border: 1.5px solid var(--skin-ink); border-radius: 8px; background: var(--skin-page-2); box-shadow: 2px 2px 0 var(--skin-shadow); color: var(--skin-ink); font: inherit; font-size: 11px; cursor: pointer; }
.missions-panel[data-skin="paper"] .missions-empty-clear:hover { background: var(--skin-page-3); }

/* Narrow panel: keep the header, lose the bubble and shrink the portrait. */
@media (prefers-reduced-motion: reduce) {
  .missions-panel[data-skin="paper"] .missions-card { transition: none; }
  .missions-panel[data-skin="paper"] .missions-card:hover { transform: none; }
}

@container (max-width: 760px) {
  .missions-panel[data-skin="paper"] .missions-hero { height: 150px; }
  .missions-panel[data-skin="paper"] .missions-head--hero { height: 150px; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-title { font-size: 30px; bottom: 24px; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-scope { bottom: 8px; font-size: 10px; }
  .missions-panel[data-skin="paper"] .missions-hero-avatar { width: 84px; height: 84px; right: 18px; bottom: 12px; }
  .missions-panel[data-skin="paper"] .missions-hero-bubble { display: none; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-actions { right: 18px; }
  .missions-panel[data-skin="paper"] .missions-tabs, .missions-panel[data-skin="paper"] .missions-toolbar { padding-left: 22px; padding-right: 22px; }
  .missions-panel[data-skin="paper"] .missions-body { padding-left: 22px; padding-right: 22px; }
  .missions-panel[data-skin="paper"] .missions-head--hero { padding: 0 22px; }
  .missions-panel[data-skin="paper"] .missions-kicker, .missions-panel[data-skin="paper"] .missions-head--hero .missions-title { left: 22px; }
  .missions-panel[data-skin="paper"] .missions-head--hero .missions-scope { left: 23px; }
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
     * One card of a dashboard section: a title, an optional line saying what
     * the card is for, a count, a body, and an optional footer that keeps the
     * total when the card is taller than its rows.
     */
    function DashboardCard({ title, sub, meta, className, footer, children }) {
      return h('article', { className: `missions-dash-card ${className ?? ''}`.trim() },
        h('header', { className: 'missions-dash-card-head' },
          h('h3', { className: 'missions-dash-card-title' }, title),
          h('span', { className: 'missions-dash-card-meta' }, meta),
        ),
        // What the card is for, under its title: the title alone assumes the
        // rule is known, and the rule is exactly what a first read misses.
        sub ? h('p', { className: 'missions-dash-card-sub' }, sub) : null,
        h('div', { className: 'missions-dash-card-body' }, children),
        footer ? h('p', { className: 'missions-dash-card-foot' }, footer) : null,
      )
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
     * its label carries the list's total, so the number the head announced is
     * the number the list will show. It returns nothing at all when the card
     * fits: no empty rule under the last row.
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
     * One row of the Done digest: the closed mission, the points it carried,
     * and the tracker's last update — the closest the model comes to a closure
     * date. The row opens the mission in its drawer.
     */
    function ClosedRow({ mission, now, onOpen }) {
      const age = missionAge(mission.updatedAt, now)
      const value = Number(mission.points)
      const counted = mission.points !== null && mission.points !== undefined && mission.points !== ''
        && Number.isFinite(value)
      const points = counted ? `${value} pt${value === 1 ? '' : 's'}` : ''
      return h('li', { className: 'missions-rowitem' },
        h('button', {
          type: 'button',
          className: 'missions-row missions-row--closed',
          'data-state': 'done',
          onClick: () => onOpen(mission),
          title: `Open ${mission.key}`,
          'aria-label': `${mission.key} ${mission.title}${points ? `, ${points}` : ''}${
            age.label ? `, last updated ${age.label} ago` : ''
          }`,
        },
          h('span', { className: 'missions-rowkey' }, mission.key),
          h('span', { className: 'missions-rowtitle' }, mission.title),
          h('span', { className: 'missions-rowpoints' }, points),
          h('span', { className: 'missions-rowage', 'data-quiet': age.quiet ? 'true' : 'false' }, age.label),
        ),
      )
    }

    /**
     * The dashboard's right panel: the queue, turned into a decision desk. The
     * dashboard already ranks what waits on the user; the desk takes the first
     * card — key, title, state verb, age, points, blocked — and offers the two
     * gestures that are worth anything there: start the step's session, or open
     * the mission. The rest of the queue stays one click away, and choosing one
     * line makes it the card without leaving the dashboard.
     */
    function DashboardQueue({
      missions = [],
      services,
      workspaceId,
      workspaceRoot,
      now = Date.now(),
      onOpenMission,
      onOpenMissions,
    }) {
      const queue = needsYou(missions)
      const [chosenKey, setChosenKey] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const found = queue.findIndex((mission) => mission.key === chosenKey)
      const index = found === -1 ? 0 : found
      const head = queue[index] ?? null
      const rest = queue.filter((mission) => mission.key !== head?.key)

      const openSession = async (mission) => {
        const blocker = executionBlocker(mission)
        if (blocker) {
          return
        }
        track('mission.session', 'dashboard')
        try {
          const { prefilledBy, openedBy, uiError } = await openMissionSession(services, missionSessionPrompt(mission), workspaceId, workspaceRoot)
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

      if (!head) {
        return h('aside', { className: 'missions-drawer missions-drawer--decision missions-drawer--decision-empty', role: 'complementary', 'aria-label': 'Now' },
          h('div', { className: 'missions-drawer-head' },
            h('div', { className: 'missions-queue-headtext' },
              h('div', { className: 'missions-drawer-key' }, 'decision'),
              h('h2', { className: 'missions-drawer-title' }, 'Now'),
            ),
          ),
          h('div', { className: 'missions-queue-empty' },
            h('p', { className: 'missions-queue-empty-text' }, 'Nothing is waiting on a decision. Start or ship a mission from Missions.'),
            h('button', { type: 'button', className: 'missions-queue-action', onClick: () => onOpenMissions?.() }, 'Open Missions'),
          ),
        )
      }

      const age = missionAge(head.updatedAt, now)
      const step = missionStep(head)
      const sessionLabel = step ? `Start a session — ${step}` : 'Start a session'
      const blocker = executionBlocker(head)
      const value = Number(head.points)
      const counted = head.points !== null && head.points !== undefined && head.points !== ''
        && Number.isFinite(value)
      const ageText = age.label ? `updated ${age.label} ago${age.quiet ? ' · quiet' : ''}` : 'no update date'

      return h('aside', { className: 'missions-drawer missions-drawer--decision', role: 'complementary', 'aria-label': 'Now' },
        h('div', { className: 'missions-drawer-head' },
          h('div', { className: 'missions-queue-headtext' },
            h('div', { className: 'missions-drawer-key' }, 'decision'),
            h('h2', { className: 'missions-drawer-title' }, 'Now'),
          ),
          h('span', { className: 'missions-queue-position' }, `${index + 1} of ${queue.length}`),
        ),
        h('article', { className: 'missions-queue-card' },
          h('div', { className: 'missions-queue-card-top' },
            h('span', { className: 'missions-queue-key' }, head.key),
            h('span', { className: 'missions-queue-verb' }, actionVerb(head.state)),
          ),
          h('h3', { className: 'missions-queue-title' }, head.title),
          h('ul', { className: 'missions-queue-cues' },
            h('li', { className: 'missions-queue-cue', 'data-quiet': age.quiet ? 'true' : 'false' }, ageText),
            counted ? h('li', { className: 'missions-queue-cue' }, `${value} pt${value === 1 ? '' : 's'}`) : null,
            head.blocked ? h('li', { className: 'missions-queue-cue missions-queue-cue--blocked' }, 'blocked') : null,
          ),
          h('div', { className: 'missions-queue-actions' },
            h('button', {
              type: 'button',
              className: 'missions-queue-action missions-queue-action--primary',
              onClick: () => openSession(head),
              disabled: blocker !== null,
              title: blocker ?? sessionLabel,
              'aria-label': sessionLabel,
              'aria-describedby': blocker ? 'missions-queue-blocked' : undefined,
            }, sessionLabel),
            h('button', {
              type: 'button',
              className: 'missions-queue-action',
              onClick: () => onOpenMission?.(head),
              title: `Open ${head.key}`,
              'aria-label': `Details for ${head.key}`,
            }, 'Details'),
          ),
          blocker ? h('p', { id: 'missions-queue-blocked', className: 'missions-queue-note' }, `Session blocked: ${blocker}.`) : null,
          note ? h('p', { className: 'missions-queue-note missions-queue-note--error', role: 'alert' }, note) : null,
        ),
        rest.length > 0
          ? h('ol', { className: 'missions-queue-lines' },
              rest.map((mission) => h('li', { key: mission.key, className: 'missions-queue-lineitem' },
                h('button', {
                  type: 'button',
                  className: 'missions-queue-line',
                  onClick: () => setChosenKey(mission.key),
                  'aria-label': `${mission.key} ${mission.title}`,
                },
                  h('span', { className: 'missions-queue-linekey' }, mission.key),
                  h('span', { className: 'missions-queue-lineverb' }, actionVerb(mission.state)),
                ),
              )),
            )
          : null,
      )
    }

    /**
     * The dashboard: a section per domain, a card per widget. Missions opens on
     * the four lenses the list makes you filter by hand; Repositories and Done
     * digest the reads their own tabs make — the root's cached scan, and the
     * Done tab's list — so no section pays for a second read. A section whose
     * read failed keeps what it already showed and names the failure: the
     * digest never turns a broken read into a zero.
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
      closed = null,
      onOpenSection,
      onOpenRepository,
      onOpenClosed,
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
      if (points.counted > 0) foot.push(`${points.total} pt${points.total === 1 ? '' : 's'} in flight`)
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
                sub: 'Unresolved, assigned to you. Oldest first.',
                meta: bugs.length,
                className: 'missions-dash-card--bugs',
                footer: widgetFoot({
                  note: bugsHidden > 0 ? `${bugsHidden} more ${bugsHidden === 1 ? 'bug' : 'bugs'}` : null,
                  total: bugs.length,
                  onViewAll: () => onViewAll({ type: 'bug' }),
                }),
              },
                bugs.length === 0
                  ? h('p', { className: 'missions-dash-card-empty' }, 'No unresolved bug assigned to you.')
                  : h('ul', { className: 'missions-rows' },
                      bugsShown.map((mission) => h(DashboardRow, { key: mission.key, mission, now, verb: false, onOpen })),
                    ),
              ),
              h(DashboardCard, {
                title: 'High-priority stories',
                sub: 'Urgent or high, oldest first.',
                meta: stories.length,
                className: 'missions-dash-card--stories',
                footer: widgetFoot({
                  note: storiesHidden > 0 ? `${storiesHidden} more ${storiesHidden === 1 ? 'story' : 'stories'}` : null,
                  total: stories.length,
                  onViewAll: () => onViewAll({ type: 'story', priority: ['urgent', 'high'] }),
                }),
              },
                stories.length === 0
                  ? h('p', { className: 'missions-dash-card-empty' }, 'No high-priority story.')
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
                  ? h('p', { className: 'missions-dash-card-empty' }, 'Nothing is in progress.')
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
                  ? h('p', { className: 'missions-dash-card-empty' }, 'Nothing is waiting on you.')
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
                    ? h('p', { className: 'missions-dash-card-empty' }, 'Every open mission branch is pushed.')
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
                    ? h('p', { className: 'missions-dash-card-empty' }, 'No checkout needs a gesture.')
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

      // The Done digest. Its rows are the Done tab's read, shared on the host
      // with the badge, so the dashboard opens it once and the tick leaves it
      // alone. `closed` is null while that read has nothing to show — a failed
      // read is not "nothing is closed", so the section waits instead.
      const closedMissions = Array.isArray(closed) ? closed : null
      const closedCount = closedMissions ? doneScope(closedMissions).count : 0
      const recent = closedMissions ? recentlyClosed(closedMissions) : []
      const leftovers = closedMissions && summary ? leftBehind(closedMissions, repositories) : []
      const recentHidden = closedCount - recent.length

      const doneSection = closedMissions
        ? h('section', { className: 'missions-sect', 'aria-labelledby': 'missions-sect-done' },
            h(SectionHead, {
              id: 'missions-sect-done',
              title: 'Done',
              scope: doneScope(closedMissions).label,
              label: 'Open Done',
              tab: 'done',
              onOpen: onOpenSection,
            }),
            h('div', { className: 'missions-sectgrid' },
              h(DashboardCard, {
                title: 'Recently closed',
                sub: 'The three last closed, by their last tracker update: the model keeps no closure date.',
                meta: recentHidden > 0 ? `${recent.length} of ${closedCount}` : String(closedCount),
                className: 'missions-dash-card--closed',
                footer: widgetFoot({
                  note: recentHidden > 0 ? `${recentHidden} more closed` : null,
                  total: closedCount,
                  cap: RECENT_CLOSED_ROWS,
                  onViewAll: () => onOpenSection('done'),
                }),
              },
                recent.length === 0
                  ? h('p', { className: 'missions-dash-card-empty' }, 'No mission is closed yet.')
                  : h('ul', { className: 'missions-rows' },
                      recent.map((mission) => h(ClosedRow, { key: mission.key, mission, now, onOpen: onOpenClosed })),
                    ),
              ),
              h(DashboardCard, {
                title: 'Left behind',
                sub: 'Closed missions whose branch still sits in a worktree.',
                meta: summary ? leftovers.length : '—',
                className: 'missions-dash-card--left',
                footer: summary ? 'Removing a worktree stays in the repository drawer.' : null,
              },
                !summary
                  ? h('p', { className: 'missions-dash-card-empty' }, 'The repository scan has not run, so leftovers are unknown.')
                  : leftovers.length === 0
                    ? h('p', { className: 'missions-dash-card-empty' }, 'No closed mission still holds a worktree.')
                    : h('ul', { className: 'missions-rows' },
                        leftovers.map((row) => h(DigestRow, {
                          key: row.mission.key,
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
        doneSection,
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

    function MissionCard({ mission, onSelect }) {
      return h('article', {
        className: 'missions-card',
        tabIndex: 0,
        role: 'button',
        'aria-pressed': 'false',
        'data-priority': mission.priority ?? 'none',
        'data-blocked': mission.blocked ? 'true' : 'false',
        onClick: () => onSelect(mission),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(mission)
          }
        },
      },
        h('div', { className: 'missions-card-top' },
          h('span', { className: 'missions-project', title: mission.projectName ?? mission.project },
            h('i', { className: 'dot', 'aria-hidden': 'true' }),
            h('span', { className: 'name' }, mission.projectName ?? mission.project),
          ),
          h('span', { className: 'missions-type', 'data-type': mission.type ?? 'none' }, TYPE_LABELS[mission.type] ?? '—'),
          h(PriorityMark, { priority: mission.priority }),
          mission.points !== null && mission.points !== undefined ? h('span', { className: 'missions-sp' }, `${mission.points} pts`) : null,
          mission.blocked
            ? h('span', {
                className: 'missions-lock',
                role: 'img',
                'aria-label': 'Bloqué',
                title: 'Bloqué : la raison est en commentaire du ticket',
              },
                h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' },
                  h('path', { className: 'lock-shackle', d: 'M3.6 5.2V4a2.4 2.4 0 0 1 4.8 0v1.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
                  h('rect', { className: 'lock-body', x: 2.5, y: 5.1, width: 7, height: 4.7, rx: 1.2, fill: 'currentColor' }),
                ),
              )
            : null,
        ),
        h('div', { className: 'missions-card-title' }, mission.title),
        h('div', { className: 'missions-card-foot' },
          h('span', { className: 'missions-key' }, mission.key),
          h('span', { className: 'missions-age' }, relativeAge(mission.updatedAt)),
        ),
      )
    }

    /** A native select under a styled label: the value can be truncated. */
    function FilterSelect({ label, value, options, format, allLabel = 'All', onChange }) {
      const entries = options.map((option) => {
        if (option && typeof option === 'object') return { value: option.id, label: option.name ?? option.id }
        return { value: option, label: format ? format(option) : String(option) }
      })
      if (value !== null && value !== undefined && !entries.some((entry) => entry.value === value)) {
        entries.push({ value, label: format ? format(value) : String(value) })
      }
      const current = entries.find((entry) => entry.value === value)
      const display = current ? current.label : allLabel
      const active = value !== null && value !== undefined
      return h('label', { className: 'missions-select', 'data-active': active ? 'true' : 'false' },
        h('span', { className: 'missions-select-label' }, label),
        h('span', { className: 'missions-select-value', title: display }, display),
        h('svg', { width: 9, height: 9, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' },
          h('path', { d: 'M2.5 4 5 6.5 7.5 4' }),
        ),
        h('select', {
          'aria-label': `Filter by ${label.toLowerCase()}`,
          value: value ?? '',
          onChange: (event) => onChange(event.target.value === '' ? null : event.target.value),
        },
          h('option', { value: '' }, allLabel),
          entries.map((entry) => h('option', { key: String(entry.value), value: entry.value }, entry.label)),
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
    function ChecklistFilter({ label, value, options, labels, counts, allLabel, onChange }) {
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
                    h('span', { className: 'missions-status-name' }, labelOf(option)),
                    h('span', { className: 'missions-status-count', 'aria-hidden': 'true' }, String(counts[option] ?? 0)),
                  ),
                )),
              ),
              // « All » is the absence of a filter, not the list of the values
              // known today: a value that appears tomorrow must not be filtered
              // out by a bar saved yesterday. A fixed filter (Done's status)
              // passes no label: there is nothing to clear.
              allLabel
                ? h('div', { className: 'missions-status-actions' },
                    h('button', { type: 'button', onClick: () => onChange(null) }, allLabel),
                  )
                : null,
            )
          : null,
      )
    }

    function StatusFilter({ missions, value, options, allLabel = 'All open states', onChange }) {
      const counts = {}
      for (const mission of missions) {
        const state = STATE_ORDER.includes(mission.state) ? mission.state : 'unknown'
        counts[state] = (counts[state] ?? 0) + 1
      }
      return h(ChecklistFilter, {
        label: 'Status',
        value,
        options: options ?? stateOptions(missions),
        labels: STATE_LABELS,
        counts,
        allLabel,
        onChange,
      })
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

    /** The themed empty state: the illustrated skin's print. */
    function ThemedEmpty({ theme, onClear }) {
      return h('div', { className: 'missions-empty-state' },
        h('div', { className: 'missions-empty-art' },
          theme === 'manga'
            ? h(React.Fragment, null,
                h('div', { className: 'missions-empty-photo' }, h('img', { src: ART.konoha, alt: '' })),
                h('div', { className: 'missions-empty-bubble' }, h('b', null, 'Naruto?'), h('span', null, 'Searching…')),
                h('div', { className: 'missions-empty-avatar' }, h('img', { src: ART.avatar, alt: '' })),
              )
            : null,
        ),
        h('h2', { className: 'missions-empty-title' }, 'No mission matches these filters.'),
        h('p', { className: 'missions-empty-hint' }, 'Try another project, or clear the filters.'),
        h('button', { type: 'button', className: 'missions-empty-clear', onClick: onClear }, 'Clear filters'),
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
    function MissionsView({ missions, query, onQuery, onSearchEnd = () => {}, filters, onFilter, onClear, sort, onSort, filtered, groups, onSelect, theme, loading, failed, onRefresh, statusOptions, statusFixed = false, emptyText = 'No open missions assigned to you.' }) {
      const epics = epicOptions(missions)
      const projects = projectOptions(missions)
      const active = hasActiveFilters(filters)

      const toolbar = h('div', { className: 'missions-toolbar' },
        h('div', { className: 'missions-toolbar-top' },
          h('label', { className: 'missions-search' },
            h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': 'true' },
              h('circle', { cx: 7, cy: 7, r: 4.6 }),
              h('path', { d: 'M10.4 10.4 14 14', strokeLinecap: 'round' }),
            ),
            h('input', {
              type: 'search',
              value: query,
              placeholder: 'Filter by title, key, project…',
              'aria-label': 'Filter missions',
              onChange: (event) => onQuery(event.target.value),
              // The gesture is the search, not the typing: the box is counted
              // when it is left, or when Enter says the term is the one meant.
              onBlur: (event) => onSearchEnd(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') onSearchEnd(event.target.value)
              },
            }),
          ),
          failed
            ? null
            : h('button', {
                type: 'button',
                className: 'missions-icon-btn',
                'aria-label': 'Refresh',
                title: 'Refresh',
                onClick: onRefresh,
                disabled: loading,
                'aria-busy': loading ? 'true' : 'false',
              }, h(RefreshIcon, { theme })),
        ),
        h('div', { className: 'missions-filters' },
          h(StatusFilter, {
            missions,
            value: filters.state,
            options: statusOptions,
            allLabel: statusFixed ? null : 'All open states',
            onChange: statusFixed ? () => {} : (value) => onFilter('state', value),
          }),
          h(FilterSelect, { label: 'Type', value: filters.type, options: TYPE_OPTIONS, onChange: (value) => onFilter('type', value) }),
          h(FilterSelect, { label: 'Epic', value: filters.epic, options: epics, onChange: (value) => onFilter('epic', value) }),
          h(FilterSelect, { label: 'Project', value: filters.project, options: projects, onChange: (value) => onFilter('project', value) }),
          h(PriorityFilter, {
            missions,
            value: filters.priority,
            onChange: (value) => onFilter('priority', value),
          }),
          h(FilterSelect, {
            label: 'Sort',
            value: sort,
            options: SORT_OPTIONS,
            allLabel: 'Default',
            onChange: onSort,
          }),
          active ? h('button', { type: 'button', className: 'missions-clear', onClick: onClear }, 'Clear') : null,
          h(Switch, {
            label: 'Missing',
            checked: filters.missing === 'any',
            onChange: (checked) => onFilter('missing', checked ? 'any' : null),
          }),
        ),
      )

      if (loading) {
        return h('div', null, toolbar, h(PanelLoader, { theme }))
      }
      if (failed) {
        return h('div', null, toolbar)
      }
      if (missions.length === 0) {
        return h('div', null, toolbar, h('p', { className: 'missions-empty' }, emptyText))
      }
      if (filtered.length === 0) {
        // The list rests on its own read: with no filter set, an empty list
        // means there is nothing to show — not that a filter excluded
        // everything.
        const resting = !hasActiveFilters(filters) && String(query ?? '').trim() === ''
        return h('div', null, toolbar, theme !== 'default' && !resting
          ? h(ThemedEmpty, { theme, onClear })
          : h('p', { className: 'missions-empty' }, resting ? emptyText : 'No mission matches these filters.'))
      }

      return h('div', null,
        toolbar,
        groups.map((group) => h('section', { className: 'missions-group', 'data-state': group.state, key: group.state },
          h('div', { className: 'missions-group-head' },
            theme === 'manga'
              ? h(React.Fragment, null,
                  h('span', { className: 'missions-group-ring' }, String(group.missions.length)),
                  h('span', { className: 'missions-group-name' }, STATE_LABELS[group.state] ?? group.state),
                  h('span', { className: 'missions-group-rule' }),
                )
              : h(React.Fragment, null,
                  h('span', { className: 'dot' }),
                  STATE_LABELS[group.state] ?? group.state,
                  h('span', { className: 'n' }, String(group.missions.length)),
                  h('span', { className: 'rule' }),
                ),
          ),
          h('div', { className: 'missions-cards' },
            group.missions.map((mission) => h(MissionCard, { key: mission.key, mission, onSelect })),
          ),
        )),
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

    function MissionDrawer({ mission, services, workspaceId, workspaceRoot, onClose, onSaved, onPrioritySaved, onArchived, theme }) {
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
      // shows what the tracker holds and the write goes through the host.
      const [blockedNow, setBlockedNow] = React.useState(Boolean(mission.blocked))
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

      // A refreshed list carries the tracker's answer: the switch follows it.
      React.useEffect(() => {
        setBlockedNow(Boolean(mission.blocked))
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
      // step button stays the primary, and the last of the row.
      const feedbackLabel = 'Check the PR feedback'
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
          h(DrawerRow, { label: 'Points', value: mission.points !== null && mission.points !== undefined ? `${mission.points} pts` : null }),
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

        h('div', { className: 'missions-blocked', 'data-blocked': blockedNow || armedBlock ? 'true' : 'false' },
          h('div', { className: 'missions-blocked-head' },
            h('span', { className: 'missions-blocked-title' },
              blockedNow ? 'Mission bloquée' : 'Signaler un blocage',
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
              : h('p', { className: 'missions-blocked-hint' },
                  'Le label `blocked` et sa raison partent dans le tracker ; rien n’est gardé ici.',
                ),
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

      return h('aside', { className: filling ? 'missions-drawer missions-drawer--fill' : 'missions-drawer', role: 'complementary', 'aria-label': `Mission ${mission.key}` },
          h('div', { className: 'missions-drawer-head' },
            theme === 'manga'
              ? h('div', { className: 'missions-drawer-portrait' }, h('img', { src: ART.avatar, alt: '' }))
              : null,
            h('div', null,
              h('div', { className: 'missions-drawer-key' }, mission.key),
              h('h2', { className: 'missions-drawer-title' }, mission.title),
            ),
            h('button', { type: 'button', className: 'missions-drawer-close', onClick: onClose, 'aria-label': 'Close' },
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
          doneNote
            ? h('p', { id: 'missions-session-blocked', className: 'missions-drawer-note' }, doneNote)
            : blocker ? h('p', { id: 'missions-session-blocked', className: 'missions-drawer-note missions-drawer-note--blocked' }, `Session blocked: ${blocker}.`) : null,

          h('div', { className: 'missions-drawer-foot' },
            // Every action of the foot shares one row: icon only, its name in
            // `title` for the pointer and in `aria-label` for the screen reader.
            h('div', { className: 'missions-drawer-actions' },
              // Only the step that follows the merge may delete the branch: the
              // panel shows the gesture there and nowhere else, and the host
              // re-reads the state before touching anything. It opens the row so
              // it never sits next to the primary; its first click arms it, its
              // second confirms, and the button itself says which state it is in.
              mission.state === 'ready-for-prod'
                ? h('button', {
                    type: 'button',
                    className: closing || !armedClose
                      ? 'missions-action missions-action--icon missions-action--danger'
                      : 'missions-action missions-action--icon missions-action--danger missions-action--danger-armed',
                    onClick: closeLocalCheckout,
                    disabled: closing || blocker !== null,
                    title: blocker ?? (closing ? 'Closing…' : armedClose ? 'Confirm — close the local checkout' : 'Close the local checkout'),
                    'aria-label': closing ? 'Closing…' : armedClose ? 'Confirm — close the local checkout' : 'Close the local checkout',
                    'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                  }, h(ActionIcon, { name: closing || !armedClose ? 'close' : 'confirm' }))
                : null,
              // A done mission can be archived: its folder moves to
              // missions/archives/. Two clicks, like the close: the first arms
              // it, the second posts, and the button itself shows its state.
              mission.state === 'done'
                ? h('button', {
                    type: 'button',
                    className: armedArchive && !archiving
                      ? 'missions-action missions-action--icon missions-action--armed'
                      : 'missions-action missions-action--icon',
                    onClick: archiveMission,
                    disabled: archiving,
                    title: archiving ? 'Archiving…' : armedArchive ? 'Confirm — archive the mission' : 'Archive',
                    'aria-label': archiving ? 'Archiving…' : armedArchive ? 'Confirm — archive the mission' : 'Archive',
                  }, h(ActionIcon, { name: armedArchive && !archiving ? 'confirm' : 'archive' }))
                : null,
              mission.url
                ? h('a', {
                    className: 'missions-action missions-action--icon',
                    href: mission.url,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    title: 'Open on the tracker',
                    'aria-label': 'Open on the tracker',
                    onClick: () => track('mission.open-tracker'),
                  }, h(ActionIcon, { name: 'tracker' }))
                : h('button', { type: 'button', className: 'missions-action missions-action--icon', disabled: true, title: 'No tracker link', 'aria-label': 'No tracker link' }, h(ActionIcon, { name: 'tracker' })),
              // The Tolgee import belongs to projects that declare their locales:
              // elsewhere the button is absent, not disabled — there is nothing
              // to check and no file to write.
              mission.translations
                ? h('button', {
                    type: 'button',
                    className: 'missions-action missions-action--icon',
                    onClick: importTolgee,
                    disabled: importingTolgee,
                    title: importingTolgee ? 'Checking the translations…' : 'Tolgee import',
                    'aria-label': importingTolgee ? 'Checking the translations…' : 'Tolgee import',
                  }, h(ActionIcon, { name: 'tolgee' }))
                : null,
              // Only a mission in review has remarks to check: the client does
              // not know whether a PR exists, so the state alone decides, and
              // the session stops with a word when `gh` finds none.
              mission.state === 'in-review'
                ? h('button', {
                    type: 'button',
                    className: 'missions-action missions-action--icon',
                    onClick: startFeedbackSession,
                    disabled: blocker !== null,
                    title: blocker ?? feedbackLabel,
                    'aria-label': feedbackLabel,
                    'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                  }, h(ActionIcon, { name: 'feedback' }))
                : null,
              // The free session sits above the step session, which stays the
              // primary and the last: a question is never the default gesture.
              // A closed mission plays no session at all, so `done` hides it.
              mission.state === 'done'
                ? null
                : h('button', {
                    type: 'button',
                    className: 'missions-action missions-action--icon',
                    onClick: startFreeSession,
                    disabled: freeBlocker !== null,
                    title: freeBlocker ?? freeLabel,
                    'aria-label': freeLabel,
                    'aria-describedby': freeBlocker ? 'missions-session-blocked' : undefined,
                  }, h(ActionIcon, { name: 'free' })),
              h('button', {
                type: 'button',
                className: 'missions-action missions-action--icon missions-action--primary',
                onClick: startSession,
                disabled: blocker !== null,
                title: blocker ?? sessionLabel,
                'aria-label': sessionLabel,
                'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
              }, h(ActionIcon, { name: 'session' })),
            ),
          ),      )
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
    function ActionIcon({ name }) {
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
        fetch(WORKFLOW_MODEL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ workflow: draft.workflow, model: { ...draft, exit: parseExits(exitText) } }),
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
          h('input', {
            value: form.description,
            placeholder: 'À quoi sert ce parcours',
            'aria-invalid': formErrors.description ? 'true' : 'false',
            onChange: (event) => updateForm('description', event.target.value),
          }),
          h('small', { className: 'wf-field-hint' }, 'une ligne, 280 caractères au plus'),
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
          h('button', { type: 'button', className: 'missions-drawer-close', 'aria-label': 'Fermer la création', onClick: closeCreate }, '×'),
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
            h('input', {
              value: draft.description ?? '',
              maxLength: 280,
              placeholder: 'À quoi sert ce parcours',
              onChange: (event) => patchModel('description', event.target.value),
            }),
            h('small', { className: 'wf-field-hint' }, 'une ligne, 280 caractères au plus'),
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
                h('button', { type: 'button', className: 'wf-arc-del', title: 'Supprimer l’arc', onClick: (event) => { event.stopPropagation(); removeArc(edge.from, edge.to) } }, '×'),
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
            h('button', {
              type: 'button',
              className: 'wf-card wf-pick',
              'data-workflow': workflow.workflow,
              'data-kind': workflow.kind,
              'aria-pressed': workflow.workflow === entry.workflow,
              onClick: () => { track('workflow.step', workflow.workflow); setStep(workflow.workflow) },
            },
              h('span', { className: 'wf-pick-top' },
                h('span', { className: 'wf-pick-title' }, workflow.title || workflow.workflow),
                h('span', { className: 'wf-pick-kind' }, WORKFLOW_KIND_LABELS[workflow.kind] ?? workflow.kind),
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
          statuts
            ? h('span', { className: 'wf-pick-kind' }, WORKFLOW_KIND_LABELS.statuts)
            : null,
        ),

        h('div', { className: 'wf-layout' }, canvas, dock),
      )
    }

    /**
     * One row of the repositories view: the clone's name, its branch, the
     * state of its working tree, and the commit it last moved on. The whole
     * row is the button — the tab's job is to get a repository open, not to
     * list it completely.
     */
    function RepositoryRow({ repository, now, onOpen, onAdopt, adopting, blocked = false }) {
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
      return h('li', { className: 'missions-repo-rowitem' },
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
          ? h('button', {
              type: 'button',
              className: 'missions-repo-main',
              title: switchTitle,
              'aria-label': mainName ? `Bring ${repository.name} into ${mainName}` : 'Bring the worktree into its main checkout',
              'aria-busy': adopting ? 'true' : 'false',
              disabled: !mainName || adopting || blocked,
              onClick: mainName ? () => onAdopt(repository) : undefined,
            }, h(MainWorktreeIcon))
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
     * It is the one tab that writes, and only through a worktree row's arrow:
     * a confirmed gesture, one POST, then the workspace read again. Reading it
     * stays free — the scan is what the list costs, and it runs on every open.
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

    function RepositoriesView({ theme, onOpen, onAdopted = () => {}, refresh = 0 }) {
      const [scan, setScan] = React.useState({ loading: true, data: null, error: null })
      // The tab's own write: the last gesture, its state and the sentence it
      // shows — then the counter that reads the workspace again, because the
      // checkouts it listed before the click are not the ones git now has.
      const [adoption, setAdoption] = React.useState(null)
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
        // again instead of showing the checkouts as they were. `refresh` is the
        // drawer's removal gesture — its row goes too, so the list reads again.
      }, [reload, refresh])

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
      // Bringing a worktree back is the tab's one write: it asks first, then
      // tells the host what to do and reads the workspace again. The host is
      // the only judge — its refusal is the sentence the banner shows.
      const adoptWorktree = async (worktree) => {
        if (!worktree || !worktree.main?.name) return
        const mainName = worktree.main.name
        const branch = worktree.branch || 'its branch'
        const ask = (question) => {
          const scope = typeof globalThis.confirm === 'function' ? globalThis : (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window : null)
          return !scope || scope.confirm(question)
        }
        const post = async (acceptIgnored) => {
          const response = await fetch(REPOSITORY_ADOPT_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(acceptIgnored ? { name: worktree.name, acceptIgnored: true } : { name: worktree.name }),
          })
          const body = await response.json().catch(() => ({}))
          return { response, body }
        }

        const question = `Bring ${branch} into ${mainName}?\n\n${mainName} will check out ${branch}, and the worktree ${worktree.name} (${worktree.path}) will be removed. Both trees must be clean: one uncommitted change refuses the switch.`
        if (!ask(question)) return
        track('repository.adopt', worktree.name)
        setAdoption({ name: worktree.name, state: 'running', message: `Bringing ${branch} into ${mainName}…` })
        try {
          let { response, body } = await post(false)
          // Ignored files go with the folder without git saying so: the host
          // names them, and a second yes is what deletes them.
          if (!response.ok && body?.ignored) {
            const held = Array.isArray(body.files) && body.files.length ? ` (${body.files.join(', ')})` : ''
            const noun = body.files?.length === 1 ? 'entry' : 'entries'
            if (!ask(`${worktree.name} also holds ignored ${noun}${held} that git deletes with the folder.\n\nRemove them with it?`)) {
              setAdoption({ name: worktree.name, state: 'error', message: `Nothing was removed: ${worktree.name} still holds ignored ${noun}.` })
              return
            }
            ;({ response, body } = await post(true))
          }
          if (!response.ok) throw new Error(body?.error ?? `switch failed (${response.status})`)
          const held = body.branch ?? branch
          const where = body.main?.name ?? mainName
          setAdoption({
            name: worktree.name,
            state: body.removed === false ? 'partial' : 'done',
            message: body.removed === false
              ? `${where} now holds ${held}, but the worktree ${worktree.name} stayed${body.reason ? `: ${body.reason}` : '.'}`
              : `${where} now holds ${held}; the worktree ${worktree.name} is gone.`,
          })
          // The drawer of that worktree has no folder left to describe — but a
          // folder git kept still has one.
          if (body.removed !== false) onAdopted(worktree)
        } catch (error) {
          setAdoption({ name: worktree.name, state: 'error', message: error?.message ?? String(error) })
        }
        // A refusal changed nothing, a partial switch did: read again anyway.
        setReload((value) => value + 1)
      }

      const running = adoption?.state === 'running' ? adoption.name : null

      return h('div', { className: 'missions-repos' },
        adoption
          ? h('div', {
              className: `missions-repos-adopt is-${adoption.state}`,
              role: adoption.state === 'error' ? 'alert' : 'status',
              'aria-live': 'polite',
            }, adoption.message)
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
                    visible.map((repository) => h(RepositoryRow, { key: repository.name, repository, now, onOpen, onAdopt: adoptWorktree, adopting: running === repository.name, blocked: running !== null })),
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
     * it stands against it — then, on their own tab, one branch's history and
     * the declared layout with its worktrees.
     *
     * Each section is read when it is opened: the detail is two git calls, a
     * history page one, and a layout one log per branch. Reading all three at
     * mount would spend them on tabs nobody opened.
     */
    function RepositoryDrawer({ repository, services, workspaceId, onClose, onRemoved = () => {}, theme }) {
      const [detail, setDetail] = React.useState({ loading: true, data: null, error: null })
      const [section, setSection] = React.useState('details')
      const [history, setHistory] = React.useState({ loading: false, more: false, data: null, error: null })
      const [tree, setTree] = React.useState({ loading: false, data: null, error: null })
      // The checkout being removed, by name: its button is busy, the others
      // wait. `treeRead` is the counter that reads the tab again once a folder
      // is gone — a refusal changes nothing and does not bump it.
      const [removing, setRemoving] = React.useState(null)
      const [treeRead, setTreeRead] = React.useState(0)
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
        if (section !== 'worktrees' || tree.data) return
        let alive = true
        setTree({ loading: true, data: null, error: null })
        readRoute(`${REPOSITORY_TREE_URL}?name=${encodeURIComponent(repository.name)}`)
          .then((data) => {
            if (alive) setTree({ loading: false, data, error: null })
          })
          .catch((error) => {
            if (alive) setTree({ loading: false, data: null, error: error?.message ?? String(error) })
          })
        return () => { alive = false }
        // A finished removal bumps `treeRead`: the tab is read again, because
        // the worktree it listed is not there anymore.
      }, [section, repository.name, treeRead])

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

      // The Worktrees tab's gesture: delete a checkout's folder and keep its
      // branch. It asks first, names the ignored entries git would take along,
      // and reads the tab again — the host is the only judge of the state.
      const removeWorktree = async (worktree) => {
        if (!worktree?.name) return
        const branch = worktree.branch || 'its branch'
        const ask = (question) => {
          const scope = typeof globalThis.confirm === 'function' ? globalThis : (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window : null)
          return !scope || scope.confirm(question)
        }
        const post = async (acceptIgnored) => {
          const response = await fetch(REPOSITORY_REMOVE_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(acceptIgnored ? { name: worktree.name, acceptIgnored: true } : { name: worktree.name }),
          })
          const body = await response.json().catch(() => ({}))
          return { response, body }
        }

        const question = `Remove the worktree ${worktree.name} (${worktree.path})?\n\nOnly the folder goes: the branch ${branch} is kept. A worktree with uncommitted changes refuses the removal.`
        if (!ask(question)) return
        track('repository.remove', worktree.name)
        setRemoving(worktree.name)
        try {
          let { response, body } = await post(false)
          // Ignored files go with the folder without git saying so: the host
          // names them, and a second yes is what deletes them.
          if (!response.ok && body?.ignored) {
            const held = Array.isArray(body.files) && body.files.length ? ` (${body.files.join(', ')})` : ''
            const noun = body.files?.length === 1 ? 'entry' : 'entries'
            if (!ask(`${worktree.name} also holds ignored ${noun}${held} that git deletes with the folder.\n\nRemove them with it?`)) {
              setNote(`Nothing was removed: ${worktree.name} still holds ignored ${noun}.`)
              return
            }
            ;({ response, body } = await post(true))
          }
          if (!response.ok) throw new Error(body?.error ?? `remove failed (${response.status})`)
          setNote(`The worktree ${worktree.name} is gone; the branch ${branch} is kept.`)
          // A drawer open on the removed folder has nothing left to describe:
          // the panel closes it and reads its list again. Another drawer keeps
          // its place and reads its tree again — that folder is gone.
          onRemoved(worktree)
          setTree({ loading: true, data: null, error: null })
          setTreeRead((value) => value + 1)
        } catch (error) {
          setNote(`Not removed: ${error?.message ?? String(error)}`)
        } finally {
          setRemoving(null)
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
          h('button', { type: 'button', className: 'missions-drawer-close', onClick: onClose, 'aria-label': 'Close' },
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
                : section === 'worktrees'
                  ? h(RepositoryTree, { tree, theme, onRemove: removeWorktree, removing, blocked: removing !== null })
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
              title: 'Resolve conflicts',
              'aria-label': 'Resolve conflicts',
            }, h(ActionIcon, { name: 'resolve' })),
            h('button', {
              type: 'button',
              className: 'missions-action missions-action--icon missions-action--primary',
              onClick: openSquashSession,
              disabled: squashBlocker !== null,
              title: squashBlocker ?? squashLabel,
              'aria-label': squashBlocker ?? squashLabel,
            }, h(ActionIcon, { name: 'squash' })),
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
     * The declared layout: one row per branch, indented by its depth, carrying
     * the commits it introduces on its parent (ten at most, then `+`), the
     * worktree that holds it, and a mark when the branch is not local.
     *
     * Below it, every worktree in full — path, branch, current — because a
     * branch may carry several, and a worktree may carry a branch the layout
     * does not declare. Each checkout but the principal carries the remove
     * gesture; a folder outside the root has no name to send, so it keeps none.
     * A layout that is absent or empty is not an empty tab: the worktrees are
     * still a reading of the repository.
     */
    function RepositoryTree({ tree, theme, onRemove = () => {}, removing = null, blocked = false }) {
      if (tree.error) return h('div', { className: 'missions-repos-error', role: 'alert' }, tree.error)
      if (!tree.data) return h(PanelLoader, { theme })
      const branches = Array.isArray(tree.data.branches) ? tree.data.branches : []
      const worktrees = Array.isArray(tree.data.worktrees) ? tree.data.worktrees : []
      const rows = h('ul', { className: 'missions-tree-flat', 'aria-label': 'Worktrees' },
        worktrees.map((worktree) => h(RepositoryWorktree, {
          key: worktree.path,
          worktree,
          onRemove,
          removing: removing === worktree.name,
          blocked,
        })),
      )

      if (!tree.data.layout) {
        return h('section', { className: 'missions-tree', 'aria-label': 'Repository tree' },
          h('p', { className: 'missions-drawer-note' }, 'No git machete layout for this repository — the worktrees below are the repository.'),
          worktrees.length === 0 ? h('p', { className: 'missions-drawer-note' }, 'No worktree.') : rows,
        )
      }

      return h('section', { className: 'missions-tree', 'aria-label': 'Repository tree' },
        h('ul', { className: 'missions-tree-branches' },
          branches.map((branch) => h(RepositoryBranch, { key: branch.name, branch })),
        ),
        worktrees.length === 0 ? null : h('div', { className: 'missions-tree-worktrees' },
          h('h3', { className: 'missions-drawer-section-title' }, 'Worktrees'),
          rows,
        ),
      )
    }

    /** One branch of the layout: its indent, its commits, its worktree. */
    function RepositoryBranch({ branch }) {
      const commits = Array.isArray(branch.commits) ? branch.commits : []
      return h('li', {
        className: branch.missing ? 'missions-tree-branch missions-tree-branch--missing' : 'missions-tree-branch',
        style: { paddingLeft: `${treeIndent(branch.depth)}px` },
      },
        h('div', { className: 'missions-tree-head' },
          h('span', { className: 'missions-tree-name' }, branch.name),
          branch.annotation ? h('span', { className: 'missions-tree-annotation' }, branch.annotation) : null,
          branch.worktree ? h('span', { className: 'missions-tree-tag', title: 'worktree' }, branch.worktree) : null,
          branch.missing ? h('span', { className: 'missions-tree-missing' }, 'not local') : null,
        ),
        commits.length > 0
          ? h('ul', { className: 'missions-tree-commits' },
              commits.map((commit, index) => h('li', { className: 'missions-tree-commit', key: `${commit.sha}-${index}` },
                h('span', { className: 'missions-tree-hash' }, commit.sha),
                h('span', { className: 'missions-tree-subject', title: commit.subject }, commit.subject),
              )),
            )
          : null,
        branch.truncated
          ? h('span', { className: 'missions-tree-more', title: 'More commits introduced on its parent are not shown.' }, '+')
          : null,
      )
    }

    /**
     * One worktree: where it is, the branch it holds, whether it is here, and
     * the gesture that removes the folder. The principal has no such gesture —
     * git cannot remove the checkout the others hang from — and the title says
     * the branch survives the removal, because that is the whole promise.
     */
    function RepositoryWorktree({ worktree, onRemove = () => {}, removing = false, blocked = false }) {
      return h('li', { className: 'missions-tree-worktree' },
        h('span', { className: 'missions-tree-worktree-label', title: worktree.path }, worktree.path),
        h('span', { className: 'missions-tree-worktree-branch' }, worktree.branch ?? 'detached'),
        worktree.current ? h('span', { className: 'missions-tree-worktree-current' }, 'current') : null,
        worktree.main
          ? h('span', { className: 'missions-tree-worktree-main', title: 'The main worktree cannot be removed.' }, 'main')
          : worktree.name
            ? h('button', {
                type: 'button',
                className: 'missions-tree-remove',
                title: `Remove ${worktree.name} (${worktree.branch ?? 'detached'}) — its branch is kept`,
                'aria-label': `Remove the worktree ${worktree.name}`,
                'aria-busy': removing ? 'true' : 'false',
                disabled: removing || blocked,
                onClick: () => onRemove(worktree),
              }, h(ActionIcon, { name: 'remove' }))
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
      // view switch, and a reload must not lose the search, the filters or the
      // order. Nothing outlives the app: session storage dies with the window.
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
      const [sort, setSort] = React.useState(restored.sort)
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
      const [doneSort, setDoneSort] = React.useState(doneRestored.sort)
      // How many repositories the root holds, for the tab badge: null until the
      // first read, so the tab shows no number it cannot prove.
      const [repositoryCount, setRepositoryCount] = React.useState(null)
      // The section open under Settings, restored from the same session value:
      // the stored id is the section while Settings is open. Last in the order
      // so the states above keep the session slot `missions.tab` restores.
      const [settingsView, setSettingsView] = React.useState(() => initialView.current.settingsView)
      // The drawer's removal gesture bumps this counter: the list it came from
      // no longer holds the folder, so the tab reads the workspace again. It
      // comes last so the states above keep their session slot.
      const [repositoryRefresh, setRepositoryRefresh] = React.useState(0)
      // The dashboard's digest of the root: its own read, kept apart from the
      // Repositories tab's scan. The tab pays a live scan when it opens; the
      // digest reads the host's five-minute memory instead, so it is the only
      // read a minute of ticks can afford.
      const [summaryView, setSummaryView] = React.useState({ loading: true, data: null, error: null })

      // The view's declared perimeter: a tab carries its own source, Settings
      // reads whatever its open section reads — so the banner and the tick
      // never lie about what the panel touches under Settings.
      const settingsSection = SETTINGS_VIEWS.find((entry) => entry.id === settingsView) ?? SETTINGS_VIEWS[0]
      const tabSource = tab === 'settings' ? settingsSection.source : TABS.find((entry) => entry.id === tab)?.source ?? 'tracker'
      const trackerTab = tabSource === 'tracker'

      // One write per change, the clear included: an empty bar drops its key.
      React.useEffect(() => {
        writeFilterSnapshot(filterStorage(), { query, filters, sort })
      }, [query, filters, sort])

      // Done keeps its own key, and its snapshot accepts the fixed status.
      React.useEffect(() => {
        writeFilterSnapshot(filterStorage(), { query: doneQuery, filters: doneFilters, sort: doneSort }, DONE_FILTERS_KEY, { allowDone: true })
      }, [doneQuery, doneFilters, doneSort])

      // The session keeps the view: the tab, and the section standing in for
      // Settings. The resting dashboard still drops the key.
      React.useEffect(() => {
        writeStoredView(filterStorage(), { tab, settingsView }, TAB_IDS, SETTINGS_IDS)
      }, [tab, settingsView])

      // The panel is remounted on every view switch: forcing a fresh read at
      // mount would pay the whole tracker round-trip on every return to
      // Missions. The server cache (60 s) is read instead; only the explicit
      // Refresh button and the 60 s tick ask for a fresh read.
      const load = React.useCallback(({ silent = false, refresh = false } = {}) => {
        if (!silent) setView((previous) => ({ ...previous, loading: true }))
        const url = refresh ? `${LIST_URL}?refresh=1` : LIST_URL
        return fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
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
          })
          .catch((error) => {
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
      // tick keeps it fresh. Another tab never pays the read, and the closed
      // rows come from the Done tab's read, which the tick leaves alone.
      React.useEffect(() => {
        if (tab !== 'dashboard') return undefined
        loadSummary()
        loadDone()
        return undefined
      }, [tab, loadSummary, loadDone])

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
      // Archiving takes the folder out of Done: the row leaves both copies at
      // once, the badge drops it without waiting, the drawer closes, and the
      // closed read refreshes without asking the tracker for a key the machine
      // no longer declares.
      const applyArchive = (archived) => {
        const drop = (previous) => ({
          ...previous,
          missions: previous.missions.filter((mission) => mission.key !== archived.key),
        })
        // The count follows the row at once, then the fresh read confirms it.
        const dropCount = (previous) => ({
          ...previous,
          count: typeof previous.count === 'number' && previous.count > 0 ? previous.count - 1 : previous.count,
        })
        setView(drop)
        setDoneView((previous) => dropCount(drop(previous)))
        setSelected(null)
        loadDone({ silent: true, refresh: true })
      }
      const hero = theme === 'default' ? null : h('div', { className: 'missions-hero', 'aria-hidden': 'true' },
        h('img', { className: 'missions-hero-photo', src: ART.village, alt: '' }),
        h('div', { className: 'missions-hero-bubble' },
          h('b', null, `${openMissions.length} mission${openMissions.length === 1 ? '' : 's'}!`),
          h('span', null, `${projectCount} project${projectCount === 1 ? '' : 's'}`),
        ),
        h('div', { className: 'missions-hero-avatar' },
          h('img', { src: ART.avatar, alt: '' }),
        ),
      )
      const activeQuery = doneTab ? doneQuery : query
      const activeFilters = doneTab ? doneFilters : filters
      const activeSort = doneTab ? doneSort : sort
      // Done keeps closed rows, so it is the only view that passes `allowDone`.
      const filtered = filterMissions(activeMissions, { query: activeQuery, ...activeFilters, allowDone: doneTab })
      const groups = groupByState(sortMissions(filtered, activeSort))
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
      const onSort = (next) => {
        track('filter.sort', next ?? 'default')
        if (doneTab) setDoneSort(next)
        else setSort(next)
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

      // A widget's link opens the list on exactly the rows the widget showed:
      // its states, its type, its priority — no search, no order, no other
      // filter. The bar is reset rather than completed, so the count the widget
      // announced is the count the list shows.
      const onViewAll = (filters = {}) => {
        track('dashboard.view-all', Object.keys(filters).join(','))
        setSelected(null)
        setQuery('')
        setSort(null)
        setFilters({ ...EMPTY_FILTERS, ...filters })
        setTab('missions')
        setRepository(null)
      }

      // Opening a mission is one gesture wherever the row lives: the list, the
      // Done list and a dashboard widget all come through here.
      const openMission = (mission) => {
        track('mission.open')
        setSelected(mission)
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

      return h('div', { className: 'missions-panel', 'data-theme': theme, 'data-skin': theme === 'default' ? undefined : 'paper' },
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
                  settingsSection.id === 'usage' ? h(UsageTab, { theme }) : h(WorkflowsView, null),
                  settingsSection.id === 'usage'
                    ? h('aside', { className: 'missions-settings-note', 'aria-label': 'Usage details' },
                        h('p', { className: 'missions-settings-note-text' },
                          'Every gesture the panel counted, in a file this machine keeps. A recommendation is a reading of the counts, not an order: the panel never deletes anything.'),
                      )
                    : null)
              : tab === 'repositories'
              ? h(RepositoriesView, {
                  theme,
                  onOpen: openRepository,
                  // The tab's write removes a folder: a drawer open on it has
                  // nothing left to describe, so it closes with the worktree.
                  onAdopted: (worktree) => { if (repository && repository.name === worktree.name) setRepository(null) },
                  refresh: repositoryRefresh,
                })
              : tab === 'done'
              ? h(MissionsView, {
                  missions: doneMissions, query: doneQuery, onQuery, onSearchEnd, filters: doneFilters, onFilter, onClear, sort: doneSort, onSort,
                  filtered, groups, onSelect: openMission, theme, loading: doneView.loading, failed,
                  onRefresh: () => { track('list.refresh', 'done'); return loadDone({ refresh: true }) },
                  statusOptions: ['done'], statusFixed: true,
                  emptyText: 'No done mission declared on this machine.',
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
                  closed: doneView.loading || doneView.errors.length > 0 ? null : doneMissions,
                  onOpen: (mission) => { openMission(mission); setTab('missions') },
                  onOpenAll: () => { setSelected(null); changeTab('missions') },
                  onViewAll,
                  onOpenSection: (next) => changeTab(next),
                  // A row of the digest opens what it names: the repository
                  // drawer for a checkout, the mission's drawer for a closed
                  // mission. The tab follows, so the drawer is not a ghost.
                  onOpenRepository: (repository) => {
                    changeTab('repositories')
                    openRepository(repository)
                  },
                  onOpenClosed: (mission) => { openMission(mission); setTab('done') },
                  onRetrySummary: () => { track('list.retry', 'summary'); return loadSummary({ refresh: true }) },
                })
              : h(MissionsView, {
                  missions, query, onQuery, onSearchEnd, filters, onFilter, onClear, sort, onSort,
                  filtered, groups, onSelect: openMission, theme, loading, failed,
                  onRefresh: () => { track('list.refresh', 'open'); return load({ refresh: true }) },
                }),
          ),
          tab === 'settings'
            ? null
            : tab === 'repositories'
            ? repository
              ? h(RepositoryDrawer, {
                  key: repository.name,
                  repository,
                  services,
                  workspaceId,
                  onClose: () => setRepository(null),
                  // The drawer's removal gesture: a drawer open on the removed
                  // folder closes, and the list reads the workspace again.
                  onRemoved: (worktree) => {
                    if (repository && repository.name === worktree.name) setRepository(null)
                    setRepositoryRefresh((value) => value + 1)
                  },
                  theme,
                })
              : h('aside', { className: 'missions-drawer missions-drawer--empty', 'aria-label': 'Repository details' },
                  h('p', { className: 'missions-drawer-hint' }, 'Select a repository to see its remote, its upstream and its last commits.'),
                )
            : selected
            ? h(MissionDrawer, { key: selected.key, mission: selected, services, workspaceId, workspaceRoot, onClose: () => setSelected(null), onSaved: applyDeclaration, onPrioritySaved: applyPriority, onArchived: applyArchive, theme })
            : tab === 'dashboard'
            ? h(DashboardQueue, {
                missions,
                services,
                workspaceId,
                workspaceRoot,
                onOpenMission: (mission) => { openMission(mission); setTab('missions') },
                onOpenMissions: () => { setSelected(null); changeTab('missions') },
              })
            : h('aside', { className: 'missions-drawer missions-drawer--empty', 'aria-label': 'Mission details' },
                h('p', { className: 'missions-drawer-hint' }, 'Select a mission to see its details and act on it.'),
              ),
        ),
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
