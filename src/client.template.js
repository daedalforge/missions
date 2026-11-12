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
    const DECLARE_URL = 'missions/api/branches'
    const BLOCKED_URL = 'missions/api/blocked'
    const PRIORITY_URL = 'missions/api/priority'
    // The one gesture that deletes a branch: it sends a key and the host owns
    // the proof, the refusals, and every writing command.
    const LOCAL_CLOSE_URL = 'missions/api/local-close'
    const JOURNAL_URL = 'missions/api/journal'
    const CHECKLIST_URL = 'missions/api/checklist'
    const WORKFLOWS_URL = 'missions/api/workflows'
    const WORKFLOW_MODEL_URL = 'missions/api/workflows/model'
    const REPOSITORIES_URL = 'missions/api/repositories'
    // The tab badge reads this one at mount: the count costs no git process,
    // where the list above pays two calls per entry.
    const REPOSITORIES_COUNT_URL = 'missions/api/repositories/count'
    const REPOSITORY_URL = 'missions/api/repositories/detail'
    const REPOSITORY_HISTORY_URL = 'missions/api/repositories/commits'
    const REPOSITORY_TREE_URL = 'missions/api/repositories/tree'
  // L'ordre de la méthode, connu avant que le serveur ait répondu : il valide
  // l'étape que la session a laissée ouverte.
  const WORKFLOW_STEPS = ['cadrage', 'execution', 'review', 'cloture']
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
    // failure speaks for both; the workflows tab reads its own files and never
    // wears the tracker's banner. `badge` names the count the tab carries: the
    // open missions the list already holds, or the root's repositories, read
    // on its own route. Done reads the tracker too, but in its own perimeter:
    // closed missions the machine declares, with a bar and a read of their own.
    const TABS = [
      { id: 'dashboard', label: 'Dashboard', source: 'tracker' },
      { id: 'missions', label: 'Missions', source: 'tracker', badge: 'missions' },
      { id: 'done', label: 'Done', source: 'tracker' },
      // The repositories tab reads the host, not the tracker: it declares its
      // own source, so it never wears the tracker's banner.
      { id: 'repositories', label: 'Repositories', source: 'host', badge: 'repositories' },
      { id: 'workflows', label: 'Workflows', source: 'files' },
    ]

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
        return localStorage.getItem(THEME_KEY) === 'manga' ? 'manga' : 'default'
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
.wf-field input, .wf-field select { font: inherit; font-size: 12px; height: 28px; padding: 0 7px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: transparent; color: inherit; }
.wf-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wf-arc { display: flex; align-items: center; gap: 6px; padding: 2px 4px; margin: 0 -4px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.wf-arc:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.wf-arc-when { color: var(--dsw-alias-label-tertiary, #7a7168); }
.wf-arc-del { border: 0; background: none; padding: 0 3px; color: #a33a2a; cursor: pointer; font-size: 13px; line-height: 1; }
.wf-error { color: #a33a2a; font-size: 12px; margin: 2px 0; }
.wf-ok { color: #3f7a4b; font-size: 12px; margin: 2px 0; }
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
@media (prefers-reduced-motion: reduce) { .missions-sect-arrow, .missions-rowarrow { transition: none; } }
@container (max-width: 820px) { .missions-sectgrid { grid-template-columns: minmax(0, 1fr); } .missions-dash-card--flight, .missions-dash-card--queue, .missions-dash-card--bugs, .missions-dash-card--stories { grid-column: auto; } }
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
.missions-drawer-actions { display: flex; flex-direction: column; gap: 8px; margin-top: auto; }
.missions-action { height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12.5px; text-decoration: none; cursor: pointer; }
.missions-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-action--primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill, #1f1f1f); color: var(--dsw-alias-label-primary-foreground, #ffffff); font-weight: 600; }
.missions-action--primary:hover { filter: brightness(1.06); background: var(--dsw-alias-button-primary-fill, #1f1f1f); }
.missions-action:disabled { opacity: .55; cursor: default; }
/* Closing the local checkout deletes a branch: the colour says so, and the
   second click is the confirmation. */
.missions-action--danger { border-color: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 38%, transparent); color: var(--dsw-alias-label-danger, #b42318); }
.missions-action--danger:hover { background: color-mix(in srgb, var(--dsw-alias-label-danger, #b42318) 7%, transparent); }
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
.missions-repo-head { padding: 0 10px 7px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 9.5px; letter-spacing: .07em; text-transform: uppercase; }
.missions-repo-head > span:last-child { justify-self: end; }
.missions-repo-rowitem { margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.07)); }
.missions-repo-rowitem:last-child { border-bottom: 0; }
.missions-repo { width: 100%; height: 36px; padding: 0 10px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.missions-repo:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 5%, transparent); }
.missions-repo:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: -2px; }
.missions-repo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; font-weight: 550; }
.missions-repo-kind { margin-left: 7px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 4px; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase; vertical-align: 1px; }
.missions-repo-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #4a4a4a); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; }
.missions-repo-state { justify-self: start; padding: 1px 7px; border-radius: 9px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; white-space: nowrap; }
.missions-repo-state[data-dirty="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-repo-state[data-error="true"] { color: #cf222e; font-weight: 600; }
.missions-repo-commit { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.missions-repo-age { justify-self: end; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-repos-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.missions-repos-total { color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 12px; font-weight: 600; }
.missions-repos-root { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; }
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
.missions-tree-worktrees { display: grid; gap: 8px; }
@media (max-width: 860px) {
  .missions-repo-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr) 78px 52px; }
  .missions-col-commit { display: none; }
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

/* Naruto theme: scoped to the panel, opt-in, no global token. */
.missions-panel[data-theme="manga"] {
  --mm-page: #fbf4e6; --mm-page-2: #fffaf0; --mm-page-3: #f3e7d3;
  --mm-ink: #2c2621; --mm-ink-2: #5e554b; --mm-ink-3: #756b60;
  --mm-line: #ddccb2; --mm-line-strong: #c8b69a; --mm-shadow: #d9c6a8;
  --mm-orange: #f2a26f; --mm-orange-deep: #a85526;
  --mm-sage: #aec7a7; --mm-sage-deep: #4f6d53;
  --mm-sky: #a9c8db; --mm-sky-deep: #4f7488;
  --mm-teal: #8fbfae; --mm-teal-deep: #3f6b66;
  --mm-lilac: #cdbcdd; --mm-lilac-deep: #6d5587;
  --mm-butter: #f3d38c; --mm-coral: #e88a7d; --mm-coral-deep: #a8453a;
  --mm-display: "Avenir Next", "Futura", ui-rounded, "Trebuchet MS", sans-serif;
  --mm-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --mm-trame: rgba(44, 38, 33, .07);
  background: var(--mm-page); color: var(--mm-ink); font-size: 12.5px; line-height: 1.45;
  container-type: inline-size;
}
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"],
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] {
  --mm-page: #1e2330; --mm-page-2: #252c3b; --mm-page-3: #2d3547;
  --mm-ink: #f5ecdf; --mm-ink-2: #cfc4b5; --mm-ink-3: #a89d8f;
  --mm-line: #3d4659; --mm-line-strong: #566176; --mm-shadow: #0f1420;
  --mm-trame: rgba(245, 236, 223, .075);
}

:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-hero-photo,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-hero-photo { filter: saturate(.45) brightness(.55) contrast(1.02); }
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-type,
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-ring,
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-tab-count,
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-title-mark,
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-drawer::before,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-type,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-ring,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-tab-count,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-title-mark,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-drawer::before { color: #2c2621; }
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-name,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-name { color: var(--mm-ink-2); }
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-declare-note--error,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-declare-note--error { color: var(--mm-coral); }

/* The select, in the themed header. */
.missions-panel[data-theme="manga"] .missions-theme { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-theme-label { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-theme-value { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-theme svg { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-btn { height: 29px; padding: 0 10px; border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); color: var(--mm-ink); font-size: 11px; }
.missions-panel[data-theme="manga"] .missions-btn:hover { background: var(--mm-page-3); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-icon-btn { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 1px 1px 0 var(--mm-shadow); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-icon-btn:hover { background: var(--mm-page-3); color: var(--mm-ink); }
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-icon-btn,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-icon-btn { background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-retry { border: 1.5px solid var(--mm-coral-deep); border-radius: 8px; background: color-mix(in srgb, var(--mm-coral) 20%, var(--mm-page-2)); box-shadow: 1px 1px 0 var(--mm-shadow); color: var(--mm-ink); font-family: var(--mm-display); }

/* Hero: the photograph, the paper wash, the portrait and the speech bubble. */
.missions-panel[data-theme="manga"] .missions-hero { position: relative; flex: none; height: 172px; overflow: hidden; border-bottom: 1.5px solid var(--mm-ink); background: var(--mm-page); }
.missions-panel[data-theme="manga"] .missions-hero-photo { position: absolute; inset: 9px 9px 0; width: calc(100% - 18px); height: calc(100% - 9px); object-fit: cover; object-position: 50% 54%; border: 1.5px solid var(--mm-ink); border-radius: 6px; filter: saturate(.62) contrast(1) brightness(1.08); z-index: 0; }
.missions-panel[data-theme="manga"] .missions-hero::before { content: ""; position: absolute; inset: 9px 9px 0; z-index: 1; border-radius: 6px; background-image: radial-gradient(var(--mm-ink) 1px, transparent 1.15px); background-size: 5px 5px; opacity: .2; mix-blend-mode: multiply; pointer-events: none; }
.missions-panel[data-theme="manga"] .missions-hero::after { content: ""; position: absolute; inset: 9px 9px 0; z-index: 2; border-radius: 6px; pointer-events: none; background: linear-gradient(90deg, var(--mm-page) 0%, var(--mm-page) 30%, color-mix(in srgb, var(--mm-page) 88%, transparent) 44%, transparent 64%), linear-gradient(165deg, rgba(242,162,111,.16), rgba(251,244,230,.16) 55%, rgba(169,200,219,.12)); }
.missions-panel[data-theme="manga"] .missions-hero-avatar { position: absolute; z-index: 3; right: 26px; bottom: 16px; width: 112px; height: 112px; border-radius: 50%; overflow: hidden; border: 3px solid var(--mm-page); background: var(--mm-page-2); box-shadow: 0 0 0 1.5px var(--mm-ink), 4px 4px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-hero-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-theme="manga"] .missions-hero-bubble { position: absolute; z-index: 3; right: 152px; bottom: 54px; display: flex; flex-direction: column; gap: 1px; min-width: 118px; padding: 8px 11px; border: 1.5px solid var(--mm-ink); border-radius: 9px; background: var(--mm-page-2); color: var(--mm-ink); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-hero-bubble::after { content: ""; position: absolute; right: -7px; bottom: 12px; width: 11px; height: 11px; background: var(--mm-page-2); border-right: 1.5px solid var(--mm-ink); border-bottom: 1.5px solid var(--mm-ink); transform: rotate(-45deg); }
.missions-panel[data-theme="manga"] .missions-hero-bubble b { font-size: 11px; line-height: 1.2; }
.missions-panel[data-theme="manga"] .missions-hero-bubble span { font-size: 8.5px; color: var(--mm-ink-3); }

/* Header over the hero: kicker, title, scope, actions. */
.missions-panel[data-theme="manga"] .missions-head--hero { position: absolute; z-index: 4; inset: 0; height: 172px; display: block; padding: 0 30px; pointer-events: none; }
.missions-panel[data-theme="manga"] .missions-kicker { position: absolute; top: 17px; left: 30px; display: flex; align-items: center; gap: 8px; color: var(--mm-ink-3); font-size: 8.5px; font-weight: 800; letter-spacing: .2em; text-transform: uppercase; }
.missions-panel[data-theme="manga"] .missions-kicker-rule { width: 20px; height: 2px; border-radius: 2px; background: var(--mm-orange-deep); transform: rotate(-2deg); }
.missions-panel[data-theme="manga"] .missions-head--hero .missions-title { position: absolute; left: 30px; bottom: 30px; margin: 0; color: var(--mm-ink); font-family: var(--mm-display); font-size: 38px; font-weight: 800; letter-spacing: -.035em; line-height: 1; pointer-events: auto; }
.missions-panel[data-theme="manga"] .missions-title-mark { display: inline-grid; place-items: center; width: 31px; height: 31px; margin-left: 11px; vertical-align: middle; border: 1.5px solid var(--mm-ink); border-radius: 8px 9px 8px 10px; background: var(--mm-orange); color: var(--mm-ink); font: 800 17px/1 var(--mm-display); box-shadow: 2px 2px 0 var(--mm-shadow); transform: rotate(2deg); }
.missions-panel[data-theme="manga"] .missions-head--hero .missions-scope { position: absolute; left: 31px; bottom: 8px; color: var(--mm-ink-3); font-size: 11px; }
.missions-panel[data-theme="manga"] .missions-head--hero .missions-scope::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: var(--mm-sage); vertical-align: 1px; }
.missions-panel[data-theme="manga"] .missions-head--hero .missions-actions { position: absolute; top: 18px; right: 24px; margin: 0; pointer-events: auto; }

/* Tabs, toolbar, search and filters. */
.missions-panel[data-theme="manga"] .missions-tabs { height: 44px; margin-top: 0; padding: 0 30px; gap: 26px; border-bottom: 1.5px solid var(--mm-ink); background-color: var(--mm-page); background-image: radial-gradient(var(--mm-trame) .55px, transparent .6px); background-size: 9px 9px; }
.missions-panel[data-theme="manga"] .missions-tab { height: 44px; color: var(--mm-ink-3); font-size: 11.5px; letter-spacing: .02em; }
.missions-panel[data-theme="manga"] .missions-tab[aria-selected="true"] { color: var(--mm-ink); border-bottom: 3px solid var(--mm-orange-deep); font-weight: 700; }
.missions-panel[data-theme="manga"] .missions-tab-count { display: grid; place-items: center; flex: none; width: 24px; height: 24px; min-width: 0; padding: 0; border: 1.5px solid var(--mm-ink); border-radius: 50%; background: var(--mm-orange); color: var(--mm-ink); font: 700 11px/1 var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-toolbar { padding: 11px 30px 8px; gap: 7px; background-color: var(--mm-page); background-image: radial-gradient(var(--mm-trame) .55px, transparent .6px); background-size: 9px 9px; }
.missions-panel[data-theme="manga"] .missions-search { height: 32px; border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); color: var(--mm-ink-3); box-shadow: 1px 1px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-search input { color: var(--mm-ink); font-size: 12.5px; }
.missions-panel[data-theme="manga"] .missions-search input::placeholder { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-select { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 1px 1px 0 var(--mm-shadow); color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-status-menu { border: 1.5px solid var(--mm-ink); border-radius: 9px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-status-option:hover { background: color-mix(in srgb, var(--mm-ink) 8%, transparent); }
.missions-panel[data-theme="manga"] .missions-status-actions { border-color: var(--mm-line); }
.missions-panel[data-theme="manga"] .missions-status-option[data-state="in-review"] input { accent-color: var(--mm-sky-deep); }
.missions-panel[data-theme="manga"] .missions-status-option[data-state="ready-for-prod"] input { accent-color: var(--mm-teal-deep); }
.missions-panel[data-theme="manga"] .missions-status-option[data-state="in-progress"] input { accent-color: #8a6a1f; }
.missions-panel[data-theme="manga"] .missions-status-option[data-state="ready"] input { accent-color: var(--mm-sage-deep); }
.missions-panel[data-theme="manga"] .missions-status-option[data-state="to-refine"] input { accent-color: var(--mm-lilac-deep); }
.missions-panel[data-theme="manga"] .missions-dash-link { font-family: var(--mm-display); }
.missions-panel[data-theme="manga"] .missions-select-label { color: var(--mm-ink-3); font-size: 9px; }
.missions-panel[data-theme="manga"] .missions-select-value { color: var(--mm-ink); font-weight: 600; }
.missions-panel[data-theme="manga"] .missions-select[data-active="true"] { border-color: var(--mm-orange-deep); background: color-mix(in srgb, var(--mm-butter) 52%, var(--mm-page-2)); }
.missions-panel[data-theme="manga"] .missions-switch { color: var(--mm-ink-2); font-size: 10.5px; }
.missions-panel[data-theme="manga"] .missions-switch-track { border: 1.5px solid var(--mm-ink); background: var(--mm-page-2); box-shadow: 1px 1px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-switch-thumb { background: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-switch[aria-checked="true"] .missions-switch-track { background: var(--mm-coral); border-color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-switch[aria-checked="true"] .missions-switch-thumb { background: var(--mm-page); }
.missions-panel[data-theme="manga"] .missions-clear { height: 29px; padding: 0 9px; border: 1.5px dashed var(--mm-line-strong); border-radius: 7px; color: var(--mm-ink-3); text-decoration: none; font-size: 10px; }
.missions-panel[data-theme="manga"] .missions-clear:hover { border-color: var(--mm-ink); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-empty { margin: 10px 0 0; padding: 14px 16px; border: 1.5px dashed var(--mm-line-strong); border-radius: 9px; background: var(--mm-page-2); color: var(--mm-ink-3); font-size: 11.5px; }

/* Groups: a tinted stamp, a name, a rule. */
.missions-panel[data-theme="manga"] .missions-group { margin-top: 10px; }
.missions-panel[data-theme="manga"] .missions-group-head { position: sticky; top: 0; z-index: 3; gap: 9px; padding: 0 1px 7px; background: var(--mm-page); color: var(--mm-ink-3); font-size: 10px; letter-spacing: .14em; }
.missions-panel[data-theme="manga"] .missions-group-ring { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border: 1.5px solid var(--mm-ink); border-radius: 50%; background: var(--state-tint, var(--mm-lilac)); color: var(--mm-ink); font: 700 11px/1 var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-group-name { flex: none; color: var(--group-ink, var(--mm-ink-2)); font-size: 10px; font-weight: 800; }
.missions-panel[data-theme="manga"] .missions-group-rule { flex: 1; height: 1px; background: var(--mm-line); }
.missions-panel[data-theme="manga"] .missions-group[data-state="in-review"] { --state-tint: var(--mm-sky); --group-ink: var(--mm-sky-deep); }
.missions-panel[data-theme="manga"] .missions-group[data-state="ready-for-prod"] { --state-tint: var(--mm-teal); --group-ink: var(--mm-teal-deep); }
.missions-panel[data-theme="manga"] .missions-group[data-state="in-progress"] { --state-tint: var(--mm-butter); --group-ink: #8a6a1f; }
.missions-panel[data-theme="manga"] .missions-group[data-state="ready"] { --state-tint: var(--mm-sage); --group-ink: var(--mm-sage-deep); }
.missions-panel[data-theme="manga"] .missions-group[data-state="to-refine"] { --state-tint: var(--mm-lilac); --group-ink: var(--mm-lilac-deep); }
.missions-panel[data-theme="manga"] .missions-sect { background: color-mix(in srgb, var(--mm-ink) 6%, transparent); }
.missions-panel[data-theme="manga"] .missions-dash-card { background: var(--mm-page-2); border: 1.5px solid var(--mm-line-strong); border-radius: 11px; }
.missions-panel[data-theme="manga"] .missions-dash-card-sub { color: var(--mm-ink-3); font-family: var(--mm-display); letter-spacing: .01em; }
.missions-panel[data-theme="manga"] .missions-dash-card-foot, .missions-panel[data-theme="manga"] .missions-rowitem { border-color: var(--mm-line); }
.missions-panel[data-theme="manga"] .missions-rowage[data-quiet="true"] { color: #8a5a00; }
.missions-panel[data-theme="manga"] .missions-row { font-family: var(--mm-display); }
.missions-panel[data-theme="manga"] .missions-rowkey { font-family: var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-row[data-state="in-review"] .missions-rowdot { background: var(--mm-sky-deep); }
.missions-panel[data-theme="manga"] .missions-row[data-state="ready-for-prod"] .missions-rowdot { background: var(--mm-teal-deep); }
.missions-panel[data-theme="manga"] .missions-row[data-state="in-progress"] .missions-rowdot { background: #8a6a1f; }
.missions-panel[data-theme="manga"] .missions-row[data-state="ready"] .missions-rowdot { background: var(--mm-sage-deep); }
.missions-panel[data-theme="manga"] .missions-row[data-state="to-refine"] .missions-rowdot { background: var(--mm-lilac-deep); }
:root[data-ds-dark-theme] .missions-rowage[data-quiet="true"],
body[data-ds-dark-theme] .missions-rowage[data-quiet="true"] { color: #e3b341; }

/* Cards: ink frame, folded corner, speech-bubble type, dashed points. */
.missions-panel[data-theme="manga"] .missions-cards { gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.missions-panel[data-theme="manga"] .missions-card { position: relative; gap: 7px; padding: 11px 14px 9px; border: 1.5px solid var(--mm-ink); border-radius: 12px 12px 13px 3px; background: var(--mm-page-2); box-shadow: 3px 3px 0 var(--mm-shadow); transition: background-color .12s ease, box-shadow .12s ease; }
.missions-panel[data-theme="manga"] .missions-card:hover { border-color: var(--mm-ink); background: color-mix(in srgb, var(--mm-orange) 8%, var(--mm-page-2)); box-shadow: 5px 5px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-card:focus-visible { outline: 2px solid var(--mm-orange-deep); outline-offset: 2px; }
.missions-panel[data-theme="manga"] .missions-card::after { content: ""; position: absolute; top: -1.5px; right: -1.5px; width: 13px; height: 13px; background: linear-gradient(225deg, var(--mm-page) 47%, var(--mm-ink) 48% 53%, transparent 54%); }
.missions-panel[data-theme="manga"] .missions-card[data-priority="urgent"] { border-left: 4px solid var(--mm-coral-deep); padding-left: 12px; }
.missions-panel[data-theme="manga"] .missions-card-top { gap: 6px; }
.missions-panel[data-theme="manga"] .missions-project { max-width: 160px; color: var(--mm-ink-2); font-size: 10px; }
.missions-panel[data-theme="manga"] .missions-project .dot { background: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-type { position: relative; height: 21px; padding: 0 8px; border: 1.5px solid var(--mm-ink); border-radius: 9px 9px 9px 3px; background: var(--mm-sage); color: var(--mm-ink); font-size: 9px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.missions-panel[data-theme="manga"] .missions-type::after { content: ""; position: absolute; left: 5px; bottom: -5px; width: 7px; height: 7px; background: inherit; border-left: 1.5px solid var(--mm-ink); border-bottom: 1.5px solid var(--mm-ink); transform: skewY(-20deg); }
.missions-panel[data-theme="manga"] .missions-type[data-type="bug"] { background: var(--mm-coral); }
.missions-panel[data-theme="manga"] .missions-prio { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-prio[data-priority="normal"] { color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-prio[data-priority="high"] { color: var(--mm-orange-deep); }
.missions-panel[data-theme="manga"] .missions-prio[data-priority="urgent"] { color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-prio[data-priority="urgent"] .prio-chip { fill: var(--mm-coral); opacity: 1; }
.missions-panel[data-theme="manga"] .missions-prio[data-priority="urgent"] .prio-mark { fill: var(--mm-ink); }
/* Le bloc sombre manga ne redéfinit pas --mm-orange (palette claire) : c'est
   cet orange clair qui tient le contraste du high sur --mm-page-2. */
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-prio[data-priority="high"] { color: var(--mm-orange); }
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-prio[data-priority="urgent"] .prio-chip { fill: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-sp { border: 1px dashed var(--mm-line-strong); background: var(--mm-page); color: var(--mm-ink-2); font-size: 9.5px; padding: 1px 6px; border-radius: 5px; }
.missions-panel[data-theme="manga"] .missions-card-title { color: var(--mm-ink); font-size: 14.5px; font-weight: 600; line-height: 1.35; }
.missions-panel[data-theme="manga"] .missions-card-foot { color: var(--mm-ink-3); font-size: 10.5px; }
.missions-panel[data-theme="manga"] .missions-key { font-size: 10px; }

/* Drawer: an orange spine, a portrait, inked actions. */
.missions-panel[data-theme="manga"] .missions-drawer { position: relative; width: 404px; max-width: 46%; padding: 16px 22px 24px 40px; border-left: 1.5px solid var(--mm-ink); background: var(--mm-page); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-drawer::before { content: "WORKSPACE MISSIONS"; position: absolute; left: 0; top: 0; bottom: 0; width: 20px; display: flex; align-items: center; justify-content: center; writing-mode: vertical-rl; transform: rotate(180deg); background: var(--mm-orange); border-right: 1.5px solid var(--mm-ink); color: var(--mm-ink); font-size: 8px; font-weight: 800; letter-spacing: .16em; }
.missions-panel[data-theme="manga"] .missions-drawer-head { gap: 10px; align-items: flex-start; }
.missions-panel[data-theme="manga"] .missions-drawer-portrait { flex: none; width: 56px; height: 56px; border-radius: 50%; overflow: hidden; border: 2px solid var(--mm-ink); background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-drawer-portrait img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-theme="manga"] .missions-drawer-key { color: var(--mm-ink-3); font-size: 10px; }
.missions-panel[data-theme="manga"] .missions-drawer-title { color: var(--mm-ink); font-family: var(--mm-display); font-size: 19px; line-height: 1.15; }
.missions-panel[data-theme="manga"] .missions-drawer-close { border: 1.5px solid var(--mm-ink); border-radius: 7px; background: var(--mm-page-2); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-drawer-tabs { gap: 20px; border-bottom: 1.5px solid var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-drawer-tab { height: 32px; color: var(--mm-ink-3); font-size: 10.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.missions-panel[data-theme="manga"] .missions-drawer-tab:hover { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-drawer-tab[aria-selected="true"] { color: var(--mm-ink); border-bottom: 3px solid var(--mm-orange-deep); }
.missions-panel[data-theme="manga"] .missions-drawer-panel .missions-props { border-top: 0; }
.missions-panel[data-theme="manga"] .missions-props { grid-template-columns: 92px 1fr; gap: 0 12px; border-top: 1.5px solid var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-props dt, .missions-panel[data-theme="manga"] .missions-props dd { padding: 6px 0; border-bottom: 1px dashed var(--mm-line); }
.missions-panel[data-theme="manga"] .missions-props dt { color: var(--mm-ink-3); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.missions-panel[data-theme="manga"] .missions-props dd { color: var(--mm-ink); font-size: 11.5px; }
.missions-panel[data-theme="manga"] .missions-action { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); color: var(--mm-ink); box-shadow: 2px 2px 0 var(--mm-shadow); font-size: 11.5px; }
.missions-panel[data-theme="manga"] .missions-action--primary { background: var(--mm-ink); color: var(--mm-page); }
.missions-panel[data-theme="manga"] .missions-drawer-note { padding: 6px 9px; border-left: 3px solid var(--mm-orange); background: color-mix(in srgb, var(--mm-orange) 12%, var(--mm-page)); color: var(--mm-ink-2); font-size: 10.5px; }
.missions-panel[data-theme="manga"] .missions-declare { gap: 7px; border-top: 1.5px solid var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-blocked { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-blocked[data-blocked="true"] { border-color: var(--mm-coral-deep); background: color-mix(in srgb, var(--mm-coral) 10%, var(--mm-page-2)); }
.missions-panel[data-theme="manga"] .missions-blocked-title { font-family: var(--mm-display, inherit); letter-spacing: .01em; }
.missions-panel[data-theme="manga"] .missions-blocked-reason-meta, .missions-panel[data-theme="manga"] .missions-blocked-reason-note { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-blocked-reason-text { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-blocked-reason-link { color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-blocked-input { border: 1.5px solid var(--mm-ink); border-radius: 6px; background: var(--mm-page); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-priority-select { border: 1.5px solid var(--mm-ink); border-radius: 6px; background: var(--mm-page); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-priority-note { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-priority-note--error { color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-blocked-apply { border: 1.5px solid var(--mm-coral-deep); border-radius: 6px; background: var(--mm-coral); color: var(--mm-page); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-blocked-cancel { border: 1.5px solid var(--mm-ink); border-radius: 6px; color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-card[data-blocked="true"] { background: color-mix(in srgb, var(--mm-coral) 12%, var(--mm-page-2)); border-color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-card[data-blocked="true"]:hover { background: color-mix(in srgb, var(--mm-coral) 18%, var(--mm-page-2)); border-color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-lock { background: var(--mm-coral-deep); color: var(--mm-page); box-shadow: 2px 2px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-declare-label { color: var(--mm-ink-3); font-family: var(--mm-mono); font-size: 9.5px; letter-spacing: .08em; }
.missions-panel[data-theme="manga"] .missions-declare-input { height: 30px; border: 1.5px solid var(--mm-ink); border-radius: 7px; background: var(--mm-page-2); color: var(--mm-ink); font-size: 11.5px; box-shadow: 1px 1px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-declare-input:focus { outline: 2px solid var(--mm-orange-deep); outline-offset: 1px; }
.missions-panel[data-theme="manga"] .missions-declare-save { height: 30px; border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); color: var(--mm-ink); box-shadow: 2px 2px 0 var(--mm-shadow); font-size: 11.5px; font-weight: 600; }
.missions-panel[data-theme="manga"] .missions-declare-save:hover:not(:disabled) { background: var(--mm-page-3); }
.missions-panel[data-theme="manga"] .missions-declare-note { color: var(--mm-ink-3); font-size: 10.5px; }
.missions-panel[data-theme="manga"] .missions-declare-note--error { color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-journal-meta { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-journal-text { border: 1.5px solid var(--mm-line); border-radius: 8px; background: var(--mm-page-2); color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-journal-hint { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-checklist-meta { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-checklist-body { border: 1.5px solid var(--mm-line); border-radius: 8px; background: var(--mm-page-2); }
.missions-panel[data-theme="manga"] .missions-checklist-title { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-checklist-item, .missions-panel[data-theme="manga"] .missions-checklist-bullet { color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-checklist-text, .missions-panel[data-theme="manga"] .missions-checklist-note, .missions-panel[data-theme="manga"] .missions-checklist-hint { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-checklist-box { border: 1.5px solid var(--mm-line-strong); border-radius: 3px; }
.missions-panel[data-theme="manga"] .missions-checklist-box[aria-checked="true"] { border-color: var(--mm-ink); background: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-checklist-box[aria-checked="true"]::after { color: var(--mm-page); }
.missions-panel[data-theme="manga"] .missions-drawer--empty { border-left: 1.5px dashed var(--mm-line-strong); }
.missions-panel[data-theme="manga"] .missions-drawer-hint { color: var(--mm-ink-3); }

/* Repositories: the workspace root as a paper ledger, ink names, a stamped row. */
.missions-panel[data-theme="manga"] .missions-repos { padding-top: 12px; }
.missions-panel[data-theme="manga"] .missions-repo-head { border-bottom: 1.5px solid var(--mm-line-strong); color: var(--mm-ink-3); font-size: 9px; }
.missions-panel[data-theme="manga"] .missions-repo-rowitem { border-bottom: 1px solid var(--mm-line); }
.missions-panel[data-theme="manga"] .missions-repo { border-radius: 6px; color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-repo:hover { background: color-mix(in srgb, var(--mm-orange) 22%, transparent); }
.missions-panel[data-theme="manga"] .missions-repo-name { font-family: var(--mm-mono); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-repo-kind { border-color: var(--mm-line-strong); color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-repo-branch { color: var(--mm-ink-2); font-family: var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-repo-state { border: 1px solid var(--mm-line-strong); background: var(--mm-page-2); color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-repo-state[data-dirty="true"] { border-color: var(--mm-orange-deep); color: var(--mm-orange-deep); }
.missions-panel[data-theme="manga"] .missions-repo-state[data-error="true"] { border-color: var(--mm-coral-deep); color: var(--mm-coral-deep); }
.missions-panel[data-theme="manga"] .missions-repo-age { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-repos-note { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-repos-error { border: 1.5px solid var(--mm-coral-deep); background: color-mix(in srgb, var(--mm-coral) 22%, var(--mm-page-2)); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-drawer-section-title { color: var(--mm-ink-3); font-family: var(--mm-display); font-size: 9px; letter-spacing: .08em; }
.missions-panel[data-theme="manga"] .missions-repo-tabs { gap: 20px; border-bottom: 1.5px solid var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-repo-tab { height: 32px; color: var(--mm-ink-3); font-family: var(--mm-display); font-size: 10.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
.missions-panel[data-theme="manga"] .missions-repo-tab[aria-selected="true"] { border-bottom: 3px solid var(--mm-orange-deep); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-history-branch { border: 1.5px solid var(--mm-ink); border-radius: 6px; background-color: var(--mm-page-2); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23201b17' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E"); color: var(--mm-ink); font-family: var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-history-total { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-history-hash { color: var(--mm-orange-deep); font-family: var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-history-age { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-history-subject { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-history-more { padding: 4px 10px; border: 1.5px solid var(--mm-ink); border-radius: 6px; background: var(--mm-page-2); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-tree-name { color: var(--mm-ink); font-family: var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-tree-annotation { border: 1px solid var(--mm-line-strong); background: var(--mm-page-2); color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-tree-tag { border: 1px solid var(--mm-line-strong); color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-tree-missing { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-tree-commits { border-left-color: var(--mm-line-strong); }
.missions-panel[data-theme="manga"] .missions-tree-hash { color: var(--mm-orange-deep); }
.missions-panel[data-theme="manga"] .missions-tree-subject { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-tree-worktree-label { color: var(--mm-ink); font-family: var(--mm-mono); }
.missions-panel[data-theme="manga"] .missions-tree-worktree-branch { color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-tree-worktree-current { color: var(--mm-ink-3); }

/* Empty result: a tilted Konoha print, the portrait and a speech bubble. */
.missions-panel[data-theme="manga"] .missions-loader { color: var(--mm-ink-3); min-height: 340px; }
.missions-panel[data-theme="manga"] .missions-loader-label { font-family: var(--mm-display); font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
.missions-panel[data-theme="manga"] .missions-sharingan { width: 86px; height: 86px; filter: drop-shadow(0 0 16px color-mix(in srgb, var(--mm-coral) 50%, transparent)); animation: missions-sharingan-pulse 1.6s ease-in-out infinite alternate; }
.missions-panel[data-theme="manga"] .missions-sharingan svg { width: 100%; height: 100%; overflow: visible; }
.missions-panel[data-theme="manga"] .missions-sharingan-tomoe { transform-box: view-box; transform-origin: 60px 60px; animation: missions-sharingan-spin 1.6s linear infinite; }
@keyframes missions-sharingan-spin { to { transform: rotate(360deg); } }
@keyframes missions-sharingan-pulse { from { opacity: .8; } to { opacity: 1; } }
.missions-panel[data-theme="manga"] .missions-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 420px; padding: 10px 20px 30px; text-align: center; }
.missions-panel[data-theme="manga"] .missions-empty-art { position: relative; width: 300px; height: 196px; margin-bottom: 12px; }
.missions-panel[data-theme="manga"] .missions-empty-photo { position: absolute; left: 0; top: 8px; width: 300px; height: 156px; overflow: hidden; border: 1.5px solid var(--mm-ink); border-radius: 6px; background: var(--mm-page-3); box-shadow: 4px 4px 0 var(--mm-shadow); transform: rotate(-2deg); }
.missions-panel[data-theme="manga"] .missions-empty-photo img { position: absolute; top: 0; left: -100%; width: 200%; height: 100%; object-fit: cover; object-position: 50% 46%; }
.missions-panel[data-theme="manga"] .missions-empty-bubble { position: absolute; right: -6px; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 1px; padding: 6px 9px; border: 1.5px solid var(--mm-ink); border-radius: 9px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); text-align: left; }
.missions-panel[data-theme="manga"] .missions-empty-bubble b { font-size: 10px; }
.missions-panel[data-theme="manga"] .missions-empty-bubble span { color: var(--mm-ink-3); font-size: 8.5px; }
.missions-panel[data-theme="manga"] .missions-empty-avatar { position: absolute; right: 0; bottom: 0; z-index: 3; width: 98px; height: 98px; border-radius: 50%; overflow: hidden; border: 3px solid var(--mm-page); background: var(--mm-page-2); box-shadow: 0 0 0 1.5px var(--mm-ink), 3px 3px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-empty-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.missions-panel[data-theme="manga"] .missions-empty-title { margin: 0 0 4px; color: var(--mm-ink); font-family: var(--mm-display); font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
.missions-panel[data-theme="manga"] .missions-empty-hint { margin: 0 0 12px; color: var(--mm-ink-3); font-size: 11.5px; }
.missions-panel[data-theme="manga"] .missions-empty-clear { height: 29px; padding: 0 11px; border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); color: var(--mm-ink); font: inherit; font-size: 11px; cursor: pointer; }
.missions-panel[data-theme="manga"] .missions-empty-clear:hover { background: var(--mm-page-3); }

/* Narrow panel: keep the header, lose the bubble and shrink the portrait. */
@media (prefers-reduced-motion: reduce) {
  .missions-panel[data-theme="manga"] .missions-card { transition: none; }
  .missions-panel[data-theme="manga"] .missions-card:hover { transform: none; }
}

@container (max-width: 760px) {
  .missions-panel[data-theme="manga"] .missions-hero { height: 150px; }
  .missions-panel[data-theme="manga"] .missions-head--hero { height: 150px; }
  .missions-panel[data-theme="manga"] .missions-head--hero .missions-title { font-size: 30px; bottom: 24px; }
  .missions-panel[data-theme="manga"] .missions-head--hero .missions-scope { bottom: 8px; font-size: 10px; }
  .missions-panel[data-theme="manga"] .missions-hero-avatar { width: 84px; height: 84px; right: 18px; bottom: 12px; }
  .missions-panel[data-theme="manga"] .missions-hero-bubble { display: none; }
  .missions-panel[data-theme="manga"] .missions-head--hero .missions-actions { right: 18px; }
  .missions-panel[data-theme="manga"] .missions-tabs, .missions-panel[data-theme="manga"] .missions-toolbar { padding-left: 22px; padding-right: 22px; }
  .missions-panel[data-theme="manga"] .missions-body { padding-left: 22px; padding-right: 22px; }
  .missions-panel[data-theme="manga"] .missions-head--hero { padding: 0 22px; }
  .missions-panel[data-theme="manga"] .missions-kicker, .missions-panel[data-theme="manga"] .missions-head--hero .missions-title { left: 22px; }
  .missions-panel[data-theme="manga"] .missions-head--hero .missions-scope { left: 23px; }
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
    function widgetFoot({ note, total, onViewAll }) {
      const more = total > WIDGET_ROWS
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
     * The dashboard: a section per domain, a card per widget. The only section
     * today is Missions, opening on the two cross-cutting lenses the list makes
     * you filter by hand — your unresolved bugs, and high-priority stories —
     * then the work already running and the queue. All four read the same
     * mission list the panel already loaded.
     */
    function DashboardView({ missions = [], loading, theme, failed, now = Date.now(), onOpen, onOpenAll, onViewAll }) {
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

    /** The themed empty state: a Konoha print, the portrait, a speech bubble. */
    function MangaEmpty({ onClear }) {
      return h('div', { className: 'missions-empty-state' },
        h('div', { className: 'missions-empty-art' },
          h('div', { className: 'missions-empty-photo' }, h('img', { src: ART.konoha, alt: '' })),
          h('div', { className: 'missions-empty-bubble' }, h('b', null, 'Naruto?'), h('span', null, 'Searching…')),
          h('div', { className: 'missions-empty-avatar' }, h('img', { src: ART.avatar, alt: '' })),
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
    function MissionsView({ missions, query, onQuery, filters, onFilter, onClear, sort, onSort, filtered, groups, onSelect, theme, loading, failed, onRefresh, statusOptions, statusFixed = false, emptyText = 'No open missions assigned to you.' }) {
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
        return h('div', null, toolbar, theme === 'manga' && !resting
          ? h(MangaEmpty, { onClear })
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

    function MissionDrawer({ mission, services, workspaceId, workspaceRoot, onClose, onSaved, onPrioritySaved, theme }) {
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
      // step button stays the primary, at the bottom.
      const feedbackLabel = 'Check the PR feedback'
      // A free session answers a question without moving the ticket; its title
      // says so, since the foot's "Session blocked" note is about the step.
      const freeLabel = 'Start a free session'
      const freeTitle = 'Ask a question without playing the workflow step'
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

      const startSession = () => openSession(prompt)
      // Same gesture, same prefill path, other prompt: the session reads the
      // PR's remarks and hands back; the merge stays the requester's.
      const startFeedbackSession = () => openSession(feedbackPrompt)
      // Same gesture again, with the prompt that plays no step and writes
      // nothing: a question, not work on the ticket.
      const startFreeSession = () => openSession(freePrompt)

      const saveDeclaration = async () => {
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
              onChange: (event) => writePriority(event.target.value),
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

      const drawerTabs = h('div', { className: 'missions-drawer-tabs', role: 'tablist', 'aria-label': 'Mission sections' },
        DRAWER_TABS.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          role: 'tab',
          className: 'missions-drawer-tab',
          id: `missions-drawer-tab-${entry.id}`,
          'aria-selected': section === entry.id ? 'true' : 'false',
          'aria-controls': section === entry.id ? 'missions-drawer-panel' : undefined,
          onClick: () => setSection(entry.id),
        }, entry.label)),
      )

      // Journal and checklist fill the drawer: the body scrolls on its own and
      // the drawer stops scrolling. Details keeps the drawer's own scroll.
      const filling = section !== 'details'

      return h('aside', { className: filling ? 'missions-drawer missions-drawer--fill' : 'missions-drawer', role: 'complementary', 'aria-label': `Mission ${mission.key}` },
          h('div', { className: 'missions-drawer-head' },
            theme === 'manga' ? h('div', { className: 'missions-drawer-portrait' }, h('img', { src: ART.avatar, alt: '' })) : null,
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
          blocker ? h('p', { id: 'missions-session-blocked', className: 'missions-drawer-note missions-drawer-note--blocked' }, `Session blocked: ${blocker}.`) : null,

          h('div', { className: 'missions-drawer-actions' },
            mission.url
              ? h('a', { className: 'missions-action', href: mission.url, target: '_blank', rel: 'noreferrer noopener' }, 'Open on the tracker')
              : h('button', { type: 'button', className: 'missions-action', disabled: true }, 'No tracker link'),
            // Only the step that follows the merge may delete the branch: the
            // panel shows the gesture there and nowhere else. The host still
            // re-reads the state before touching anything.
            mission.state === 'ready-for-prod'
              ? h('button', {
                  type: 'button',
                  className: 'missions-action missions-action--danger',
                  onClick: closeLocalCheckout,
                  disabled: closing || blocker !== null,
                  title: blocker ?? undefined,
                  'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                }, closing ? 'Closing…' : armedClose ? 'Confirm — close the local checkout' : 'Close the local checkout')
              : null,
            // Only a mission in review has remarks to check: the client does
            // not know whether a PR exists, so the state alone decides, and
            // the session stops with a word when `gh` finds none.
            mission.state === 'in-review'
              ? h('button', {
                  type: 'button',
                  className: 'missions-action',
                  onClick: startFeedbackSession,
                  disabled: blocker !== null,
                  title: blocker ?? undefined,
                  'aria-describedby': blocker ? 'missions-session-blocked' : undefined,
                }, feedbackLabel)
              : null,
            // The free session sits above the step session, which stays the
            // primary at the bottom: a question is never the default gesture.
            // A closed mission plays no session at all, so `done` hides it.
            mission.state === 'done'
              ? null
              : h('button', {
                  type: 'button',
                  className: 'missions-action',
                  onClick: startFreeSession,
                  disabled: freeBlocker !== null,
                  title: freeBlocker ?? freeTitle,
                  'aria-describedby': freeBlocker ? 'missions-session-blocked' : undefined,
                }, freeLabel),
            h('button', { type: 'button', className: 'missions-action missions-action--primary', onClick: startSession, disabled: blocker !== null, title: blocker ?? undefined, 'aria-describedby': blocker ? 'missions-session-blocked' : undefined }, sessionLabel),
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
          h('circle', { cx: 12, cy: 12, r: 2.2, fill: 'var(--mm-page-2, #ffffff)', stroke: 'currentColor', strokeWidth: 1.2 }),
        )
      }
      return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true', className: 'missions-icon-arrow', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M20.4 11.2a8.4 8.4 0 1 1-2.5-6.1' }),
        h('path', { d: 'M20.6 3.8v7.2h-7.2' }),
      )
    }


    // L'onglet Workflows : le parcours se lit et s'édite comme un graphe. Le
    // fichier ne porte aucune coordonnée — la géométrie se recalcule à chaque
    // rendu (`layoutWorkflow`), donc deux sauvegardes du même graphe donnent la
    // même image et le modèle reste lisible à la main.
    function WorkflowsView() {
      const [view, setView] = React.useState({ loading: true, error: null, workflows: [], writers: [], states: [] })
      const [step, setStep] = React.useState(() => readStep(filterStorage(), WORKFLOW_STEPS))
      const [draft, setDraft] = React.useState(null)
      const [chosen, setChosen] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [arc, setArc] = React.useState({ from: '', to: '', when: '' })
      // Chaque rechargement rend la main au serveur : le brouillon repart du
      // fichier, les retouches non enregistrées comprises.
      const [version, setVersion] = React.useState(0)

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

      // L'étape ouverte suit la session, comme l'onglet : fermer le panneau sur
      // la revue le rouvre sur la revue.
      React.useEffect(() => { writeStep(filterStorage(), step, WORKFLOW_STEPS) }, [step])

      const entry = view.workflows.find((item) => item.workflow === step) ?? null

      // Le brouillon suit l'étape : la réponse du serveur porte des champs
      // d'affichage (`errors`, `headings`, `file`) que le fichier ne contient pas.
      React.useEffect(() => {
        if (!entry) { setDraft(null); return }
        setDraft(modelOf(entry))
        setChosen(null)
        setStatus(null)
        setArc({ from: '', to: '', when: '' })
      }, [entry && entry.workflow, version])

      const patchNode = (key, value) => {
        if (!chosen) return
        setDraft((previous) => ({ ...previous, nodes: previous.nodes.map((node) => (node.id === chosen ? { ...node, [key]: value } : node)) }))
      }

      const labelOf = (id) => (draft ? draft.nodes.find((node) => node.id === id)?.label ?? id : id)
      const sectionOf = (id) => (draft ? draft.nodes.find((node) => node.id === id)?.section ?? '' : '')
      const writerOf = (id) => (draft ? draft.nodes.find((node) => node.id === id)?.writer ?? '' : '')

      const addGesture = () => {
        if (!draft) return
        const id = nextGestureId(draft)
        const heading = entry?.headings?.[0]?.text ?? ''
        setDraft({ ...draft, nodes: [...draft.nodes, { id, label: 'Nouveau geste', section: heading, writer: view.writers[0] ?? 'session' }] })
        setChosen(id)
        setStatus(null)
      }

      const removeGesture = () => {
        if (!draft || !chosen) return
        setDraft(withoutNode(draft, chosen))
        setChosen(null)
        setStatus(null)
      }

      // Un même couple (départ, arrivée) ne se double pas : le geste se relit,
      // il ne s'ajoute pas. Réappliquer le couple met la condition à jour.
      const addArc = () => {
        if (!draft || !arc.from || !arc.to) { setStatus({ kind: 'error', message: 'Choisis un départ et une arrivée.' }); return }
        if (arc.from === arc.to) { setStatus({ kind: 'error', message: 'Un geste ne se suit pas lui-même : passe par un autre geste.' }); return }
        setDraft(upsertEdge(draft, arc.from, arc.to, arc.when.trim()))
        setArc({ from: '', to: '', when: '' })
        setStatus(null)
      }

      // Cliquer un arc le charge dans le formulaire : le modifier, c'est le
      // relire puis le reposer, sans le supprimer d'abord.
      const pickArc = (edge) => {
        setArc({ from: edge.from, to: edge.to, when: edge.when ?? '' })
        setStatus(null)
      }

      const removeArc = (from, to) => {
        if (!draft) return
        setDraft(withoutEdge(draft, from, to))
        setStatus(null)
      }

      // Le serveur valide, dit non, et n'écrit rien : le bouton ne fait
      // qu'envoyer, jamais juger.
      const save = () => {
        if (!draft || saving) return
        setSaving(true)
        setStatus(null)
        fetch(WORKFLOW_MODEL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ workflow: draft.workflow, model: draft }),
        })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then(({ ok, data }) => {
            if (!ok) {
              setStatus({ kind: 'error', message: data?.error ?? 'save failed', errors: data?.errors ?? [] })
              return
            }
            setView((previous) => ({
              ...previous,
              workflows: previous.workflows.map((item) => (item.workflow === data.workflow
                ? { ...item, ...data.model, headings: data.headings, orphanSections: data.orphanSections, errors: [] }
                : item)),
            }))
            setStatus({ kind: 'ok', message: `Enregistré — ${data.file}` })
          })
          .catch((error) => setStatus({ kind: 'error', message: error?.message ?? 'save failed' }))
          .finally(() => setSaving(false))
      }

      // Deux attentes : le parcours (la liste) puis le modèle de l'étape. Entre
      // les deux, l'entrée existe et le brouillon n'est pas encore posé — lire
      // `draft` ici ferait tomber le panneau entier, pas seulement le graphe.
      if (!entry || !draft) {
        return h('div', { className: 'wf-view' },
          h('div', { className: 'wf-toolbar' },
            h('span', { className: 'wf-note' },
              view.loading ? 'Chargement du parcours…'
                : !entry ? view.error ?? 'Aucun modèle de workflow.'
                  : 'Chargement du modèle du parcours…'),
            h('button', { type: 'button', className: 'missions-btn', onClick: load }, 'Recharger'),
          ),
        )
      }

      const graph = layoutWorkflow(draft)
      const node = draft && chosen ? draft.nodes.find((item) => item.id === chosen) ?? null : null
      const clip = (text, max) => {
        const value = String(text ?? '')
        return value.length > max ? `${value.slice(0, max - 1)}…` : value
      }
      const headingTexts = (entry.headings ?? []).map((heading) => heading.text)
      const sectionChoices = node && node.section && !headingTexts.includes(node.section) ? [node.section, ...headingTexts] : headingTexts
      const ends = endPoints(draft)

      return h('div', { className: 'wf-view' },
        h('div', { className: 'wf-toolbar' },
          h('div', { className: 'wf-steps', role: 'group', 'aria-label': 'Étapes du parcours' },
            view.workflows.map((item) => h('button', {
              key: item.workflow,
              type: 'button',
              className: 'wf-step',
              'aria-pressed': item.workflow === step,
              onClick: () => setStep(item.workflow),
            }, item.title || item.workflow)),
          ),
          h('span', { className: 'wf-note' }, `${entry.document} — ${entry.entry ?? '?'} → ${(entry.exit ?? []).join(', ') || '?'}`),
          h('button', { type: 'button', className: 'missions-btn', onClick: save, disabled: saving }, saving ? 'Enregistrement…' : 'Enregistrer'),
          h('button', { type: 'button', className: 'missions-btn', onClick: load }, 'Recharger'),
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

        h('div', { className: 'wf-layout' },
          h('div', { className: 'wf-canvas-wrap' },
            graph.boxes.length === 0
              ? h('p', { className: 'wf-note' }, 'Ce modèle est vide.')
              : h('svg', {
                  className: 'wf-canvas',
                  viewBox: `0 0 ${graph.width} ${graph.height}`,
                  width: graph.width,
                  height: graph.height,
                  role: 'img',
                  'aria-label': `${entry.title} — ${graph.boxes.length} gestes, ${graph.links.length} arcs`,
                },
                  h('defs', null, h('marker', { id: 'wf-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: 'currentColor', opacity: 0.45 }))),
                  graph.links.map((link) => h('g', { key: `${link.from}→${link.to}` },
                    h('path', { className: link.back ? 'wf-link wf-link--back' : 'wf-link', d: link.path, 'marker-end': 'url(#wf-arrow)' }),
                    // Chaque condition s'affiche en entier : le losange dit où
                    // l'on choisit, l'étiquette dit sur quoi.
                    link.when ? h('text', {
                      className: link.back ? 'wf-link-label wf-link-label--back' : 'wf-link-label wf-link-label--forward',
                      x: link.labelX,
                      y: link.labelY,
                      textAnchor: link.labelAnchor,
                    }, link.when) : null,
                  )),
                  graph.decisions.map((decision) => h('g', {
                    key: `decision-${decision.id}`,
                    className: 'wf-node-group wf-node-group--decision',
                    onClick: () => { setChosen(decision.id); setStatus(null) },
                  },
                    h('polygon', {
                      className: `wf-node wf-node--decision${decision.id === chosen ? ' wf-node--selected' : ''}`,
                      points: `${decision.x + decision.width / 2},${decision.y} ${decision.x + decision.width},${decision.y + decision.height / 2} ${decision.x + decision.width / 2},${decision.y + decision.height} ${decision.x},${decision.y + decision.height / 2}`,
                    }),
                  )),
                  graph.boxes.map((box) => h('g', {
                    key: box.id,
                    className: 'wf-node-group',
                    onClick: box.kind === 'geste' ? () => { setChosen(box.id); setStatus(null) } : null,
                  },
                    h('rect', { className: `wf-node wf-node--${box.kind}${box.id === chosen ? ' wf-node--selected' : ''}`, x: box.x, y: box.y, width: box.width, height: box.height, rx: 9 }),
                    h('text', { className: 'wf-node-label', x: box.x + 10, y: box.y + (box.kind === 'etat' ? 22 : 20) }, clip(box.label, box.kind === 'geste' ? 30 : 20)),
                    box.kind === 'geste' ? h('text', { className: 'wf-node-section', x: box.x + 10, y: box.y + 36 }, clip(`${sectionOf(box.id)} · ${writerOf(box.id)}`, 30)) : null,
                  )),
                ),
          ),

          h('div', { className: 'wf-side' },
            h('div', { className: 'wf-card' },
              h('div', { className: 'wf-card-title' }, node ? 'Geste' : 'Graphe'),
              node
                ? h('div', null,
                    h('p', { className: 'wf-note' }, node.id),
                    h('label', { className: 'wf-field' }, h('span', null, 'Libellé'), h('input', { value: node.label ?? '', onChange: (event) => patchNode('label', event.target.value) })),
                    h('label', { className: 'wf-field' }, h('span', null, 'Section du document'), h('select', { value: node.section ?? '', onChange: (event) => patchNode('section', event.target.value) }, sectionChoices.map((text) => h('option', { key: text, value: text }, text)))),
                    h('label', { className: 'wf-field' }, h('span', null, 'Écrivain'), h('select', { value: node.writer ?? '', onChange: (event) => patchNode('writer', event.target.value) }, view.writers.map((writer) => h('option', { key: writer, value: writer }, writer)))),
                    h('label', { className: 'wf-field' }, h('span', null, 'Condition'), h('input', { value: node.condition ?? '', placeholder: 'Quand ce geste a lieu', onChange: (event) => patchNode('condition', event.target.value) })),
                    h('label', { className: 'wf-field' }, h('span', null, 'Artefact'), h('input', { value: node.artifact ?? '', placeholder: 'Ce que le geste produit', onChange: (event) => patchNode('artifact', event.target.value) })),
                    h('label', { className: 'wf-field' }, h('span', null, 'Porte'), h('input', { value: node.gate ?? '', placeholder: 'Ce qui doit être vrai pour avancer', onChange: (event) => patchNode('gate', event.target.value) })),
                    h('div', { className: 'wf-actions' }, h('button', { type: 'button', className: 'missions-btn', onClick: removeGesture }, 'Supprimer le geste')),
                  )
                : h('div', null,
                    h('p', { className: 'wf-note' }, 'Clique un geste pour le modifier.'),
                    h('p', { className: 'wf-note' }, `Écrivains : ${view.writers.join(', ') || '—'}`),
                    h('p', { className: 'wf-note' }, `${draft.nodes.length} gestes · ${draft.edges.length} arcs`),
                    h('div', { className: 'wf-actions' }, h('button', { type: 'button', className: 'missions-btn', onClick: addGesture }, 'Ajouter un geste')),
                  ),
            ),

            h('div', { className: 'wf-card' },
              h('div', { className: 'wf-card-title' }, 'Arcs'),
              draft.edges.length === 0
                ? h('p', { className: 'wf-note' }, 'Aucun arc.')
                : h('div', null, draft.edges.map((edge) => h('div', {
                    key: `${edge.from}→${edge.to}`,
                    className: 'wf-arc',
                    role: 'button',
                    tabIndex: 0,
                    title: 'Reprendre cet arc dans le formulaire',
                    onClick: () => pickArc(edge),
                    onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pickArc(edge) } },
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
          ),
        ),
      )
    }

    /**
     * One row of the repositories view: the clone's name, its branch, the
     * state of its working tree, and the commit it last moved on. The whole
     * row is the button — the tab's job is to get a repository open, not to
     * list it completely.
     */
    function RepositoryRow({ repository, now, onOpen }) {
      const state = repositoryState(repository)
      const branch = repositoryBranch(repository)
      const commit = repositoryCommit(repository)
      const age = repository.lastCommit ? relativeAge(repository.lastCommit.date, now) : ''
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
            repository.name,
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
      )
    }

    /**
     * The repositories tab: every clone of the workspace root, read-only.
     *
     * The scan starts when the tab opens, not when the panel mounts: forty
     * clones are two git calls each, and a panel that scanned on every mount
     * would pay for a view nobody is looking at. It also means every opening
     * of the tab shows the workspace as it is now — the list is never served
     * from a cache.
     */
    function RepositoriesView({ theme, onOpen }) {
      const [scan, setScan] = React.useState({ loading: true, data: null, error: null })

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
      }, [])

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
      const repositories = sortRepositories(data.repositories)
      const now = Date.now()
      const missing = Array.isArray(data.errors) ? data.errors : []

      return h('div', { className: 'missions-repos' },
        h('div', { className: 'missions-repos-head' },
          h('span', { className: 'missions-repos-total' }, scanLabel(data)),
          data.root ? h('span', { className: 'missions-repos-root', title: data.root }, data.root) : null,
        ),
        repositories.length === 0
          ? h('div', { className: 'missions-dash-empty' },
              h('p', null, 'No repository in the workspace root.'),
              h('p', { className: 'missions-dash-empty-hint' },
                data.root ? `Scanned ${data.root}.` : 'The host did not name the root it scanned.'),
            )
          : h(React.Fragment, null,
              h('div', { className: 'missions-repo-head missions-repo-grid', 'aria-hidden': 'true' },
                h('span', null, 'Repository'),
                h('span', null, 'Branch'),
                h('span', null, 'State'),
                h('span', { className: 'missions-col-commit' }, 'Last commit'),
                h('span', null, 'Age'),
              ),
              h('ul', { className: 'missions-rows' },
                repositories.map((repository) => h(RepositoryRow, { key: repository.name, repository, now, onOpen })),
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
    function RepositoryDrawer({ repository, onClose, theme }) {
      const [detail, setDetail] = React.useState({ loading: true, data: null, error: null })
      const [section, setSection] = React.useState('details')
      const [history, setHistory] = React.useState({ loading: false, more: false, data: null, error: null })
      const [tree, setTree] = React.useState({ loading: false, data: null, error: null })

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
      const track = shown.upstream ? `${ahead} ahead · ${behind} behind` : 'no upstream'

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
            onClick: () => setSection(entry.id),
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
                ? h(RepositoryHistory, { history, theme, onBranch: (branch) => loadHistory(branch, 0), onMore: () => loadHistory(history.data?.branch ?? null, history.data?.commits?.length ?? 0, true) })
                : section === 'worktrees'
                  ? h(RepositoryTree, { tree, theme })
                  : h(React.Fragment, null,
                      h('dl', { className: 'missions-props' },
                        h(DrawerRow, { label: 'Path', value: shown.path }),
                        h(DrawerRow, { label: 'Branch', value: repositoryBranch(shown) }),
                        h(DrawerRow, { label: 'State', value: state.label }),
                        h(DrawerRow, { label: 'Remote', value: shown.remote ?? 'no remote' }),
                        h(DrawerRow, { label: 'Upstream', value: shown.upstream ?? 'none' }),
                        h(DrawerRow, { label: 'Against upstream', value: track }),
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
     * The declared layout: one row per branch, indented by its depth, carrying
     * the commits it introduces on its parent (ten at most, then `+`), the
     * worktree that holds it, and a mark when the branch is not local.
     *
     * Below it, every worktree in full — path, branch, current — because a
     * branch may carry several, and a worktree may carry a branch the layout
     * does not declare. A layout that is absent or empty is not an empty tab:
     * the worktrees are still a reading of the repository.
     */
    function RepositoryTree({ tree, theme }) {
      if (tree.error) return h('div', { className: 'missions-repos-error', role: 'alert' }, tree.error)
      if (!tree.data) return h(PanelLoader, { theme })
      const branches = Array.isArray(tree.data.branches) ? tree.data.branches : []
      const worktrees = Array.isArray(tree.data.worktrees) ? tree.data.worktrees : []
      // Once the layout names its branches, a worktree is "outside" when the
      // branch it carries is none of them. A detached worktree carries no
      // branch: it is not a layout branch, so it is not a comparison either.
      const known = new Set(branches.map((branch) => branch.name))
      const outside = worktrees.filter((worktree) => worktree.branch && !known.has(worktree.branch))

      if (!tree.data.layout) {
        return h('section', { className: 'missions-tree', 'aria-label': 'Repository tree' },
          h('p', { className: 'missions-drawer-note' }, 'No git machete layout for this repository — the worktrees below are the repository.'),
          worktrees.length === 0
            ? h('p', { className: 'missions-drawer-note' }, 'No worktree.')
            : h('ul', { className: 'missions-tree-flat', 'aria-label': 'Worktrees' },
                worktrees.map((worktree) => h(RepositoryWorktree, { key: worktree.path, worktree })),
              ),
        )
      }

      return h('section', { className: 'missions-tree', 'aria-label': 'Repository tree' },
        h('ul', { className: 'missions-tree-branches' },
          branches.map((branch) => h(RepositoryBranch, { key: branch.name, branch })),
        ),
        outside.length === 0 ? null : h('div', { className: 'missions-tree-worktrees' },
          h('h3', { className: 'missions-drawer-section-title' }, 'Not in the layout'),
          h('ul', { className: 'missions-tree-flat', 'aria-label': 'Worktrees not in the layout' },
            outside.map((worktree) => h(RepositoryWorktree, { key: worktree.path, worktree })),
          ),
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

    /** One worktree: where it is, the branch it holds, and whether it is here. */
    function RepositoryWorktree({ worktree }) {
      return h('li', { className: 'missions-tree-worktree' },
        h('span', { className: 'missions-tree-worktree-label', title: worktree.path }, worktree.path),
        h('span', { className: 'missions-tree-worktree-branch' }, worktree.branch ?? 'detached'),
        worktree.current ? h('span', { className: 'missions-tree-worktree-current' }, 'current') : null,
      )
    }

    function MissionsPanel({ services }) {
      // The bar comes back from the session: the panel is remounted on every
      // view switch, and a reload must not lose the search, the filters or the
      // order. Nothing outlives the app: session storage dies with the window.
      const [restored] = React.useState(() => filterBarState(readFilterSnapshot(filterStorage())))
      const [view, setView] = React.useState({ loading: true, missions: [], errors: [], workspaceId: null, workspaceRoot: null })
      // The open tab is remembered the same way, and opens on the dashboard:
      // the panel lands on what waits, not on the list.
      const [tab, setTab] = React.useState(() => readTab(filterStorage(), TAB_IDS))
      const [query, setQuery] = React.useState(restored.query)
      const [filters, setFilters] = React.useState(restored.filters)
      const [sort, setSort] = React.useState(restored.sort)
      const [selected, setSelected] = React.useState(null)
      const [theme, setTheme] = React.useState(readTheme)
      // The repository whose drawer is open, and only while the repositories
      // tab is the open one: the tab switch below clears it.
      const [repository, setRepository] = React.useState(null)
      // Done is a view of its own: its own bar, its own rows, its own failures.
      // These states come after the open list's so the order above — and the
      // session each state restores — does not move.
      const [doneRestored] = React.useState(() => filterBarState(readFilterSnapshot(filterStorage(), DONE_FILTERS_KEY, { allowDone: true }), { allowDone: true }))
      const [doneView, setDoneView] = React.useState({ loading: true, missions: [], errors: [], workspaceId: null, workspaceRoot: null })
      const [doneQuery, setDoneQuery] = React.useState(doneRestored.query)
      // The status of Done is not a choice: the view is closed work, and its bar
      // fixes the value instead of offering the other states.
      const [doneFilters, setDoneFilters] = React.useState({ ...doneRestored.filters, state: ['done'] })
      const [doneSort, setDoneSort] = React.useState(doneRestored.sort)
      // How many repositories the root holds, for the tab badge: null until the
      // first read, so the tab shows no number it cannot prove.
      const [repositoryCount, setRepositoryCount] = React.useState(null)

      // One write per change, the clear included: an empty bar drops its key.
      React.useEffect(() => {
        writeFilterSnapshot(filterStorage(), { query, filters, sort })
      }, [query, filters, sort])

      // Done keeps its own key, and its snapshot accepts the fixed status.
      React.useEffect(() => {
        writeFilterSnapshot(filterStorage(), { query: doneQuery, filters: doneFilters, sort: doneSort }, DONE_FILTERS_KEY, { allowDone: true })
      }, [doneQuery, doneFilters, doneSort])

      // The resting tab drops its key, so an untouched session stores nothing.
      React.useEffect(() => {
        writeTab(filterStorage(), tab, TAB_IDS)
      }, [tab])

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
            setView({ loading: false, missions: data?.missions ?? [], errors: data?.errors ?? [], workspaceId: data?.workspaceId ?? null, workspaceRoot: data?.workspaceRoot ?? null })
          })
          .catch((error) => {
            // A silent refresh that fails must not empty the list.
            setView((previous) => ({
              loading: false,
              workspaceId: previous.workspaceId,
              workspaceRoot: previous.workspaceRoot,
              missions: silent ? previous.missions : [],
              errors: [{ project: 'panel', message: error?.message ?? 'read failed' }],
            }))
          })
      }, [])

      // The closed read has its own perimeter and its own cache: `?done=1` asks
      // the server for the declared closed missions, and refresh keeps that
      // perimeter too instead of mixing it with the open list.
      const loadDone = React.useCallback(({ silent = false, refresh = false } = {}) => {
        if (!silent) setDoneView((previous) => ({ ...previous, loading: true }))
        const url = `${LIST_URL}?done=1${refresh ? '&refresh=1' : ''}`
        return fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data?.error) throw new Error(data.error)
            setDoneView({ loading: false, missions: data?.missions ?? [], errors: data?.errors ?? [], workspaceId: data?.workspaceId ?? null, workspaceRoot: data?.workspaceRoot ?? null })
          })
          .catch((error) => {
            setDoneView((previous) => ({
              loading: false,
              workspaceId: previous.workspaceId,
              workspaceRoot: previous.workspaceRoot,
              missions: silent ? previous.missions : [],
              errors: [{ project: 'panel', message: error?.message ?? 'read failed' }],
            }))
          })
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

      // The count is read at mount too: the badge must answer without the tab
      // being opened, and the route costs no git process.
      React.useEffect(() => {
        load()
        loadRepositoryCount()
      }, [load, loadRepositoryCount])

      // Opening Done pays the closed read once; the server caches it for 60 s.
      // The panel never reads closed work at mount, whichever tab it lands on.
      React.useEffect(() => {
        if (tab !== 'done') return undefined
        loadDone()
        return undefined
      }, [tab, loadDone])

      // The tick keeps the perimeter of the open tab: Done refreshes the closed
      // read, the other tracker tabs refresh the open one. The repository count
      // is refreshed whatever the tab, Done included.
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.hidden) return
          if (tab === 'done') loadDone({ silent: true, refresh: true })
          else load({ silent: true, refresh: true })
          loadRepositoryCount()
        }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [load, loadDone, tab, loadRepositoryCount])

      const { loading, missions, errors, workspaceId, workspaceRoot } = view
      // Done is a perimeter, not a tab looking at the open list: its rows, its
      // failures and its loading come from its own read. The client keeps the
      // promise too — a stale or mixed payload never shows an open mission here.
      const doneTab = tab === 'done'
      const doneMissions = doneView.missions.filter((mission) => mission.state === 'done')
      const activeMissions = doneTab ? doneMissions : missions
      const activeErrors = doneTab ? doneView.errors : errors
      const activeLoading = doneTab ? doneView.loading : loading
      // One read feeds every open tracker tab: Dashboard and Missions share this
      // list, so they share its failure too. Workflows reads its own files and
      // never wears the tracker's banner. The source comes from TABS, so a new
      // tab declares what it reads instead of copying a condition.
      const tabSource = TABS.find((entry) => entry.id === tab)?.source ?? 'tracker'
      const trackerTab = tabSource === 'tracker'
      const failed = activeErrors.length > 0
      // The header and the tab badge count open work: a done mission the Done
      // view shows is history, not a mission waiting on anyone.
      const openMissions = missions.filter((mission) => mission.state !== 'done')
      const projectCount = new Set(openMissions.map((mission) => mission.project).filter(Boolean)).size
      const changeTheme = (value) => {
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
      const hero = theme === 'manga' ? h('div', { className: 'missions-hero', 'aria-hidden': 'true' },
        h('img', { className: 'missions-hero-photo', src: ART.village, alt: '' }),
        h('div', { className: 'missions-hero-bubble' },
          h('b', null, `${openMissions.length} mission${openMissions.length === 1 ? '' : 's'}!`),
          h('span', null, `${projectCount} project${projectCount === 1 ? '' : 's'}`),
        ),
        h('div', { className: 'missions-hero-avatar' }, h('img', { src: ART.avatar, alt: '' })),
      ) : null
      const activeQuery = doneTab ? doneQuery : query
      const activeFilters = doneTab ? doneFilters : filters
      const activeSort = doneTab ? doneSort : sort
      // Done keeps closed rows, so it is the only view that passes `allowDone`.
      const filtered = filterMissions(activeMissions, { query: activeQuery, ...activeFilters, allowDone: doneTab })
      const groups = groupByState(sortMissions(filtered, activeSort))
      const onFilter = (key, value) => {
        if (doneTab) setDoneFilters((previous) => ({ ...previous, [key]: value, state: ['done'] }))
        else setFilters((previous) => ({ ...previous, [key]: value }))
      }
      const onClear = () => {
        // Done's status is fixed: clearing keeps the view's perimeter.
        if (doneTab) setDoneFilters({ ...EMPTY_FILTERS, state: ['done'] })
        else setFilters({ ...EMPTY_FILTERS })
      }

      // A widget's link opens the list on exactly the rows the widget showed:
      // its states, its type, its priority — no search, no order, no other
      // filter. The bar is reset rather than completed, so the count the widget
      // announced is the count the list shows.
      const onViewAll = (filters = {}) => {
        setSelected(null)
        setQuery('')
        setSort(null)
        setFilters({ ...EMPTY_FILTERS, ...filters })
        setTab('missions')
        setRepository(null)
      }

      // A tab switch closes the repository drawer: the drawer belongs to the
      // tab that opened it, and a repository selected there has no meaning on
      // the mission tabs.
      const changeTab = (next) => {
        setTab(next)
        setRepository(null)
      }

      // A tab carries the count its badge names. The repositories count is
      // `null` until the host answers, so the tab draws no badge before that
      // first read: a zero nobody proved is not a count.
      const tabBadge = (entry) => {
        if (entry.badge === 'missions') return openMissions.length
        if (entry.badge === 'repositories') return repositoryCount
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
            entry.label,
            badge === null ? null : h('span', { className: 'missions-tab-count' }, String(badge)),
          )
        }),
      )

      return h('div', { className: 'missions-panel', 'data-theme': theme },
        hero,
        h('header', { className: theme === 'manga' ? 'missions-head missions-head--hero' : 'missions-head' },
          theme === 'manga'
            ? h('div', { className: 'missions-kicker' },
                h('span', { className: 'missions-kicker-rule' }),
                'Konoha · mission log',
              )
            : null,
          h('h1', { className: 'missions-title' }, 'Missions',
            theme === 'manga' ? h('span', { className: 'missions-title-mark', 'aria-hidden': 'true' }, '忍') : null,
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
                onClick: () => (doneTab ? loadDone({ refresh: true }) : load({ refresh: true })),
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
            tab === 'workflows'
              ? h(WorkflowsView, null)
              : tab === 'repositories'
              ? h(RepositoriesView, { theme, onOpen: setRepository })
              : tab === 'done'
              ? h(MissionsView, {
                  missions: doneMissions, query: doneQuery, onQuery: setDoneQuery, filters: doneFilters, onFilter, onClear, sort: doneSort, onSort: setDoneSort,
                  filtered, groups, onSelect: setSelected, theme, loading: doneView.loading, failed,
                  onRefresh: () => loadDone({ refresh: true }),
                  statusOptions: ['done'], statusFixed: true,
                  emptyText: 'No done mission declared on this machine.',
                })
              : tab === 'dashboard'
              ? h(DashboardView, {
                  missions,
                  loading,
                  theme,
                  failed,
                  onOpen: (mission) => { setSelected(mission); setTab('missions') },
                  onOpenAll: () => { setSelected(null); setTab('missions') },
                  onViewAll,
                })
              : h(MissionsView, {
                  missions, query, onQuery: setQuery, filters, onFilter, onClear, sort, onSort: setSort,
                  filtered, groups, onSelect: setSelected, theme, loading, failed,
                  onRefresh: () => load({ refresh: true }),
                }),
          ),
          tab === 'workflows'
            ? null
            : tab === 'repositories'
            ? repository
              ? h(RepositoryDrawer, { key: repository.name, repository, onClose: () => setRepository(null), theme })
              : h('aside', { className: 'missions-drawer missions-drawer--empty', 'aria-label': 'Repository details' },
                  h('p', { className: 'missions-drawer-hint' }, 'Select a repository to see its remote, its upstream and its last commits.'),
                )
            : selected
            ? h(MissionDrawer, { key: selected.key, mission: selected, services, workspaceId, workspaceRoot, onClose: () => setSelected(null), onSaved: applyDeclaration, onPrioritySaved: applyPriority, theme })
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
