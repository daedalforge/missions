/**
 * Panneau Missions — moitié client.
 *
 * Il n'affiche que ce que la moitié hôte lui donne : une liste normalisée et
 * une erreur par projet. Aucun jeton, aucun appel direct à un tracker.
 */
window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const module = { exports: {} }
    const exports = module.exports

    const LISTE_URL = 'missions/api/list'

    const ETATS = { 'to-refine': 'à cadrer', ready: 'prête', 'in-progress': 'en cours', 'in-review': 'en revue' }
    const TYPES = { bug: 'bug', story: 'story' }

    const CSS = `
.missions-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; line-height: 1.5; }
.missions-head { display: flex; align-items: baseline; gap: 12px; padding: 24px 28px 0; flex: none; }
.missions-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.missions-count { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 12px; font-variant-numeric: tabular-nums; }
.missions-actions { margin-left: auto; display: flex; gap: 8px; }
.missions-btn { height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 6px; background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.missions-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.missions-erreurs { display: flex; flex-direction: column; gap: 6px; padding: 14px 28px 0; flex: none; }
.missions-erreur { display: flex; gap: 8px; padding: 8px 10px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #1f1f1f); background: color-mix(in srgb, #cf222e 10%, transparent); border: 1px solid color-mix(in srgb, #cf222e 35%, transparent); }
.missions-erreur b { font-weight: 600; }
.missions-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 28px 28px; }
.missions-liste { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.missions-ligne { display: grid; grid-template-columns: 96px 52px 1fr auto; gap: 12px; align-items: baseline; padding: 9px 8px; border-radius: 6px; }
.missions-ligne:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.missions-etat { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-tertiary, #7a7168); }
.missions-etat[data-etat="in-progress"] { color: #bf8700; }
.missions-etat[data-etat="in-review"] { color: #0969da; }
.missions-etat[data-etat="ready"] { color: #1a7f37; }
.missions-type { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, currentColor 9%, transparent); color: var(--dsw-alias-label-tertiary, #7a7168); justify-self: start; }
.missions-titre { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.missions-cle { color: var(--dsw-alias-label-tertiary, #7a7168); font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.missions-vide { color: var(--dsw-alias-label-tertiary, #7a7168); padding: 8px 0; }
.missions-epic { color: var(--dsw-alias-label-tertiary, #7a7168); font-size: 11.5px; }
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

    function MissionsPanel() {
      const [etat, setEtat] = React.useState({ chargement: true, missions: [], erreurs: [] })

      const charger = React.useCallback(() => {
        setEtat((precedent) => ({ ...precedent, chargement: true }))
        fetch(`${LISTE_URL}?frais=1`, { headers: { accept: 'application/json' } })
          .then((reponse) => reponse.json())
          .then((donnees) => {
            if (donnees?.erreur) throw new Error(donnees.erreur)
            setEtat({ chargement: false, missions: donnees?.missions ?? [], erreurs: donnees?.erreurs ?? [] })
          })
          .catch((erreur) => {
            setEtat({ chargement: false, missions: [], erreurs: [{ projet: 'panneau', message: erreur?.message ?? 'lecture impossible' }] })
          })
      }, [])

      React.useEffect(() => {
        charger()
      }, [charger])

      const { chargement, missions, erreurs } = etat

      return h('div', { className: 'missions-panel' },
        h('header', { className: 'missions-head' },
          h('h1', { className: 'missions-title' }, 'Missions'),
          h('span', { className: 'missions-count' }, String(missions.length)),
          h('div', { className: 'missions-actions' },
            h('button', { type: 'button', className: 'missions-btn', onClick: charger, disabled: chargement }, 'Rafraîchir'),
          ),
        ),

        erreurs.length > 0
          ? h('div', { className: 'missions-erreurs' },
              erreurs.map((erreur) => h('div', { className: 'missions-erreur', key: `${erreur.projet}` },
                h('b', null, erreur.projet),
                h('span', null, erreur.message),
              )))
          : null,

        h('div', { className: 'missions-body' },
          chargement && missions.length === 0
            ? h('p', { className: 'missions-vide' }, 'Lecture des projets…')
            : missions.length === 0
              ? h('p', { className: 'missions-vide' }, 'Aucune mission ouverte.')
              : h('ul', { className: 'missions-liste' },
                  missions.map((mission) => h('li', { className: 'missions-ligne', key: mission.cle },
                    h('span', { className: 'missions-etat', 'data-etat': mission.etat ?? 'inconnu' },
                      ETATS[mission.etat] ?? 'état inconnu'),
                    h('span', { className: 'missions-type' }, TYPES[mission.type] ?? '—'),
                    h('span', { className: 'missions-titre' }, mission.titre),
                    h('span', { className: 'missions-cle' }, mission.cle),
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
