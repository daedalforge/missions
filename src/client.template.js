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

    /* __VIEW__ */
    /* __ART__ */

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
  const WORKFLOW_FORM = { title: '', description: '', kind: 'etape', local: false }
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
/* One card, one frame: border, radius and background are shared by every list.
   Geometry and interior belong to the variant; a static card draws no
   affordance, an interactive one owns its hover, focus ring and pressed state. */
.missions-card { display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #ffffff); transition: border-color .15s ease, background-color .15s ease; }
.missions-card[data-interactive="true"] { cursor: pointer; }
.missions-card[data-interactive="true"]:hover { border-color: color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 3%, var(--dsw-alias-bg-layer-1, #ffffff)); }
.missions-card[data-interactive="true"]:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-card[data-interactive="true"][aria-pressed="true"] { border-color: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary, #1f1f1f); }
.missions-card--mission { gap: 10px; padding: 14px 16px 12px; }
.missions-card--pick { width: 100%; gap: 6px; padding: 12px; text-align: left; font: inherit; color: inherit; }
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

/* Cards: ink frame, folded corner, speech-bubble type, dashed points. */
.missions-panel[data-skin="paper"] .missions-cards { gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
/* The paper skin frames the three variants; the geometry stays on --mission. */
.missions-panel[data-skin="paper"] .missions-card { position: relative; border: 1.5px solid var(--skin-ink); border-radius: 12px 12px 13px 3px; background: var(--skin-page-2); box-shadow: 3px 3px 0 var(--skin-shadow); transition: background-color .12s ease, box-shadow .12s ease; }
.missions-panel[data-skin="paper"] .missions-card--mission { gap: 7px; padding: 11px 14px 9px; }
.missions-panel[data-skin="paper"] .missions-card[data-interactive="true"]:hover { border-color: var(--skin-ink); background: color-mix(in srgb, var(--skin-accent) 8%, var(--skin-page-2)); box-shadow: 5px 5px 0 var(--skin-shadow); }
.missions-panel[data-skin="paper"] .missions-card[data-interactive="true"]:focus-visible { outline: 2px solid var(--skin-accent-strong); outline-offset: 2px; }
/* The folded corner stays on the mission card: on a widget it would sit on the meta. */
.missions-panel[data-skin="paper"] .missions-card--mission::after { content: ""; position: absolute; top: -1.5px; right: -1.5px; width: 13px; height: 13px; background: linear-gradient(225deg, var(--skin-page) 47%, var(--skin-ink) 48% 53%, transparent 54%); }
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
.missions-panel[data-skin="paper"] .missions-card-head-title { color: var(--skin-ink); }
.missions-panel[data-skin="paper"] .missions-card-meta { color: var(--skin-ink-3); }
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
.missions-panel[data-skin="paper"] .missions-card[data-interactive="true"][data-blocked="true"]:hover { background: color-mix(in srgb, var(--skin-danger) 18%, var(--skin-page-2)); border-color: var(--skin-danger-strong); }
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
  .missions-panel[data-skin="paper"] .missions-card[data-interactive="true"]:hover { transform: none; }
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
     * The one card of the plugin: an ink frame, then the slots each list fills.
     * The frame (border, radius, background) is shared; the geometry, the paper
     * skin and the interior belong to the variant.
     *
     * `interactive` is what makes a card a control: it takes the click, the
     * focus ring and the Enter/Space keys, and says so with `data-interactive`
     * so the stylesheet never draws an affordance a static card would lie
     * about. A native `button` brings those by itself: only the click is wired
     * there, and a pressed state is an `aria-pressed`, not a `role`.
     */
    function Card({
      as = 'article',
      variant = 'mission',
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
        if (as !== 'button') {
          props.role = 'button'
          props.tabIndex = 0
          props.onKeyDown = (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onActivate()
            }
          }
        }
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
                  ? h('p', { className: 'missions-card-empty' }, 'No unresolved bug assigned to you.')
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
                  ? h('p', { className: 'missions-card-empty' }, 'No high-priority story.')
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
                  ? h('p', { className: 'missions-card-empty' }, 'Nothing is in progress.')
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
                  ? h('p', { className: 'missions-card-empty' }, 'Nothing is waiting on you.')
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
                  ? h('p', { className: 'missions-card-empty' }, 'No mission is closed yet.')
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
                  ? h('p', { className: 'missions-card-empty' }, 'The repository scan has not run, so leftovers are unknown.')
                  : leftovers.length === 0
                    ? h('p', { className: 'missions-card-empty' }, 'No closed mission still holds a worktree.')
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
      return h(Card, {
        variant: 'mission',
        interactive: true,
        onActivate: () => onSelect(mission),
        'data-priority': mission.priority ?? 'none',
        'data-blocked': mission.blocked ? 'true' : 'false',
        top: [
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
        ],
        title: mission.title,
        foot: [
          h('span', { className: 'missions-key' }, mission.key),
          h('span', { className: 'missions-age' }, relativeAge(mission.updatedAt)),
        ],
      })
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
            : tab === 'dashboard'
            ? null
            : selected
            ? h(MissionDrawer, { key: selected.key, mission: selected, services, workspaceId, workspaceRoot, onClose: () => setSelected(null), onSaved: applyDeclaration, onPrioritySaved: applyPriority, onArchived: applyArchive, theme })
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
