/**
 * Panneau Missions — moitié client.
 *
 * Aujourd'hui : un onglet « Missions » vide dans la barre latérale, et un
 * panneau qui dit qu'il n'a rien à montrer. La lecture des issues viendra
 * ensuite ; rien ici ne parle encore au réseau.
 */
window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    const CSS = `
.missions-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  min-height: 0;
  padding: 24px 28px 32px;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 13px;
  line-height: 1.5;
}
.missions-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex: none;
}
.missions-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.missions-count {
  color: var(--dsw-alias-label-tertiary, #7a7168);
  font-size: 12px;
}
.missions-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 0 0;
  color: var(--dsw-alias-label-tertiary, #7a7168);
}
.missions-empty strong {
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-weight: 600;
}
`

    /** Icône de l'onglet : une liste de tickets. */
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

    /** Panneau vide : il ne prétend rien savoir tant que la lecture n'existe pas. */
    function MissionsPanel() {
      return h('div', { className: 'missions-panel' },
        h('header', { className: 'missions-head' },
          h('h1', { className: 'missions-title' }, 'Missions'),
          h('span', { className: 'missions-count' }, '0'),
        ),
        h('div', { className: 'missions-empty' },
          h('strong', null, 'Aucune mission affichée'),
          h('span', null, 'Le panneau est en place ; la lecture du tracker viendra ensuite.'),
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
