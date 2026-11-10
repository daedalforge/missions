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

    /** Plugin context captured at apply time: gives access to uiWorkspace. */
    let appContext = null

    const LIST_URL = 'missions/api/list'
    const REFRESH_MS = 60000

    const STATE_LABELS = {
      'to-refine': 'to refine',
      ready: 'ready',
      'in-progress': 'in progress',
      'in-review': 'in review',
      unknown: 'unknown state',
    }
    const TYPE_LABELS = { bug: 'bug', story: 'story' }
    const TYPE_FILTERS = [
      { id: null, label: 'All' },
      { id: 'bug', label: 'Bug' },
      { id: 'story', label: 'Story' },
    ]

    const TABS = [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'missions', label: 'Missions' },
    ]

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
.missions-toolbar { display: flex; align-items: center; gap: 10px; padding: 16px 28px 0; flex: none; }
.missions-search { flex: 1; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); border-radius: 8px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f); font: inherit; font-size: 12.5px; }
.missions-search input::placeholder { color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-chips { display: flex; gap: 6px; }
.missions-chip { height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); background: transparent; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 11.5px; cursor: pointer; }
.missions-chip[aria-pressed="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); border-color: color-mix(in srgb, currentColor 30%, transparent); }
.missions-errors { display: flex; flex-direction: column; gap: 6px; padding: 14px 28px 0; flex: none; }
.missions-error { display: flex; gap: 8px; padding: 8px 10px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, #cf222e 10%, transparent); border: 1px solid color-mix(in srgb, #cf222e 35%, transparent); }
.missions-error b { font-weight: 600; }
.missions-body { flex: 1; min-height: 0; overflow: auto; padding: 6px 28px 32px; }
.missions-group { margin-top: 20px; }
.missions-group-head { display: flex; align-items: center; gap: 8px; padding: 0 2px 10px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); position: sticky; top: 0; background: var(--dsw-alias-bg-base, #fbfaf8); z-index: 1; }
.missions-group-head .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.missions-group-head .n { font-variant-numeric: tabular-nums; opacity: .75; }
.missions-group-head .rule { flex: 1; height: 1px; background: var(--dsw-alias-border-l2, rgba(0,0,0,.07)); }
.missions-group[data-state="in-review"] .missions-group-head { color: #0969da; }
.missions-group[data-state="in-progress"] .missions-group-head { color: #bf8700; }
.missions-group[data-state="ready"] .missions-group-head { color: #1a7f37; }
.missions-group[data-state="to-refine"] .missions-group-head { color: #8250df; }
.missions-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(292px, 1fr)); gap: 12px; }
.missions-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #ffffff); cursor: pointer; transition: border-color .15s ease, background-color .15s ease; }
.missions-card:hover { border-color: color-mix(in srgb, currentColor 22%, transparent); background: color-mix(in srgb, currentColor 3%, var(--dsw-alias-bg-layer-1, #ffffff)); }
.missions-card:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #1f1f1f) 45%, transparent); outline-offset: 2px; }
.missions-card[data-priority="urgent"] { border-left: 3px solid #cf222e; padding-left: 14px; }
@media (prefers-reduced-motion: reduce) { .missions-card { transition: none; } }
.missions-card-top { display: flex; align-items: center; gap: 8px; }
.missions-type { display: inline-flex; align-items: center; height: 21px; padding: 0 8px; border-radius: 999px; font-size: 11px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-type[data-type="bug"] { color: #cf222e; background: color-mix(in srgb, #cf222e 10%, transparent); }
.missions-type[data-type="story"] { color: #2da44e; background: color-mix(in srgb, #2da44e 11%, transparent); }
.missions-prio { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-prio[data-priority="urgent"] { color: #cf222e; font-weight: 600; }
.missions-prio[data-priority="high"] { color: #bf8700; }
.missions-sp { margin-left: auto; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; color: var(--dsw-alias-label-tertiary, #7a7168); padding: 1px 7px; border-radius: 6px; background: color-mix(in srgb, currentColor 7%, transparent); }
.missions-card-title { font-size: 13.5px; font-weight: 550; line-height: 1.4; letter-spacing: -.005em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.missions-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; }
.missions-key { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; }
.missions-age { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.missions-empty { color: var(--dsw-alias-label-tertiary, #7a7168); padding: 24px 0; }
.missions-dashboard { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; max-width: 520px; padding-top: 8px; }
.missions-dashboard-card { width: 100%; padding: 18px 20px; border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 10px; }
.missions-dashboard-card h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.missions-dashboard-card p { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12.5px; }
.missions-drawer-backdrop { position: absolute; inset: 0; z-index: 2; }
.missions-drawer { position: absolute; top: 0; right: 0; bottom: 0; z-index: 3; width: 380px; max-width: 92%; display: flex; flex-direction: column; gap: 16px; padding: 22px 24px; overflow: auto; background: var(--dsw-alias-bg-layer-2, #ffffff); border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); box-shadow: -8px 0 24px rgba(0,0,0,.06); animation: missions-slide .16s ease; }
@keyframes missions-slide { from { transform: translateX(12px); opacity: 0 } to { transform: none; opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .missions-drawer { animation: none; } }
.missions-drawer-head { display: flex; align-items: flex-start; gap: 12px; }
.missions-drawer-key { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-drawer-title { margin: 6px 0 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.missions-drawer-close { margin-left: auto; width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-tertiary, #7a7168); cursor: pointer; }
.missions-drawer-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #1f1f1f); }
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
.missions-drawer-version { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 10.5px; letter-spacing: .04em; }
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

    function MissionsView({ loading, missions, query, onQuery, type, onType, filtered, groups, onSelect }) {
      const toolbar = h('div', { className: 'missions-toolbar' },
        h('label', { className: 'missions-search' },
          h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' },
            h('circle', { cx: 7, cy: 7, r: 4.6 }),
            h('path', { d: 'M10.4 10.4 14 14', 'stroke-linecap': 'round' }),
          ),
          h('input', {
            type: 'search',
            value: query,
            placeholder: 'Filter by title, key, project…',
            'aria-label': 'Filter missions',
            onChange: (event) => onQuery(event.target.value),
          }),
        ),
        h('div', { className: 'missions-chips' },
          TYPE_FILTERS.map((entry) => h('button', {
            key: entry.label,
            type: 'button',
            className: 'missions-chip',
            'aria-pressed': type === entry.id ? 'true' : 'false',
            onClick: () => onType(entry.id),
          }, entry.label)),
        ),
      )

      if (loading && missions.length === 0) {
        return h('div', null, toolbar, h('p', { className: 'missions-empty' }, 'Reading projects…'))
      }
      if (missions.length === 0) {
        return h('div', null, toolbar, h('p', { className: 'missions-empty' }, 'No open missions assigned to you.'))
      }
      if (filtered.length === 0) {
        return h('div', null, toolbar, h('p', { className: 'missions-empty' }, 'No mission matches these filters.'))
      }

      return h('div', null,
        toolbar,
        groups.map((group) => h('section', { className: 'missions-group', 'data-state': group.state, key: group.state },
          h('div', { className: 'missions-group-head' },
            h('span', { className: 'dot' }),
            STATE_LABELS[group.state] ?? group.state,
            h('span', { className: 'n' }, String(group.missions.length)),
            h('span', { className: 'rule' }),
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

    function MissionDrawer({ mission, onClose }) {
      const [note, setNote] = React.useState(null)

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const startSession = () => {
        const workspace =
          appContext?.uiWorkspace ??
          (typeof appContext?.get === 'function' ? appContext.get('uiWorkspace') : null)

        if (!workspace || typeof workspace.startSession !== 'function') {
          setNote('uiWorkspace is not exposed to this panel: cannot start a session here.')
          return
        }

        const prompt = `Travaille sur la mission ${mission.key} — ${mission.title}.\n\nOuvre d'abord le ticket : ${mission.url ?? '(lien indisponible)'}\nSuis le workflow du workspace : cadrage → exécution → revue → clôture.`
        setNote('Starting a session…')

        try {
          const outcome = workspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
          if (outcome && typeof outcome.then === 'function') {
            outcome.then(
              () => setNote('Session started.'),
              (error) => setNote(`Session failed: ${error?.message ?? error}`),
            )
            return
          }
          setNote('Session started.')
        } catch (error) {
          setNote(`Session failed: ${error?.message ?? error}`)
        }
      }

      return h(React.Fragment, null,
        h('div', { className: 'missions-drawer-backdrop', onClick: onClose }),
        h('aside', { className: 'missions-drawer', role: 'dialog', 'aria-label': `Mission ${mission.key}` },
          h('div', { className: 'missions-drawer-head' },
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

          h('dl', { className: 'missions-props' },
            h(DrawerRow, { label: 'State', value: STATE_LABELS[mission.state] ?? mission.state }),
            h(DrawerRow, { label: 'Type', value: TYPE_LABELS[mission.type] ?? mission.type }),
            h(DrawerRow, { label: 'Priority', value: mission.priority }),
            h(DrawerRow, { label: 'Points', value: mission.points !== null && mission.points !== undefined ? `${mission.points} pts` : null }),
            h(DrawerRow, { label: 'Project', value: mission.project }),
            h(DrawerRow, { label: 'Epic', value: mission.epic }),
            h(DrawerRow, { label: 'Updated', value: relativeAge(mission.updatedAt) }),
          ),

          note ? h('p', { className: 'missions-drawer-note' }, note) : null,

          h('div', { className: 'missions-drawer-version' }, 'panel v__VERSION__'),

          h('div', { className: 'missions-drawer-actions' },
            mission.url
              ? h('a', { className: 'missions-action', href: mission.url, target: '_blank', rel: 'noreferrer noopener' }, 'Open on the tracker')
              : h('button', { type: 'button', className: 'missions-action', disabled: true }, 'No tracker link'),
            h('button', { type: 'button', className: 'missions-action missions-action--primary', onClick: startSession }, 'Start a session'),
          ),
        ),
      )
    }

    function MissionsPanel() {
      const [view, setView] = React.useState({ loading: true, missions: [], errors: [] })
      const [tab, setTab] = React.useState('missions')
      const [query, setQuery] = React.useState('')
      const [type, setType] = React.useState(null)
      const [selected, setSelected] = React.useState(null)

      const load = React.useCallback(({ silent = false } = {}) => {
        if (!silent) setView((previous) => ({ ...previous, loading: true }))
        return fetch(`${LIST_URL}?refresh=1`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data?.error) throw new Error(data.error)
            setView({ loading: false, missions: data?.missions ?? [], errors: data?.errors ?? [] })
          })
          .catch((error) => {
            // A silent refresh that fails must not empty the list.
            setView((previous) => ({
              loading: false,
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

      const { loading, missions, errors } = view
      const filtered = filterMissions(missions, { query, type })
      const groups = groupByState(filtered)

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

      return h('div', { className: 'missions-panel' },
        h('header', { className: 'missions-head' },
          h('h1', { className: 'missions-title' }, 'Missions'),
          h('span', { className: 'missions-scope' }, `assigned to me · ${missions.length}`),
          tab === 'missions' && errors.length === 0
            ? h('div', { className: 'missions-actions' },
                h('button', { type: 'button', className: 'missions-btn', onClick: () => load(), disabled: loading }, 'Refresh'),
              )
            : null,
        ),
        tabBar,

        tab === 'missions' && errors.length > 0
          ? h('div', { className: 'missions-errors' },
              errors.map((error) => h('div', { className: 'missions-error', key: `${error.project}` },
                h('b', null, error.project),
                h('span', null, error.message),
              )))
          : null,

        h('div', {
          className: 'missions-body',
          role: 'tabpanel',
          id: `missions-view-${tab}`,
          'aria-labelledby': `missions-tab-${tab}`,
        },
          tab === 'dashboard'
            ? h(DashboardView, null)
            : h(MissionsView, { loading, missions, query, onQuery: setQuery, type, onType: setType, filtered, groups, onSelect: setSelected }),
        ),

        selected ? h(MissionDrawer, { mission: selected, onClose: () => setSelected(null) }) : null,
      )
    }

    exports.apply = function apply(ctx) {
      appContext = ctx
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-missions'
        style.textContent = CSS
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
          { name: 'main', key: 'missions', inject: () => ({ services: { getService: (name) => ctx.get(name) } }) },
          MissionsPanel,
        ),
      )
    }

    exports.inject = ['slots']

    return module.exports
  },
})
