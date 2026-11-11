import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * Smoke test for the generated client bundle.
 *
 * It loads `lib/client.js` with a fake module loader and a fake React, mounts
 * the panel once, and renders every registered component. This is what catches
 * a render-time crash — the regression that made the panel blank when a
 * missing service was looked up through `ctx.get`.
 */
const SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Le corps d'une règle CSS du bundle : de quoi la juger sans la recopier. */
function regle(selector) {
  const at = SOURCE.indexOf(`${selector} {`)
  assert.ok(at >= 0, `règle absente : ${selector}`)
  return SOURCE.slice(at + selector.length, SOURCE.indexOf('}', at))
}

// Minimal DOM surface: the bundle mounts one <style> and nothing else.
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { append() {} },
}

/**
 * L'état restauré avant le premier rendu de `MissionsPanel` : la barre vide.
 * `useState` le consomme en premier, comme le ferait `sessionStorage` vide.
 */
const EMPTY_BAR = {
  query: '',
  filters: { type: null, state: null, epic: null, priority: null, project: null, missing: null },
  sort: null,
}

function charger(storage, initialStates = [], session = undefined) {
  let captured = null
  // `sessionStorage` est injecté comme `localStorage` : chaque test tient la
  // barre de la session dans un faux stockage, sans toucher au global de Node.
  new Function('window', 'localStorage', 'sessionStorage', SOURCE)({ __ModuleLoader__: { load: (module) => { captured = module } } }, storage, session)

  const queue = [...initialStates]
  // Ce qu'un setter reçoit, dans l'ordre : de quoi prouver qu'un clic bascule
  // vraiment le panneau, pas seulement que le câblage ressemble à ça.
  const setters = []
  // Les composants gardent leur nom dans l'arbre : un test peut alors vérifier
  // quelle vue est rendue, pas seulement qu'un nœud existe. `fn` garde la
  // fonction pour la rendre pour de vrai (voir `renderTree`).
  const h = (type, props, ...children) => ({
    type: typeof type === 'function' ? type.name : type,
    fn: typeof type === 'function' ? type : null,
    props,
    children,
  })
  // Les effets sont collectés, pas exécutés : un montage de test ne doit ni
  // lancer la requête ni armer le timer de 60 s. Un test qui vise une écriture
  // de session appelle l'effet lui-même.
  const effects = []
  const React = {
    createElement: h,
    Fragment: 'fragment',
    useState: (initial) => [
      queue.length > 0 ? queue.shift() : (typeof initial === 'function' ? initial() : initial),
      (next) => { setters.push(next) },
    ],
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => { effects.push({ fn, deps }) },
    // Un `ref` n'a pas de nœud DOM à recevoir ici : le conteneur reste vide, ce
    // qui suffit au rendu (seul le menu ouvert lit `.contains`).
    useRef: () => ({ current: null }),
  }

  const registered = {}
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        registered[options.name] = component
      },
    },
    // A cordis context throws on an unknown service: the panel must survive it.
    get: () => {
      throw new Error('service not found')
    },
  }

  const api = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { api, ctx, registered, id: captured.id, setters, effects }
}

/** Aplatit les listes d'enfants que `Array#map` imbrique. */
function flat(children) {
  return children.reduce((all, child) => all.concat(Array.isArray(child) ? flat(child) : [child]), [])
}

/**
 * Rend un arbre comme React le ferait : chaque composant sans état est appelé
 * avec ses props, chaque nœud hôte garde ses enfants. Le panneau lui-même a des
 * hooks, on ne le rend donc pas — seulement le dashboard, qui n'en a aucun.
 */
function renderTree(node) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) return flat(node.map(renderTree).filter((child) => child !== null))
  if (typeof node !== 'object') return node

  if (node.fn) {
    const children = node.children.length === 1 ? node.children[0] : node.children
    return renderTree(node.fn({ ...node.props, children }))
  }

  return {
    type: node.type,
    props: node.props ?? {},
    children: flat(node.children.map(renderTree).filter((child) => child !== null)),
  }
}

/** Tout le texte rendu sous un nœud, dans l'ordre du document. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** Tous les nœuds d'un type donné, en profondeur d'abord. */
function findAll(node, type, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found)
    return found
  }
  if (node.type === type) found.push(node)
  findAll(node.children, type, found)
  return found
}

/** Le dashboard que le panneau rend, résolu en arbre ordinaire. */
function renderDashboard(initialStates, props = {}) {
  const { api, ctx, registered, setters } = charger(undefined, initialStates)
  api.apply(ctx)

  const view = findAll(registered.main({}), 'DashboardView')[0]
  assert.ok(view, 'le panneau doit rendre DashboardView')

  return { view, tree: renderTree({ ...view, props: { ...view.props, ...props } }), setters }
}

test('le bundle charge et déclare ses slots', () => {
  const { api, ctx, registered, id } = charger()
  assert.equal(id, '@daedalforge/dsh-missions')
  assert.deepEqual(api.inject, ['slots'])

  api.apply(ctx)

  assert.deepEqual(Object.keys(registered).sort(), ['main', 'sidebar.panellist'])
})

test('chaque composant rend sans lever, même sans service uiWorkspace', () => {
  const { api, ctx, registered } = charger()
  api.apply(ctx)

  for (const [name, component] of Object.entries(registered)) {
    assert.doesNotThrow(() => component({}), `rendu de ${name}`)
  }
})

test('le volet déclare la branche et la base, et bloque sans elles', () => {
  // Le volet n'est pas enregistré comme slot : on vérifie le bundle construit,
  // seule preuve que le formulaire et l'aide de vue ont bien été inlinés.
  assert.match(SOURCE, /const DECLARE_URL = 'missions\/api\/branches'/)
  assert.match(SOURCE, /className: 'missions-declare-label' \}, 'Branch'/)
  assert.match(SOURCE, /className: 'missions-declare-label' \}, 'Base'/)
  assert.match(SOURCE, /key: mission\.key, branch: branch\.trim\(\), base: base\.trim\(\)/)
  assert.match(SOURCE, /disabled: saving \|\| !dirty/)
  // Le champ est prérempli avec le nom conventionnel tant que rien n'est
  // déclaré ; une valeur déclarée reste prioritaire et rien n'est écrit avant
  // Save.
  assert.match(SOURCE, /React\.useState\(branchFieldValue\(mission\)\)/)
  assert.match(SOURCE, /function branchFieldValue\(mission = \{\}\)/)
  assert.match(SOURCE, /function suggestBranch\(mission = \{\}\)/)
  assert.match(SOURCE, /onSaved: applyDeclaration/)
  // Le volet est remonté quand la mission change : sinon Save écrirait les
  // valeurs de la mission précédente dans la suivante.
  assert.match(SOURCE, /h\(MissionDrawer, \{ key: selected\.key, mission: selected/)
  assert.match(SOURCE, /local only, nothing to commit/)
  // Un conflit d'états bloque la session : le volet doit le dire, et la note ne
  // renvoie plus au dossier pour un état qu'aucun formulaire ne corrige.
  assert.match(SOURCE, /state labels conflict/)
  assert.match(SOURCE, /Session blocked: \$\{blocker\}\./)
  assert.match(SOURCE, /role: declareNote\.error \? 'alert' : 'status'/)
  assert.match(SOURCE, /onSaved\?\.\(data\)/)
  assert.match(SOURCE, /function executionBlocker\(mission = \{\}\)/)
  assert.match(SOURCE, /Session blocked: \$\{blocker\}/)
  assert.match(SOURCE, /disabled: blocker !== null/)
  assert.match(SOURCE, /'aria-describedby': blocker \? 'missions-session-blocked' : undefined/)
})

test('le prompt de session reprend la branche et la base déclarées', () => {
  assert.match(SOURCE, /Branche : \$\{mission\.branch\} ; base : \$\{mission\.base\}\./)
})

test('le prompt de session interdit le merge et l’écriture sur main', () => {
  assert.match(SOURCE, /Garde-fou : tu ne merges jamais la PR/)
  assert.match(SOURCE, /tu n'écris jamais sur main/)
  assert.match(SOURCE, /les gestes du demandeur/)
})

test('le prompt de session nomme l’étape en cours, pas la chaîne entière', () => {
  assert.match(SOURCE, /const step = missionStep\(mission\)/)
  assert.match(SOURCE, /Étape en cours : \$\{step\} \(statut \$\{mission\.state\}\)/)
  assert.match(SOURCE, /Chaque étape se joue dans une nouvelle session/)
  // La chaîne complète invitait une session à courir plusieurs étapes.
  assert.doesNotMatch(SOURCE, /Suis le workflow du workspace/)
})

test('le bouton de session nomme l’étape courante', () => {
  assert.match(SOURCE, /const sessionLabel = step \? `Start a session — \$\{step\}` : 'Start a session'/)
  assert.match(SOURCE, /\}, sessionLabel\)/)
})

test('le volet lit le journal de mission, sans dépendance de rendu', () => {
  assert.match(SOURCE, /const JOURNAL_URL = 'missions\/api\/journal'/)
  // L'onglet s'appelle Journal : la section ne répète pas le titre, elle garde
  // le chemin et la date.
  assert.match(SOURCE, /className: 'missions-journal-meta' \}/)
  assert.match(SOURCE, /className: 'missions-journal-text', tabIndex: 0 \}, journal\.source/)
  assert.match(SOURCE, /No journal yet — it is written at cadrage\./)
  assert.match(SOURCE, /mission\.folder \? `missions\/\$\{mission\.folder\}\/journal\.md`/)
  assert.match(SOURCE, /Journal de mission : \$\{journalPath\}/)
  // Le journal n'est pas dans la liste : le volet le demande à l'ouverture.
  assert.match(SOURCE, /fetch\(`\$\{JOURNAL_URL\}\?key=\$\{encodeURIComponent\(mission\.key\)\}`/)
})

test('le volet découpe le détail en trois onglets', () => {
  assert.match(SOURCE, /const DRAWER_TABS = \[\n\s+\{ id: 'details', label: 'Details' \},\n\s+\{ id: 'journal', label: 'Journal' \},\n\s+\{ id: 'checklist', label: 'Checklist' \},\n\s+\]/)
  // Le volet s'ouvre sur Details : c'est l'onglet qui porte l'existant.
  assert.match(SOURCE, /const \[section, setSection\] = React\.useState\('details'\)/)
  assert.match(SOURCE, /className: 'missions-drawer-tabs', role: 'tablist'/)
  assert.match(SOURCE, /'aria-selected': section === entry\.id \? 'true' : 'false'/)
  assert.match(SOURCE, /'aria-controls': section === entry\.id \? 'missions-drawer-panel' : undefined/)
  assert.match(SOURCE, /onClick: \(\) => setSection\(entry\.id\)/)
  assert.match(SOURCE, /role: 'tabpanel'/)
  assert.match(SOURCE, /'aria-labelledby': `missions-drawer-tab-\$\{section\}`/)
  // Un seul panneau, un id stable : aucun aria-controls ne pointe dans le vide.
  assert.match(SOURCE, /id: 'missions-drawer-panel'/)
  // Journal et checklist défilent : la zone elle-même prend le focus clavier.
  assert.match(SOURCE, /h\('pre', \{ className: 'missions-journal-text', tabIndex: 0 \}/)
  // Les deux thèmes stylent la barre : le défaut et le manga.
  assert.match(SOURCE, /\.missions-drawer-tabs \{/)
  assert.match(SOURCE, /\.missions-panel\[data-theme="manga"\] \.missions-drawer-tabs \{/)
  // Le panneau est déjà séparé par le trait des onglets : aucun bloc ne
  // rajoute une bordure haute, propriétés comprises.
  assert.match(SOURCE, /\.missions-drawer-panel \.missions-props, \.missions-drawer-panel \.missions-journal, \.missions-drawer-panel \.missions-checklist \{ padding-top: 0; border-top: 0; \}/)
  assert.match(SOURCE, /\.missions-panel\[data-theme="manga"\] \.missions-drawer-panel \.missions-props \{ border-top: 0; \}/)
  // Un seul bloc à la fois : le panneau ne rend que la section active.
  assert.match(SOURCE, /const panelContent = section === 'journal' \? journalPanel : section === 'checklist' \? checklistPanel : detailsPanel/)
})

test('le volet range l’existant dans Details, chaque fichier dans son onglet', () => {
  const details = SOURCE.indexOf('const detailsPanel')
  const journal = SOURCE.indexOf('const journalPanel')
  const checklist = SOURCE.indexOf('const checklistPanel')
  const actions = SOURCE.indexOf("className: 'missions-drawer-actions'")
  assert.ok(details > 0 && details < journal && journal < checklist, 'ordre des panneaux')
  // Propriétés et déclaration sont dans Details, pas dans les onglets.
  assert.ok(SOURCE.indexOf("className: 'missions-props'") > details)
  assert.ok(SOURCE.indexOf("className: 'missions-props'") < journal)
  assert.ok(SOURCE.indexOf("className: 'missions-declare'") > details)
  assert.ok(SOURCE.indexOf("className: 'missions-declare'") < journal)
  // Le journal n'est rendu que par son panneau.
  assert.ok(SOURCE.indexOf("className: 'missions-journal-text'") > journal)
  assert.ok(SOURCE.indexOf("className: 'missions-journal-text'") < checklist)
  // La checklist n'est rendue que par le sien.
  assert.ok(SOURCE.indexOf('h(ChecklistBlocks, { blocks: checklistView.blocks })') > checklist)
  // Les actions restent hors du panneau : accessibles depuis les trois onglets.
  assert.ok(actions > checklist)
})

test('le journal et la checklist prennent la hauteur restante du volet', () => {
  // Le modificateur n'est posé que hors Details : le volet garde son défilement
  // pour les propriétés et les champs.
  assert.match(SOURCE, /const filling = section !== 'details'/)
  assert.match(SOURCE, /className: filling \? 'missions-drawer missions-drawer--fill' : 'missions-drawer'/)
  // La hauteur se propage du panneau à la section puis à la zone.
  assert.match(SOURCE, /\.missions-drawer--fill \.missions-drawer-panel \{ flex: 1; min-height: 120px; \}/)
  // Sans align-content, la grille étire ses lignes sur toute la hauteur.
  assert.match(SOURCE, /\.missions-drawer--fill \.missions-checklist-body \{ align-content: start; \}/)
  // Les zones défilantes prennent le focus : c'est elles que le clavier fait défiler.
  assert.match(SOURCE, /h\('pre', \{ className: 'missions-journal-text', tabIndex: 0 \}/)
  assert.match(SOURCE, /h\('div', \{ className: 'missions-checklist-body', tabIndex: 0 \}/)
  assert.match(SOURCE, /\.missions-drawer--fill \.missions-drawer-panel > section \{ display: flex; flex-direction: column; flex: 1; min-height: 0; \}/)
  // Plus de hauteur fixe héritée : la zone prend la place disponible.
  assert.match(SOURCE, /\.missions-drawer--fill \.missions-journal-text, \.missions-drawer--fill \.missions-checklist-body \{ max-height: none; flex: 1; min-height: 0; \}/)
})

test('le bundle ne propose plus l’état done', () => {
  assert.match(SOURCE, /STATE_FILTER_ORDER = \['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod'\]/)
  assert.doesNotMatch(SOURCE, /done: 'done'/)
})

test('les erreurs du bandeau ont une clé unique par ligne', () => {
  assert.ok(SOURCE.includes('key: `${error.project}-${index}`'))
})

test('le thème Naruto rend le bandeau et les images embarquées', () => {
  const { api, ctx, registered } = charger({ getItem: () => 'manga', setItem: () => {} })
  api.apply(ctx)
  const tree = registered.main({})
  const flat = JSON.stringify(tree)
  assert.match(flat, /"data-theme":"manga"/)
  assert.match(flat, /missions-hero/)
  assert.match(flat, /data:image\/webp;base64,/)
  assert.match(SOURCE, /Naruto theme/)
  assert.match(flat, /missions-drawer--empty/)
  assert.doesNotMatch(SOURCE, /missions-drawer--empty \{ display: none; \}/)
  assert.match(SOURCE, /\[data-theme="manga"\] \.missions-card:hover \{[^}]*background: color-mix/)
  assert.doesNotMatch(SOURCE, /\[data-theme="manga"\] \.missions-card:hover \{[^}]*translateY/)
})

test('le compteur de l’onglet prend l’anneau des groupes, pas une pastille pâle', () => {
  const ring = regle('.missions-panel[data-theme="manga"] .missions-tab-count')
  // Même dessin que `.missions-group-ring` : le trait, la taille, le chiffre.
  assert.match(ring, /display: grid/)
  assert.match(ring, /width: 24px/)
  assert.match(ring, /height: 24px/)
  assert.match(ring, /border: 1\.5px solid var\(--mm-ink\)/)
  assert.match(ring, /border-radius: 50%/)
  assert.match(ring, /font: 700 11px\/1 var\(--mm-mono\)/)
  // Un compteur d'onglet n'a pas d'état : l'accent du panneau remplace la
  // teinte d'état que l'anneau des groupes reçoit de son groupe.
  assert.match(ring, /background: var\(--mm-orange\)/)
  // La pastille du thème par défaut ne bouge pas.
  assert.match(regle('.missions-tab-count'), /border-radius: 9px/)
  // En thème sombre, le chiffre reste en encre sombre sur l'orange, comme
  // l'anneau et la marque du titre : c'est le bloc, pas seulement l'entrée de
  // la liste, qui doit porter la couleur.
  for (const prefix of [':root[data-ds-dark-theme]', 'body[data-ds-dark-theme]']) {
    const at = SOURCE.indexOf(`${prefix} .missions-panel[data-theme="manga"] .missions-tab-count,`)
    assert.ok(at >= 0, `sélecteur sombre manquant : ${prefix}`)
    assert.match(SOURCE.slice(at, SOURCE.indexOf('}', at)), /color: #2c2621/)
  }
})

test('le thème Naruto finit le formulaire de branche, le filtre et la liste vide', () => {
  const manga = (name) => regle(`.missions-panel[data-theme="manga"] ${name}`)

  // Le formulaire du volet suivait le thème par défaut : champs blancs, bordure
  // grise. Il prend le cadre encre, le fond page-2 et l'ombre papier.
  for (const field of ['.missions-declare-input', '.missions-declare-save']) {
    assert.match(manga(field), /border: 1\.5px solid var\(--mm-ink\)/)
    assert.match(manga(field), /background: var\(--mm-page-2\)/)
    assert.match(manga(field), /box-shadow: [12]px [12]px 0 var\(--mm-shadow\)/)
  }
  assert.match(manga('.missions-declare'), /border-top: 1\.5px solid var\(--mm-ink\)/)
  // Les cases du filtre Statut prennent les teintes du thème ; la palette
  // GitHub ne reste que sur le thème par défaut.
  const accents = [
    ['in-review', 'var(--mm-sky-deep)'],
    ['ready-for-prod', 'var(--mm-teal-deep)'],
    ['in-progress', '#8a6a1f'],
    ['ready', 'var(--mm-sage-deep)'],
    ['to-refine', 'var(--mm-lilac-deep)'],
  ]
  for (const [state, color] of accents) {
    assert.ok(
      manga(`.missions-status-option[data-state="${state}"] input`).includes(`accent-color: ${color};`),
      `accent manga manquant pour ${state}`,
    )
  }
  assert.match(regle('.missions-status-option[data-state="to-refine"] input'), /accent-color: #8250df/)
  // La liste vide n'est plus un texte gris nu : un bandeau pointillé.
  assert.match(manga('.missions-empty'), /border: 1\.5px dashed var\(--mm-line-strong\)/)
  assert.match(manga('.missions-empty'), /background: var\(--mm-page-2\)/)
  // L'aide d'erreur repasse au corail clair en thème sombre : le corail profond
  // du thème clair tomberait à 2,6:1 sur le fond sombre.
  const darkError = SOURCE.slice(SOURCE.indexOf(':root[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-declare-note--error,'))
  assert.match(darkError.slice(0, darkError.indexOf('}')), /color: var\(--mm-coral\)/)
})

/** Une ligne complète, telle que `missions/api/list` la renvoie. */
const MISSION = {
  key: 'MIS-42', project: 'missions', projectName: 'Missions', title: 'Reload onglet mission',
  type: 'feat', state: 'in-progress', priority: 'high', epic: null, points: null,
  updated: '2026-11-11T10:00:00Z', folder: '/w/missions/MIS-42', branch: 'fix/mis-42', base: 'main',
}

test('chaque carte porte un repère de priorité qui se lit sans la couleur', () => {
  // Cinq cartes, un niveau chacune, plus l'absence : le repère doit exister
  // partout, et le niveau doit se lire dans la forme (barres allumées), pas
  // seulement dans la couleur.
  const priorities = ['urgent', 'high', 'normal', 'low', null]
  const missions = priorities.map((priority, index) => ({
    ...MISSION, key: `MIS-6${index}`, priority, updatedAt: MISSION.updated,
  }))
  const view = { loading: false, missions, errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
  api.apply(ctx)

  const list = findAll(registered.main({}), 'MissionsView')[0]
  assert.ok(list, 'le panneau doit rendre MissionsView')
  const tree = renderTree({ ...list, props: list.props })
  const marks = findAll(tree, 'span').filter((node) => node.props.className === 'missions-prio')

  assert.equal(marks.length, 5)
  assert.deepEqual(marks.map((mark) => mark.props['data-priority']), ['urgent', 'high', 'normal', 'low', 'none'])
  assert.deepEqual(marks.map((mark) => mark.props['aria-label']), [
    'Priority: Urgent', 'Priority: High', 'Priority: Normal', 'Priority: Low', 'No priority',
  ])

  // Le nombre de barres allumées porte le niveau : 3 pour high, 2 pour normal,
  // 1 pour low ; urgent et l'absence n'ont pas de barres.
  const lit = (mark) => findAll(mark, 'rect').filter((rect) => rect.props.className === 'prio-bar').length
  assert.deepEqual(marks.map(lit), [0, 3, 2, 1, 0])
  // Urgent : un carré et un point d'exclamation.
  assert.equal(findAll(marks[0], 'rect').filter((rect) => rect.props.className === 'prio-chip').length, 1)
  assert.equal(findAll(marks[0], 'rect').filter((rect) => rect.props.className === 'prio-mark').length, 2)
  // Sans priorité : un carré pointillé, jamais un vide.
  assert.equal(findAll(marks[4], 'rect').filter((rect) => rect.props.className === 'prio-none').length, 1)

  // Chaque repère est annoncé : rôle, nom accessible et infobulle.
  assert.deepEqual(marks.map((mark) => mark.props.role), ['img', 'img', 'img', 'img', 'img'])
  assert.deepEqual(marks.map((mark) => mark.props.title), marks.map((mark) => mark.props['aria-label']))

  // Les barres éteintes restent des barres (elles gardent leur classe) et la
  // hauteur croît de gauche à droite : le niveau se lit même sans couleur.
  const bars = (mark) => findAll(mark, 'rect').filter((rect) => String(rect.props.className).startsWith('prio-bar'))
  assert.deepEqual(bars(marks[3]).map((rect) => rect.props.className), [
    'prio-bar', 'prio-bar prio-bar--off', 'prio-bar prio-bar--off',
  ])
  assert.deepEqual(bars(marks[1]).map((rect) => rect.props.height), [4.5, 7.5, 10.5])

  // Le CSS porte le rendu : éteintes discrètes, pointillé lisible, orange de
  // manga contrasté en thème sombre, et aucun voile sur l'absence.
  assert.match(SOURCE, /\.missions-prio \.prio-bar--off \{ opacity: \.22; \}/)
  assert.ok(SOURCE.includes('.prio-none { fill: none; stroke: currentColor; stroke-width: 1.25; stroke-dasharray: 2.4 2; }'))
  assert.ok(SOURCE.includes('body[data-ds-dark-theme] .missions-panel[data-theme="manga"] .missions-prio[data-priority="high"] { color: var(--mm-orange); }'))
  assert.ok(!SOURCE.includes('.missions-prio[data-priority="none"] { opacity: .55; }'))
  // Le remplissage est la seule chose qui rend les barres visibles : sans lui
  // elles prennent le noir par défaut et disparaissent en thème sombre.
  assert.ok(SOURCE.includes('.missions-prio .prio-bar, .missions-prio .prio-mark { fill: currentColor; }'))
})

test('le montage lit le cache ; seuls le bouton et le tick forcent', () => {
  // Le panneau est remonté à chaque changement de vue : forcer au montage
  // paierait tout le trajet tracker à chaque retour sur Missions. Le cache
  // serveur de 60 s est lu ; le bouton Refresh et le tick de 60 s forcent.
  assert.match(SOURCE, /const load = React\.useCallback\(\(\{ silent = false, refresh = false \} = \{\}\) => \{/)
  assert.match(SOURCE, /const url = refresh \? `\$\{LIST_URL\}\?refresh=1` : LIST_URL/)
  // Le montage appelle load() sans option ; le tick et le bouton forcent.
  assert.match(SOURCE, /React\.useEffect\(\(\) => \{\n\s+load\(\)\n\s+const timer = setInterval/)
  assert.match(SOURCE, /load\(\{ silent: true, refresh: true \}\)/)
  assert.match(SOURCE, /onClick: \(\) => load\(\{ refresh: true \}\)/)
  // Aucun autre appel ne force : le seul refresh=1 est derrière `refresh`.
  assert.equal((SOURCE.match(/\?refresh=1/g) ?? []).length, 1)
})

test('un refresh affiche le loader de la vue, même avec des missions chargées', () => {
  // L'état de départ reproduit un clic sur Refresh : des missions déjà là et un
  // chargement en cours. Le loader remplace alors la liste, pas seulement le
  // premier montage.
  const view = { loading: true, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  // Le refresh est lancé depuis l'onglet Missions : c'est la vue qui recharge.
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
  api.apply(ctx)

  const flat = JSON.stringify(registered.main({}))
  // La liste est remplacée par le loader de la vue, malgré les missions en état.
  assert.match(flat, /"type":"PanelLoader"/)
  assert.doesNotMatch(flat, /"type":"MissionsView"/)
  // Le bouton reste rendu, désactivé pendant le chargement, mais sans spinner.
  assert.match(flat, /"aria-busy":"true"/)
  assert.match(flat, /"disabled":true/)
  assert.doesNotMatch(flat, /missions-btn-spinner/)
})

test('le montage initial ouvre sur le dashboard, en chargement, et le polling reste silencieux', () => {
  const { api, ctx, registered } = charger()
  api.apply(ctx)
  const flat = JSON.stringify(registered.main({}))
  // Sans session, le panneau atterrit sur le dashboard : c'est lui qui porte le
  // chargement, pas le loader de la liste.
  assert.match(flat, /"type":"DashboardView"/)
  assert.match(flat, /"loading":true/)
  assert.doesNotMatch(flat, /"type":"PanelLoader"/)
  // Seul un chargement non silencieux lève l'état de chargement : le timer de
  // 60 s recharge sans vider la liste ni afficher le loader.
  assert.match(SOURCE, /if \(!silent\) setView/)
  assert.match(SOURCE, /load\(\{ silent: true, refresh: true \}\)/)
  assert.doesNotMatch(SOURCE, /missions-btn-spinner/)
})

test('le loader ne déborde pas sur l’onglet Dashboard', () => {
  // Un refresh lancé depuis Missions ne doit pas remplacer le Dashboard par le
  // loader si l'on change d'onglet pendant la requête : le Dashboard est hors
  // périmètre et reste rendu tel quel.
  const view = { loading: true, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'dashboard'])
  api.apply(ctx)

  const flat = JSON.stringify(registered.main({}))
  assert.match(flat, /"type":"DashboardView"/)
  assert.doesNotMatch(flat, /"type":"PanelLoader"/)
  assert.doesNotMatch(flat, /missions-loader/)
})

/**
 * Le jeu de données du dashboard, à dates fixes : sans elles, un âge dépendrait
 * du jour où la suite tourne.
 */
const DASH_NOW = Date.parse('2026-11-11T12:00:00Z')
const DASH_MISSIONS = [
  { key: 'MIS-1', title: 'reload onglet mission', state: 'in-review', type: 'bug', priority: 'urgent', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-02T12:00:00Z' },
  { key: 'MIS-2', title: 'thème manga', state: 'ready', type: 'story', priority: 'high', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-10T12:00:00Z' },
  { key: 'MIS-3', title: 'export CSV du planning', state: 'in-progress', type: 'story', priority: 'urgent', project: 'socle', projectName: 'Socle', updatedAt: '2026-10-31T12:00:00Z', points: 5 },
  { key: 'MIS-4', title: 'densité compacte', state: 'in-progress', type: 'bug', priority: 'normal', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-07T12:00:00Z', points: 3 },
  { key: 'MIS-5', title: 'statut non mappé', state: null, type: 'story', priority: 'high', project: 'socle', projectName: 'Socle', updatedAt: '2026-11-05T12:00:00Z' },
  // Une mission close ne doit ni s'afficher ni compter : le tracker ne devrait
  // pas l'envoyer, mais la section ne dépend pas de cette promesse. Elle reste
  // un bug de priorité haute, pour que les widgets aient à l'exclure.
  { key: 'MIS-6', title: 'mission close', state: 'done', type: 'bug', priority: 'high', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-09T12:00:00Z' },
]

function dashboardView(missions, loading = false) {
  return { loading, missions, errors: [], workspaceId: 'w', workspaceRoot: '/w' }
}

/**
 * Un `sessionStorage` en mémoire : l'onglet et la barre y écrivent, comme dans
 * la fenêtre, sans toucher au global de Node.
 */
function memorySession(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    entries: map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/** Le panneau monté tel quel, avec sa session et ses états initiaux. */
function monter(initialStates, session) {
  const { api, ctx, registered } = charger(undefined, initialStates, session)
  api.apply(ctx)
  return registered.main({})
}

test('sans onglet retenu, le panneau ouvre sur le dashboard', () => {
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())

  assert.equal(findAll(tree, 'DashboardView').length, 1, 'le panneau doit atterrir sur le dashboard')
  assert.equal(findAll(tree, 'MissionsView').length, 0)
})

test("l'onglet rangé par la session est rouvert au montage", () => {
  // « missions.tab » vient de `TAB_KEY` : la clé est le contrat, pas un détail.
  const session = memorySession({ 'missions.tab': 'missions' })
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)

  assert.equal(findAll(tree, 'MissionsView').length, 1, 'le panneau doit rouvrir sur la liste')
  assert.equal(findAll(tree, 'DashboardView').length, 0)
})

/** L'effet qui range l'onglet dans la session, retrouvé par ce qu'il appelle. */
function tabEffect(effects) {
  const found = effects.find(({ fn }) => String(fn).includes('writeTab('))
  assert.ok(found, "le panneau doit persister l'onglet, pas seulement le lire")
  return found
}

test("le panneau range l'onglet ouvert dans la session", () => {
  const session = memorySession()
  const { api, ctx, registered, effects } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions'], session)
  api.apply(ctx)
  registered.main({})

  // L'onglet vaut « missions » : l'effet doit l'écrire, pas le laisser filer.
  tabEffect(effects).fn()
  assert.equal(session.entries.get('missions.tab'), 'missions')
  // L'effet de l'onglet n'écrit que sa clé : la barre garde la sienne.
  assert.equal(session.entries.has('missions.filters'), false)
})

test("revenir sur le dashboard retire la clé de l'onglet", () => {
  const session = memorySession({ 'missions.tab': 'missions' })
  const { api, ctx, registered, effects } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], session)
  api.apply(ctx)
  registered.main({})

  tabEffect(effects).fn()
  assert.equal(session.entries.has('missions.tab'), false, 'le repos ne laisse pas de clé derrière lui')
})

test("un onglet rangé qui n'existe plus retombe sur le dashboard", () => {
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'epics' }))

  assert.equal(findAll(tree, 'DashboardView').length, 1)
})

test('le dashboard rend les quatre cartes, dans l’ordre', () => {
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })

  const cards = findAll(tree, 'article')
  assert.equal(cards.length, 4, 'quatre cartes : les bugs, les stories, l’en-cours, la file')

  const [bugs, stories, flight, queue] = cards
  assert.match(textOf(bugs), /Bugs/, 'les bugs passent en premier')
  assert.match(textOf(stories), /High-priority stories/)
  assert.match(textOf(flight), /In flight/)
  assert.match(textOf(queue), /Needs you/)

  // Les deux nouveaux widgets prennent les missions que la file et l'en-cours
  // laissent de côté, et les trient comme eux : la plus ancienne d'abord.
  const keysOf = (card) => findAll(card, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf)
  assert.deepEqual(keysOf(bugs), ['MIS-1', 'MIS-4'], 'les bugs non résolus, sans le bug clos')
  assert.deepEqual(keysOf(stories), ['MIS-3', 'MIS-5', 'MIS-2'], 'urgent et high, tous états, la plus ancienne d’abord')
  assert.equal(findAll(bugs, 'span').filter((span) => span.props.className === 'missions-rowverb').length, 0)
  assert.equal(findAll(stories, 'span').filter((span) => span.props.className === 'missions-rowverb').length, 0)

  // La file : un rang par état (in-review, ready), puis la mission sans état
  // connu en dernier — celle qui demande un arbitrage.
  const queueRows = findAll(queue, 'button').filter((button) => button.props['data-state'] !== undefined)
  assert.deepEqual(
    queueRows.map((button) => button.props['data-state']),
    ['in-review', 'ready', null],
  )
  assert.deepEqual(
    findAll(queue, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf),
    ['MIS-1', 'MIS-2', 'MIS-5'],
  )

  // Les verbes ne vivent que dans la file, et suivent l'état.
  const verbs = findAll(queue, 'span').filter((span) => span.props.className === 'missions-rowverb').map(textOf)
  assert.deepEqual(verbs, ['Review→', 'Start→', 'Open→'])

  // Le nom accessible porte le verbe affiché, pas seulement la clé et l'âge.
  assert.match(queueRows[1].props['aria-label'], /thème manga, 1 d, Start$/)
  assert.equal(findAll(flight, 'span').filter((span) => span.props.className === 'missions-rowverb').length, 0)

  // L'en-cours ne garde que les missions in-progress, la plus ancienne d'abord.
  assert.deepEqual(
    findAll(flight, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf),
    ['MIS-3', 'MIS-4'],
  )

  // Le pied additionne les points et reprend l'âge de la plus ancienne.
  assert.match(textOf(findAll(flight, 'p').at(-1)), /8 pts in flight · oldest 11 d/)
})

test('la bande résume le périmètre et compte les missions qu’elle montre', () => {
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })

  // 5 missions ouvertes, 3 dans la file, 2 projets. Les widgets se recoupent :
  // dix lignes rendues, mais cinq missions distinctes — le périmètre compte les
  // missions, pas les occurrences.
  const rendered = findAll(tree, 'button').filter((button) => button.props['data-state'] !== undefined)
  const scope = findAll(tree, 'span').find((span) => span.props.className === 'missions-sect-scope')
  assert.equal(textOf(scope), '3 need you · 5 open · 2 projects')
  assert.equal(rendered.length, 10)
})

test('cliquer une ligne ouvre la mission dans l’onglet Missions', () => {
  const { tree, setters } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })

  const row = findAll(tree, 'button').find((button) => textOf(button).includes('MIS-2'))
  row.props.onClick()

  // Le panneau reçoit la mission puis bascule d'onglet : le dashboard choisit ce
  // que l'onglet montre, il ne route pas.
  assert.ok(setters.some((next) => next === 'missions'), 'le clic doit basculer sur l’onglet Missions')
  assert.ok(setters.some((next) => next && next.key === 'MIS-2'), 'le clic doit sélectionner la mission')
})

test('la sortie « Open Missions » ouvre l’onglet sans sélection', () => {
  const { tree, setters } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })

  const link = findAll(tree, 'button').find((button) => textOf(button).includes('Open Missions'))
  link.props.onClick()

  assert.ok(setters.some((next) => next === 'missions'))
  assert.ok(setters.some((next) => next === null), 'la sortie ne garde aucune mission sélectionnée')
})

test('une carte plafonne à dix lignes, compte le tout et lie le reste', () => {
  // 14 bugs en file, 12 stories hautes en vol : les quatre cartes débordent.
  const missions = []
  for (let index = 0; index < 14; index += 1) {
    // Une date distincte par rang : la file trie la plus ancienne d'abord, et
    // l'ordre attendu ne doit pas dépendre du départage par clé.
    missions.push({ key: `Q-${index}`, title: `file ${index}`, state: 'ready', type: 'bug', priority: 'normal', project: 'missions', projectName: 'Missions', updatedAt: new Date(Date.UTC(2026, 10, 1) + index * 3600000).toISOString() })
  }
  for (let index = 0; index < 12; index += 1) {
    missions.push({ key: `F-${index}`, title: `vol ${index}`, state: 'in-progress', type: 'story', priority: 'high', project: 'missions', projectName: 'Missions', updatedAt: new Date(Date.UTC(2026, 9, 1) + index * 3600000).toISOString(), points: 2 })
  }
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(missions), 'dashboard'], { now: DASH_NOW })
  const [bugs, stories, flight, queue] = findAll(tree, 'article')

  const rows = (card) => findAll(card, 'button').filter((button) => button.props['data-state'] !== undefined)
  for (const [name, card] of [['file', queue], ['en-cours', flight], ['bugs', bugs], ['stories', stories]]) {
    assert.equal(rows(card).length, 10, `${name} s’arrête à dix lignes`)
  }
  const keys = (card) => findAll(card, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf)
  assert.deepEqual(keys(queue), ['Q-0', 'Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5', 'Q-6', 'Q-7', 'Q-8', 'Q-9'])
  assert.deepEqual(keys(flight), ['F-0', 'F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8', 'F-9'])
  assert.deepEqual(keys(bugs), ['Q-0', 'Q-1', 'Q-2', 'Q-3', 'Q-4', 'Q-5', 'Q-6', 'Q-7', 'Q-8', 'Q-9'])
  assert.deepEqual(keys(stories), ['F-0', 'F-1', 'F-2', 'F-3', 'F-4', 'F-5', 'F-6', 'F-7', 'F-8', 'F-9'])

  // Le compte de l'en-tête reste le total : le plafond ne réécrit pas la donnée.
  const meta = (card) => textOf(findAll(card, 'span').find((span) => span.props.className === 'missions-dash-card-meta'))
  assert.equal(meta(queue), '14')
  assert.equal(meta(flight), '12')
  assert.equal(meta(bugs), '14')
  assert.equal(meta(stories), '12')

  // Le pied dit ce qui reste, puis le lien porte le total de la liste.
  const foot = (card) => textOf(findAll(card, 'p').at(-1))
  assert.match(foot(queue), /4 more waiting/)
  assert.match(foot(queue), /View all 14/)
  assert.match(foot(flight), /24 pts in flight/)
  assert.match(foot(flight), /View all 12/)
  assert.match(foot(bugs), /4 more bugs/)
  assert.match(foot(bugs), /View all 14/)
  assert.match(foot(stories), /2 more stories/)
  assert.match(foot(stories), /View all 12/)
})

test('une carte qui tient en dix lignes n’a ni compte ni lien', () => {
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })
  const [, , flight, queue] = findAll(tree, 'article')

  // Rien à annoncer, rien à ouvrir : la file n'a même pas de pied.
  assert.equal(findAll(queue, 'p').length, 1, 'seul le sous-titre reste')
  assert.equal(findAll(tree, 'button').filter((button) => textOf(button).includes('View all')).length, 0)
  // L'en-cours garde son pied — les points et l'âge — mais sans lien.
  assert.match(textOf(findAll(flight, 'p').at(-1)), /8 pts in flight · oldest 11 d/)
})

test('dix lignes pile : la carte est pleine, mais complète', () => {
  // Le plafond se joue à une ligne près : dix tient, onze déborde. Un `>=`
  // dans `widgetFoot` ne se verrait que sur ce cas-là.
  const missions = []
  for (let index = 0; index < 10; index += 1) {
    missions.push({
      key: `T-${index}`,
      title: `en cours ${index}`,
      state: 'in-progress',
      project: 'missions',
      projectName: 'Missions',
      points: 1,
      updatedAt: new Date(Date.UTC(2026, 10, 1) + index * 3600000).toISOString(),
    })
  }
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(missions), 'dashboard'], { now: DASH_NOW })
  const flight = findAll(tree, 'article').find((article) => textOf(findAll(article, 'h3')[0]) === 'In flight')
  assert.ok(flight, 'la carte In flight doit être rendue')
  const rows = findAll(flight, 'button').filter((button) => button.props['data-state'] === 'in-progress')

  assert.equal(rows.length, 10, 'dix lignes rendues')
  const links = findAll(flight, 'button').filter((button) => textOf(button).includes('View all'))
  assert.equal(links.length, 0, 'aucun lien : la carte ne cache rien')
  // Les points restent comptés sur la liste entière ; aucun reste à annoncer.
  const foot = textOf(findAll(flight, 'p').at(-1))
  assert.match(foot, /10 pts in flight/)
  assert.doesNotMatch(foot, /more/)
})

test('le lien du widget ouvre la liste sur les états de la carte', () => {
  const missions = []
  for (let index = 0; index < 11; index += 1) {
    // Une date distincte par rang : la file trie la plus ancienne d'abord, et
    // l'ordre attendu ne doit pas dépendre du départage par clé.
    missions.push({ key: `Q-${index}`, title: `file ${index}`, state: 'ready', project: 'missions', projectName: 'Missions', updatedAt: new Date(Date.UTC(2026, 10, 1) + index * 3600000).toISOString() })
  }
  // Une mission sans état connu : la file la montre, la liste doit la retrouver.
  missions.push({ key: 'Q-x', title: 'sans état', state: null, project: 'missions', projectName: 'Missions', updatedAt: '2026-11-02T12:00:00Z' })
  // Une mission prête pour la prod : elle ne demande rien, la file et le lien
  // l'ignorent — le total reste douze, pas treize.
  missions.push({ key: 'Q-p', title: 'prête pour la prod', state: 'ready-for-prod', project: 'missions', projectName: 'Missions', updatedAt: '2026-10-01T12:00:00Z' })
  const { tree, setters } = renderDashboard([EMPTY_BAR, dashboardView(missions), 'dashboard'], { now: DASH_NOW })

  const link = findAll(tree, 'button').find((button) => textOf(button).includes('View all 12'))
  assert.ok(link, 'la file doit lier ses douze lignes')
  link.props.onClick()

  const filters = setters.find((next) => next && typeof next === 'object' && Array.isArray(next.state))
  assert.deepEqual(filters.state, ['ready', 'unknown'], 'les états viennent de la carte, dans l’ordre du panneau')
  // La barre est remise à zéro : seul le statut reste, sinon le compte mentirait.
  assert.equal(filters.type, null)
  assert.equal(filters.priority, null)
  assert.equal(filters.epic, null)
  assert.equal(filters.project, null)
  assert.equal(filters.missing, null)
  assert.ok(setters.includes('missions'), 'le clic bascule sur l’onglet Missions')
  assert.ok(setters.includes(''), 'le clic efface la recherche')
})

test('les nouveaux widgets ouvrent la liste sur leur type et leur priorité', () => {
  const missions = []
  for (let index = 0; index < 12; index += 1) {
    missions.push({ key: `B-${index}`, title: `bug ${index}`, state: 'to-refine', type: 'bug', priority: 'normal', project: 'missions', projectName: 'Missions', updatedAt: new Date(Date.UTC(2026, 10, 1) + index * 3600000).toISOString() })
  }
  for (let index = 0; index < 12; index += 1) {
    missions.push({ key: `S-${index}`, title: `story ${index}`, state: 'ready', type: 'story', priority: index % 2 === 0 ? 'high' : 'urgent', project: 'missions', projectName: 'Missions', updatedAt: new Date(Date.UTC(2026, 9, 1) + index * 3600000).toISOString() })
  }
  const { tree, setters } = renderDashboard([EMPTY_BAR, dashboardView(missions), 'dashboard'], { now: DASH_NOW })
  const card = (title) => findAll(tree, 'article').find((article) => textOf(findAll(article, 'h3')[0]) === title)
  const clickAll = (article) => {
    const link = findAll(article, 'button').find((button) => textOf(button).includes('View all 12'))
    assert.ok(link, 'la carte doit lier ses douze lignes')
    link.props.onClick()
  }
  const empty = { type: null, state: null, epic: null, priority: null, project: null, missing: null }

  clickAll(card('Bugs'))
  assert.deepEqual(setters.find((next) => next && typeof next === 'object' && next.type === 'bug'), { ...empty, type: 'bug' })

  clickAll(card('High-priority stories'))
  assert.deepEqual(
    setters.find((next) => next && typeof next === 'object' && next.type === 'story'),
    { ...empty, type: 'story', priority: ['urgent', 'high'] },
    'la liste garde les deux niveaux dans la barre',
  )
  assert.ok(setters.includes('missions'), 'le clic bascule sur l’onglet Missions')
  assert.ok(setters.includes(''), 'le clic efface la recherche')
})

test('le statut montre « 2 selected » quand le panneau en porte deux', () => {
  const session = memorySession({ 'missions.tab': 'missions' })
  const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
  api.apply(ctx)
  const view = findAll(registered.main({}), 'MissionsView')[0]
  assert.ok(view, 'le panneau doit rendre la liste')

  // Rejouer la vue avec une barre à deux états : la session ne peut pas porter
  // une barre à plusieurs valeurs au montage, la vue se rend donc seule.
  const rerender = (filters) => renderTree({ type: 'MissionsView', fn: view.fn, props: { ...view.props, filters }, children: [] })
  const chip = (node) => findAll(node, 'button').find((button) => button.props.className === 'missions-select')

  const both = chip(rerender({ ...view.props.filters, state: ['ready', 'in-review'] }))
  assert.equal(both.props['data-active'], 'true')
  assert.equal(both.props['aria-expanded'], 'false', 'le menu reste fermé tant qu’on ne l’ouvre pas')
  assert.match(textOf(both), /Status2 selected/)

  // Un seul état garde son libellé, une majuscule en tête : le chip se lit seul.
  assert.match(textOf(chip(rerender({ ...view.props.filters, state: ['ready'] }))), /StatusReady/)
  // Aucun état : le chip retombe sur « All » et n'est plus actif.
  const none = chip(rerender({ ...view.props.filters, state: null }))
  assert.equal(none.props['data-active'], 'false')
  assert.match(textOf(none), /StatusAll/)
  // Le clic bascule bien l'ouverture : le menu est câblé, pas décoratif.
  both.props.onClick()
  assert.ok(setters.length > 0)
})

test('la priorité prend plusieurs valeurs et la barre les montre', () => {
  const session = memorySession({ 'missions.tab': 'missions' })
  const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
  api.apply(ctx)
  const view = findAll(registered.main({}), 'MissionsView')[0]
  assert.ok(view, 'le panneau doit rendre la liste')

  const rerender = (filters) => renderTree({ type: 'MissionsView', fn: view.fn, props: { ...view.props, filters }, children: [] })
  const chip = (node) => findAll(node, 'button').find((button) => button.props.className === 'missions-select' && textOf(button).startsWith('Priority'))

  // Le lien du widget transporte deux niveaux : la barre les compte et reste
  // active, au lieu de fondre les deux dans une valeur composée.
  const both = chip(rerender({ ...view.props.filters, priority: ['urgent', 'high'] }))
  assert.ok(both, 'la barre doit rendre le filtre Priorité')
  assert.equal(both.props['data-active'], 'true')
  assert.equal(both.props['aria-label'], 'Filter by priority (2 selected)')
  assert.match(textOf(both), /Priority2 selected/)

  // Un seul niveau garde son libellé ; aucun retombe sur « All ».
  assert.match(textOf(chip(rerender({ ...view.props.filters, priority: ['high'] }))), /PriorityHigh/)
  const none = chip(rerender({ ...view.props.filters, priority: null }))
  assert.equal(none.props['data-active'], 'false')
  assert.match(textOf(none), /PriorityAll/)

  // Le clic bascule l'ouverture du menu, qui porte de vraies cases à cocher.
  both.props.onClick()
  assert.ok(setters.length > 0)
  assert.match(SOURCE, /allLabel: 'All priorities'/)
  assert.match(SOURCE, /type: 'checkbox'/)
})
test('une mission qui dort est signalée, sa ligne le dit aussi', () => {
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })

  const rows = findAll(tree, 'button').filter((button) => button.props['data-state'] !== undefined)
  const quiet = rows.filter((button) => button.props['aria-label'].includes('not updated for a week'))
  // Les widgets : MIS-1 dans Bugs (9 j), MIS-3 dans Stories (11 j). Puis
  // l'en-cours : MIS-3 (11 j), MIS-4 (4 j) ; la file : MIS-1 (9 j), MIS-2 (1 j),
  // MIS-5 (6 j).
  assert.deepEqual(quiet.map((button) => button.props['aria-label'].split(' ')[0]), ['MIS-1', 'MIS-3', 'MIS-3', 'MIS-1'])

  const ages = findAll(tree, 'span').filter((span) => span.props.className === 'missions-rowage')
  assert.deepEqual(ages.map((span) => span.props['data-quiet']), ['true', 'false', 'true', 'false', 'false', 'true', 'false', 'true', 'false', 'false'])
})

test('chaque carte dit à quoi elle sert, sous son titre', () => {
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })
  const subs = findAll(tree, 'p').filter((node) => node.props.className === 'missions-dash-card-sub')

  assert.deepEqual(subs.map(textOf), [
    'Unresolved, assigned to you. Oldest first.',
    'Urgent or high, oldest first.',
    'Started, not shipped.',
    'Waiting on your next move, most urgent first.',
  ])
  // « sous le titre » : la ligne vient juste après l'en-tête, pas au bas de la carte.
  for (const card of findAll(tree, 'article')) {
    const line = card.children.findIndex((child) => child?.props?.className === 'missions-dash-card-sub')
    assert.equal(line, 1, 'la ligne se place entre l’en-tête et le corps')
    assert.equal(card.children[0].type, 'header')
  }
  assert.match(SOURCE, /^\.missions-dash-card-sub \{/m, 'la règle de style est présente')
})

test('sans mission, le dashboard rend son état vide', () => {
  // Le premier mount n'a rien à montrer : la section garde son cadre et son
  // texte, plutôt qu'une grille vide ou une erreur.
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView([]), 'dashboard'], { now: DASH_NOW })

  assert.equal(findAll(tree, 'article').length, 0)
  assert.match(textOf(tree), /No mission is assigned to you yet\./)
  assert.equal(findAll(tree, 'div').filter((div) => div.props.className === 'missions-dash-empty').length, 1)
})

test('les widgets sans ligne disent ce qui manque, sans lien', () => {
  const missions = [
    { key: 'S-1', title: 'story normale', state: 'ready', type: 'story', priority: 'normal', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-01T12:00:00Z' },
  ]
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(missions), 'dashboard'], { now: DASH_NOW })
  const [bugs, stories] = findAll(tree, 'article')

  assert.match(textOf(bugs), /No unresolved bug assigned to you\./)
  assert.match(textOf(stories), /No high-priority story\./)
  assert.equal(findAll(tree, 'button').filter((button) => textOf(button).includes('View all')).length, 0)
})

test('un chargement sans donnée rend le loader, un refresh garde les lignes', () => {
  const cold = renderDashboard([EMPTY_BAR, dashboardView([], true), 'dashboard'], { now: DASH_NOW })
  assert.equal(findAll(cold.tree, 'div').filter((div) => div.props.className === 'missions-loader').length, 1)

  // Un refresh lancé depuis un autre onglet ne doit pas vider le dashboard.
  const warm = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS, true), 'dashboard'], { now: DASH_NOW })
  assert.equal(findAll(warm.tree, 'div').filter((div) => div.props.className === 'missions-loader').length, 0)
  assert.equal(findAll(warm.tree, 'button').filter((button) => button.props['data-state'] !== undefined).length, 10)
})

test('le panneau relit la barre de la session au montage', () => {
  const reads = []
  const session = {
    getItem: (key) => {
      reads.push(key)
      return JSON.stringify({
        query: 'panneau', type: 'bug', state: 'ready', epic: 'Workspace',
        priority: 'urgent', project: 'missions', missing: 'any', sort: 'points',
      })
    },
    setItem: () => {},
    removeItem: () => {},
  }
  const { api, ctx, registered } = charger(undefined, [], session)
  api.apply(ctx)

  assert.doesNotThrow(() => registered.main({}))
  // Deux lectures au montage, dans cet ordre : la barre, puis l'onglet. Le
  // montage reprend la session telle qu'elle a été laissée.
  assert.deepEqual(reads, ['missions.filters', 'missions.tab'])
})

test('une barre corrompue ou un stockage en panne ne casse pas le montage', () => {
  const sessions = [
    { getItem: () => 'pas du json', setItem: () => {}, removeItem: () => {} },
    { getItem: () => { throw new Error('blocked') }, setItem: () => {}, removeItem: () => {} },
    {},
    undefined,
  ]
  for (const session of sessions) {
    const { api, ctx, registered } = charger(undefined, [], session)
    api.apply(ctx)
    assert.doesNotThrow(() => registered.main({}), 'montage avec un stockage dégradé')
  }
})

test('la barre est restaurée au montage et réécrite à chaque changement', () => {
  // La barre vit dans la session : une seule clé, lue au montage, réécrite par
  // l'effet dès que la recherche, un filtre ou le tri change.
  assert.match(SOURCE, /FILTERS_KEY = 'missions\.filters'/)
  assert.match(SOURCE, /function filterStorage\(\) \{\s+try \{\s+return typeof sessionStorage === 'undefined' \? null : sessionStorage/)
  assert.match(SOURCE, /const \[restored\] = React\.useState\(\(\) => filterBarState\(readFilterSnapshot\(filterStorage\(\)\)\)\)/)
  assert.match(SOURCE, /const \[query, setQuery\] = React\.useState\(restored\.query\)/)
  assert.match(SOURCE, /const \[filters, setFilters\] = React\.useState\(restored\.filters\)/)
  assert.match(SOURCE, /const \[sort, setSort\] = React\.useState\(restored\.sort\)/)
  assert.match(SOURCE, /writeFilterSnapshot\(filterStorage\(\), \{ query, filters, sort \}\)/)
  assert.match(SOURCE, /\}, \[query, filters, sort\]\)/)
  // `Clear` rend un objet neuf : il vide les filtres sans partager l'état vide.
  assert.match(SOURCE, /const onClear = \(\) => setFilters\(\{ \.\.\.EMPTY_FILTERS \}\)/)
  // Aucune clé de barre dans localStorage : elle ne survit pas à l'app.
  assert.doesNotMatch(SOURCE, /localStorage\.(?:get|set)Item\(FILTERS_KEY/)
})


test('la barre d’onglets propose Workflows, et l’onglet ouvre l’éditeur', () => {
  const session = memorySession({ 'missions.tab': 'workflows' })
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)

  assert.equal(findAll(tree, 'WorkflowsView').length, 1, 'l’onglet Workflows porte l’éditeur de parcours')
  assert.equal(findAll(tree, 'MissionsView').length, 0)
  assert.equal(findAll(tree, 'MissionDrawer').length, 0, 'aucune mission n’a de tiroir dans cet onglet')
  assert.match(textOf(tree), /Workflows/)

  // L'onglet est bien une vue montée, pas un libellé : rendue pour de vrai, elle
  // dit ce qu'elle attend avant la première réponse.
  const inner = renderTree(findAll(tree, 'WorkflowsView')[0])
  assert.match(textOf(inner), /Chargement du parcours…/)
  assert.equal(findAll(inner, 'svg').length, 0, 'aucun graphe tant que le modèle n’est pas là')
})

test('l’éditeur demande le parcours au serveur et garde l’étape ouverte', async () => {
  // L'effet de chargement est collecté, pas exécuté : le test l'appelle lui-même
  // avec un `fetch` de circonstance, et lit la requête qui part vraiment.
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return { json: async () => ({ workflows: [], writers: ['demandeur', 'session', 'outil'], states: ['to-refine'] }) }
  }
  try {
    const session = memorySession({ 'missions.tab': 'workflows', 'missions.workflow-step': 'review' })
    const { api, ctx, registered, effects } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
    api.apply(ctx)
    const tree = registered.main({})
    // Les effets du panneau (dont son rafraîchissement de 60 s) ne sont pas
    // joués : seuls ceux que la vue de l'onglet arme en se montant le sont.
    const avant = effects.length
    renderTree(findAll(tree, 'WorkflowsView')[0])
    for (const effect of effects.slice(avant)) effect.fn()

    assert.equal(appels[0]?.url, 'missions/api/workflows')
    assert.equal(appels[0]?.options?.headers?.accept, 'application/json')
    // L'étape laissée ouverte se réécrit telle quelle : la session la retrouve.
    assert.equal(session.entries.get('missions.workflow-step'), 'review')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('le graphe a ses règles : nœuds, sélection, retour en pointillé', () => {
  assert.match(regle('.wf-node'), /stroke-width: 1/)
  assert.match(regle('.wf-node--geste'), /cursor: pointer/)
  assert.match(regle('.wf-node--selected'), /stroke-width: 2/)
  assert.match(regle('.wf-link--back'), /stroke-dasharray/)
  assert.match(regle('.wf-canvas-wrap'), /overflow: auto/)
  assert.match(regle('.wf-layout'), /grid-template-columns: minmax\(0, 1fr\) 300px/)
  // Le graphe reprend le vocabulaire visuel du panneau : les variables du
  // thème, pas des couleurs figées — le thème manga suit sans règle de plus.
  assert.match(regle('.wf-card'), /border-radius: 12px/)
})

test('l’éditeur attend le modèle au lieu de lire un brouillon absent', () => {
  // La régression MIS-102 : entre la réponse du serveur (l'entrée est trouvée)
  // et l'effet qui pose le brouillon, le rendu lisait `draft.entry` et levait —
  // React démontait alors le panneau entier, onglets compris.
  assert.match(SOURCE, /if \(!entry \|\| !draft\) \{/, 'le rendu garde les deux attentes')
  assert.match(SOURCE, /'Chargement du modèle du parcours…'/, 'l’attente du modèle se dit')
  assert.ok(!/draft\.entry/.test(SOURCE), 'aucun accès direct à un brouillon peut-être absent')
  assert.match(SOURCE, /const ends = endPoints\(draft\)/, 'les extrémités passent par le helper qui tolère l’absence')
})
