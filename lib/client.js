/**
 * Missions panel — client half.
 *
 * It only shows what the host half gives it: a normalized list and one error
 * per project. No token, no direct call to a tracker.
 */
window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    const LIST_URL = 'missions/api/list'

    const STATE_LABELS = {
      'to-refine': 'to refine',
      ready: 'ready',
      'in-progress': 'in progress',
      'in-review': 'in review',
    }
    const TYPE_LABELS = { bug: 'bug', story: 'story' }

    const CSS = `
.missions-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; line-height: 1.5; }
.missions-head { display: flex; align-items: baseline; gap: 12px; padding: 24px 28px 0; flex: none; }
.missions-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.missions-count { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12px; font-variant-numeric: tabular-nums; }
.missions-actions { margin-left: auto; display: flex; gap: 8px; }
.missions-btn { height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.missions-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
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

    function MissionsPanel() {
      const [view, setView] = React.useState({ loading: true, missions: [], errors: [] })

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
        }, 60000)
        return () => clearInterval(timer)
      }, [load])

      const { loading, missions, errors } = view

      return h('div', { className: 'missions-panel' },
        h('header', { className: 'missions-head' },
          h('h1', { className: 'missions-title' }, 'Missions'),
          h('span', { className: 'missions-count' }, String(missions.length)),
          h('div', { className: 'missions-actions' },
            h('button', { type: 'button', className: 'missions-btn', onClick: () => load(), disabled: loading }, 'Refresh'),
          ),
        ),

        errors.length > 0
          ? h('div', { className: 'missions-errors' },
              errors.map((error) => h('div', { className: 'missions-error', key: `${error.project}` },
                h('b', null, error.project),
                h('span', null, error.message),
              )))
          : null,

        h('div', { className: 'missions-body' },
          loading && missions.length === 0
            ? h('p', { className: 'missions-empty' }, 'Reading projects…')
            : missions.length === 0
              ? h('p', { className: 'missions-empty' }, 'No open missions.')
              : h('ul', { className: 'missions-list' },
                  missions.map((mission) => h('li', { className: 'missions-row', key: mission.key },
                    h('span', { className: 'missions-state', 'data-state': mission.state ?? 'unknown' },
                      STATE_LABELS[mission.state] ?? 'unknown state'),
                    h('span', { className: 'missions-type' }, TYPE_LABELS[mission.type] ?? '—'),
                    h('span', { className: 'missions-title-cell' }, mission.title),
                    h('span', { className: 'missions-key' }, mission.key),
                  )),
                ),
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
