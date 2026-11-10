/**
 * Missions panel — client half.
 *
 * It only shows what the host half gives it: a normalized list and one error
 * per project. No token, no direct call to a tracker.
 *
 * Two views for now: a Dashboard that has nothing to show yet, and the mission
 * list inherited from the first version.
 */
window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    const LIST_URL = 'missions/api/list'
    const REFRESH_MS = 60000

    const STATE_LABELS = {
      'to-refine': 'to refine',
      ready: 'ready',
      'in-progress': 'in progress',
      'in-review': 'in review',
    }
    const TYPE_LABELS = { bug: 'bug', story: 'story' }

    const TABS = [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'missions', label: 'Missions' },
    ]

    const CSS = `
.missions-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; line-height: 1.5; }
.missions-head { display: flex; align-items: baseline; gap: 12px; padding: 24px 28px 0; flex: none; }
.missions-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.missions-actions { margin-left: auto; display: flex; gap: 8px; }
.missions-btn { height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.missions-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-btn:disabled { opacity: .55; cursor: default; }
.missions-tabs { display: flex; gap: 22px; margin-top: 14px; padding: 0 28px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12)); flex: none; }
.missions-tab { height: 34px; padding: 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--dsw-alias-label-tertiary, #7a7168); font: inherit; font-size: 12.5px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.missions-tab:hover { color: var(--dsw-alias-label-primary, #1f1f1f); }
.missions-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary, #1f1f1f); border-bottom-color: var(--dsw-alias-brand-primary, #f5893a); font-weight: 600; }
.missions-tab-count { min-width: 18px; padding: 0 5px; border-radius: 9px; background: color-mix(in srgb, currentColor 10%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; text-align: center; }
.missions-errors { display: flex; flex-direction: column; gap: 6px; padding: 14px 28px 0; flex: none; }
.missions-error { display: flex; gap: 8px; padding: 8px 10px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #1f1f1f); background: color-mix(in srgb, #cf222e 10%, transparent); border: 1px solid color-mix(in srgb, #cf222e 35%, transparent); }
.missions-error b { font-weight: 600; }
.missions-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 28px 28px; }
.missions-list { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.missions-row { display: grid; grid-template-columns: 96px 52px 1fr auto; gap: 12px; align-items: baseline; padding: 9px 8px; border-radius: 6px; }
.missions-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.missions-state { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-state[data-state="in-progress"] { color: #bf8700; }
.missions-state[data-state="in-review"] { color: #0969da; }
.missions-state[data-state="ready"] { color: #1a7f37; }
.missions-type { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); justify-self: start; }
.missions-title-cell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-key { color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.missions-empty { color: var(--dsw-alias-label-tertiary, #7a7168); padding: 8px 0; }
.missions-dashboard { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; max-width: 520px; padding-top: 8px; }
.missions-dashboard-card { width: 100%; padding: 18px 20px; border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.16)); border-radius: 10px; }
.missions-dashboard-card h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.missions-dashboard-card p { margin: 0; color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12.5px; }
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

    function MissionsView({ loading, missions, errors }) {
      if (loading && missions.length === 0) {
        return h('p', { className: 'missions-empty' }, 'Reading projects…')
      }
      if (missions.length === 0) {
        return h('p', { className: 'missions-empty' }, 'No open missions.')
      }
      return h('ul', { className: 'missions-list' },
        missions.map((mission) => h('li', { className: 'missions-row', key: mission.key },
          h('span', { className: 'missions-state', 'data-state': mission.state ?? 'unknown' },
            STATE_LABELS[mission.state] ?? 'unknown state'),
          h('span', { className: 'missions-type' }, TYPE_LABELS[mission.type] ?? '—'),
          h('span', { className: 'missions-title-cell' }, mission.title),
          h('span', { className: 'missions-key' }, mission.key),
        )),
      )
    }

    function MissionsPanel() {
      const [view, setView] = React.useState({ loading: true, missions: [], errors: [] })
      const [tab, setTab] = React.useState('missions')

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
            : h(MissionsView, { loading, missions, errors }),
        ),
      )
    }

    exports.apply = function apply(ctx) {
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
