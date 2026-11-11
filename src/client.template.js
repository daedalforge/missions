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
      if (ui && typeof ui.startSession === 'function' && id) {
        try {
          if (typeof ui.connectWorkspace === 'function') await ui.connectWorkspace(id)
          ui.startSession(id, { prompt })
          return {
            sessionId: null,
            prefilledBy: 'uiWorkspace.startSession',
            openedBy: 'uiWorkspace.startSession',
          }
        } catch (error) {
          const raison = error?.message ?? String(error)
          return { sessionId: null, prefilledBy: null, openedBy: null, uiError: raison }
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
    const JOURNAL_URL = 'missions/api/journal'
    const CHECKLIST_URL = 'missions/api/checklist'
    const REFRESH_MS = 60000

    const STATE_LABELS = {
      'to-refine': 'to refine',
      ready: 'ready',
      'in-progress': 'in progress',
      'in-review': 'in review',
      'ready-for-prod': 'ready for prod',
      unknown: 'unknown state',
    }
    const TYPE_LABELS = { bug: 'bug', story: 'story' }
    const TYPE_OPTIONS = [
      { id: 'bug', name: 'Bug' },
      { id: 'story', name: 'Story' },
    ]
    const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' }
    const EMPTY_FILTERS = { type: null, state: null, epic: null, priority: null, project: null, missing: null }
    const SORT_OPTIONS = [
      { id: 'priority', name: 'Priority (high → low)' },
      { id: 'points', name: 'Story points (low → high)' },
    ]

    const TABS = [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'missions', label: 'Missions' },
    ]

    // The drawer keeps its own sections: the panel tabs above switch views, these
    // switch what a single mission shows. 'details' is the resting tab.
    const DRAWER_TABS = [
      { id: 'details', label: 'Details' },
      { id: 'journal', label: 'Journal' },
      { id: 'checklist', label: 'Checklist' },
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

    const CSS = `
.missions-panel { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; line-height: 1.5; }
.missions-head { display: flex; align-items: center; gap: 12px; padding: 24px 28px 0; flex: none; }
.missions-title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.015em; }
.missions-scope { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12px; }
.missions-actions { margin-left: auto; display: flex; gap: 8px; }
.missions-btn { height: 30px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary, #4a4a4a); font: inherit; font-size: 12px; cursor: pointer; }
.missions-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-btn:disabled { opacity: .55; cursor: default; }
.missions-tabs { display: flex; gap: 24px; margin-top: 16px; padding: 0 28px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); flex: none; }
.missions-tab { height: 36px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 12.5px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.missions-tab:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); border-bottom-color: var(--dsw-alias-label-primary, #1f1f1f); font-weight: 600; }
.missions-tab-count { min-width: 18px; padding: 0 5px; border-radius: 9px; background: color-mix(in srgb, currentColor 10%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; font-weight: 500; text-align: center; }
.missions-toolbar { display: flex; flex-direction: column; gap: 10px; padding: 16px 28px 0; flex: none; }
.missions-toolbar-top { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.missions-search { flex: 1 1 240px; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12.5px; }
.missions-search input::placeholder { color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.missions-select { position: relative; display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 8px 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-secondary, #4a4a4a); font-size: 11.5px; max-width: 300px; cursor: pointer; }
.missions-select-label { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.missions-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-select svg { flex: none; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-select[data-active="true"] { border-color: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 32%, transparent); background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 3%, var(--dsw-alias-bg-layer-1, #ffffff)); }
.missions-select[data-active="true"] .missions-select-value { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-select:focus-within { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 1px; }
.missions-select select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.missions-clear { flex: none; height: 30px; padding: 0 6px; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.missions-clear:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
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
.missions-content { display: flex; flex: 1; min-height: 0; align-items: stretch; }
.missions-body { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 6px 28px 32px; }
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
.missions-prio { font-size: 10.5px; letter-spacing: .01em; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-prio[data-priority="urgent"] { color: #cf222e; font-weight: 600; }
.missions-prio[data-priority="high"] { color: #bf8700; }
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
.missions-dashboard { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; max-width: 520px; padding-top: 8px; }
.missions-dashboard-card { width: 100%; padding: 18px 20px; border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 10px; }
.missions-dashboard-card h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.missions-dashboard-card p { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12.5px; }
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
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-title-mark,
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-drawer::before,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-type,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-ring,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-title-mark,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-drawer::before { color: #2c2621; }
:root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-name,
body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-group-name { color: var(--mm-ink-2); }

/* The select, in the themed header. */
.missions-panel[data-theme="manga"] .missions-theme { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-theme-label { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-theme-value { color: var(--mm-ink); }
.missions-panel[data-theme="manga"] .missions-theme svg { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-btn { height: 29px; padding: 0 10px; border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 2px 2px 0 var(--mm-shadow); color: var(--mm-ink); font-size: 11px; }
.missions-panel[data-theme="manga"] .missions-btn:hover { background: var(--mm-page-3); color: var(--mm-ink); }

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
.missions-panel[data-theme="manga"] .missions-tab-count { border: 1px solid var(--mm-line-strong); background: var(--mm-page-2); color: var(--mm-ink-2); }
.missions-panel[data-theme="manga"] .missions-toolbar { padding: 11px 30px 8px; gap: 7px; background-color: var(--mm-page); background-image: radial-gradient(var(--mm-trame) .55px, transparent .6px); background-size: 9px 9px; }
.missions-panel[data-theme="manga"] .missions-search { height: 32px; border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); color: var(--mm-ink-3); box-shadow: 1px 1px 0 var(--mm-shadow); }
.missions-panel[data-theme="manga"] .missions-search input { color: var(--mm-ink); font-size: 12.5px; }
.missions-panel[data-theme="manga"] .missions-search input::placeholder { color: var(--mm-ink-3); }
.missions-panel[data-theme="manga"] .missions-select { border: 1.5px solid var(--mm-ink); border-radius: 8px; background: var(--mm-page-2); box-shadow: 1px 1px 0 var(--mm-shadow); color: var(--mm-ink-2); }
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
.missions-panel[data-theme="manga"] .missions-prio { color: var(--mm-ink-3); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; font-weight: 700; }
.missions-panel[data-theme="manga"] .missions-prio[data-priority="urgent"] { color: var(--mm-coral-deep); }
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

    function DashboardView() {
      return h('div', { className: 'missions-dashboard' },
        h('div', { className: 'missions-dashboard-card' },
          h('h2', null, 'Nothing to show yet'),
          h('p', null, 'This is where the workspace overview will live: missions by state, active projects, and what moved today.'),
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
          mission.priority ? h('span', { className: 'missions-prio', 'data-priority': mission.priority }, mission.priority) : null,
          mission.points !== null && mission.points !== undefined ? h('span', { className: 'missions-sp' }, `${mission.points} pts`) : null,
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
    function Switch({ label, checked, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        className: 'missions-switch',
        onClick: () => onChange(!checked),
      },
        h('span', { className: 'missions-switch-track', 'aria-hidden': 'true' },
          h('span', { className: 'missions-switch-thumb' }),
        ),
        h('span', { className: 'missions-switch-label' }, label),
      )
    }

    function MissionsView({ missions, query, onQuery, filters, onFilter, onClear, sort, onSort, filtered, groups, onSelect, theme }) {
      const states = stateOptions(missions)
      const epics = epicOptions(missions)
      const priorities = priorityOptions(missions)
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
        ),
        h('div', { className: 'missions-filters' },
          h(FilterSelect, {
            label: 'Status',
            value: filters.state,
            options: states,
            format: (state) => STATE_LABELS[state] ?? state,
            onChange: (value) => onFilter('state', value),
          }),
          h(FilterSelect, { label: 'Type', value: filters.type, options: TYPE_OPTIONS, onChange: (value) => onFilter('type', value) }),
          h(FilterSelect, { label: 'Epic', value: filters.epic, options: epics, onChange: (value) => onFilter('epic', value) }),
          h(FilterSelect, { label: 'Project', value: filters.project, options: projects, onChange: (value) => onFilter('project', value) }),
          h(FilterSelect, {
            label: 'Priority',
            value: filters.priority,
            options: priorities,
            format: (priority) => PRIORITY_LABELS[priority] ?? priority,
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

      if (missions.length === 0) {
        return h('div', null, toolbar, h('p', { className: 'missions-empty' }, 'No open missions assigned to you.'))
      }
      if (filtered.length === 0) {
        return h('div', null, toolbar, theme === 'manga'
          ? h(MangaEmpty, { onClear })
          : h('p', { className: 'missions-empty' }, 'No mission matches these filters.'))
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

    function MissionDrawer({ mission, services, workspaceId, workspaceRoot, onClose, onSaved, theme }) {
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

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const blocker = executionBlocker(mission)
      const journalPath = mission.folder ? `missions/${mission.folder}/journal.md` : null
      const checklistPath = mission.folder ? `missions/${mission.folder}/checklist.md` : null
      const prompt = `Travaille sur la mission ${mission.key} — ${mission.title}.\n\nOuvre d'abord le ticket : ${mission.url ?? '(lien indisponible)'}\nSuis le workflow du workspace : cadrage → exécution → revue → clôture.${blocker === null ? `\n\nBranche : ${mission.branch} ; base : ${mission.base}.` : ''}${journalPath ? `\n\nJournal de mission : ${journalPath} — ouvre-le au cadrage et tiens-le à jour à chaque étape.` : ''}${checklistPath ? `\n\nChecklist de mission : ${checklistPath} — ouvre-la au cadrage, coche chaque point avec sa preuve.` : ''}`

      const startSession = async () => {
        setNote('Starting a session…')
        try {
          const { prefilledBy, openedBy, uiError } = await openMissionSession(services, prompt, workspaceId, workspaceRoot)
          if (uiError) {
            setNote(`uiWorkspace refused: ${uiError}`)
          } else if (openedBy) {
            setNote(`Session opened via ${openedBy}, prompt prefilled via ${prefilledBy ?? 'nothing'} — press Enter to send.`)
          } else if (prefilledBy === 'clipboard') {
            setNote(
              `Session created ${workspaceId ? 'in the projects workspace' : 'without a workspace'}; the prompt is on your clipboard — paste it in the session.`,
            )
          } else if (prefilledBy) {
            setNote(
              `Session created ${workspaceId ? 'in the projects workspace' : 'without a workspace'} and prefilled via ${prefilledBy}, but this panel cannot open it — pick it in the sidebar.`,
            )
          } else {
            setNote(
              `Session created ${workspaceId ? 'in the projects workspace' : 'without a workspace'}, but neither opened nor prefilled — pick it in the sidebar.`,
            )
          }
        } catch (error) {
          setNote(`Session failed: ${error?.message ?? error}`)
        }
      }

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

      const savedBranch = mission.branch ?? ''
      const savedBase = mission.base ?? ''
      const dirty = branch.trim() !== savedBranch || base.trim() !== savedBase
      const checklistView = checklist?.exists ? parseChecklist(checklist.source) : null

      const detailsPanel = h(React.Fragment, null,
        h('dl', { className: 'missions-props' },
          h(DrawerRow, { label: 'State', value: STATE_LABELS[mission.state] ?? mission.state }),
          h(DrawerRow, { label: 'Type', value: TYPE_LABELS[mission.type] ?? mission.type }),
          h(DrawerRow, { label: 'Priority', value: mission.priority }),
          h(DrawerRow, { label: 'Points', value: mission.points !== null && mission.points !== undefined ? `${mission.points} pts` : null }),
          h(DrawerRow, { label: 'Project', value: mission.projectName ?? mission.project }),
          h(DrawerRow, { label: 'Epic', value: mission.epic }),
          h(DrawerRow, { label: 'Updated', value: relativeAge(mission.updatedAt) }),
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
          blocker ? h('p', { id: 'missions-session-blocked', className: 'missions-drawer-note missions-drawer-note--blocked' }, `Session blocked: ${blocker}.`) : null,

          h('div', { className: 'missions-drawer-actions' },
            mission.url
              ? h('a', { className: 'missions-action', href: mission.url, target: '_blank', rel: 'noreferrer noopener' }, 'Open on the tracker')
              : h('button', { type: 'button', className: 'missions-action', disabled: true }, 'No tracker link'),
            h('button', { type: 'button', className: 'missions-action missions-action--primary', onClick: startSession, disabled: blocker !== null, title: blocker ?? undefined, 'aria-describedby': blocker ? 'missions-session-blocked' : undefined }, 'Start a session'),
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

    function MissionsPanel({ services }) {
      const [view, setView] = React.useState({ loading: true, missions: [], errors: [], workspaceId: null, workspaceRoot: null })
      const [tab, setTab] = React.useState('missions')
      const [query, setQuery] = React.useState('')
      const [filters, setFilters] = React.useState(EMPTY_FILTERS)
      const [sort, setSort] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [theme, setTheme] = React.useState(readTheme)

      const load = React.useCallback(({ silent = false } = {}) => {
        if (!silent) setView((previous) => ({ ...previous, loading: true }))
        return fetch(`${LIST_URL}?refresh=1`, { headers: { accept: 'application/json' } })
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

      React.useEffect(() => {
        load()
        const timer = setInterval(() => {
          if (!document.hidden) load({ silent: true })
        }, REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])

      const { loading, missions, errors, workspaceId, workspaceRoot } = view
      const projectCount = new Set(missions.map((mission) => mission.project).filter(Boolean)).size
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
        setSelected((previous) => (
          previous && previous.key === saved.key
            ? { ...previous, folder: saved.folder, branch: saved.branch, base: saved.base }
            : previous
        ))
      }
      const hero = theme === 'manga' ? h('div', { className: 'missions-hero', 'aria-hidden': 'true' },
        h('img', { className: 'missions-hero-photo', src: ART.village, alt: '' }),
        h('div', { className: 'missions-hero-bubble' },
          h('b', null, `${missions.length} mission${missions.length === 1 ? '' : 's'}!`),
          h('span', null, `${projectCount} project${projectCount === 1 ? '' : 's'}`),
        ),
        h('div', { className: 'missions-hero-avatar' }, h('img', { src: ART.avatar, alt: '' })),
      ) : null
      const filtered = filterMissions(missions, { query, ...filters })
      const groups = groupByState(sortMissions(filtered, sort))
      const onFilter = (key, value) => setFilters((previous) => ({ ...previous, [key]: value }))
      const onClear = () => setFilters(EMPTY_FILTERS)

      const tabBar = h('div', { className: 'missions-tabs', role: 'tablist', 'aria-label': 'Missions views' },
        TABS.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          role: 'tab',
          className: 'missions-tab',
          'aria-selected': tab === entry.id ? 'true' : 'false',
          'aria-controls': `missions-view-${entry.id}`,
          id: `missions-tab-${entry.id}`,
          onClick: () => setTab(entry.id),
        },
          entry.label,
          entry.id === 'missions' ? h('span', { className: 'missions-tab-count' }, String(missions.length)) : null,
        )),
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
            `assigned to me · ${missions.length} open · ${projectCount} project${projectCount === 1 ? '' : 's'}`,
          ),
          h('div', { className: 'missions-actions' },
            h(ThemeSelect, { value: theme, onChange: changeTheme }),
            tab === 'missions' && errors.length === 0
              ? h('button', {
                  type: 'button',
                  className: 'missions-btn',
                  onClick: () => load(),
                  disabled: loading,
                  'aria-busy': loading ? 'true' : 'false',
                }, 'Refresh')
              : null,
          ),
        ),
        tabBar,

        tab === 'missions' && errors.length > 0
          ? h('div', { className: 'missions-errors' },
              errors.map((error, index) => h('div', { className: 'missions-error', key: `${error.project}-${index}` },
                h('b', null, error.project),
                h('span', null, error.message),
              )))
          : null,

        h('div', { className: 'missions-content' },
          h('div', {
            className: 'missions-body',
            role: 'tabpanel',
            id: `missions-view-${tab}`,
            'aria-labelledby': `missions-tab-${tab}`,
          },
            loading
              ? h(PanelLoader, { theme })
              : tab === 'dashboard'
                ? h(DashboardView, null)
                : h(MissionsView, { missions, query, onQuery: setQuery, filters, onFilter, onClear, sort, onSort: setSort, filtered, groups, onSelect: setSelected, theme }),
          ),
          selected
            ? h(MissionDrawer, { key: selected.key, mission: selected, services, workspaceId, workspaceRoot, onClose: () => setSelected(null), onSaved: applyDeclaration, theme })
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
