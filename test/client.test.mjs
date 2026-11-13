import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { USAGE_ELEMENTS } from '../lib/view.js'
import { MODELS_DIR, readWorkflow } from '../lib/workflows.js'
import { blockedReasonAfterWrite } from '../lib/view.js'
import { forgetToken, setBlocked } from '../lib/trackers/jira.js'

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
  // Les valeurs posées par les setters, par hook : un second rendu les rejoue
  // au lieu de repartir des états de montage. C'est ce qui prouve qu'un clic
  // change bien ce que le panneau affiche.
  const updates = new Map()
  let hookIndex = 0
  const React = {
    createElement: h,
    Fragment: 'fragment',
    useState: (initial) => {
      const index = hookIndex++
      return [
        updates.has(index) ? updates.get(index) : (queue.length > 0 ? queue.shift() : (typeof initial === 'function' ? initial() : initial)),
        (next) => { updates.set(index, next); setters.push(next) },
      ]
    },
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
  const resetHooks = () => { hookIndex = 0 }
  return { api, ctx, registered, id: captured.id, setters, effects, queue, resetHooks }
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
  // Le nom voyage dans l'infobulle et le libellé accessible : l'icône n'a pas de texte.
  assert.match(SOURCE, /title: blocker \?\? sessionLabel,/)
  assert.match(SOURCE, /'aria-label': sessionLabel,/)
})

/** Le nom accessible d'un geste du volet : les icônes n'ont plus de texte. */
function nomDuGeste(node) {
  return (node.props['aria-label'] ?? '').trim()
}

/** Le bouton d'action dont le nom accessible est exactement ce libellé. */
function boutonGeste(tree, label) {
  return findAll(tree, 'button').find((node) => nomDuGeste(node) === label) ?? null
}

/** Le bouton de session, dont le libellé finit par l'étape courante. */
function boutonSession(tree) {
  return findAll(tree, 'button').find((node) => /^Start a session/.test(nomDuGeste(node))) ?? null
}

/** Le bouton des remontées du volet, ou null quand la mission n'en rend pas. */
function boutonRemontees(tree) {
  return boutonGeste(tree, 'Check the PR feedback')
}

test('le volet rend « Check the PR feedback » en revue, à côté de la session', () => {
  const { tree } = monterVolet({ ...MISSION, state: 'in-review', updatedAt: MISSION.updated })
  const bouton = boutonRemontees(tree)
  assert.ok(bouton, 'le bouton doit être rendu en revue')

  // Icône seule : le nom vit dans l'infobulle et le libellé accessible, et le
  // verrou ne mord pas ici.
  assert.equal(bouton.props.className, 'missions-action missions-action--icon')
  assert.equal(bouton.props.disabled, false)
  assert.equal(bouton.props.title, 'Check the PR feedback')
  assert.equal(bouton.props['aria-label'], 'Check the PR feedback')
  assert.equal(textOf(bouton), '', 'le bouton ne porte plus de texte')
  assert.equal(findAll(bouton, 'svg').length, 1, 'le bouton porte une icône')
  assert.equal(bouton.props['aria-describedby'], undefined)
  assert.equal(typeof bouton.props.onClick, 'function')

  // Il précède le bouton de session, qui reste le primaire et le dernier.
  const actions = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-actions')
  assert.ok(actions, 'le volet doit rendre la barre d’actions')
  const boutons = actions.children.filter((child) => child.type === 'button')
  const iRemontees = boutons.findIndex((node) => nomDuGeste(node) === 'Check the PR feedback')
  const iSession = boutons.findIndex((node) => /^Start a session/.test(nomDuGeste(node)))
  assert.ok(iSession > iRemontees, 'la session reste après les remontées')
  assert.match(boutons[iSession].props.className, /missions-action--primary/)
})

test('hors revue, le volet ne rend pas le bouton des remontées', () => {
  for (const state of ['to-refine', 'ready', 'in-progress', 'ready-for-prod', 'done', 'blocked', null]) {
    const { tree } = monterVolet({ ...MISSION, state, updatedAt: MISSION.updated })
    assert.equal(boutonRemontees(tree), null, `aucun bouton des remontées pour ${state}`)
  }
})

test('le bouton des remontées est désarmé par le même verrou que la session', () => {
  const cas = [
    [{ branch: null, base: 'main' }, 'branch is not declared, set it below or in the mission folder'],
    [{ branch: 'fix/mis-42', base: null }, 'base branch is not declared, set it below or in the mission folder'],
    [
      { branch: 'fix/mis-42', base: 'main', stateConflict: ['in-review', 'ready'] },
      'state labels conflict (in-review, ready), keep one',
    ],
  ]

  for (const [patch, message] of cas) {
    const { tree } = monterVolet({ ...MISSION, state: 'in-review', updatedAt: MISSION.updated, ...patch })
    const bouton = boutonRemontees(tree)
    assert.ok(bouton, `le bouton reste rendu, désarmé : ${message}`)
    assert.equal(bouton.props.disabled, true)
    // L'infobulle dit pourquoi le geste est fermé ; le nom, lui, reste le geste.
    assert.equal(bouton.props.title, message)
    assert.equal(bouton.props['aria-label'], 'Check the PR feedback')
    assert.equal(bouton.props['aria-describedby'], 'missions-session-blocked')
    // Le message est bien rendu sous le bouton, et la note le cite.
    assert.match(textOf(tree), new RegExp(`Session blocked: ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
})

test('le clic sur les remontées ouvre une session avec le prompt dédié', async () => {
  const captures = []
  const services = {
    getService: (name) =>
      name === 'uiWorkspace'
        ? { startSession: (id, options) => captures.push({ id, prompt: options?.prompt }) }
        : null,
  }
  const { tree } = monterVolet(
    {
      ...MISSION,
      state: 'in-review',
      repo: '~/projects/missions',
      url: 'https://github.com/daedalforge/missions/issues/42',
      updatedAt: MISSION.updated,
    },
    { services, workspaceId: 'w' },
  )

  await boutonRemontees(tree).props.onClick()
  assert.equal(captures.length, 1)
  const prompt = captures[0].prompt

  // La clé, le titre, le ticket avec ses commentaires, et le clone du projet.
  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  assert.match(prompt, /gh issue view 42 -R daedalforge\/missions --json [^\n]*comments/)
  assert.match(prompt, /Dépôt du projet : ~\/projects\/missions\./)
  assert.match(prompt, /Branche : fix\/mis-42 ; base : main\./)
  // La PR se retrouve par la branche ; revues et fils se lisent en ligne.
  assert.match(prompt, /gh pr list --head fix\/mis-42 --state all/)
  assert.match(prompt, /pulls\/<n>\/comments/)
  // Le tri, la correction et le push sur la branche.
  assert.match(prompt, /corriger \/ répondre \/ hors périmètre/)
  assert.match(prompt, /corrige sur la branche et pousse/)
  assert.match(prompt, /`<CLÉ>: <impératif>`/)
  // Journal et checklist restent les preuves ; le garde-fou est complet.
  assert.match(prompt, /Journal de mission : /)
  assert.match(prompt, /Checklist de mission : /)
  assert.match(prompt, /tu ne merges jamais la PR/)
  assert.match(prompt, /tu ne touches pas aux labels/)
  assert.match(prompt, /tu ne fermes pas le ticket/)
  // Ce n'est pas le brief de l'étape : les deux prompts ne se confondent pas.
  assert.doesNotMatch(prompt, /Tu ne fais que la revue/)
})

test('le bouton de session envoie toujours le prompt d’hier', async () => {
  const captures = []
  const services = {
    getService: (name) =>
      name === 'uiWorkspace'
        ? { startSession: (id, options) => captures.push(options?.prompt) }
        : null,
  }
  const { tree } = monterVolet(
    { ...MISSION, state: 'in-review', updatedAt: MISSION.updated },
    { services, workspaceId: 'w' },
  )

  const bouton = boutonSession(tree)
  await bouton.props.onClick()

  assert.equal(captures.length, 1)
  assert.match(captures[0], /Étape en cours : revue \(statut in-review\)\./)
  assert.match(captures[0], /Tu ne fais que la revue/)
  assert.doesNotMatch(captures[0], /Dépôt du projet/)
})

test('un clic sur Start a session n’écrit aucune note et ne crée qu’une session', async () => {
  const opened = []
  const connected = []
  const services = {
    getService: (name) =>
      name === 'uiWorkspace'
        ? {
            connectWorkspace: (id) => connected.push(id),
            startSession: (id, options) => opened.push({ id, options }),
          }
        : null,
  }
  const { tree, setters } = monterVolet(
    { ...MISSION, state: 'in-review', updatedAt: MISSION.updated },
    { services, workspaceId: 'w' },
  )

  const bouton = boutonSession(tree)
  await bouton.props.onClick()

  // Un seul geste : startSession. connectWorkspace créerait une session blanche
  // que startSession reprendrait aussitôt, pour un aller-retour de plus.
  assert.equal(connected.length, 0)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].id, 'w')
  // Aucune note : DSH démonte le volet dès la session ouverte, la note vivait
  // moins de 50 ms et se lisait comme une erreur.
  const notes = setters.filter((value) => typeof value === 'string' && /session/i.test(value))
  assert.deepEqual(notes, [])
})

test('une session que le shell refuse laisse une note courte et lisible', async () => {
  const services = {
    getService: (name) =>
      name === 'uiWorkspace'
        ? {
            startSession: () => {
              throw new Error('workspace/not-found')
            },
          }
        : null,
  }
  const { tree, setters } = monterVolet(
    { ...MISSION, state: 'in-review', updatedAt: MISSION.updated },
    { services, workspaceId: 'w' },
  )

  const bouton = boutonSession(tree)
  await bouton.props.onClick()

  assert.ok(setters.includes('Session not opened: workspace/not-found'))
})

test('le prompt n’est plus construit en ligne dans le gabarit du volet', async () => {
  const template = await readFile(new URL('../src/client.template.js', import.meta.url), 'utf8')

  // Le volet appelle les helpers : la chaîne du prompt vit dans lib/view.js.
  assert.match(template, /const prompt = missionSessionPrompt\(mission\)/)
  assert.match(template, /const feedbackPrompt = feedbackSessionPrompt\(mission\)/)
  assert.doesNotMatch(template, /Garde-fou : tu ne merges jamais la PR/)
  assert.doesNotMatch(template, /Chaque étape se joue dans une nouvelle session/)
  // Le bundle, lui, porte bien les deux helpers et le bouton.
  assert.match(SOURCE, /function missionSessionPrompt\(mission = \{\}\)/)
  assert.match(SOURCE, /function feedbackSessionPrompt\(mission = \{\}\)/)
  assert.match(SOURCE, /const FEEDBACK_BRIEF =/)
  assert.match(SOURCE, /Check the PR feedback/)
  assert.match(SOURCE, /mission\.state === 'in-review'/)
  // La session libre suit le même chemin : son prompt vit à côté, pas en ligne.
  assert.match(template, /const freePrompt = freeSessionPrompt\(mission\)/)
  assert.match(SOURCE, /function freeSessionPrompt\(mission = \{\}\)/)
  assert.match(SOURCE, /const FREE_BRIEF =/)
})

/** Le bouton de session libre du volet, ou null quand la mission n'en rend pas. */
function boutonLibre(tree) {
  return boutonGeste(tree, 'Start a free session')
}

test('le volet rend « Start a free session » à toutes les étapes sauf done', () => {
  for (const state of ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod']) {
    const { tree } = monterVolet({ ...MISSION, state, updatedAt: MISSION.updated })
    assert.ok(boutonLibre(tree), `le bouton libre doit être rendu pour ${state}`)
  }
  // Une mission fermée ne joue aucune session : le bouton disparaît.
  const { tree } = monterVolet({ ...MISSION, state: 'done', updatedAt: MISSION.updated })
  assert.equal(boutonLibre(tree), null, 'aucune session libre sur une mission done')
})

test('le bouton libre est secondaire, titré et reste au-dessus de la session', () => {
  const { tree } = monterVolet({ ...MISSION, state: 'in-progress', updatedAt: MISSION.updated })
  const bouton = boutonLibre(tree)
  assert.ok(bouton, 'le bouton libre doit être rendu')

  // Icône seule, active : son nom voyage dans l'infobulle et le libellé
  // accessible, comme les autres gestes de la rangée.
  assert.equal(bouton.props.className, 'missions-action missions-action--icon')
  assert.doesNotMatch(bouton.props.className, /--primary/)
  assert.equal(bouton.props.disabled, false)
  assert.equal(bouton.props.title, 'Start a free session')
  assert.equal(bouton.props['aria-label'], 'Start a free session')
  assert.equal(textOf(bouton), '', 'le bouton ne porte plus de texte')
  assert.equal(findAll(bouton, 'svg').length, 1, 'le bouton porte une icône')
  assert.equal(bouton.props['aria-describedby'], undefined)
  assert.equal(typeof bouton.props.onClick, 'function')

  // Il précède le bouton de session, qui reste le primaire et le dernier.
  const actions = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-actions')
  assert.ok(actions, 'le volet doit rendre la barre d’actions')
  const boutons = actions.children.filter((child) => child.type === 'button')
  const iLibre = boutons.findIndex((node) => nomDuGeste(node) === 'Start a free session')
  const iSession = boutons.findIndex((node) => /^Start a session/.test(nomDuGeste(node)))
  assert.ok(iLibre >= 0, 'le bouton libre est dans la barre d’actions')
  assert.ok(iSession > iLibre, 'la session d’étape reste après la session libre')
  assert.match(boutons[iSession].props.className, /missions-action--primary/)
})

test('le thème Naruto rend le bouton libre sans règle nouvelle', () => {
  const { tree } = monterVolet({ ...MISSION, state: 'in-progress', updatedAt: MISSION.updated })
  const bouton = boutonLibre(tree)
  assert.equal(bouton.props.className, 'missions-action missions-action--icon')

  // La classe suffit : le manga ne réécrit que `.missions-action` et le primaire.
  const manga = regle('.missions-panel[data-theme="manga"] .missions-action')
  assert.match(manga, /border: 1\.5px solid var\(--mm-ink\)/)
  assert.match(manga, /box-shadow: 2px 2px 0 var\(--mm-shadow\)/)
  assert.match(regle('.missions-panel[data-theme="manga"] .missions-action--primary'), /background: var\(--mm-ink\)/)
})

test('la rangée du pied aligne les icônes sur une seule ligne', () => {
  const actions = regle('.missions-drawer-actions')
  assert.match(actions, /display: flex/)
  assert.match(actions, /flex-direction: row/)
  assert.match(actions, /flex-wrap: wrap/)
  assert.match(actions, /align-items: center/)
  assert.match(actions, /gap: 6px/)

  // L'icône est un carré de 34 px : la hauteur de la famille, sans texte.
  const icone = regle('.missions-action--icon')
  assert.match(icone, /width: 34px/)
  assert.match(icone, /height: 34px/)
  assert.match(icone, /padding: 0/)

  // Le focus reste visible au clavier, et le manga garde son encre.
  assert.match(regle('.missions-action:focus-visible'), /outline: 2px solid/)
  assert.match(
    regle('.missions-panel[data-theme="manga"] .missions-action:focus-visible'),
    /outline-color: var\(--mm-ink\)/,
  )

  // Le pied empile deux choses seulement : la clôture textuelle et la rangée.
  assert.match(regle('.missions-drawer-foot'), /flex-direction: column/)
})

test('chaque geste de la rangée ne porte que son icône, nommée', () => {
  const { tree } = monterVolet({
    ...MISSION,
    state: 'in-review',
    url: 'https://github.com/daedalforge/missions/issues/42',
    updatedAt: MISSION.updated,
  })
  const actions = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-actions')
  const gestes = actions.children.filter((child) => child !== null && child !== false)
  assert.deepEqual(gestes.map(nomDuGeste), [
    'Open on the tracker',
    'Check the PR feedback',
    'Start a free session',
    'Start a session — revue',
  ])

  for (const geste of gestes) {
    assert.equal(textOf(geste), '', `${nomDuGeste(geste)} ne porte pas de texte visible`)
    const icones = findAll(geste, 'svg')
    assert.equal(icones.length, 1, `${nomDuGeste(geste)} porte une seule icône`)
    assert.equal(icones[0].props['aria-hidden'], 'true', 'l’icône reste décorative')
    assert.equal(geste.props.title, nomDuGeste(geste), `${nomDuGeste(geste)} garde le même nom en infobulle`)
    assert.match(geste.props.className, /missions-action--icon/)
  }
  // La step session reste l'action primaire, et la dernière.
  assert.match(gestes.at(-1).props.className, /missions-action--primary/)
})

test('la session bloquée dit pourquoi dans son infobulle, son nom ne change pas', () => {
  const bloque = boutonSession(monterVolet({ ...MISSION, branch: null, base: null, updatedAt: MISSION.updated }).tree)
  assert.equal(bloque.props.disabled, true)
  assert.equal(bloque.props.title, 'branch is not declared, set it below or in the mission folder')
  assert.equal(bloque.props['aria-label'], 'Start a session — exécution')
  assert.equal(bloque.props['aria-describedby'], 'missions-session-blocked')

  // Débloquée, l'infobulle reprend le libellé du geste.
  const libre = boutonSession(monterVolet({ ...MISSION, updatedAt: MISSION.updated }).tree)
  assert.equal(libre.props.title, 'Start a session — exécution')
  assert.equal(libre.props['aria-describedby'], undefined)
})

test('le clic sur la session libre ouvre une session avec le prompt libre, sans envoi', async () => {
  const captures = []
  const services = {
    getService: (name) =>
      name === 'uiWorkspace'
        ? { startSession: (id, options) => captures.push({ id, options }) }
        : null,
  }
  const { tree } = monterVolet(
    {
      ...MISSION,
      state: 'in-progress',
      repo: '~/projects/missions',
      url: 'https://github.com/daedalforge/missions/issues/42',
      updatedAt: MISSION.updated,
    },
    { services, workspaceId: 'w' },
  )

  await boutonLibre(tree).props.onClick()
  assert.equal(captures.length, 1)
  assert.equal(captures[0].id, 'w')
  // Le préremplissage seul : le prompt, rien d'autre, aucun envoi.
  assert.deepEqual(Object.keys(captures[0].options), ['prompt'])
  const prompt = captures[0].options.prompt

  // L'identité, le ticket au CLI et le statut en information.
  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  assert.match(prompt, /gh issue view 42 -R daedalforge\/missions --json [^\n]*comments/)
  assert.match(prompt, /Statut du ticket : in-progress \(information seule\)\./)
  assert.match(prompt, /Dépôt du projet : ~\/projects\/missions\./)
  // Journal et checklist sont nommés en lecture seule.
  assert.match(prompt, /Journal de mission : /)
  assert.match(prompt, /Checklist de mission : /)
  // Ce n'est pas le prompt d'étape : ni étape, ni avancement du ticket.
  assert.match(prompt, /Session libre/)
  assert.match(prompt, /aucune étape du workflow/)
  assert.doesNotMatch(prompt, /Étape en cours/)
  assert.doesNotMatch(prompt, /Tu ne fais que l’exécution/)
})

test('sans branche, la session libre reste active quand la session d’étape est bloquée', () => {
  const { tree } = monterVolet({
    ...MISSION,
    state: 'to-refine',
    branch: null,
    base: null,
    updatedAt: MISSION.updated,
  })

  const libre = boutonLibre(tree)
  assert.ok(libre, 'le bouton libre doit être rendu en cadrage sans branche')
  assert.equal(libre.props.disabled, false)
  assert.equal(libre.props.title, 'Start a free session')
  assert.equal(libre.props['aria-describedby'], undefined)

  // L'étape, elle, reste fermée : la note du pied la concerne.
  const session = boutonSession(tree)
  assert.equal(session.props.disabled, true)
  assert.match(textOf(tree), /Session blocked: branch is not declared/)
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
  // Chaque onglet du volet compte le geste qui l'ouvre, puis l'ouvre.
  assert.match(SOURCE, /onClick: \(\) => \{ track\(`mission\.tab\.\$\{entry\.id\}`\); setSection\(entry\.id\) \}/)
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

test('le bundle cantonne done à l’onglet Done, jamais à la liste ouverte', () => {
  assert.match(SOURCE, /const STATE_ORDER = \['in-progress', 'in-review', 'ready', 'to-refine', 'ready-for-prod', 'done'\]/)
  assert.match(SOURCE, /STATE_FILTER_ORDER = \['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done'\]/)
  assert.match(SOURCE, /done: 'done'/)
  // Done est un onglet déclaré entre Missions et Repositories, pas un filtre.
  assert.match(SOURCE, /\{ id: 'done', label: 'Done', source: 'tracker' \},/)
  // La liste ouverte ne relit plus done, même si un filtre le nomme : seul le
  // périmètre Done passe `allowDone`.
  assert.match(SOURCE, /if \(!allowDone && mission\.state === 'done'\) return false/)
  assert.match(SOURCE, /allowDone: doneTab/)
  assert.match(SOURCE, /filterMissions\(activeMissions, \{ query: activeQuery, \.\.\.activeFilters, allowDone: doneTab \}\)/)
  // Done lit les closes par son propre appel et dit son vide propre.
  assert.match(SOURCE, /\?done=1/)
  assert.match(SOURCE, /No done mission declared on this machine\./)
})

test('l’onglet Done rend sa liste, son vide et son statut figé', () => {
  const doneMission = {
    key: 'MIS-6', title: 'mission close', state: 'done', type: 'bug', priority: 'high',
    project: 'missions', projectName: 'Missions', updatedAt: '2026-11-09T12:00:00Z',
  }
  const states = (missions) => [
    EMPTY_BAR,
    dashboardView(DASH_MISSIONS.filter((mission) => mission.state !== 'done')),
    'done',
    '',
    { ...EMPTY_BAR.filters },
    null,
    null,
    'default',
    null,
    EMPTY_BAR,
    { loading: false, missions, errors: [], workspaceId: 'w', workspaceRoot: '/w' },
    '',
    { ...EMPTY_BAR.filters, state: ['done'] },
    null,
  ]

  // Une liste mêlant ouverte et close : l’onglet Done ne garde que la close,
  // même si le serveur lui servait un périmètre trop large.
  const openMission = {
    key: 'MIS-7', title: 'mission ouverte', state: 'in-review', type: 'story', priority: 'normal',
    project: 'missions', projectName: 'Missions', updatedAt: '2026-11-09T12:00:00Z',
  }
  const panel = monter(states([openMission, doneMission]))
  const view = findAll(panel, 'MissionsView')[0]
  assert.ok(view, 'l’onglet Done porte la même vue, nourrie par sa lecture')
  assert.deepEqual(view.props.statusOptions, ['done'])
  assert.equal(view.props.statusFixed, true)
  assert.equal(view.props.emptyText, 'No done mission declared on this machine.')

  const text = textOf(renderTree(panel))
  assert.match(text, /mission close/)
  assert.doesNotMatch(text, /mission ouverte/)
  // Le statut est figé : pas de « All open states » dans une vue close.
  assert.doesNotMatch(text, /All open states/)

  const empty = textOf(renderTree(monter(states([]))))
  assert.match(empty, /No done mission declared on this machine\./)
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

test('le montage ne lit que l’ouvert ; Done paie sa lecture, le bouton et le tick forcent', () => {
  // Le panneau est remonté à chaque changement de vue : forcer au montage
  // paierait tout le trajet tracker à chaque retour sur Missions. Le cache
  // serveur de 60 s est lu ; le bouton Refresh et le tick de 60 s forcent.
  assert.match(SOURCE, /const load = React\.useCallback\(\(\{ silent = false, refresh = false \} = \{\}\) => \{/)
  assert.match(SOURCE, /const loadDone = React\.useCallback\(\(\{ silent = false, refresh = false \} = \{\}\) => \{/)
  assert.match(SOURCE, /const url = refresh \? `\$\{LIST_URL\}\?refresh=1` : LIST_URL/)
  assert.match(SOURCE, /const url = `\$\{LIST_URL\}\?done=1\$\{refresh \? '&refresh=1' : ''\}`/)
  // Le montage appelle load() et le compte des dépôts, sans option ; Done lit à
  // l'ouverture de son onglet, et le compte se relit au tick quel que soit l'onglet.
  assert.match(SOURCE, /React\.useEffect\(\(\) => \{\n\s+load\(\)\n\s+loadRepositoryCount\(\)\n\s+\}, \[load, loadRepositoryCount\]\)/)
  assert.match(SOURCE, /if \(tab !== 'done'\) return undefined\n\s+loadDone\(\)/)
  // Le tick suit le périmètre de la vue ouverte : Done relit le clos, les vues
  // tracker lisent l'ouvert, et Settings n'en relit aucune.
  assert.match(SOURCE, /if \(tab === 'done'\) loadDone\(\{ silent: true, refresh: true \}\)\n\s+else if \(trackerTab\) load\(\{ silent: true, refresh: true \}\)/)
  assert.match(SOURCE, /loadRepositoryCount\(\)\n\s+\}, REFRESH_MS\)/)
  assert.match(SOURCE, /doneTab \? loadDone\(\{ refresh: true \}\) : load\(\{ refresh: true \}\)/)
  // Aucun autre appel ne force : le seul refresh=1 est derrière `refresh`.
  assert.equal((SOURCE.match(/\?refresh=1/g) ?? []).length, 1)
})

test('un refresh garde la vue montée : le châssis et le loader, jamais un écran vide', () => {
  // L'état de départ reproduit un clic sur Refresh : des missions déjà là et un
  // chargement en cours. La liste survit — la barre d'outils avec elle — et le
  // corps porte le loader.
  const view = { loading: true, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
  api.apply(ctx)

  const panel = registered.main({})
  const list = findAll(panel, 'MissionsView')[0]
  assert.ok(list, 'MissionsView reste rendu pendant la lecture')
  assert.equal(list.props.loading, true)
  assert.equal(findAll(panel, 'PanelLoader').length, 0, 'le panneau ne remplace plus la vue par un loader')

  const tree = renderTree({ ...list, props: { ...list.props } })
  // Le corps porte le loader, la barre d'outils reste au-dessus : la recherche
  // et la commande ne disparaissent pas sous la main.
  const loader = findAll(tree, 'div').filter((node) => node.props.className === 'missions-loader')
  assert.equal(loader.length, 1)
  assert.equal(loader[0].props.role, 'status')
  const toolbar = findAll(tree, 'div').filter((node) => node.props.className === 'missions-toolbar')
  assert.equal(toolbar.length, 1)
  assert.equal(findAll(toolbar[0], 'input').length, 1)

  // Le bouton-icône est là, désactivé et annoncé occupé, mais sans texte : le
  // nom accessible porte tout le libellé.
  const button = findAll(toolbar[0], 'button').find((node) => node.props.className === 'missions-icon-btn')
  assert.ok(button, 'le bouton-icône vit dans la barre d’outils')
  assert.equal(button.props['aria-label'], 'Refresh')
  assert.equal(button.props.title, 'Refresh')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props['aria-busy'], 'true')
  assert.equal(textOf(button), '', 'l’icône est son seul contenu')
  assert.equal(findAll(button, 'svg')[0].props['aria-hidden'], 'true')
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

test('le loader et le bouton de la liste ne débordent pas sur le Dashboard', () => {
  // Un refresh lancé depuis Missions ne doit pas remplacer le Dashboard par le
  // loader si l'on change d'onglet pendant la requête : le Dashboard est hors
  // périmètre, garde ses lignes et ne porte aucune commande de la liste.
  const view = { loading: true, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'dashboard'])
  api.apply(ctx)

  const panel = registered.main({})
  assert.equal(findAll(panel, 'MissionsView').length, 0)
  const dashboard = findAll(panel, 'DashboardView')[0]
  assert.ok(dashboard)
  const tree = renderTree({ ...dashboard, props: { ...dashboard.props } })
  assert.equal(findAll(tree, 'PanelLoader').length, 0)
  assert.doesNotMatch(JSON.stringify(panel), /"title":"Refresh"/)
})

test('aucune commande ne reste dans l’en-tête : le sélecteur de thème est seul', () => {
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions'])
  api.apply(ctx)
  const panel = registered.main({})

  const actions = findAll(panel, 'div').filter((node) => node.props.className === 'missions-actions')
  assert.equal(actions.length, 1)
  assert.equal(findAll(actions[0], 'button').length, 0, 'plus aucun bouton dans .missions-actions')
  assert.equal(findAll(actions[0], 'ThemeSelect').length, 1, 'le sélecteur de thème reste, seul')
  assert.doesNotMatch(JSON.stringify(actions[0]), /"aria-label":"Refresh"/)
})

test('la liste commande son rafraîchissement, en icône accessible', () => {
  const view = { loading: false, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
  api.apply(ctx)

  const list = findAll(registered.main({}), 'MissionsView')[0]
  const tree = renderTree({ ...list, props: { ...list.props } })
  const toolbar = findAll(tree, 'div').filter((node) => node.props.className === 'missions-toolbar')
  const button = findAll(toolbar[0], 'button').find((node) => node.props.className === 'missions-icon-btn')

  assert.ok(button)
  assert.equal(button.props['aria-label'], 'Refresh')
  assert.equal(button.props.title, 'Refresh')
  assert.equal(textOf(button), '')
  assert.equal(findAll(button, 'svg').length, 1)
  assert.equal(findAll(button, 'svg')[0].props['aria-hidden'], 'true')
  assert.equal(button.props.disabled, false)
  // Le clic est câblé sur la lecture forcée, pas sur un simple re-rendu.
  assert.match(String(button.props.onClick), /refresh: true/)
})

test('l’icône de rafraîchissement suit le thème, comme le loader', () => {
  const view = { loading: false, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const icon = (theme) => {
    const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
    api.apply(ctx)
    const list = findAll(registered.main({}), 'MissionsView')[0]
    const tree = renderTree({ ...list, props: { ...list.props, theme } })
    return findAll(tree, 'svg').filter((node) => String(node.props.className ?? '').startsWith('missions-icon-'))
  }

  const arrow = icon('default')
  assert.equal(arrow.length, 1)
  assert.equal(arrow[0].props.className, 'missions-icon-arrow')
  assert.equal(arrow[0].props['aria-hidden'], 'true')

  const shuriken = icon('manga')
  assert.equal(shuriken.length, 1)
  assert.equal(shuriken[0].props.className, 'missions-icon-shuriken')
  assert.equal(shuriken[0].props['aria-hidden'], 'true')
})

const PANEL_ERROR = { project: 'panel', message: 'tracker unreachable' }

test('le bandeau d’erreurs suit la lecture, pas l’onglet', () => {
  // Dashboard et Missions lisent le même tracker : le bandeau les couvre tous
  // les deux. Workflows lit ses propres fichiers : il n'en porte pas.
  const view = { loading: false, missions: [], errors: [PANEL_ERROR], workspaceId: 'w', workspaceRoot: '/w' }
  const mount = (tab) => {
    const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, tab])
    api.apply(ctx)
    return registered.main({})
  }

  for (const tab of ['dashboard', 'missions']) {
    const panel = mount(tab)
    const banner = findAll(panel, 'div').filter((node) => node.props.className === 'missions-errors')
    assert.equal(banner.length, 1, `bandeau attendu sur ${tab}`)
    assert.equal(banner[0].props.role, 'alert')
    assert.match(textOf(banner[0]), /tracker unreachable/)
    // Le rétablissement vit dans le bandeau, qui porte le seul Retry.
    const retry = findAll(banner[0], 'button')
    assert.equal(retry.length, 1)
    assert.equal(textOf(retry[0]), 'Retry')
    assert.match(String(retry[0].props.onClick), /refresh: true/)
  }

  // Settings lit ce que sa section lit : Workflows n'a pas de bandeau tracker,
  // et la section Usage non plus.
  const workflows = monter([EMPTY_BAR, view], memorySession({ 'missions.tab': 'workflows' }))
  assert.equal(findAll(workflows, 'div').filter((node) => node.props.className === 'missions-errors').length, 0)
  assert.doesNotMatch(JSON.stringify(workflows), /missions-errors/)
  assert.doesNotMatch(JSON.stringify(workflows), /"title":"Refresh"/)
})

test('une lecture en échec ne se déguise pas en file vide', () => {
  const view = { loading: false, missions: [], errors: [PANEL_ERROR], workspaceId: 'w', workspaceRoot: '/w' }

  // Dashboard : le message d'accueil serait un mensonge, le digest se tait et
  // le bandeau du panneau dit ce qui a échoué.
  const dash = (() => {
    const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'dashboard'])
    api.apply(ctx)
    const node = findAll(registered.main({}), 'DashboardView')[0]
    return renderTree({ ...node, props: { ...node.props } })
  })()
  assert.doesNotMatch(textOf(dash), /No mission is assigned to you yet\./)
  assert.equal(findAll(dash, 'PanelLoader').length, 0)

  // Missions : la barre reste, le corps se tait (le bandeau parle) et l'icône
  // est retirée — ce serait une seconde commande pour le même geste.
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
  api.apply(ctx)
  const node = findAll(registered.main({}), 'MissionsView')[0]
  const tree = renderTree({ ...node, props: { ...node.props } })
  assert.doesNotMatch(textOf(tree), /No open missions assigned to you\./)
  assert.equal(findAll(tree, 'button').filter((button) => button.props.className === 'missions-icon-btn').length, 0)
})

test('l’icône de rafraîchissement est servie par les deux thèmes', () => {
  const base = regle('.missions-icon-btn')
  assert.match(base, /width: 32px/)
  assert.match(base, /height: 32px/)
  assert.match(regle('.missions-icon-btn:focus-visible'), /outline:/)

  // Naruto : la même commande, au trait d'encre et à l'ombre portée.
  const manga = regle('.missions-panel[data-theme="manga"] .missions-icon-btn')
  assert.match(manga, /1\.5px solid var\(--mm-ink\)/)
  assert.match(manga, /var\(--mm-shadow\)/)
  // Les deux ancrages du thème sombre sont couverts.
  assert.match(SOURCE, /:root\[data-ds-dark-theme\] \.missions-panel\[data-theme="manga"\] \.missions-icon-btn/)
  assert.match(SOURCE, /body\[data-ds-dark-theme\] \.missions-panel\[data-theme="manga"\] \.missions-icon-btn/)
  // Comme le spinner, l'animation du shuriken s'éteint si l'on demande moins de mouvement.
  assert.match(SOURCE, /@media \(prefers-reduced-motion: reduce\) \{ \.missions-icon-shuriken \{ animation: none; \} \}/)
})

test('la source d’un onglet est déclarée dans TABS, pas recopiée', () => {
  // L'ajout d'un onglet (MIS-116) ne doit pas obliger à réécrire les conditions.
  assert.match(SOURCE, /\{ id: 'dashboard', label: 'Dashboard', source: 'tracker' \},/)
  assert.match(SOURCE, /\{ id: 'missions', label: 'Missions', source: 'tracker', badge: 'missions' \},/)
  assert.match(SOURCE, /\{ id: 'done', label: 'Done', source: 'tracker' \},/)
  // Repositories lit l'hôte et porte le compte de la racine : son badge est
  // nommé, pas un booléen, pour que chaque onglet dise quel compte il porte.
  assert.match(SOURCE, /\{ id: 'repositories', label: 'Repositories', source: 'host', badge: 'repositories' \},/)
  // Settings ne déclare pas de périmètre : ses sections portent le leur.
  assert.match(SOURCE, /\{ id: 'settings', label: 'Settings' \},/)
  assert.match(SOURCE, /\{ id: 'usage', label: 'Usage', source: 'host' \},/)
  assert.match(SOURCE, /\{ id: 'workflows', label: 'Workflows', source: 'files' \},/)
  // La barre ne rend plus Usage ni Workflows : TABS n'en garde aucune trace.
  const start = SOURCE.indexOf('const TABS = [')
  const tabs = SOURCE.slice(start, SOURCE.indexOf(']', start))
  assert.equal(tabs.includes("'usage'"), false)
  assert.equal(tabs.includes("'workflows'"), false)
  // Le périmètre de Settings se lit dans sa section, pas dans l'onglet.
  assert.match(SOURCE, /const tabSource = tab === 'settings' \? settingsSection\.source : TABS\.find/)
  assert.match(SOURCE, /const activeErrors = doneTab \? doneView\.errors : errors/)
  assert.match(SOURCE, /const failed = activeErrors\.length > 0/)
  // Le bandeau et le bouton ne se décident plus sur un id d'onglet.
  assert.doesNotMatch(SOURCE, /tab === 'missions' && errors/)
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

/**
 * L'état initial de `WorkflowsView`, dans l'ordre de ses huit hooks : la vue
 * reçoit le modèle, le brouillon posé et, si on le donne, le geste choisi.
 */
function workflowStates(draft, chosen = null) {
  return [
    { loading: false, error: null, workflows: [draft], writers: ['demandeur', 'session', 'outil'], states: [] },
    'review',
    draft,
    chosen,
    null,
    false,
    { from: '', to: '', when: '' },
    0,
  ]
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

/** L'effet qui range la vue dans la session, retrouvé par ce qu'il appelle. */
function tabEffect(effects) {
  const found = effects.find(({ fn }) => String(fn).includes('writeStoredView('))
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
  // Trois lectures au montage, dans cet ordre : la barre ouverte, l'onglet,
  // puis la barre de Done. Le montage reprend la session telle qu'elle a été
  // laissée, sans jamais mélanger les deux périmètres.
  assert.deepEqual(reads, ['missions.filters', 'missions.tab', 'missions.filters.done'])
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
  assert.match(SOURCE, /DONE_FILTERS_KEY = 'missions\.filters\.done'/)
  assert.match(SOURCE, /function filterStorage\(\) \{\s+try \{\s+return typeof sessionStorage === 'undefined' \? null : sessionStorage/)
  assert.match(SOURCE, /const \[restored\] = React\.useState\(\(\) => filterBarState\(readFilterSnapshot\(filterStorage\(\)\)\)\)/)
  assert.match(SOURCE, /const \[query, setQuery\] = React\.useState\(restored\.query\)/)
  assert.match(SOURCE, /const \[filters, setFilters\] = React\.useState\(restored\.filters\)/)
  assert.match(SOURCE, /const \[sort, setSort\] = React\.useState\(restored\.sort\)/)
  // Done a sa propre clé, relue avec son périmètre.
  assert.match(SOURCE, /const \[doneRestored\] = React\.useState\(\(\) => filterBarState\(readFilterSnapshot\(filterStorage\(\), DONE_FILTERS_KEY, \{ allowDone: true \}\), \{ allowDone: true \}\)\)/)
  assert.match(SOURCE, /const \[doneFilters, setDoneFilters\] = React\.useState\(\{ \.\.\.doneRestored\.filters, state: \['done'\] \}\)/)
  assert.match(SOURCE, /writeFilterSnapshot\(filterStorage\(\), \{ query, filters, sort \}\)/)
  assert.match(SOURCE, /writeFilterSnapshot\(filterStorage\(\), \{ query: doneQuery, filters: doneFilters, sort: doneSort \}, DONE_FILTERS_KEY, \{ allowDone: true \}\)/)
  assert.match(SOURCE, /\}, \[query, filters, sort\]\)/)
  // `Clear` rend un objet neuf : il vide les filtres sans partager l'état vide,
  // et garde le statut fixé de Done dans son propre périmètre.
  assert.match(SOURCE, /if \(doneTab\) setDoneFilters\(\{ \.\.\.EMPTY_FILTERS, state: \['done'\] \}\)/)
  assert.match(SOURCE, /else setFilters\(\{ \.\.\.EMPTY_FILTERS \}\)/)
  // Aucune clé de barre dans localStorage : elle ne survit pas à l'app.
  assert.doesNotMatch(SOURCE, /localStorage\.(?:get|set)Item\(FILTERS_KEY/)
})


test('la barre ouvre Settings sur la section stockée, et Workflows y monte l’éditeur', () => {
  const session = memorySession({ 'missions.tab': 'workflows' })
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)

  // La barre ne porte plus Workflows : un onglet Settings s'ouvre sur sa section.
  assert.equal(findAll(tree, 'SettingsView').length, 1, 'l’onglet Settings porte la vue à deux volets')
  assert.equal(findAll(tree, 'WorkflowsView').length, 1, 'la section Workflows porte l’éditeur de parcours')
  assert.equal(findAll(tree, 'MissionsView').length, 0)
  assert.equal(findAll(tree, 'MissionDrawer').length, 0, 'aucune mission n’a de tiroir sous Settings')
  assert.match(textOf(tree), /Settings/)

  // La navigation nomme les deux sections, chacune devant son icône, et la
  // section restaurée est la sélectionnée.
  const settings = renderTree(findAll(tree, 'SettingsView')[0])
  const nav = findAll(settings, 'button').filter((node) => node.props.className === 'missions-settings-tab')
  assert.deepEqual(nav.map((node) => textOf(node)), ['Usage', 'Workflows'])
  assert.equal(nav[1].props['aria-selected'], 'true', 'la section stockée est la sélectionnée')
  assert.equal(nav[0].props['aria-selected'], 'false')
  assert.equal(findAll(settings, 'svg').filter((node) => /missions-tab-icon-/.test(node.props.className ?? '')).length >= 2, true)

  // Rendue pour de vrai, la section dit ce qu'elle attend avant la première
  // réponse du serveur.
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

test('le losange du choix se dessine, montre les conditions entières et ouvre le geste', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const session = memorySession({ 'missions.tab': 'workflows' })
  const { api, ctx, registered, queue, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
  api.apply(ctx)
  const tree = registered.main({})
  const vue = findAll(tree, 'WorkflowsView')[0]
  assert.ok(vue, 'l’onglet Workflows est monté')

  // Premier rendu : le vrai graphe de la revue, sans sélection.
  queue.push(...workflowStates(review))
  const graph = renderTree(vue)
  const diamonds = findAll(graph, 'polygon').filter((node) => /wf-node--decision/.test(node.props.className ?? ''))
  assert.equal(diamonds.length, 2, '« verifier-perimetre » et « decider » portent un losange')

  const labels = findAll(graph, 'text').filter((node) => /wf-link-label--forward/.test(node.props.className ?? ''))
  const texts = labels.map((node) => textOf(node))
  assert.ok(texts.includes('tout est conforme'))
  assert.ok(texts.includes('un critère ou une preuve manque'), 'la condition longue s’affiche entière')
  assert.ok(texts.includes('la PR sort du périmètre'))
  assert.equal(texts.some((text) => text.includes('…')), false, 'aucune étiquette n’est tronquée')

  // Un clic sur le losange choisit le geste qu'il représente.
  const group = findAll(graph, 'g').find((node) => node.props.key === 'decision-decider')
  assert.ok(group, 'le losange de « decider » est cliquable')
  group.props.onClick()
  assert.deepEqual(setters.slice(-2), ['decider', null])

  // Avec ce choix, la carte « Geste » s’ouvre et le losange se marque.
  queue.push(...workflowStates(review, 'decider'))
  const chosen = renderTree(vue)
  const titles = findAll(chosen, 'div').filter((node) => node.props.className === 'wf-card-title')
  assert.equal(textOf(titles[0]), 'Geste')
  const marked = findAll(chosen, 'polygon').filter((node) => /wf-node--decision/.test(node.props.className ?? '') && /wf-node--selected/.test(node.props.className ?? ''))
  assert.equal(marked.length, 1, 'le losange du geste choisi se marque')
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

test('le blocage écrit par la route de l’hôte, jamais vers le tracker', () => {
  // Le panneau n'a pas de jeton : la seule écriture passe par la route hôte.
  assert.match(SOURCE, /missions\/api\/blocked/)
  assert.match(SOURCE, /blocked: next/)
  assert.match(SOURCE, /if \(next && !message\) return/)
})

test('une carte bloquée se teinte entièrement et porte un cadenas, sans mot', () => {
  // Plus visuel que textuel (retour du demandeur) : la carte entière prend la
  // teinte, le cadenas porte le sens, le mot ne vit plus que dans l'infobulle.
  assert.match(SOURCE, /'data-blocked': mission\.blocked \? 'true' : 'false'/)
  assert.match(SOURCE, /className: 'missions-lock'/)
  assert.match(SOURCE, /'aria-label': 'Bloqué'/)
  assert.ok(!/missions-blocked-badge/.test(SOURCE), 'la pastille textuelle a disparu')
  assert.match(regle('.missions-card[data-blocked="true"]'), /background: color-mix/)
  assert.match(regle('.missions-lock'), /border-radius: 999px/)
  assert.match(
    regle('.missions-panel[data-theme="manga"] .missions-card[data-blocked="true"]'),
    /border-color: var\(--mm-coral-deep\)/,
  )
})

test('le volet bloque avec un champ de raison et un bouton désarmé sans raison', () => {
  assert.match(SOURCE, /className: 'missions-blocked-input'/)
  // Le bouton reste désarmé tant que la raison est vide : la route exige le
  // texte, le panneau ne laisse pas envoyer un blocage muet.
  assert.match(SOURCE, /disabled: writingBlock \|\| !reason\.trim\(\)/)
  assert.match(regle('.missions-blocked'), /display: grid/)
  assert.match(regle('.missions-blocked-input'), /resize: vertical/)
  assert.match(regle('.missions-panel[data-theme="manga"] .missions-blocked'), /border: 1\.5px solid var\(--mm-ink\)/)
})

test('le volet montre la raison du blocage : auteur, âge, texte et lien', () => {
  const createdAt = new Date(Date.now() - 30 * 60000).toISOString()
  const { tree } = monterVolet({
    ...MISSION,
    updatedAt: MISSION.updated,
    blocked: true,
    blockedReason: {
      state: 'found',
      author: 'slucienvauthier-so',
      body: 'Attente du ticket de données.',
      createdAt,
      url: 'https://github.com/daedalforge/missions/issues/144#issuecomment-9',
    },
  })

  // Le texte du commentaire garde ses retours à la ligne.
  assert.match(SOURCE, /className: 'missions-blocked-reason-text'/)
  assert.match(regle('.missions-blocked-reason-text'), /white-space: pre-wrap/)

  const meta = findAll(tree, 'div').find((node) => node.props.className === 'missions-blocked-reason-meta')
  assert.ok(meta, 'la raison nomme son auteur et son âge')
  assert.equal(textOf(meta), 'slucienvauthier-so · 30 min')

  const text = findAll(tree, 'p').find((node) => node.props.className === 'missions-blocked-reason-text')
  assert.equal(textOf(text), 'Attente du ticket de données.')

  const link = findAll(tree, 'a').find((node) => node.props.className === 'missions-blocked-reason-link')
  assert.ok(link, 'la raison renvoie au commentaire du ticket')
  assert.equal(link.props.href, 'https://github.com/daedalforge/missions/issues/144#issuecomment-9')
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noreferrer')
  assert.equal(textOf(link), 'Voir le commentaire')

  // La raison remplace l'indice du label seul.
  assert.ok(!textOf(tree).includes('sa raison est en commentaire'))
})

test('une raison sans auteur affiche « Commentaire du ticket »', () => {
  const { tree } = monterVolet({
    ...MISSION,
    updatedAt: MISSION.updated,
    blocked: true,
    blockedReason: { state: 'found', author: null, body: 'Attente.', createdAt: null, url: null },
  })

  const meta = findAll(tree, 'div').find((node) => node.props.className === 'missions-blocked-reason-meta')
  assert.equal(textOf(meta), 'Commentaire du ticket')
  assert.equal(findAll(tree, 'a').filter((node) => node.props.className === 'missions-blocked-reason-link').length, 0)
})

test('une raison absente ou illisible est dite, sans texte inventé', () => {
  const empty = monterVolet({
    ...MISSION,
    updatedAt: MISSION.updated,
    blocked: true,
    blockedReason: { state: 'empty', author: null, body: '', createdAt: null, url: null },
  }).tree
  const note = findAll(empty, 'p').find((node) => node.props.className === 'missions-blocked-reason-note')
  assert.equal(textOf(note), "Aucun commentaire sur le ticket : la raison n'y est pas écrite.")
  assert.equal(textOf(empty).includes('Voir le commentaire'), false)

  const unavailable = monterVolet({
    ...MISSION,
    updatedAt: MISSION.updated,
    blocked: true,
    blockedReason: { state: 'unavailable', author: null, body: '', createdAt: null, url: null },
  }).tree
  const note2 = findAll(unavailable, 'p').find((node) => node.props.className === 'missions-blocked-reason-note')
  assert.equal(textOf(note2), "Raison illisible pour l'instant ; nouvelle tentative au prochain rafraîchissement.")
})

test('une mission non bloquée garde le formulaire et l’indice, sans raison', () => {
  const { tree } = monterVolet()
  assert.equal(findAll(tree, 'div').filter((node) => node.props.className === 'missions-blocked-reason').length, 0)
  assert.match(textOf(tree), /Le label `blocked` et sa raison partent dans le tracker/)

  // Une mission bloquée sans raison (ancienne réponse de l'hôte) garde l'indice
  // du label seul plutôt qu'une carte vide.
  const legacy = monterVolet({ ...MISSION, updatedAt: MISSION.updated, blocked: true }).tree
  assert.match(textOf(legacy), /Le label `blocked` est posé sur le ticket ; sa raison est en commentaire\./)
})

test('une raison écrite est posée sans attendre la lecture suivante', () => {
  assert.match(SOURCE, /setBlockedReason\(blockedReasonAfterWrite\(/)
  assert.match(SOURCE, /setBlockedReason\(mission\.blockedReason \?\? null\)/)
})

test('un blocage Jira ouvre la carte sur le ticket, jamais sur l’API', async () => {
  process.env.JIRA_API_TOKEN = 'test-token'
  forgetToken()
  const project = {
    id: 'manager',
    name: 'Manager',
    reference: 'SO',
    tracker: 'jira',
    jira: { site: 'https://example.atlassian.net', cloud_id: 'cloud-1', email: 'me@example.test' },
    map: { states: {}, types: {}, priorities: {}, labels: {} },
  }
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/comment') && init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          id: '10101',
          self: 'https://example.atlassian.net/rest/api/3/issue/SO-1/comment/10101',
        }),
      }
    }
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' }
  }

  // La chaîne réelle : le blocage rend son lien, le helper le pose, la carte l'affiche.
  const written = await setBlocked(project, 'SO-1', { blocked: true, message: 'Attente du contrat.', fetchImpl })
  const blockedReason = blockedReasonAfterWrite({ next: true, message: 'Attente du contrat.', comment: written.comment })
  const { tree } = monterVolet({ ...MISSION, updatedAt: MISSION.updated, blocked: true, blockedReason })

  const link = findAll(tree, 'a').find((node) => node.props.className === 'missions-blocked-reason-link')
  assert.ok(link, 'la carte doit offrir le lien vers le commentaire')
  assert.equal(link.props.href, 'https://example.atlassian.net/browse/SO-1?focusedCommentId=10101')
})

/** Le volet monté sur une mission choisie : le panneau le crée, on le rend seul. */
function monterVolet(mission = { ...MISSION, updatedAt: MISSION.updated }, overrides = {}) {
  const view = { loading: false, missions: [mission], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const panneau = [EMPTY_BAR, view, 'missions', '', EMPTY_BAR.filters, null, mission]
  const { api, ctx, registered, setters, queue, resetHooks } = charger(undefined, [...panneau])
  api.apply(ctx)

  const drawer = findAll(registered.main({}), 'MissionDrawer')[0]
  assert.ok(drawer, 'le panneau doit monter le volet quand une mission est choisie')
  const tree = renderTree({ ...drawer, props: { ...drawer.props, ...overrides } })

  // Le même volet, un tour plus tard : les setters du clic alimentent les états.
  const rerendre = () => {
    resetHooks()
    queue.length = 0
    queue.push(...panneau)
    const noeud = findAll(registered.main({}), 'MissionDrawer')[0]
    return renderTree({ ...noeud, props: { ...noeud.props, ...overrides } })
  }
  return { tree, drawer, setters, rerendre }
}

test('le volet rend la priorité comme un select natif, plus comme une ligne morte', () => {
  const { tree } = monterVolet()

  const select = findAll(tree, 'select')[0]
  assert.ok(select, 'le volet doit rendre un select de priorité')
  assert.equal(select.props.className, 'missions-priority-select')
  assert.equal(select.props['aria-label'], 'Priority')
  assert.equal(select.props.disabled, false)
  assert.equal(select.props.value, 'high')

  // Les quatre mots du workflow, dans leur ordre, avec la valeur courante
  // sélectionnée une seule fois.
  const options = select.children.filter((child) => child.type === 'option')
  assert.deepEqual(options.map((option) => option.props.value), ['urgent', 'high', 'normal', 'low'])
  assert.deepEqual(options.map((option) => option.props.selected), [false, true, false, false])
  assert.deepEqual(options.map((option) => textOf(option)), ['Urgent', 'High', 'Normal', 'Low'])

  // L'ancienne ligne en lecture seule ne doit pas survivre à côté du select.
  assert.doesNotMatch(SOURCE, /h\(DrawerRow, \{ label: 'Priority'/)
  assert.match(SOURCE, /const PRIORITY_URL = 'missions\/api\/priority'/)
  assert.match(SOURCE, /onPrioritySaved: applyPriority/)

  // Le CSS du select est présent, focus et état désactivé compris.
  assert.match(regle('.missions-priority-select'), /max-width: 100%/)
  assert.match(SOURCE, /\.missions-priority-select:focus \{/)
  assert.match(SOURCE, /\.missions-priority-select:disabled \{/)
  assert.match(SOURCE, /\.missions-priority-note--error \{/)
  // Les deux thèmes : la bordure encre de manga, comme le bloc de blocage.
  assert.match(regle('.missions-panel[data-theme="manga"] .missions-priority-select'), /border: 1\.5px solid var\(--mm-ink\)/)
  // Le message est rendu dans le volet, en alerte quand le tracker refuse.
  assert.match(SOURCE, /role: priorityNote\.error \? 'alert' : 'status'/)
})

test('sans priorité, le select propose une option vide non sélectionnable', () => {
  const { tree } = monterVolet({ ...MISSION, priority: null, updatedAt: MISSION.updated })

  const select = findAll(tree, 'select')[0]
  assert.equal(select.props.value, '')
  const options = select.children.filter((child) => child.type === 'option')
  assert.equal(options.length, 5)
  assert.deepEqual(options[0].props, { value: '', disabled: true, selected: true })
  assert.equal(textOf(options[0]), 'No priority')
  assert.deepEqual(options.slice(1).map((option) => option.props.value), ['urgent', 'high', 'normal', 'low'])

  // Le gap est reconnu sans le tracker : on ne prétend pas que c'est « low ».
  assert.match(SOURCE, /No priority/)
})

test('choisir une priorité écrit le mot canonique et ne patche que ce champ', async () => {
  const saved = []
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({ key: 'MIS-42', priority: 'urgent', value: 'priority:urgent', project: 'missions' }) }
  }

  const { tree, drawer, setters } = monterVolet(undefined, { onPrioritySaved: (data) => saved.push(data) })
  const select = findAll(tree, 'select')[0]

  await select.props.onChange({ target: { value: 'urgent' } })

  assert.deepEqual(writes(calls), [
    { url: 'missions/api/priority', method: 'POST', body: { key: 'MIS-42', priority: 'urgent' } },
  ])
  assert.deepEqual(saved, [{ key: 'MIS-42', priority: 'urgent' }])
  // La valeur locale ne bouge qu'après l'accord du tracker.
  assert.ok(setters.includes('urgent'))
  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, false)
  assert.match(note.text, /Priorité enregistrée/)

  // Choisir la valeur déjà affichée n'écrit rien.
  await select.props.onChange({ target: { value: 'high' } })
  assert.equal(writes(calls).length, 1)

  // La mise à jour du panneau ne touche que `priority` : la déclaration
  // (folder, branch, base) reste intacte — le bug latent de `onSaved`.
  const previous = { ...MISSION, updatedAt: MISSION.updated, folder: '/w/missions/MIS-42', branch: 'fix/mis-42', base: 'main', blocked: false }
  const previousView = { loading: false, missions: [previous], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  drawer.props.onPrioritySaved({ key: 'MIS-42', priority: 'urgent' })
  const setView = setters.at(-2)
  const setSelected = setters.at(-1)
  const nextView = setView(previousView)
  assert.deepEqual(nextView.missions[0], { ...previous, priority: 'urgent' })
  // La déclaration et le blocage ne bougent pas : seul `priority` est patché.
  assert.deepEqual(
    [nextView.missions[0].folder, nextView.missions[0].branch, nextView.missions[0].base, nextView.missions[0].blocked],
    ['/w/missions/MIS-42', 'fix/mis-42', 'main', false],
  )
  const nextSelected = setSelected(previous)
  assert.deepEqual(nextSelected, { ...previous, priority: 'urgent' })
})

test('un refus du tracker laisse l’ancienne priorité et le dit', async () => {
  const saved = []
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: 'tracker refused' }),
  })

  const { tree, setters } = monterVolet(undefined, { onPrioritySaved: (data) => saved.push(data) })
  const select = findAll(tree, 'select')[0]

  await select.props.onChange({ target: { value: 'urgent' } })

  // Aucun setter n'a reçu la nouvelle priorité : l'affichage reste l'ancienne.
  assert.ok(!setters.includes('urgent'))
  assert.deepEqual(saved, [])
  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, true)
  assert.match(note.text, /Priority failed: tracker refused/)
})

/* Repositories: l'onglet, ses lignes, son volet. */

/**
 * Le relevé d'usage part à chaque geste, et n'est pas une écriture métier :
 * les tests qui comptent les écritures le laissent de côté.
 */
const USAGE_ROUTE = 'missions/api/usage'
const writes = (calls) => calls.filter((call) => call.url !== USAGE_ROUTE)

const HOUR = 3600 * 1000
const REPO_NOW = Date.now()

/** Un scan tel que la route le renvoie : trois dépôts, un worktree, un vide. */
const REPO_SCAN = {
  root: '/Users/moi/projects',
  count: 3,
  durationMs: 1904,
  errors: [],
  repositories: [
    {
      name: 'zeta', path: '/Users/moi/projects/zeta', kind: 'clone', branch: 'main',
      upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, lastCommit: null, error: null, main: null,
    },
    {
      name: 'missions', path: '/Users/moi/projects/missions', kind: 'clone', branch: 'feat/mis-116',
      upstream: 'origin/feat/mis-116', ahead: 0, behind: 0, dirty: 2,
      lastCommit: { sha: 'a1b2c3d', date: REPO_NOW - 20 * 1000, subject: 'MIS-116: ajoute l’onglet' }, error: null, main: null,
    },
    {
      name: 'missions-gh20', path: '/Users/moi/projects/missions-gh20', kind: 'worktree', branch: 'gh-20-hover',
      upstream: null, ahead: 0, behind: 0, dirty: 1,
      lastCommit: { sha: 'd4e5f6a', date: REPO_NOW - 3 * HOUR, subject: 'gh-20: le survol' }, error: null,
      main: { name: 'missions', path: '/Users/moi/projects/missions' },
    },
  ],
}

/**
 * Les états du panneau, dans l'ordre de ses hooks — dont ceux, propres, de
 * l'onglet Done et le compte de la pastille — puis celui que la vue de l'onglet
 * consomme au montage : `useState` les prend dans cet ordre. Le compte de la
 * pastille est inconnu (`null`) tant qu'un test ne l'a pas lu.
 */
function repositoriesStates(view, repository = null, count = null) {
  return [
    EMPTY_BAR,
    dashboardView(DASH_MISSIONS),
    'repositories',
    '',
    { ...EMPTY_BAR.filters },
    null,
    null,
    'default',
    repository,
    EMPTY_BAR,
    { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null },
    '',
    { ...EMPTY_BAR.filters, state: ['done'] },
    null,
    count,
    // La seizième état est la section de Settings, restaurée avec l'onglet.
    'usage',
    // Le compteur de relecture de la liste Repositories, après une suppression.
    0,
    view,
  ]
}

/** L'état que la vue atteint quand le scan a répondu : le payload, pas le wrapper. */
function scanReady(data) {
  return { loading: false, data, error: null }
}

/** Le panneau monté sur l'onglet Repositories, et la vue résolue. */
function montrerRepositories(view, repository = null) {
  const { api, ctx, registered, effects, setters } = charger(undefined, repositoriesStates(view, repository), memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  const node = findAll(tree, 'RepositoriesView')[0]
  assert.ok(node, 'l’onglet Repositories porte sa vue')
  return { tree, node, inner: renderTree(node), effects, setters }
}

test('la barre d’onglets place Done et Repositories entre Missions et Workflows', () => {
  assert.match(SOURCE, /const REPOSITORIES_URL = 'missions\/api\/repositories'/)
  assert.match(SOURCE, /const REPOSITORY_URL = 'missions\/api\/repositories\/detail'/)

  // Les onglets sont des entrées de la même barre, pas des vues à part : ils
  // passent par le même câblage, et la même session les mémorise.
  const start = SOURCE.indexOf('const TABS = [')
  const tabs = SOURCE.slice(start, SOURCE.indexOf(']', start))
  assert.ok(tabs.indexOf("'missions'") < tabs.indexOf("'done'"))
  assert.ok(tabs.indexOf("'done'") < tabs.indexOf("'repositories'"))
  assert.ok(tabs.indexOf("'repositories'") < tabs.indexOf("'settings'"))
  assert.equal(tabs.includes("'usage'"), false, 'Usage ne vit plus dans la barre')
  assert.equal(tabs.includes("'workflows'"), false, 'Workflows ne vit plus dans la barre')

  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'repositories' }))
  assert.equal(findAll(tree, 'RepositoriesView').length, 1)
  assert.equal(findAll(tree, 'DashboardView').length, 0)
  assert.equal(findAll(tree, 'MissionsView').length, 0)
  assert.equal(findAll(tree, 'MissionDrawer').length, 0, 'aucune mission n’a de tiroir dans cet onglet')
  assert.match(textOf(tree), /Select a repository to see its remote/)
})

test('la barre porte cinq onglets, chacun devant son icône et son libellé', () => {
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
  const bar = findAll(tree, 'div').find((node) => node.props.className === 'missions-tabs')
  assert.ok(bar, 'la barre est rendue')

  // Done et Repositories quittent la barre avec Usage et Workflows : il reste
  // les quatre vues de travail, puis Settings qui range les deux dernières.
  const onglets = findAll(bar, 'button').filter((node) => node.props.role === 'tab')
  assert.deepEqual(onglets.map((node) => node.props.id), [
    'missions-tab-dashboard', 'missions-tab-missions', 'missions-tab-done',
    'missions-tab-repositories', 'missions-tab-settings',
  ])

  const labels = ['Dashboard', 'Missions', 'Done', 'Repositories', 'Settings']
  for (const [index, label] of labels.entries()) {
    const html = renderTree(onglets[index])
    // L'icône n'enlève rien au nom : le libellé reste le nom accessible.
    assert.match(textOf(html), new RegExp(`^${label}`))
    const svg = findAll(html, 'svg')[0]
    assert.ok(svg, `icône absente : ${label}`)
    assert.equal(svg.props['aria-hidden'], 'true', 'le dessin est décoratif')
    assert.equal(svg.props.width, 16)
    assert.equal(svg.props.height, 16)
    assert.equal(svg.props.stroke, 'currentColor')
    assert.ok(findAll(svg, 'path').length > 0, `dessin vide : ${label}`)
  }

  // La pastille du compte reste sur Missions et Repositories.
  const badges = findAll(bar, 'span').filter((node) => node.props.className === 'missions-tab-count')
  assert.equal(badges.length >= 1, true, 'le compte des missions et des dépôts reste dans la barre')
})

test('l’icône d’un onglet se redessine quand le thème change', () => {
  const dessins = (theme) => {
    const { api, ctx, registered } = charger(
      undefined,
      [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions', '', { ...EMPTY_BAR.filters }, null, null, theme],
      memorySession(),
    )
    api.apply(ctx)
    const tree = registered.main({})
    const bar = findAll(tree, 'div').find((node) => node.props.className === 'missions-tabs')
    const result = {}
    for (const button of findAll(bar, 'button').filter((node) => node.props.role === 'tab')) {
      const svg = findAll(renderTree(button), 'svg')[0]
      result[button.props.id] = {
        paths: findAll(svg, 'path').map((path) => path.props.d),
        strokeWidth: svg.props.strokeWidth,
      }
    }
    return result
  }

  const defaults = dessins('default')
  const manga = dessins('manga')
  // Le même onglet, deux dessins : le thème n'est pas un simple recoloriage.
  for (const id of Object.keys(defaults)) {
    assert.notDeepEqual(manga[id].paths, defaults[id].paths, `dessin identique dans les deux thèmes : ${id}`)
    assert.ok(manga[id].paths.length > 0)
    assert.ok(defaults[id].paths.length > 0)
  }
  // L'encre manga est plus épaisse, comme le reste de la barre.
  assert.equal(defaults['missions-tab-dashboard'].strokeWidth, 1.3)
  assert.equal(manga['missions-tab-dashboard'].strokeWidth, 1.7)
})

test('Settings montre ses deux sections dans une navigation verticale, et la section active seule', () => {
  const { api, ctx, registered, setters } = charger(
    undefined,
    [EMPTY_BAR, dashboardView(DASH_MISSIONS)],
    memorySession({ 'missions.tab': 'usage' }),
  )
  api.apply(ctx)
  const tree = registered.main({})
  const settings = findAll(tree, 'SettingsView')[0]
  assert.ok(settings, "l'onglet Settings porte la vue à deux volets")

  // La navigation est un onglet vertical, nommé autrement que la barre du haut.
  const view = settings.fn({ ...settings.props, children: settings.children })
  const nav = findAll(view, 'div').find((node) => node.props.className === 'missions-settings-nav')
  assert.ok(nav, 'la navigation de Settings est rendue')
  assert.equal(nav.props.role, 'tablist')
  assert.equal(nav.props['aria-orientation'], 'vertical')
  assert.equal(nav.props['aria-label'], 'Settings views')

  const sections = findAll(nav, 'button').filter((node) => node.props.role === 'tab')
  assert.deepEqual(sections.map((node) => textOf(node)), ['Usage', 'Workflows'])
  assert.equal(sections[0].props['aria-selected'], 'true', 'Usage est la section par défaut')
  assert.equal(sections[1].props['aria-selected'], 'false')
  assert.equal(sections[0].props['aria-controls'], 'missions-settings-panel-usage')
  assert.equal(sections[1].props['aria-controls'], 'missions-settings-panel-workflows')

  // Le panneau est décrit par son onglet, et une seule section est montée.
  const panel = findAll(view, 'section').find((node) => node.props.role === 'tabpanel')
  assert.ok(panel, 'la section est un panneau')
  assert.equal(panel.props.id, 'missions-settings-panel-usage')
  assert.equal(panel.props['aria-labelledby'], 'missions-settings-tab-usage')
  assert.equal(findAll(panel, 'UsageTab').length, 1, 'la section Usage porte sa vue')
  assert.equal(findAll(panel, 'WorkflowsView').length, 0, 'la section Workflows ne se monte pas en double')

  // Choisir Workflows bascule la section sans quitter l'onglet.
  sections[1].props.onClick()
  assert.deepEqual(setters.slice(-1), ['workflows'], 'la section change, pas l’onglet')

  // Chaque section garde son nom accessible, son icône restant décorative.
  for (const section of sections) {
    const html = renderTree(section)
    assert.equal(findAll(html, 'svg')[0].props['aria-hidden'], 'true')
    assert.match(textOf(html), /Usage|Workflows/)
  }
})

test('une session Usage ou Workflows rouvre la section, une valeur inconnue retombe sur le dashboard', () => {
  const usage = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'usage' }))
  assert.equal(findAll(usage, 'SettingsView').length, 1, 'usage rouvre Settings')
  assert.equal(findAll(usage, 'UsageTab').length, 1, '... sur sa section Usage')
  assert.equal(findAll(usage, 'WorkflowsView').length, 0)

  const workflows = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'workflows' }))
  assert.equal(findAll(workflows, 'SettingsView').length, 1, 'workflows rouvre Settings')
  assert.equal(findAll(workflows, 'WorkflowsView').length, 1, '... sur sa section Workflows')
  assert.equal(findAll(workflows, 'UsageTab').length, 0)

  // Une valeur qui ne nomme plus rien ne ressuscite aucun onglet : dashboard.
  const unknown = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'epics' }))
  assert.equal(findAll(unknown, 'SettingsView').length, 0)
  assert.equal(findAll(unknown, 'DashboardView').length, 1)
})

test('sous Settings, le tick ne relit pas la liste des missions ouvertes', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  const vraiSetInterval = globalThis.setInterval
  let tick = null
  globalThis.setInterval = (fn) => { tick = fn; return 0 }
  globalThis.fetch = async (url, init = {}) => {
    appels.push({ url: String(url), method: init.method ?? 'GET' })
    return { ok: true, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    const { api, ctx, registered, effects } = charger(
      undefined,
      [EMPTY_BAR, dashboardView(DASH_MISSIONS)],
      memorySession({ 'missions.tab': 'usage' }),
    )
    api.apply(ctx)
    registered.main({})
    // Les effets joués comme React les jouerait au montage : la lecture monte,
    // le tick s'arme.
    for (const effect of effects) effect.fn()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(appels.map((appel) => appel.url), ['missions/api/list', 'missions/api/repositories/count'], 'le montage lit l’ouvert et la pastille')

    // Le tick suit le périmètre de la section : ni tracker, ni liste ouverte.
    const tickEffect = effects.find((effect) => String(effect.fn).includes('REFRESH_MS'))
    assert.ok(tickEffect, 'le tick est armé')
    assert.equal(tickEffect.deps[3], false, 'le tick dépend du périmètre lu, pas de l’onglet : ici Settings')

    appels.length = 0
    assert.ok(tick, 'le tick est un intervalle')
    tick()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(appels.map((appel) => appel.url), ['missions/api/repositories/count'], 'Settings ne relit que la pastille')
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiSetInterval
  }
})

test('ouvrir Done lit les closes une fois, sans toucher à la liste ouverte', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(url)
    return { json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    // Onglet Missions : le montage lit l'ouvert, l'effet de Done ne lit rien.
    const ouvert = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'missions' }))
    ouvert.api.apply(ouvert.ctx)
    ouvert.registered.main({})
    const montageOuvert = ouvert.effects.find((effect) => String(effect.fn).includes('loadRepositoryCount()') && !String(effect.fn).includes('loadDone'))
    const doneOuvert = ouvert.effects.find((effect) => String(effect.fn).includes("if (tab !== 'done')"))
    montageOuvert.fn()
    doneOuvert.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(appels, ['missions/api/list', 'missions/api/repositories/count'])
    assert.equal(doneOuvert.deps[0], 'missions')

    // Onglet Done : les mêmes effets ne lisent que les closes.
    appels.length = 0
    const done = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'done' }))
    done.api.apply(done.ctx)
    done.registered.main({})
    const montageDone = done.effects.find((effect) => String(effect.fn).includes('loadRepositoryCount()') && !String(effect.fn).includes('loadDone'))
    const doneEffect = done.effects.find((effect) => String(effect.fn).includes("if (tab !== 'done')"))
    montageDone.fn()
    doneEffect.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(appels, ['missions/api/list', 'missions/api/repositories/count', 'missions/api/list?done=1'])
    assert.equal(doneEffect.deps[0], 'done')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('un clic sur l’onglet Repositories bascule le panneau et ferme le volet', () => {
  const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
  api.apply(ctx)
  const tree = registered.main({})

  const boutons = findAll(tree, 'button').filter((button) => button.props.role === 'tab')
  assert.equal(boutons.length, 5, 'Dashboard, Missions, Done, Repositories, Settings')
  const bouton = boutons.find((button) => button.props.id === 'missions-tab-repositories')
  assert.ok(bouton, 'l’onglet a un identifiant stable')
  assert.equal(bouton.props['aria-selected'], 'false')
  assert.equal(bouton.props['aria-controls'], 'missions-view-repositories')

  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => ({}) }
  }
  try {
    bouton.props.onClick()
    // Le changement d'onglet écrit l'onglet puis vide la sélection du volet :
    // un dépôt choisi dans l'onglet ne survit pas à un autre onglet.
    assert.deepEqual(setters.slice(-2), ['repositories', null])
    // Le clic ne relit pas le compte : la pastille a déjà sa valeur, et ce sont
    // le montage et le tick qui la rafraîchissent. Le scan, lui, appartient au
    // montage de la vue de l'onglet, joué séparément plus bas. Le seul appel du
    // clic est le geste qu'il compte, jamais une lecture.
    assert.equal(appels.includes('missions/api/repositories/count'), false, 'le clic ne relit pas le compte')
    assert.deepEqual(appels, ['missions/api/usage'], 'le clic ne paie que le geste qu’il compte')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('l’onglet Repositories porte son compte, et pas de pastille avant de le connaître', () => {
  const panneau = (states) => {
    const { api, ctx, registered } = charger(undefined, states, memorySession())
    api.apply(ctx)
    return registered.main({})
  }
  const onglet = (tree, id) => findAll(tree, 'button').find((button) => button.props.id === `missions-tab-${id}`)
  const pastille = (button) => findAll(button, 'span').find((span) => span.props.className === 'missions-tab-count')

  // Compte lu : la pastille est celle de Missions — même classe, même style —
  // et elle porte les dépôts de la racine, pas le total du scan (30 clones,
  // 39 entrées sur ce poste).
  const avec = panneau(repositoriesStates(scanReady(REPO_SCAN), null, 30))
  assert.equal(textOf(pastille(onglet(avec, 'repositories'))), '30')
  assert.equal(SOURCE.includes("const REPOSITORIES_COUNT_URL = 'missions/api/repositories/count'"), true)
  // Missions garde la sienne, sur la liste ouverte : deux comptes, deux sources.
  const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
  assert.equal(textOf(pastille(onglet(avec, 'missions'))), String(ouvertes))

  // Aucune réponse encore : l'onglet ne montre rien plutôt qu'un 0 non prouvé.
  const avant = panneau([EMPTY_BAR, dashboardView(DASH_MISSIONS)])
  assert.equal(pastille(onglet(avant, 'repositories')), undefined)
  assert.match(textOf(onglet(avant, 'repositories')), /Repositories/)
  // Le compte des missions, lui, est connu dès la liste : sa pastille reste.
  assert.equal(textOf(pastille(onglet(avant, 'missions'))), String(ouvertes))
})

/** Le lecteur du compte tel que le panneau l'arme : une dépendance de son effet de montage. */
function lecteurDeCompte(effects) {
  for (const effect of effects) {
    const dep = (effect.deps ?? []).find((item) => typeof item === 'function' && String(item).includes('REPOSITORIES_COUNT_URL'))
    if (dep) return dep
  }
  return null
}

test('le compte est lu au montage, sur Dashboard comme sur Missions, et jamais le scan', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const cible = String(url)
    appels.push(cible)
    if (cible === 'missions/api/repositories/count') return { ok: true, json: async () => ({ count: 30 }) }
    return { ok: true, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    // La lecture n'attend pas l'onglet Repositories : c'est tout l'objet de la
    // pastille. Sur les deux onglets du tracker, le compte part une fois, et le
    // scan — qui coûte deux appels git par dépôt — pas du tout.
    for (const onglet of ['dashboard', 'missions']) {
      appels.length = 0
      const { api, ctx, registered, effects } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': onglet }))
      api.apply(ctx)
      registered.main({})
      const montage = effects.find((effect) => String(effect.fn).includes('loadRepositoryCount()') && !String(effect.fn).includes('loadDone'))
      assert.ok(montage, `le montage lit le compte (onglet ${onglet})`)
      montage.fn()
      await new Promise((done) => setTimeout(done, 0))
      assert.deepEqual(
        appels,
        ['missions/api/list', 'missions/api/repositories/count'],
        `onglet ${onglet} : le compte une fois, le scan jamais`,
      )
      assert.equal(appels.filter((url) => url === 'missions/api/repositories').length, 0)
    }
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('un échec du compte garde la pastille, sans bandeau, et le tick retente', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  const vraiInterval = globalThis.setInterval
  const vraiClear = globalThis.clearInterval
  const ongletRepositories = (tree) => findAll(tree, 'button').find((button) => button.props.id === 'missions-tab-repositories')
  const pastille = (tree) => {
    const span = findAll(ongletRepositories(tree), 'span').find((node) => node.props.className === 'missions-tab-count')
    return span === undefined ? undefined : textOf(span)
  }
  const bandeaux = (tree) => findAll(tree, 'div').filter((node) => node.props.className === 'missions-errors')

  const { api, ctx, registered, effects, setters } = charger(undefined, repositoriesStates(scanReady(REPO_SCAN), null, 30), memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  assert.equal(pastille(tree), '30', 'une pastille déjà affichée part du compte connu')

  const lecture = lecteurDeCompte(effects)
  assert.ok(lecture, 'le compte est une dépendance de l’effet de montage')

  try {
    // Un échec ne pousse aucun compte : la pastille garde le sien, aucun 0
    // n'est affiché, et une pastille n'allume pas de bandeau.
    globalThis.fetch = async (url) => { appels.push(String(url)); throw new Error('offline') }
    const avant = setters.length
    await lecture()
    assert.equal(setters.length, avant, 'un échec ne pousse aucun compte')
    assert.deepEqual(appels, ['missions/api/repositories/count'], 'le compte est relu, une fois')
    assert.equal(pastille(tree), '30', 'la pastille garde sa valeur')
    assert.equal(bandeaux(tree).length, 0, 'une pastille n’allume pas de bandeau')

    // Le tick de 60 s retente, quel que soit l'onglet : on arme l'intervalle et
    // on joue son tour à la main, comme le demande la preuve.
    let tour = null
    globalThis.setInterval = (callback) => { tour = callback; return 1 }
    globalThis.clearInterval = () => {}
    const tick = effects.find((effect) => String(effect.fn).includes('setInterval'))
    assert.ok(tick, 'le panneau arme son tick de 60 s')
    const arreter = tick.fn()
    assert.equal(typeof arreter, 'function', 'le tick se démonte avec le panneau')

    // La relecture réussit : le compte est republié, toujours sans bandeau.
    globalThis.fetch = async (url) => {
      appels.push(String(url))
      if (String(url) === 'missions/api/repositories/count') return { ok: true, json: async () => ({ count: 31 }) }
      return { ok: true, json: async () => ({ missions: [], errors: [] }) }
    }
    tour()
    await new Promise((done) => setTimeout(done, 0))
    assert.ok(setters.includes(31), 'le tick republie le compte lu')
    assert.equal(bandeaux(tree).length, 0, 'aucun bandeau après un échec puis un succès')
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiInterval
    globalThis.clearInterval = vraiClear
  }

  // La valeur republiée est celle que la pastille affiche.
  const apres = charger(undefined, repositoriesStates(scanReady(REPO_SCAN), null, 31), memorySession())
  apres.api.apply(apres.ctx)
  const arbre = apres.registered.main({})
  assert.equal(pastille(arbre), '31')
})

test('la rangée d’onglets défile plutôt que de couper un libellé', () => {
  // Une troisième pastille peut déborder un panneau étroit : la rangée défile,
  // et la barre de défilement qu'elle dessinerait reste masquée.
  assert.match(regle('.missions-tabs'), /overflow-x: auto/)
  assert.match(regle('.missions-tabs'), /scrollbar-width: none/)
  assert.match(SOURCE, /\.missions-tabs::-webkit-scrollbar \{ display: none; \}/)
  // La pastille ne gagne aucune règle propre : elle est celle de Missions, dans
  // les deux thèmes.
  assert.match(regle('.missions-tab-count'), /border-radius: 9px/)
  assert.match(regle('.missions-panel[data-theme="manga"] .missions-tab-count'), /background: var\(--mm-orange\)/)
  assert.doesNotMatch(SOURCE, /missions-tab-count--/)
})

test('l’onglet demande le scan au serveur, une fois, à son montage', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return { ok: true, json: async () => REPO_SCAN }
  }
  try {
    const { api, ctx, registered, effects } = charger(undefined, repositoriesStates(scanReady(REPO_SCAN)), memorySession())
    api.apply(ctx)
    const tree = registered.main({})
    const avant = effects.length
    renderTree(findAll(tree, 'RepositoriesView')[0])
    // Les effets du panneau (dont son rafraîchissement de 60 s) ne sont pas
    // joués : seul celui que la vue arme en se montant l'est.
    assert.equal(effects.length - avant, 1, 'un seul effet de chargement pour l’onglet')
    for (const effect of effects.slice(avant)) effect.fn()
    await new Promise((done) => setTimeout(done, 0))

    assert.equal(appels.length, 1, 'un scan par ouverture de l’onglet')
    assert.equal(appels[0].url, 'missions/api/repositories')
    assert.equal(appels[0].options.headers.accept, 'application/json')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('chaque dépôt est une ligne : nom, branche, état, dernier commit, âge', () => {
  const { inner } = montrerRepositories(scanReady(REPO_SCAN))

  // L'en-tête dit ce que le scan a lu : les clones d'un côté, les worktrees de
  // l'autre, le tout sans gonfler le compte des dépôts.
  assert.match(textOf(inner), /2 repositories · 1 worktree · scanned in 1\.9 s/)
  assert.match(textOf(inner), /\/Users\/moi\/projects/)

  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.equal(lignes.length, 3)
  // Le plus récent d'abord ; un dépôt sans commit ferme la liste.
  assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions', 'missions-gh20', 'zeta'])

  const [missions, worktree, vide] = lignes
  assert.equal(missions.props.title, '/Users/moi/projects/missions')
  assert.match(missions.props['aria-label'], /^missions, feat\/mis-116, 2 files, MIS-116: ajoute l’onglet$/)
  assert.match(textOf(missions), /feat\/mis-116/)
  assert.match(textOf(missions), /2 files/)
  assert.match(textOf(missions), /MIS-116: ajoute l’onglet/)
  assert.match(textOf(missions), /now/, 'le commit a moins d’une minute')

  // Un worktree se distingue d'un clone : même enfant de la racine, autre nature.
  assert.equal(worktree.props['aria-label'], 'missions-gh20, gh-20-hover, 1 file, gh-20: le survol')
  assert.match(textOf(worktree), /worktree/)
  assert.match(textOf(worktree), /3 h/)

  // Un dépôt vide est une ligne, pas une absence.
  assert.match(textOf(vide), /clean/)
  assert.match(textOf(vide), /no commit yet/)
  assert.equal(vide.props['aria-label'], 'zeta, main, clean, no commit yet')
})

test('un worktree porte la bascule vers son principal, un clone n’en a pas', () => {
  const { inner } = montrerRepositories(scanReady(REPO_SCAN))
  const lignes = findAll(inner, 'li').filter((li) => li.props.className === 'missions-repo-rowitem')
  assert.equal(lignes.length, 3)
  const bascule = (li) => findAll(li, 'button').find((button) => button.props.className === 'missions-repo-main')
  const [missions, worktree, zeta] = lignes

  const créneau = (li) => findAll(li, 'span').find((span) => span.props.className === 'missions-repo-main-slot')
  assert.equal(bascule(missions), undefined, 'un clone ne bascule nulle part')
  assert.equal(bascule(zeta), undefined)
  assert.ok(créneau(missions), 'un clone réserve la colonne de la bascule')
  assert.equal(créneau(missions).props['aria-hidden'], 'true')
  assert.equal(créneau(worktree), undefined, 'le worktree n’a pas de créneau vide')

  const bouton = bascule(worktree)
  assert.ok(bouton, 'le worktree porte sa bascule')
  assert.equal(nomDuGeste(bouton), 'Bring missions-gh20 into missions')
  // L'infobulle dit ce que le clic fait : la branche reprise, le dossier perdu.
  assert.match(bouton.props.title, /^Bring missions-gh20 into missions \(\/Users\/moi\/projects\/missions\)/)
  assert.match(bouton.props.title, /worktree folder is removed$/)
  assert.equal(bouton.props.disabled, false)
  assert.equal(textOf(bouton), '', 'la bascule ne porte que son dessin')
  const dessin = findAll(bouton, 'svg')
  assert.equal(dessin.length, 1)
  assert.equal(dessin[0].props['aria-hidden'], 'true')
  // La bascule est un frère de la ligne, pas un bouton dans le bouton.
  assert.equal(worktree.children.filter((child) => child && child.type === 'button').length, 2)

  // L'en-tête garde la même géométrie : la cellule terminale vide aligne la
  // colonne de la bascule sur celle des lignes.
  const head = findAll(inner, 'div').find((div) => div.props.className === 'missions-repo-head')
  assert.ok(head)
  assert.equal(head.children.filter((child) => child).length, 2)
  assert.equal(head.children.filter((child) => child)?.at(-1).props.className, 'missions-repo-headmain')
})

test('une bascule sans cible reste là, désarmée, et dit pourquoi', () => {
  const worktree = REPO_SCAN.repositories[2]
  const scan = {
    ...REPO_SCAN,
    repositories: [
      { ...worktree, name: 'dehors', main: { name: null, path: '/Users/moi/ailleurs/missions' } },
      { ...worktree, name: 'inconnu', main: null },
    ],
  }
  const { inner } = montrerRepositories(scanReady(scan))
  const bascules = findAll(inner, 'button').filter((button) => button.props.className === 'missions-repo-main')
  assert.equal(bascules.length, 2)
  for (const bouton of bascules) {
    assert.equal(bouton.props.disabled, true)
    assert.equal(bouton.props.onClick, undefined)
  }
  const [dehors, inconnu] = bascules
  assert.equal(dehors.props.title, 'outside the workspace root : /Users/moi/ailleurs/missions')
  assert.equal(inconnu.props.title, 'main worktree unknown')
})

test('la bascule ramène le worktree dans le principal, après confirmation, et ne compte qu’une fois', async () => {
  const spy = espionUsage()
  const vraiConfirm = globalThis.confirm
  let question = ''
  globalThis.confirm = (asked) => { question = String(asked); return true }
  try {
    const rendu = montrerRepositories(scanReady(REPO_SCAN))
    const bouton = findAll(rendu.inner, 'button').find((button) => button.props.className === 'missions-repo-main')
    assert.ok(bouton)
    await bouton.props.onClick()

    // La confirmation dit ce qui bouge : la branche reprise, le dossier perdu.
    assert.match(question, /Bring gh-20-hover into missions\?/)
    assert.match(question, /missions-gh20/)
    assert.match(question, /will be removed/)
    assert.match(question, /must be clean/)

    // L'hôte reçoit le nom du worktree sur la route d'écriture, et rien d'autre.
    const adopt = spy.appels.find((appel) => appel.url === 'missions/api/repositories/adopt')
    assert.ok(adopt, 'la bascule écrit sur la route dédiée')
    assert.equal(adopt.method, 'POST')
    assert.deepEqual(adopt.body, { name: 'missions-gh20' })

    // Un geste, un compte : le relevé nomme l'action, pas une navigation.
    spy.geste('repository.adopt', 'missions-gh20')
    assert.equal(spy.postes().length, 0)

    // La vue arme la relecture, et le panneau ne change pas de volet.
    assert.ok(
      rendu.setters.some((value) => (typeof value === 'function' ? value(0) === 1 : value === 1)),
      'la liste est relue après le geste',
    )
    assert.equal(rendu.setters.some((value) => value === 'missions'), false, 'l’onglet Repositories ne bouge pas')
    // La ligne est passée par « en cours » avant de célébrer le résultat.
    const etats = rendu.setters.filter((value) => value && value.name === 'missions-gh20' && value.state)
    assert.deepEqual(etats.map((value) => value.state), ['running', 'done'])
    assert.match(etats.at(-1).message, /missions now holds gh-20-hover; the worktree missions-gh20 is gone\./)
  } finally {
    globalThis.confirm = vraiConfirm
    spy.restore()
  }
})

test('une confirmation refusée n’écrit rien et ne compte rien', async () => {
  const spy = espionUsage()
  const vraiConfirm = globalThis.confirm
  globalThis.confirm = () => false
  try {
    const rendu = montrerRepositories(scanReady(REPO_SCAN))
    const bouton = findAll(rendu.inner, 'button').find((button) => button.props.className === 'missions-repo-main')
    await bouton.props.onClick()
    assert.deepEqual(spy.appels, [], 'aucune requête sans confirmation')
    assert.deepEqual(rendu.setters, [], 'aucun état touché')
  } finally {
    globalThis.confirm = vraiConfirm
    spy.restore()
  }
})

test('un refus de l’hôte est le bandeau, mot pour mot, et la liste est relue', async () => {
  const vraiFetch = globalThis.fetch
  const vraiConfirm = globalThis.confirm
  const appels = []
  globalThis.confirm = () => true
  globalThis.fetch = async (url, init = {}) => {
    appels.push({ url: String(url), method: init.method ?? 'GET' })
    if (init.method === 'POST') {
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: 'Manager has uncommitted changes (1 file: yarn.lock) — commit or stash them first', side: 'main', files: ['yarn.lock'] }),
      }
    }
    return { ok: true, json: async () => ({}) }
  }
  try {
    const rendu = montrerRepositories(scanReady(REPO_SCAN))
    const bouton = findAll(rendu.inner, 'button').find((button) => button.props.className === 'missions-repo-main')
    await bouton.props.onClick()
    const erreur = rendu.setters.filter((value) => value && value.state === 'error').at(-1)
    assert.ok(erreur, 'la ligne porte l’erreur')
    assert.equal(erreur.message, 'Manager has uncommitted changes (1 file: yarn.lock) — commit or stash them first')
    assert.ok(
      rendu.setters.some((value) => (typeof value === 'function' ? value(0) === 1 : value === 1)),
      'même un refus relit la liste',
    )
    assert.equal(appels.some((appel) => appel.method === 'POST' && appel.url.includes('adopt')), true)
  } finally {
    globalThis.confirm = vraiConfirm
    globalThis.fetch = vraiFetch
  }
})

test('un worktree que git garde est un résultat partiel, pas un échec', async () => {
  const vraiFetch = globalThis.fetch
  const vraiConfirm = globalThis.confirm
  globalThis.confirm = () => true
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, branch: 'gh-20-hover', main: { name: 'missions', path: '/Users/moi/projects/missions' }, removed: false, reason: 'is locked' }) }
    }
    return { ok: true, json: async () => ({}) }
  }
  try {
    const rendu = montrerRepositories(scanReady(REPO_SCAN))
    const bouton = findAll(rendu.inner, 'button').find((button) => button.props.className === 'missions-repo-main')
    await bouton.props.onClick()
    const fin = rendu.setters.filter((value) => value && value.name === 'missions-gh20').at(-1)
    assert.equal(fin.state, 'partial')
    assert.match(fin.message, /missions now holds gh-20-hover, but the worktree missions-gh20 stayed: is locked/)
  } finally {
    globalThis.confirm = vraiConfirm
    globalThis.fetch = vraiFetch
  }
})

test('un dépôt illisible reste une ligne, et l’en-tête compte les refus', () => {
  const scan = {
    ...REPO_SCAN,
    count: 2,
    errors: [{ name: 'broken', message: 'not a git repository' }],
    repositories: [
      REPO_SCAN.repositories[1],
      {
        name: 'broken', path: '/Users/moi/projects/broken', kind: 'clone', branch: null,
        upstream: null, ahead: 0, behind: 0, dirty: 0, lastCommit: null, error: 'not a git repository',
      },
    ],
  }
  const { inner } = montrerRepositories(scanReady(scan))

  assert.match(textOf(inner), /2 repositories · scanned in 1\.9 s · 1 unreadable/)
  const ligne = findAll(inner, 'button').find((button) => button.props['data-repository'] === 'broken')
  assert.match(ligne.props['aria-label'], /unreadable/)
  assert.match(ligne.props.title, /not a git repository/)
  assert.match(textOf(inner), /One repository was left unreadable: broken\./)
  assert.match(textOf(inner), /The scan did not stop for them\./)
})

test('un scan en échec est un bandeau, une racine vide est un état vide', () => {
  const echec = montrerRepositories({ loading: false, data: null, error: 'permission denied' })
  const bandeau = findAll(echec.inner, 'div').find((div) => div.props.className === 'missions-repos-error')
  assert.ok(bandeau, 'l’échec est visible')
  assert.equal(bandeau.props.role, 'alert')
  assert.match(textOf(bandeau), /The scan failed\./)
  assert.match(textOf(bandeau), /permission denied/)

  const vide = montrerRepositories(scanReady({ root: '/Users/moi/projects/vide', count: 0, durationMs: 40, errors: [], repositories: [] }))
  assert.match(textOf(vide.inner), /No repository in the workspace root\./)
  assert.match(textOf(vide.inner), /Scanned \/Users\/moi\/projects\/vide\./)
})

test('le volet lit le détail du dépôt choisi et le montre, sans liste de commits', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = {
    ...repository,
    remote: 'https://github.com/daedalforge/missions.git',
    ahead: 1,
    behind: 0,
    commits: [
      { sha: 'a1b2c3d', date: Date.now() - 60 * 1000, subject: 'MIS-116: ajoute l’onglet' },
      { sha: '5de99bc', date: Date.now() - 26 * HOUR, subject: 'MIS-114: empile les étiquettes' },
    ],
  }
  const { api, ctx, registered } = charger(undefined, repositoriesStates(scanReady(detail), repository), memorySession())
  api.apply(ctx)
  const tree = registered.main({})

  const node = findAll(tree, 'RepositoryDrawer')[0]
  assert.ok(node, 'le volet du dépôt choisi est monté')
  const inner = renderTree(node)

  // Trois sections, Details au repos : c'est lui que le volet ouvre.
  const onglets = findAll(inner, 'button').filter((button) => button.props.role === 'tab')
  assert.deepEqual(onglets.map((button) => textOf(button)), ['Details', 'History', 'Worktrees'])
  assert.equal(onglets[0].props['aria-selected'], 'true')
  assert.equal(onglets[1].props['aria-selected'], 'false')

  assert.match(textOf(inner), /feat\/mis-116/)
  assert.match(textOf(inner), /https:\/\/github\.com\/daedalforge\/missions\.git/)
  assert.match(textOf(inner), /origin\/feat\/mis-116/)
  assert.match(textOf(inner), /1 ahead · 0 behind/)
  // Les commits ont quitté Details pour History : aucun n'est rendu ici.
  assert.doesNotMatch(textOf(inner), /a1b2c3d/)
  assert.doesNotMatch(textOf(inner), /commit/)
  assert.equal(findAll(inner, 'select').length, 0, 'Details ne montre pas encore le sélecteur de branche')
  assert.equal(findAll(inner, 'li').length, 0, 'Details n’a plus de liste')

  // Le volet se ferme par sa croix, et Échap : la touche est armée et retirée
  // avec le volet.
  assert.match(SOURCE, /if \(event\.key === 'Escape'\) onClose\(\)/)
  assert.match(SOURCE, /document\.addEventListener\('keydown', onKey\)/)
  assert.match(SOURCE, /return \(\) => document\.removeEventListener\('keydown', onKey\)/)
})

/**
 * Le volet d'un dépôt, monté avec les états que ses hooks consomment :
 * `repositoriesStates` puis [section, history, tree] — le volet est invoqué par
 * `renderTree`, c'est donc là que ses trois `useState` prennent la file.
 */
function volet(states) {
  const { api, ctx, registered, setters, effects } = charger(undefined, states, memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  const node = findAll(tree, 'RepositoryDrawer')[0]
  assert.ok(node, 'le volet du dépôt choisi est monté')
  return { tree, node, inner: renderTree(node), setters, effects }
}

test('History montre une page, le total de la branche, et charge la suivante', async () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const page = (commits, hasMore) => ({
    branch: 'feat/mis-116',
    branches: ['main', 'feat/mis-116'],
    total: 3094,
    hasMore,
    commits,
  })
  const history = {
    loading: false, more: false, error: null,
    data: page([
      { sha: 'a1b2c3d', date: REPO_NOW - 60 * 1000, subject: 'MIS-116: ajoute l’onglet' },
      { sha: '5de99bc', date: REPO_NOW - 26 * HOUR, subject: 'MIS-114: empile les étiquettes' },
    ], true),
  }
  const { inner } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'history', history, { loading: false, data: null, error: null },
  ])

  const select = findAll(inner, 'select')[0]
  assert.deepEqual(findAll(inner, 'option').map((option) => option.props.value), ['main', 'feat/mis-116'])
  assert.equal(select.props.value, 'feat/mis-116', 'le sélecteur montre la branche lue')
  assert.match(textOf(inner), /3 094 commits on feat\/mis-116/, 'le total porte les milliers espacés')
  assert.match(textOf(inner), /a1b2c3d/)
  assert.match(textOf(inner), /MIS-114: empile les étiquettes/)
  assert.equal(findAll(inner, 'li').filter((li) => li.props.className === 'missions-history-commit').length, 2)

  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => page([], false) }
  }
  try {
    // Changer de branche repart de la première page, et le dit au serveur.
    await select.props.onChange({ target: { value: 'main' } })
    const commits = () => appels.filter((url) => String(url).includes('repositories/commits'))
    assert.match(commits()[0], /repositories\/commits\?name=missions&skip=0&branch=main/)

    // « Show more » demande la page suivante de la branche affichée.
    const plus = findAll(inner, 'button').find((button) => textOf(button) === 'Show more')
    assert.ok(plus, 'la page a une suite')
    await plus.props.onClick()
    assert.match(commits()[1], /skip=2/, 'la page suivante commence après les deux lignes lues')
    assert.match(commits()[1], /branch=feat%2Fmis-116/, 'la branche choisie est conservée')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('passer à History charge la branche par défaut, sans en imposer une', async () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const { effects } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'history', { loading: false, more: false, data: null, error: null }, { loading: false, data: null, error: null },
  ])

  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => ({ branch: 'main', branches: ['main'], commits: [], hasMore: false, total: 0 }) }
  }
  try {
    const lecture = effects.find((effect) => Array.isArray(effect.deps) && effect.deps[0] === 'history' && effect.deps[1] === repository.name)
    assert.ok(lecture, 'un effet lit History à son ouverture')
    lecture.fn()
    await new Promise((done) => setImmediate(done))
  } finally {
    globalThis.fetch = vraiFetch
  }

  assert.match(appels[0], /repositories\/commits\?name=missions&skip=0$/, 'la première page, sans branche imposée')
})

test('Show more ajoute la page suivante au lieu de la remplacer', async () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const page = (commits, hasMore) => ({ branch: 'main', branches: ['main'], total: 3, hasMore, commits })
  const history = {
    loading: false, more: false, error: null,
    data: page([
      { sha: 'a1b2c3d', date: REPO_NOW, subject: 'MIS-1: un' },
      { sha: '5de99bc', date: REPO_NOW, subject: 'MIS-2: deux' },
    ], true),
  }
  const { inner, setters } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'history', history, { loading: false, data: null, error: null },
  ])

  const vraiFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => page([{ sha: 'fffffff', date: REPO_NOW, subject: 'MIS-3: trois' }], false),
  })
  try {
    const plus = findAll(inner, 'button').find((button) => textOf(button) === 'Show more')
    await plus.props.onClick()
  } finally {
    globalThis.fetch = vraiFetch
  }

  // Pendant la lecture, la page affichée reste sous le sélecteur : il ne
  // disparaît pas sous le curseur qui vient de demander la suite.
  const pendant = setters[0](history)
  assert.equal(pendant.more, true)
  assert.equal(pendant.data, history.data)

  // À l'arrivée, la page reçue s'ajoute à celle qu'on avait.
  const apres = setters[1]({ ...history, loading: true, more: true })
  assert.equal(apres.loading, false)
  assert.equal(apres.more, false)
  assert.deepEqual(apres.data.commits.map((commit) => commit.sha), ['a1b2c3d', '5de99bc', 'fffffff'])
  assert.equal(apres.data.hasMore, false, 'la dernière page le dit')
})

test('un échec de History est un bandeau, pas un chargement sans fin', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const { inner } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'history', { loading: false, more: false, data: null, error: 'no local branch to read' }, { loading: false, data: null, error: null },
  ])

  // La première lecture a échoué : rien à montrer, mais l'échec se dit — le
  // sélecteur n'attend plus une lecture qui n'arrivera jamais.
  const bandeau = findAll(inner, 'div').find((div) => div.props.className === 'missions-repos-error')
  assert.ok(bandeau, 'l’échec est visible')
  assert.equal(bandeau.props.role, 'alert')
  assert.match(textOf(bandeau), /no local branch to read/)
  assert.doesNotMatch(textOf(inner), /Reading branches…/, 'le sélecteur ne lit plus indéfiniment')
  assert.doesNotMatch(textOf(inner), /Loading…/, 'aucun chargement sans fin sous le bandeau')
})

test('les onglets du volet basculent, et un autre dépôt ramène à Details', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const { inner, setters, effects } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'details', { loading: false, more: false, data: null, error: null }, { loading: false, data: null, error: null },
  ])

  const onglet = findAll(inner, 'button').find((button) => textOf(button) === 'Worktrees')
  onglet.props.onClick()
  assert.equal(setters.at(-1), 'worktrees', 'l’onglet choisi devient la section')

  // La remise à zéro ne dépend que du nom, et ouvre Details.
  const remise = effects.find((effect) => Array.isArray(effect.deps) && effect.deps.length === 1 && effect.deps[0] === repository.name)
  assert.ok(remise, 'un effet écoute le changement de dépôt')
  remise.fn()
  assert.equal(setters.at(-1), 'details', 'un autre dépôt rouvre le volet sur Details')
})

test('Worktrees dessine le layout, ses commits, ses marques et ses worktrees', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const arbre = {
    layout: true,
    branches: [
      { name: 'main', depth: 0, parent: null, annotation: null, worktree: 'myapp', commits: [], truncated: false, missing: false },
      { name: 'feat/a', depth: 1, parent: 'main', annotation: 'PR #12', worktree: 'myapp-12', commits: [{ sha: 'c0ffee1', date: REPO_NOW, subject: 'feat: a' }], truncated: true, missing: false },
      { name: 'old/x', depth: 1, parent: 'main', annotation: null, worktree: null, commits: [], truncated: false, missing: true },
    ],
    worktrees: [
      { path: '/Users/moi/projects/myapp', branch: 'main', head: 'abc1234', current: true, main: true, name: 'myapp' },
      { path: '/Users/moi/projects/myapp-12', branch: 'feat/a', head: 'def5678', current: false, main: false, name: 'myapp-12' },
      { path: '/Users/moi/projects/myapp-hot', branch: 'hotfix/24', head: 'fff9012', current: false, main: false, name: 'myapp-hot' },
    ],
  }
  const { inner } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'worktrees', { loading: false, more: false, data: null, error: null }, { loading: false, data: arbre, error: null },
  ])

  const lignes = findAll(inner, 'li').filter((li) => /missions-tree-branch/.test(String(li.props.className)))
  assert.equal(lignes.length, 3, 'une ligne par branche déclarée')
  assert.equal(lignes[0].props.style.paddingLeft, '10px', 'la racine est au bord')
  assert.equal(lignes[1].props.style.paddingLeft, '24px', 'un cran par profondeur')

  assert.match(textOf(lignes[0]), /myapp/, 'le worktree qui porte la branche est nommé')
  assert.match(textOf(lignes[1]), /PR #12/, 'l’annotation du fichier est lue')
  assert.match(textOf(lignes[1]), /myapp-12/)
  assert.match(textOf(lignes[1]), /c0ffee1/)
  assert.match(textOf(lignes[1]), /\+/, 'au-delà de dix commits, la marque dit qu’il y en a d’autres')
  assert.match(textOf(lignes[2]), /not local/, 'une branche absente est marquée, pas cachée')

  // L'onglet liste tous les worktrees sous la même section, layout ou pas :
  // celui d'une branche qu'il ne déclare pas n'est pas perdu, et le chemin
  // entier s'y lit.
  const section = findAll(inner, 'h3').filter((node) => node.props.className === 'missions-drawer-section-title')
  assert.deepEqual(section.map((node) => textOf(node)), ['Worktrees'])
  const flat = findAll(inner, 'ul').filter((ul) => ul.props['aria-label'] === 'Worktrees')
  assert.equal(flat.length, 1, 'une seule liste de worktrees')
  assert.match(textOf(flat[0]), /\/Users\/moi\/projects\/myapp-hot/, 'le chemin entier se lit')
  assert.match(textOf(flat[0]), /hotfix\/24/, 'une branche hors du layout garde son worktree')
})

test('un layout complet liste quand même ses worktrees, sans bouton sur le principal', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const arbre = {
    layout: true,
    branches: [
      { name: 'main', depth: 0, parent: null, annotation: null, worktree: 'myapp', commits: [], truncated: false, missing: false },
    ],
    worktrees: [
      { path: '/Users/moi/projects/myapp', branch: 'main', head: 'abc1234', current: true, main: true, name: 'myapp' },
    ],
  }
  const { inner } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'worktrees', { loading: false, more: false, data: null, error: null }, { loading: false, data: arbre, error: null },
  ])

  // Le layout ne remplace pas la liste : le worktree s'y lit, marqué « main ».
  const flat = findAll(inner, 'ul').filter((ul) => ul.props['aria-label'] === 'Worktrees')
  assert.equal(flat.length, 1)
  assert.match(textOf(flat[0]), /\/Users\/moi\/projects\/myapp/)
  assert.match(textOf(flat[0]), /main/)

  // Le principal n'a pas de bouton : git ne retire pas la souche des autres.
  const gestes = findAll(inner, 'button').filter((node) => /^Remove the worktree /.test(node.props['aria-label'] ?? ''))
  assert.deepEqual(gestes, [])
})

test('sans layout, Worktrees liste à plat et le dit', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const arbre = {
    layout: false,
    branches: [],
    worktrees: [
      { path: '/Users/moi/projects/alpha', branch: 'main', head: 'abc', current: true, main: true, name: 'alpha' },
      { path: '/Users/moi/projects/beta', branch: null, head: 'def', current: false, main: false, name: 'beta' },
      { path: '/private/tmp/beta-away', branch: null, head: 'def', current: false, main: false, name: null },
    ],
  }
  const { inner } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'worktrees', { loading: false, more: false, data: null, error: null }, { loading: false, data: arbre, error: null },
  ])

  assert.match(textOf(inner), /No git machete layout for this repository/)
  assert.match(textOf(inner), /alpha/)
  assert.match(textOf(inner), /beta/)
  assert.match(textOf(inner), /detached/, 'un worktree détaché le dit, il ne disparaît pas')

  // Sans layout, le geste s'offre au même endroit : chaque worktree non
  // principal enfant direct de la racine, et seulement ceux-là.
  const gestes = findAll(inner, 'button').filter((node) => /^Remove the worktree /.test(node.props['aria-label'] ?? ''))
  assert.deepEqual(gestes.map((node) => node.props['aria-label']), ['Remove the worktree beta'])
  assert.match(textOf(inner), /\/private\/tmp\/beta-away/, 'un dossier hors racine se lit, sans bouton')
})

/**
 * Le volet du dépôt ouvert, sur l'onglet Worktrees, avec l'arbre que le test
 * lui donne. `repositoriesStates` fournit les états du panneau ; les trois
 * états de l'onglet viennent après, dans l'ordre des hooks du volet.
 */
function voletWorktrees(arbre, repository = REPO_SCAN.repositories[1]) {
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  return volet([
    ...repositoriesStates(scanReady(detail), repository),
    'worktrees', { loading: false, more: false, data: null, error: null },
    { loading: false, data: arbre, error: null },
  ])
}

/** L'arbre d'un dépôt et de son worktree, tous deux enfants de la racine. */
const ARBRE_DUO = {
  layout: true,
  branches: [
    { name: 'main', depth: 0, parent: null, annotation: null, worktree: 'missions', commits: [], truncated: false, missing: false },
  ],
  worktrees: [
    { path: '/Users/moi/projects/missions', branch: 'feat/mis-116', head: 'a1b2c3d', current: true, main: true, name: 'missions' },
    { path: '/Users/moi/projects/missions-gh20', branch: 'gh-20-hover', head: 'd4e5f6a', current: false, main: false, name: 'missions-gh20' },
  ],
}

/** Le bouton du geste, tel que `RepositoryWorktree` le nomme. */
function boutonRemove(inner, name) {
  return findAll(inner, 'button').find((node) => node.props['aria-label'] === `Remove the worktree ${name}`) ?? null
}

/**
 * Un serveur de test : la suppression répond par la file donnée, le relevé
 * d'usage par un succès vide. Les appels sont gardés avec leur corps.
 */
function fauxServeur(reponses = []) {
  const vraiFetch = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url, init = {}) => {
    appels.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    if (String(url) === 'missions/api/repositories/remove') {
      const reponse = reponses.shift() ?? { ok: true, status: 200, body: { name: 'missions-gh20', removed: true } }
      return { ok: reponse.ok !== false, status: reponse.status ?? 200, json: async () => reponse.body ?? {} }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  return { appels, restore: () => { globalThis.fetch = vraiFetch } }
}

/** Un `confirm` qui répond la file donnée et garde les questions posées. */
function fauxConfirm(reponses) {
  const vraiConfirm = globalThis.confirm
  const questions = []
  globalThis.confirm = (question) => {
    questions.push(question)
    return reponses.length > 0 ? reponses.shift() : false
  }
  return { questions, restore: () => { globalThis.confirm = vraiConfirm } }
}

test('la confirmation nomme le worktree, son chemin et la branche gardée', async () => {
  const serveur = fauxServeur()
  const confirmation = fauxConfirm([false])
  try {
    const { inner } = voletWorktrees(ARBRE_DUO)
    const bouton = boutonRemove(inner, 'missions-gh20')
    assert.ok(bouton, 'le worktree non principal porte le geste')
    await bouton.props.onClick()

    assert.equal(confirmation.questions.length, 1, 'une question, pas deux')
    assert.match(confirmation.questions[0], /missions-gh20/)
    assert.match(confirmation.questions[0], /\/Users\/moi\/projects\/missions-gh20/)
    assert.match(confirmation.questions[0], /gh-20-hover/)
    assert.match(confirmation.questions[0], /is kept/, 'la branche survit au dossier')
    assert.deepEqual(serveur.appels, [], 'un refus n’envoie aucune requête')
  } finally {
    confirmation.restore()
    serveur.restore()
  }
})

test('un refus de la question n’envoie rien, ne compte rien et ne relit rien', async () => {
  const serveur = fauxServeur()
  const confirmation = fauxConfirm([false])
  try {
    const { inner, setters } = voletWorktrees(ARBRE_DUO)
    await boutonRemove(inner, 'missions-gh20').props.onClick()

    assert.deepEqual(serveur.appels, [], 'aucune requête, pas même le relevé')
    assert.deepEqual(setters, [], 'aucun état touché')
  } finally {
    confirmation.restore()
    serveur.restore()
  }
})

test('un clic confirmé supprime le worktree, compte le geste et relit l’onglet', async () => {
  const serveur = fauxServeur()
  const confirmation = fauxConfirm([true])
  try {
    const { inner, setters } = voletWorktrees(ARBRE_DUO)
    await boutonRemove(inner, 'missions-gh20').props.onClick()

    // L'écriture est un seul POST, nommé, sur la route de l'onglet.
    const suppressions = serveur.appels.filter((appel) => appel.url === 'missions/api/repositories/remove')
    assert.equal(suppressions.length, 1)
    assert.equal(suppressions[0].method, 'POST')
    assert.deepEqual(suppressions[0].body, { name: 'missions-gh20' })

    // Le relevé compte le geste une fois, avec le nom du worktree.
    const gestes = serveur.appels.filter((appel) => appel.url === 'missions/api/usage')
    assert.equal(gestes.length, 1)
    assert.deepEqual(gestes[0].body, { element: 'repository.remove', detail: 'missions-gh20' })

    // Le volet reste — l'autre dépôt le décrit encore —, dit que le dossier
    // est parti et que la branche reste, et remet l'arbre en lecture.
    assert.ok(setters.includes('The worktree missions-gh20 is gone; the branch gh-20-hover is kept.'))
    assert.ok(setters.some((value) => value?.loading === true && value?.data === null), 'l’arbre se relit')
    const compteur = setters.find((value) => typeof value === 'function')
    assert.ok(compteur, 'le compteur de lecture avance')
    assert.equal(compteur(0), 1)
    assert.equal(confirmation.questions.length, 1, 'aucune seconde question sans fichiers ignorés')
  } finally {
    confirmation.restore()
    serveur.restore()
  }
})

test('un refus de l’hôte est la note du volet, mot pour mot, sans relecture', async () => {
  const serveur = fauxServeur([{
    ok: false,
    status: 409,
    body: {
      error: 'the worktree missions-gh20 has uncommitted changes (one file: README.md) — commit or stash them first',
      side: 'worktree',
      files: ['README.md'],
    },
  }])
  const confirmation = fauxConfirm([true])
  try {
    const { inner, setters } = voletWorktrees(ARBRE_DUO)
    await boutonRemove(inner, 'missions-gh20').props.onClick()

    assert.ok(setters.includes('Not removed: the worktree missions-gh20 has uncommitted changes (one file: README.md) — commit or stash them first'))
    assert.equal(setters.some((value) => value?.loading === true), false, 'rien n’a été supprimé : pas de relecture')
  } finally {
    confirmation.restore()
    serveur.restore()
  }
})

test('des fichiers ignorés demandent un second oui, puis partent avec le dossier', async () => {
  const serveur = fauxServeur([
    {
      ok: false,
      status: 409,
      body: {
        error: 'the worktree missions-gh20 holds 1 ignored entry (node_modules) that git deletes with the folder — send acceptIgnored to remove them with it',
        side: 'worktree',
        ignored: true,
        files: ['node_modules'],
      },
    },
    { ok: true, status: 200, body: { name: 'missions-gh20', removed: true } },
  ])
  const confirmation = fauxConfirm([true, true])
  try {
    const { inner, setters } = voletWorktrees(ARBRE_DUO)
    await boutonRemove(inner, 'missions-gh20').props.onClick()

    assert.equal(confirmation.questions.length, 2, 'la seconde question nomme les ignorés')
    assert.match(confirmation.questions[1], /node_modules/)

    const suppressions = serveur.appels.filter((appel) => appel.url === 'missions/api/repositories/remove')
    assert.deepEqual(suppressions.map((appel) => appel.body), [
      { name: 'missions-gh20' },
      { name: 'missions-gh20', acceptIgnored: true },
    ])
    assert.ok(setters.includes('The worktree missions-gh20 is gone; the branch gh-20-hover is kept.'))
  } finally {
    confirmation.restore()
    serveur.restore()
  }
})

test('dire non aux fichiers ignorés laisse le dossier et le dit', async () => {
  const serveur = fauxServeur([{
    ok: false,
    status: 409,
    body: {
      error: 'the worktree missions-gh20 holds 1 ignored entry (node_modules) that git deletes with the folder — send acceptIgnored to remove them with it',
      side: 'worktree',
      ignored: true,
      files: ['node_modules'],
    },
  }])
  const confirmation = fauxConfirm([true, false])
  try {
    const { inner, setters } = voletWorktrees(ARBRE_DUO)
    await boutonRemove(inner, 'missions-gh20').props.onClick()

    assert.equal(serveur.appels.filter((appel) => appel.url === 'missions/api/repositories/remove').length, 1)
    assert.ok(setters.includes('Nothing was removed: missions-gh20 still holds ignored entry.'))
  } finally {
    confirmation.restore()
    serveur.restore()
  }
})

test('le volet ferme le dépôt supprimé et le panneau relit la liste', async () => {
  const repository = REPO_SCAN.repositories[2]
  const arbre = {
    layout: false,
    branches: [],
    worktrees: [
      { path: '/Users/moi/projects/missions-gh20', branch: 'gh-20-hover', head: 'd4e5f6a', current: true, main: true, name: 'missions-gh20' },
    ],
  }
  const { node, setters } = voletWorktrees(arbre, repository)
  node.props.onRemoved({ name: 'missions-gh20' })

  // Le dépôt ouvert n'existe plus : le volet se ferme (`null`) et le compteur
  // de relecture avance pour que l'onglet Repositories ne montre pas la ligne.
  assert.deepEqual(setters.slice(0, 1), [null], 'le volet se ferme')
  const relecture = setters[1]
  assert.equal(typeof relecture, 'function', 'la liste relit')
  assert.equal(relecture(0), 1)
})

test('un layout illisible est un bandeau dans Worktrees', () => {
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  const { inner } = volet([
    ...repositoriesStates(scanReady(detail), repository),
    'worktrees', { loading: false, more: false, data: null, error: null }, { loading: false, data: null, error: 'fatal: not a git repository' },
  ])

  const bandeau = findAll(inner, 'div').find((div) => div.props.className === 'missions-repos-error')
  assert.ok(bandeau, 'l’échec est visible')
  assert.equal(bandeau.props.role, 'alert')
  assert.match(textOf(bandeau), /fatal: not a git repository/)
})

test('un clic de ligne ouvre le volet, la croix et Échap le ferment', () => {
  const repository = REPO_SCAN.repositories[1]
  const { tree, inner, effects, setters } = montrerRepositories(scanReady(REPO_SCAN), repository)

  // La ligne est un bouton, pas un dessin de bouton : son gestionnaire remet le
  // dépôt au sélecteur du panneau, et le changement d'onglet le remet à `null`.
  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.equal(lignes.length, 3)
  lignes[0].props.onClick()
  assert.deepEqual(setters.slice(-1), [repository], 'le clic d’une ligne ouvre ce dépôt')

  const volet = findAll(tree, 'RepositoryDrawer')[0]
  assert.ok(volet, 'le volet du dépôt choisi est monté')
  const fermer = findAll(renderTree(volet), 'button')
    .find((button) => button.props.className === 'missions-drawer-close')
  assert.ok(fermer, 'le volet a sa croix')
  fermer.props.onClick()
  assert.deepEqual(setters.slice(-1), [null], 'la croix ferme le volet')

  // Échap est une vraie touche : le volet l'arme à son montage, la retire en
  // partant, et seul `Escape` déclenche la fermeture.
  const ecoutes = new Map()
  const fauxDocument = {
    addEventListener: (type, callback) => { ecoutes.set(type, callback) },
    removeEventListener: (type) => { ecoutes.delete(type) },
  }
  const vraiDocument = globalThis.document
  globalThis.document = fauxDocument
  try {
    const touche = effects.find((effect) => /addEventListener\('keydown'/.test(String(effect.fn)))
    assert.ok(touche, 'le volet arme Échap à son montage')
    const avant = setters.length
    const retirer = touche.fn()
    assert.equal(typeof retirer, 'function', 'le volet rend son désabonnement')
    ecoutes.get('keydown')({ key: 'Escape' })
    assert.equal(setters.length, avant + 1, 'Échap passe par le sélecteur')
    assert.deepEqual(setters.slice(-1), [null], 'Échap ferme le volet')
    retirer()
    assert.equal(ecoutes.has('keydown'), false, 'la touche ne survit pas au volet')
  } finally {
    if (vraiDocument === undefined) delete globalThis.document
    else globalThis.document = vraiDocument
  }
})

test('l’onglet Repositories a sa grille et ses deux thèmes', () => {
  assert.match(regle('.missions-repo-grid'), /grid-template-columns/)
  assert.match(regle('.missions-repo-grid'), /minmax\(0, 1\.55fr\)/)
  assert.match(regle('.missions-repo-state[data-dirty="true"]'), /font-weight: 600/)
  assert.match(regle('.missions-repo-state[data-error="true"]'), /#cf222e/)

  // Le thème manga ne copie pas la grille : il l'habille de papier et d'encre.
  assert.match(SOURCE, /\.missions-panel\[data-theme="manga"\] \.missions-repo \{/)
  assert.match(SOURCE, /\.missions-panel\[data-theme="manga"\] \.missions-repo-head \{/)
  // La colonne du dernier commit cède la première quand le panneau rétrécit.
  assert.match(SOURCE, /@media \(max-width: 860px\) \{\s+\.missions-repo-grid \{ grid-template-columns: [^}]+\}\s+\.missions-col-commit \{ display: none; \}/)
})

/** Le volet d'un dépôt, monté avec les services que le panneau lui passe. */
function voletDepot(repository, { services = undefined, note = null } = {}) {
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git' }
  const { api, ctx, registered, setters } = charger(
    undefined,
    [...repositoriesStates(scanReady(detail), repository), 'details', null, null, null, 0, note],
    memorySession(),
  )
  api.apply(ctx)
  const tree = registered.main({})
  const node = findAll(tree, 'RepositoryDrawer')[0]
  assert.ok(node, 'le volet du dépôt choisi est monté')
  // Le rendu réel passe `services` et `workspaceId` au volet : le test les
  // pose sur le même nœud.
  const propose = services ? { ...node, props: { ...node.props, services, workspaceId: 'w' } } : node
  return { inner: renderTree(propose), setters }
}

/**
 * Le volet d'un dépôt, monté avec le détail que le test lui donne et les
 * services que le panneau lui passe. `repositoriesStates` fournit quinze états
 * au panneau puis le seizième au `detail` du volet ; `renderTree` invoque le
 * volet, c'est donc là que ses quatre derniers `useState` prennent la file.
 */
function voletSquash(repository, { detail, services = undefined, note = null } = {}) {
  const detailState = detail ?? scanReady({ ...repository, remote: 'https://github.com/daedalforge/missions.git' })
  const { api, ctx, registered, setters } = charger(
    undefined,
    [...repositoriesStates(detailState, repository), 'details', null, null, null, 0, note],
    memorySession(),
  )
  api.apply(ctx)
  const tree = registered.main({})
  const node = findAll(tree, 'RepositoryDrawer')[0]
  assert.ok(node, 'le volet du dépôt choisi est monté')
  const propose = services ? { ...node, props: { ...node.props, services, workspaceId: 'w' } } : node
  return { inner: renderTree(propose), setters }
}

function boutonConflits(inner) {
  return findAll(inner, 'button').find((node) => node.props['aria-label'] === 'Resolve conflicts') ?? null
}

/** La rangée d'actions du pied : elle porte les deux gestes du dépôt. */
function actionsSquash(inner) {
  const actions = findAll(inner, 'div').filter((node) => node.props.className === 'missions-drawer-actions')
  assert.equal(actions.length, 1, 'une seule rangée d’actions')
  return actions[0]
}

function boutonSquash(inner) {
  const label = 'Squash the mission branch into one commit'
  const bouton = findAll(actionsSquash(inner), 'button').find((node) => node.props['aria-label'] === label
    || node.props['aria-label'] === 'Reading the repository…'
    || node.props['aria-label'] === 'The repository could not be read'
    || node.props['aria-label'] === 'Detached HEAD — no branch to squash')
  assert.ok(bouton, 'le bouton squash est dans la rangée')
  return bouton
}

test('le volet d’un dépôt porte « Resolve conflicts » et « Squash » dans la même rangée de pied', () => {
  for (const repository of REPO_SCAN.repositories) {
    const { inner } = voletDepot(repository)
    const bouton = boutonConflits(inner)
    assert.ok(bouton, `le geste resolve est rendu pour ${repository.name}`)
    assert.match(bouton.props.className, /missions-action--icon/)
    assert.equal(bouton.props.title, 'Resolve conflicts')
    assert.equal(bouton.props.type, 'button')
    assert.equal(textOf(bouton), '', 'icône seule : le nom vit dans title et aria-label')
    assert.equal(findAll(bouton, 'svg').length, 1, 'le bouton porte son dessin')

    const squash = boutonSquash(inner)
    assert.equal(squash.props.title, 'Squash the mission branch into one commit')
    assert.equal(textOf(squash), '', 'icône seule : le nom vit dans title et aria-label')
    assert.equal(findAll(squash, 'svg').length, 1, 'le bouton porte son dessin')

    // Le pied reprend la famille du volet mission.
    const pied = findAll(inner, 'div').find((node) => node.props.className === 'missions-drawer-foot')
    assert.ok(pied, 'le pied porte .missions-drawer-foot')
    const actions = findAll(pied, 'div').find((node) => node.props.className === 'missions-drawer-actions')
    assert.ok(actions, 'les actions portent .missions-drawer-actions')
    assert.deepEqual(findAll(actions, 'button').map((node) => node.props['aria-label']), ['Resolve conflicts', 'Squash the mission branch into one commit'])
  }
})

test('un clic sur « Resolve conflicts » ouvre la session dans le workspace du dépôt', async () => {
  const repository = REPO_SCAN.repositories[1]
  const ouverts = []
  const services = {
    getService: (name) => {
      if (name === 'uiWorkspace') {
        return { startSession: (id, options) => ouverts.push({ id, prompt: options?.prompt }) }
      }
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot: () => [
              { workspaceId: 'w-zeta', path: '/Users/moi/projects/zeta' },
              { workspaceId: 'w-missions', path: repository.path },
            ],
          },
        }
      }
      return null
    },
  }

  const { inner } = voletDepot(repository, { services })
  await boutonConflits(inner).props.onClick()

  assert.equal(ouverts.length, 1, 'un clic, une session')
  assert.equal(ouverts[0].id, 'w-missions', 'l’identifiant est celui du workspace dont le chemin est le dépôt')
  assert.match(ouverts[0].prompt, /Chemin : \/Users\/moi\/projects\/missions\./)
  assert.match(ouverts[0].prompt, /Branche courante : feat\/mis-116\./)
  assert.match(ouverts[0].prompt, /tu ne merges jamais la PR/)
  assert.match(ouverts[0].prompt, /tu n’écris jamais sur main/)
})

test('le volet d’un dépôt porte « Squash the mission branch into one commit » dans son pied', () => {
  const label = 'Squash the mission branch into one commit'
  for (const repository of REPO_SCAN.repositories) {
    const { inner } = voletSquash(repository)
    const bouton = boutonSquash(inner)
    assert.equal(bouton.props.className, 'missions-action missions-action--icon missions-action--primary')
    assert.equal(bouton.props.type, 'button')
    assert.equal(bouton.props.title, label)
    assert.equal(bouton.props['aria-label'], label)
    assert.equal(bouton.props.disabled, false)
    assert.equal(textOf(bouton), '', 'icône seule : le nom vit dans title et aria-label')
    assert.equal(findAll(bouton, 'svg').length, 1, 'le bouton porte son dessin')
    // Le pied reprend la famille du volet mission.
    const pied = findAll(inner, 'div').find((node) => node.props.className === 'missions-drawer-foot')
    assert.ok(pied, 'le pied porte .missions-drawer-foot')
    assert.ok(findAll(pied, 'div').some((node) => node.props.className === 'missions-drawer-actions'), 'la rangée est dans le pied')
  }
})

test('sans détail lisible ou sans branche, « Squash » reste visible, désactivé, et dit pourquoi', () => {
  const repository = REPO_SCAN.repositories[1]

  const lecture = boutonSquash(voletSquash(repository, { detail: { loading: true, data: null, error: null } }).inner)
  assert.equal(lecture.props.disabled, true)
  assert.equal(lecture.props.title, 'Reading the repository…')
  assert.equal(lecture.props['aria-label'], 'Reading the repository…')

  const echec = boutonSquash(voletSquash(repository, { detail: { loading: false, data: null, error: 'fatal: not a git repository' } }).inner)
  assert.equal(echec.props.disabled, true)
  assert.equal(echec.props.title, 'The repository could not be read')
  assert.equal(echec.props['aria-label'], 'The repository could not be read')

  const detache = boutonSquash(voletSquash(repository, { detail: scanReady({ ...repository, detached: true, branch: null, remote: 'x' }) }).inner)
  assert.equal(detache.props.disabled, true)
  assert.equal(detache.props.title, 'Detached HEAD — no branch to squash')
  assert.equal(detache.props['aria-label'], 'Detached HEAD — no branch to squash')

  // Le détail donne une branche : le geste se débloque et reprend son nom.
  const actif = boutonSquash(voletSquash(repository).inner)
  assert.equal(actif.props.disabled, false)
  assert.equal(actif.props.title, 'Squash the mission branch into one commit')
})

test('un clic sur « Squash » ouvre la session dans le workspace du dépôt, sans l’envoyer', async () => {
  const repository = REPO_SCAN.repositories[1]
  const ouverts = []
  let envoye = false
  const services = {
    getService: (name) => {
      if (name === 'uiWorkspace') {
        return { startSession: (id, options) => ouverts.push({ id, prompt: options?.prompt }) }
      }
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot: () => [
              { workspaceId: 'w-zeta', path: '/Users/moi/projects/zeta' },
              { workspaceId: 'w-missions', path: repository.path },
            ],
          },
        }
      }
      if (name === 'sessions') return { create: () => { envoye = true; throw new Error('sent') } }
      return null
    },
  }

  const { inner } = voletSquash(repository, { services })
  await boutonSquash(inner).props.onClick()

  assert.equal(ouverts.length, 1, 'un clic, une session')
  assert.equal(ouverts[0].id, 'w-missions', 'l’identifiant est celui du workspace dont le chemin est le dépôt')
  assert.equal(envoye, false, 'le prompt est posé dans le composeur, jamais envoyé')
  assert.match(ouverts[0].prompt, /Chemin : \/Users\/moi\/projects\/missions\./)
  assert.match(ouverts[0].prompt, /Branche courante : feat\/mis-116\./)
  assert.match(ouverts[0].prompt, /git reset --soft/)
  assert.match(ouverts[0].prompt, /tu ne merges jamais la PR/)
  assert.match(ouverts[0].prompt, /tu n’écris jamais sur main/)
})

test('une session refusée dit « Session not opened: … » sans perdre le prompt', async () => {
  const repository = REPO_SCAN.repositories[1]
  const envois = []
  const services = {
    getService: (name) => (name === 'uiWorkspace'
      ? { startSession: (id, options) => { envois.push(options?.prompt); throw new Error('workspace/not-found') } }
      : null),
  }

  const { inner, setters } = voletSquash(repository, { services })
  const bouton = boutonSquash(inner)
  await bouton.props.onClick()

  assert.ok(setters.includes('Session not opened: workspace/not-found'), 'l’échec est dit en une ligne')
  // Le prompt n’est pas perdu : un second clic envoie exactement le même.
  await bouton.props.onClick()
  assert.equal(envois.length, 2)
  assert.equal(envois[0], envois[1])

  // La note est rendue dans le volet, au-dessus du bouton qui reste en place.
  const apres = voletSquash(repository, { services, note: 'Session not opened: workspace/not-found' })
  assert.match(textOf(apres.inner), /Session not opened: workspace\/not-found/)
  assert.equal(textOf(boutonSquash(apres.inner)), '', 'le bouton reste une icône après l’échec')
})

test('le bouton « Squash » compte « repository.squash », un seul POST, aucun autre appel', async () => {
  const spy = espionUsage()
  try {
    const repository = REPO_SCAN.repositories[1]
    const services = {
      getService: (name) => {
        if (name === 'uiWorkspace') return { startSession: () => {} }
        if (name === 'workspaces') return { list: { getSnapshot: () => [{ workspaceId: 'w-missions', path: repository.path }] } }
        return null
      },
    }
    const { inner } = voletSquash(repository, { services })
    await boutonSquash(inner).props.onClick()
    // Le relevé se lit AVANT `geste`, qui vide `appels` : un seul appel part,
    // le POST du geste — ni lecture, ni création, ni envoi de session.
    assert.deepEqual(
      spy.appels,
      [{ url: 'missions/api/usage', method: 'POST', body: { element: 'repository.squash' } }],
      'un clic, un seul appel : le POST missions/api/usage, aucun autre',
    )
    spy.geste('repository.squash')
  } finally {
    spy.restore()
  }
})

test('le bouton des conflits compte « repository.resolve », un seul POST', async () => {
  const spy = espionUsage()
  try {
    const repository = REPO_SCAN.repositories[1]
    const services = {
      getService: (name) => {
        if (name === 'uiWorkspace') return { startSession: () => {} }
        if (name === 'workspaces') return { list: { getSnapshot: () => [{ workspaceId: 'w-missions', path: repository.path }] } }
        return null
      },
    }
    const { inner } = voletDepot(repository, { services })
    await boutonConflits(inner).props.onClick()
    spy.geste('repository.resolve')
  } finally {
    spy.restore()
  }
})

function monterVoletCloture(mission = { ...MISSION, state: 'ready-for-prod', updatedAt: MISSION.updated }) {
  return monterVolet(mission)
}

function boutonCloture(tree) {
  return findAll(tree, 'button').find((node) => /close the local checkout/i.test(nomDuGeste(node))) ?? null
}

test('le volet ne propose la clôture locale qu’en ready-for-prod', () => {
  for (const state of ['to-refine', 'ready', 'in-progress', 'in-review', 'done', 'blocked', null]) {
    const { tree } = monterVoletCloture({ ...MISSION, state, updatedAt: MISSION.updated })
    assert.equal(boutonCloture(tree), null, `aucun bouton de clôture pour ${state}`)
  }

  const { tree } = monterVoletCloture()
  const bouton = boutonCloture(tree)
  assert.ok(bouton, 'le bouton doit être rendu en ready-for-prod')
  assert.equal(bouton.props.className, 'missions-action missions-action--icon missions-action--danger')
  assert.equal(bouton.props.disabled, false)
  assert.equal(typeof bouton.props.onClick, 'function')
  // Le geste destructif suit la règle du pied : une icône, son nom en infobulle
  // et en nom accessible. L'état armé, lui, se voit dans le bouton.
  assert.equal(nomDuGeste(bouton), 'Close the local checkout')
  assert.equal(bouton.props.title, 'Close the local checkout')
  assert.equal(textOf(bouton), '')
  const dessins = findAll(bouton, 'svg')
  assert.equal(dessins.length, 1)
  assert.equal(dessins[0].props['aria-hidden'], 'true')

  // Il ouvre la rangée, dont la session reste le dernier geste : le geste
  // destructif ne colle pas au bouton primaire.
  const foot = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-foot')
  assert.ok(foot, 'le pied du volet est rendu')
  const enfants = foot.children.filter((child) => child !== null && child !== false)
  assert.deepEqual(enfants.map((child) => child.props.className), ['missions-drawer-actions'])
  const boutons = enfants[0].children.filter((child) => child.type === 'button')
  assert.equal(nomDuGeste(boutons[0]), 'Close the local checkout', 'la clôture ouvre la rangée')
  const iSession = boutons.findIndex((node) => /^Start a session/.test(nomDuGeste(node)))
  assert.equal(iSession, boutons.length - 1, 'la session reste le dernier geste de la rangée')

  // L'état armé est porté par le bouton : classe, nom et dessin changent.
  assert.match(SOURCE, /armedClose \? 'Confirm — close the local checkout' : 'Close the local checkout'/)
  assert.match(SOURCE, /missions-action--danger-armed/)
  assert.match(SOURCE, /h\(ActionIcon, \{ name: closing \|\| !armedClose \? 'close' : 'confirm' \}\)/)
  assert.match(SOURCE, /\.missions-action--danger-armed \{[^}]*background: var\(--dsw-alias-label-danger/)
  assert.match(SOURCE, /\.missions-panel\[data-theme="manga"\] \.missions-action--danger-armed \{[^}]*--mm-orange-deep/)

  // Le câblage du bundle, en plus du rendu.
  assert.match(SOURCE, /const LOCAL_CLOSE_URL = 'missions\/api\/local-close'/)
  assert.match(SOURCE, /body: JSON\.stringify\(\{ key: mission\.key \}\)/)
  assert.match(SOURCE, /mission\.state === 'ready-for-prod'/)
  assert.match(SOURCE, /\.missions-action--danger \{/)
})

test('la clôture ouvre la rangée, et la primaire la ferme', () => {
  const { tree } = monterVoletCloture()
  const actions = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-actions')
  assert.ok(actions, 'la rangée du pied est rendue')
  const gestes = actions.children.filter((child) => child && (child.type === 'button' || child.type === 'a'))
  const noms = gestes.map(nomDuGeste)
  assert.equal(noms[0], 'Close the local checkout', 'le geste destructif ouvre la rangée')
  assert.match(noms.at(-1), /^Start a session/, 'la session de l’étape la ferme')
  assert.equal(noms.length, 4, 'clôture, ticket, session libre, session de l’étape')
  for (const geste of gestes) {
    assert.equal(textOf(geste), '', 'aucun geste de la rangée ne porte de texte')
    assert.equal(findAll(geste, 'svg').length, 1)
  }
})

test('le premier clic arme la clôture, le second envoie la clé', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        key: 'MIS-42', branch: 'fix/mis-42', base: 'main', cloneSha: '1234567',
        worktreesRemoved: ['/w/wt'], branchRemoved: true, macheteUpdated: true,
      }),
    }
  }

  const { tree, setters } = monterVoletCloture()
  const bouton = boutonCloture(tree)

  await bouton.props.onClick()
  assert.deepEqual(writes(calls), [], 'le premier clic n’écrit rien')
  assert.ok(setters.includes(true), 'le premier clic arme le bouton')
  const armeNote = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(armeNote.error, false)
  assert.match(armeNote.text, /Click again to confirm/)

  await bouton.props.onClick()
  assert.deepEqual(writes(calls), [
    { url: 'missions/api/local-close', method: 'POST', body: { key: 'MIS-42' } },
  ])
  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, false)
  assert.match(note.text, /Local checkout closed: fix\/mis-42 deleted, 1 worktree\(s\) removed, clone on main \(1234567\)/)
})

test('un refus de clôture se dit, et le bouton se réarme pour un nouvel essai', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url) })
    return { ok: false, status: 409, json: async () => ({ error: 'pull request #7 is not merged' }) }
  }

  const { tree, setters } = monterVoletCloture()
  const bouton = boutonCloture(tree)

  await bouton.props.onClick()
  await bouton.props.onClick()

  assert.equal(writes(calls).length, 1)
  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, true)
  assert.match(note.text, /Local close refused: pull request #7 is not merged/)

  // Le refus rend le geste inoffensif mais réarmable : un clic de plus
  // redevient une demande, pas une écriture immédiate.
  await bouton.props.onClick()
  assert.equal(writes(calls).length, 1, 'le clic après refus réarme sans écrire')
  const rearme = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.match(rearme.text, /Click again to confirm/)
})

test('une mission sans branche garde le bouton de clôture, mais désarmé', () => {
  const { tree } = monterVoletCloture({ ...MISSION, state: 'ready-for-prod', branch: null, updatedAt: MISSION.updated })
  const bouton = boutonCloture(tree)
  assert.ok(bouton)
  assert.equal(bouton.props.disabled, true)
  assert.match(bouton.props.title, /branch is not declared/)
  assert.equal(nomDuGeste(bouton), 'Close the local checkout', 'le nom ne change pas quand le geste est refusé')
  assert.equal(bouton.props['aria-describedby'], 'missions-session-blocked')
})

/* Tolgee: le geste n'apparaît que pour un projet qui déclare ses locales. */

const TRANSLATIONS = {
  locales: ['fr', 'en'],
  languageFile: 'locales/{locale}.json',
  reference: 'fr',
}

/** Le bouton de l'import Tolgee, nommé par son libellé accessible. */
function boutonTolgee(tree) {
  return boutonGeste(tree, 'Tolgee import')
}

test('le volet ne rend l’import Tolgee que pour un projet qui déclare ses locales', () => {
  for (const state of ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done', null]) {
    const { tree } = monterVolet({ ...MISSION, state, translations: null, updatedAt: MISSION.updated })
    assert.equal(boutonTolgee(tree), null, `aucun import Tolgee pour ${state} sans translations`)
  }

  const { tree } = monterVolet({ ...MISSION, translations: TRANSLATIONS, updatedAt: MISSION.updated })
  const bouton = boutonTolgee(tree)
  assert.ok(bouton, 'le bouton est rendu pour un projet traduit')
  assert.equal(bouton.props.className, 'missions-action missions-action--icon')
  assert.equal(bouton.props.title, 'Tolgee import')
  assert.equal(bouton.props['aria-label'], 'Tolgee import')
  assert.equal(bouton.props.disabled, false)
  assert.equal(textOf(bouton), '', 'icône seule : le nom vit dans title et aria-label')
  assert.equal(findAll(bouton, 'svg').length, 1, 'le bouton porte son dessin')
  assert.equal('aria-describedby' in bouton.props, false, 'le geste ne dépend pas du verrou de session')
  assert.equal(typeof bouton.props.onClick, 'function')
})

test('l’import Tolgee se place entre le ticket et les remontées', () => {
  const { tree } = monterVolet({ ...MISSION, state: 'in-review', translations: TRANSLATIONS, updatedAt: MISSION.updated })
  const actions = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-actions')
  assert.ok(actions, 'la rangée du pied est rendue')
  const noms = actions.children
    .filter((child) => child && (child.type === 'button' || child.type === 'a'))
    .map(nomDuGeste)
  const iTolgee = noms.indexOf('Tolgee import')
  const iFeedback = noms.indexOf('Check the PR feedback')
  const iSession = noms.findIndex((name) => /^Start a session/.test(name))
  assert.ok(iTolgee > 0, 'l’import suit le ticket')
  assert.ok(iTolgee < iFeedback, 'l’import précède les remontées')
  assert.equal(iSession, noms.length - 1, 'la session reste le dernier geste')
})

test('à l’ouverture du volet, ni bilan ni rapport Tolgee ne sont rendus', () => {
  // Given: une mission traduite, sans clic sur l'import.
  const { tree } = monterVolet({ ...MISSION, translations: TRANSLATIONS, updatedAt: MISSION.updated })

  // Then: le geste est là, son résultat n'existe pas encore.
  assert.ok(boutonTolgee(tree), 'le bouton reste rendu')
  assert.equal(
    findAll(tree, 'p').some((node) => node.props.className === 'missions-tolgee-note'),
    false,
    'aucun bilan avant le clic',
  )
  assert.equal(
    findAll(tree, 'div').some((node) => node.props.className === 'missions-tolgee'),
    false,
    'aucun rapport avant le clic',
  )
})

test('un clic sur l’import Tolgee envoie la clé et rend le bilan', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        file: 'missions/MIS-42/import-tolgee.xliff',
        keys: [
          { key: 'greet', value: 'Bonjour', missing: ['en'], occurrences: ['src/a.js:1'] },
          { key: 'bye', value: 'Au revoir', missing: ['en', 'de'], occurrences: ['src/b.js:2'] },
        ],
        untranslated: [],
        warnings: [],
      }),
    }
  }

  const { tree, setters, rerendre } = monterVolet({ ...MISSION, translations: TRANSLATIONS, updatedAt: MISSION.updated })
  await boutonTolgee(tree).props.onClick()

  const imports = calls.filter((entry) => entry.url === 'missions/api/tolgee')
  assert.deepEqual(imports, [{ url: 'missions/api/tolgee', method: 'POST', body: { key: 'MIS-42' } }])
  assert.ok(calls.some((entry) => entry.url === 'missions/api/usage'), 'le geste se compte')
  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, false)
  assert.match(note.text, /2 clé\(s\) manquante\(s\) en en, de/)
  assert.match(note.text, /fichier écrit dans missions\/MIS-42\/import-tolgee\.xliff/)
  const rapport = setters.filter((value) => Array.isArray(value) && value.length === 2).at(-1)
  assert.deepEqual(rapport.map((entry) => entry.key), ['greet', 'bye'])
  assert.equal(setters.at(-1), false, 'le bouton se réarme après le rapport')

  // Then: le bilan et les clés sont bien rendus, pas seulement posés.
  const apres = rerendre()
  const bilan = findAll(apres, 'p').find((node) => node.props.className === 'missions-tolgee-note')
  assert.ok(bilan, 'le bilan du clic se lit dans les détails')
  assert.equal(bilan.props.role, 'status')
  assert.match(textOf(bilan), /2 clé\(s\) manquante\(s\) en en, de — fichier écrit dans missions\/MIS-42\/import-tolgee\.xliff/)
  const liste = findAll(apres, 'div').find((node) => node.props.className === 'missions-tolgee')
  assert.ok(liste, 'le rapport du clic est rendu')
  assert.match(textOf(liste), /greet/)
  assert.match(textOf(liste), /manque en en/)
})

test('sans clé manquante, l’import Tolgee le dit sans fichier', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      file: null,
      keys: [],
      untranslated: [{ key: 'newKey', occurrences: ['src/a.js:3'] }],
      warnings: [],
    }),
  })

  const { tree, setters, rerendre } = monterVolet({ ...MISSION, translations: TRANSLATIONS, updatedAt: MISSION.updated })
  await boutonTolgee(tree).props.onClick()

  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, false)
  assert.match(note.text, /1 clé\(s\) sans valeur fr à écrire d’abord — aucun fichier écrit\./)
  assert.ok(
    setters.some((value) => Array.isArray(value) && value[0]?.key === 'newKey'),
    'la clé sans fr est gardée pour la liste à part',
  )

  // Then: la liste à part est rendue, le fichier n'est pas annoncé.
  const apres = rerendre()
  const liste = findAll(apres, 'div').find((node) => node.props.className === 'missions-tolgee')
  assert.ok(liste, 'le rapport du clic est rendu')
  assert.match(textOf(liste), /À écrire en fr d’abord/)
  assert.match(textOf(liste), /newKey/)
  assert.match(textOf(liste), /src\/a\.js:3/)
  assert.doesNotMatch(textOf(liste), /fichier écrit/)
})

test('un refus de l’import Tolgee se dit et rend le bouton', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'no changed source file on feat/mis-42 against main' }),
  })

  const { tree, setters, rerendre } = monterVolet({ ...MISSION, translations: TRANSLATIONS, updatedAt: MISSION.updated })
  await boutonTolgee(tree).props.onClick()

  const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
  assert.equal(note.error, true)
  assert.match(note.text, /^Import Tolgee : no changed source file on feat\/mis-42 against main/)
  assert.equal(setters.at(-1), false, 'le bouton se réarme après le refus')

  // Then: l'échec est lu à l'écran, en alerte, sans rapport vide à côté.
  const apres = rerendre()
  const alerte = findAll(apres, 'p').find((node) => node.props.role === 'alert')
  assert.ok(alerte, 'l’échec est rendu en alerte')
  assert.match(textOf(alerte), /^Import Tolgee : no changed source file on feat\/mis-42 against main/)
  assert.equal(findAll(apres, 'div').some((node) => node.props.className === 'missions-tolgee'), false)
})

test('le bundle câble l’URL, le dessin et le rapport Tolgee', () => {
  assert.match(SOURCE, /const TOLGEE_URL = 'missions\/api\/tolgee'/)
  assert.match(SOURCE, /h\(ActionIcon, \{ name: 'tolgee' \}\)/)
  assert.match(SOURCE, /if \(name === 'tolgee'\)/)
  assert.match(SOURCE, /body: JSON\.stringify\(\{ key: mission\.key \}\)/)
  // Le rapport nomme les deux listes, chacune avec sa raison d'être.
  assert.match(SOURCE, /Clés de traduction du diff/)
  assert.match(SOURCE, /À écrire en fr d’abord/)
  assert.match(SOURCE, /manque en \$\{entry\.missing\.join\(', '\)\}/)
  assert.match(SOURCE, /entry\.occurrences \?\? \[\]\)\.join/)
  assert.match(SOURCE, /className: 'missions-tolgee'/)
  // Le style existe dans le bundle généré, pas seulement dans le template.
  assert.match(regle('.missions-tolgee'), /display: grid/)
  assert.match(SOURCE, /mission\.translations\s*\n\s*\?/)
})

/* Usage: le relevé se lit dans un onglet, et chaque geste s'y compte. */

const DAY = 86_400_000
const USAGE_NOW = Date.now()
// Le relevé garde des dates ISO : c'est ce que la route renvoie, tel quel.
const USAGE_AGO = (days) => new Date(USAGE_NOW - days * DAY).toISOString()

/**
 * Un relevé tel que la route le renvoie : quatre gestes déclarés, un retiré.
 *
 * Le retiré pèse le total, donc la part des autres : c'est ce qui fait tenir
 * les quatre verdicts dans le même relevé.
 */
const USAGE_LOADED = {
  version: 1,
  startedAt: USAGE_AGO(40),
  updatedAt: USAGE_AGO(0.1),
  broken: false,
  elements: {
    'tab.usage': { count: 25, firstUsed: USAGE_AGO(40), lastUsed: USAGE_AGO(0.1), values: {} },
    'filter.state': { count: 6, firstUsed: USAGE_AGO(20), lastUsed: USAGE_AGO(2), values: { 'in-review': 4, ready: 2 } },
    'mission.declare': { count: 1, firstUsed: USAGE_AGO(90), lastUsed: USAGE_AGO(90), values: {} },
    'tab.done': { count: 0, firstUsed: null, lastUsed: null, values: {} },
    'old.gesture': { count: 68, firstUsed: USAGE_AGO(200), lastUsed: USAGE_AGO(120), values: {} },
  },
}

/**
 * Le panneau monté sur la section Usage de Settings, avec le relevé déjà lu :
 * les états de la barre, l'onglet, la section, puis celui que `UsageTab`
 * consomme en se montant.
 */
function monterUsage(releve = USAGE_LOADED) {
  const { api, ctx, registered, setters, effects } = charger(
    undefined,
    [
      EMPTY_BAR,
      dashboardView(DASH_MISSIONS),
      'settings',
      '',
      { ...EMPTY_BAR.filters },
      null,
      null,
      'default',
      null,
      EMPTY_BAR,
      { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null },
      '',
      { ...EMPTY_BAR.filters, state: ['done'] },
      null,
      // Le compte des dépôts de la pastille, lu au montage et gardé dans le panneau.
      null,
      // Le seizième état est la section de Settings, restaurée avec l'onglet.
      'usage',
      // Le dix-septième est le compteur de relecture de la liste Repositories.
      0,
      // Le dix-huitième est celui de `UsageTab`, consommé quand on la rend.
      { loading: false, usage: releve, error: null },
    ],
    memorySession({ 'missions.tab': 'usage' }),
  )
  api.apply(ctx)
  const tree = registered.main({})
  const tab = findAll(tree, 'UsageTab')[0]
  assert.ok(tab, 'l’onglet Usage porte sa vue')
  return { tree, tab, inner: renderTree(tab), setters, effects }
}

test('chaque geste du registre est émis par un endroit du panneau, et rien d’autre', () => {
  const known = new Set(USAGE_ELEMENTS.map((element) => element.id))
  // Les identifiants écrits en clair : s'ils sortent du registre, c'est une
  // faute de frappe que la route refusera en 400 au premier clic.
  const staticIds = [...SOURCE.matchAll(/track\('([a-z][a-z.\-]*)'/g)].map((match) => match[1])
  assert.ok(staticIds.length > 20, 'le panneau compte ses gestes')
  for (const id of staticIds) assert.ok(known.has(id), `geste inconnu du registre : ${id}`)

  // Les familles dynamiques : une seule écriture pour toutes leurs valeurs.
  const families = {
    tab: /track\(`tab\.\$\{viewed\}`\)/,
    filter: /track\(`filter\.\$\{key\}`/,
    'mission.tab': /track\(`mission\.tab\.\$\{entry\.id\}`\)/,
    'repository.tab': /track\(`repository\.tab\.\$\{entry\.id\}`\)/,
    'workflow.arc': /track\(exists \? 'workflow\.arc\.update' : 'workflow\.arc\.add'\)/,
  }
  for (const [family, pattern] of Object.entries(families)) {
    assert.match(SOURCE, pattern, `la famille ${family} est comptée depuis un seul point`)
  }

  // Chaque identifiant du registre est donc émis, soit en clair, soit par sa
  // famille : aucun geste déclaré ne reste sans compteur.
  const covered = (id) => staticIds.includes(id) || Object.keys(families).some((family) => id.startsWith(`${family}.`))
  const orphans = USAGE_ELEMENTS.map((element) => element.id).filter((id) => !covered(id))
  assert.deepEqual(orphans, [])
})

test('chaque adresse client passe par le préfixe des routes du panneau', () => {
  const urls = [...SOURCE.matchAll(/[A-Z_]+_URL = '([^']+)'/g)].map((match) => match[1])
  assert.ok(urls.length >= 14)
  for (const url of urls) assert.ok(url.startsWith('missions/api/'), `adresse hors du préfixe : ${url}`)
  // Et aucune adresse complète ne s'écrit ailleurs que dans ces constantes.
  assert.doesNotMatch(SOURCE, /fetch\('/)
  assert.doesNotMatch(SOURCE, /readRoute\('/)
})

test('l’onglet Usage lit le relevé une fois, et ne monte pas la liste', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => USAGE_LOADED }
  }
  try {
    const { tree, effects } = monterUsage()
    assert.equal(findAll(tree, 'MissionsView').length, 0, 'la liste ne se monte pas sous Usage')
    assert.equal(findAll(tree, 'DashboardView').length, 0)

    // L'onglet arme un seul effet : la lecture du relevé, et rien d'autre.
    const avant = effects.length
    const node = findAll(tree, 'UsageTab')[0]
    renderTree(node)
    assert.equal(effects.length - avant, 1)
    effects.at(-1).fn()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(appels, ['missions/api/usage'])

    // La colonne du volet dit d'où vient le chiffre, et qu'il n'ordonne rien.
    assert.match(textOf(tree), /A recommendation is a reading of the counts, not an order/)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('le relevé se lit comme un rapport : gestes rangés, verdicts, jamais utilisés', () => {
  const { inner } = monterUsage()
  const texte = textOf(inner)

  // Le total compte les retirés, et la fenêtre part de `startedAt`.
  assert.match(texte, /100 gestures counted/)
  assert.match(texte, /40 days · since/)
  assert.match(texte, /Most used/)
  const top = findAll(inner, 'li').filter((li) => li.props.className === 'missions-usage-top-item')
  assert.deepEqual(top.map((li) => textOf(li.children[1])), ['Usage tab', 'Filter by state', 'Declare branch and base'])

  // Les quatre verdicts se lisent avec le compte qui les a produits.
  assert.match(texte, /Grow/)
  assert.match(texte, /Keep/)
  assert.match(texte, /Improve/)
  assert.match(texte, /Remove/)
  // Le détail retenu s'affiche, les jamais utilisés se comptent, et le geste
  // retiré garde son compte dans une section à part.
  assert.match(texte, /in-review ×4/)
  assert.match(texte, /Never used \(47\)/)
  assert.match(texte, /Retired/)
  assert.match(texte, /old.gesture/)
  assert.match(texte, /Dashboard tab/)
})

test('un relevé absent, vide ou corrompu ne se confondent pas', () => {
  // Aucun fichier : le panneau n'a jamais rien compté ici, donc aucun verdict.
  const vide = monterUsage(null)
  assert.match(textOf(vide.inner), /No tally on this machine yet/)
  assert.match(textOf(vide.inner), /gestures it counts will show up here/)

  // Un fichier lisible mais vide : tout est déclaré, rien n'est utilisé, et la
  // porte n'est pas franchie — donc une recommandation serait un mensonge.
  const zero = monterUsage({ version: 1, startedAt: USAGE_AGO(2), elements: {} })
  assert.match(textOf(zero.inner), /0 gestures counted/)
  assert.match(textOf(zero.inner), /Never used \(50\)/)
  assert.match(textOf(zero.inner), /No verdict yet: the tally needs 7 days and 20 gestures/)

  // Un fichier illisible se dit corrompu, il ne se fait pas passer pour vide.
  const casse = monterUsage({ version: 1, startedAt: null, updatedAt: null, broken: true, elements: {} })
  assert.match(textOf(casse.inner), /could not be read/)
})

test('chaque geste compte une fois, et un relevé qui échoue ne casse aucun clic', async () => {
  const calls = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body), keepalive: init.keepalive })
    return { ok: true, json: async () => USAGE_LOADED }
  }
  try {
    const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
    api.apply(ctx)
    const tree = registered.main({})
    const bouton = findAll(tree, 'button').find((node) => node.props.id === 'missions-tab-settings')
    assert.ok(bouton, 'la barre porte l’onglet Settings')

    bouton.props.onClick()
    // Settings ouvre sa section Usage : le geste reste `tab.usage` au registre.
    assert.deepEqual(setters.slice(-2), ['settings', null], 'le clic ouvre Settings')
    assert.deepEqual(calls, [{ url: 'missions/api/usage', method: 'POST', body: { element: 'tab.usage' }, keepalive: true }])
  } finally {
    globalThis.fetch = vraiFetch
  }

  // Le relevé tombe : le geste qu'il comptait se fait quand même.
  globalThis.fetch = () => { throw new Error('offline') }
  try {
    const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
    api.apply(ctx)
    const tree = registered.main({})
    const bouton = findAll(tree, 'button').find((node) => node.props.id === 'missions-tab-settings')
    assert.doesNotThrow(() => bouton.props.onClick())
    assert.deepEqual(setters.slice(-2), ['settings', null])
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la recherche se compte quand on la quitte, pas à chaque frappe', () => {
  const calls = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({}) }
  }
  try {
    const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'missions' }))
    api.apply(ctx)
    const tree = registered.main({})
    const view = renderTree(findAll(tree, 'MissionsView')[0])
    const input = findAll(view, 'input').find((node) => node.props.type === 'search')

    input.props.onChange({ target: { value: 'm' } })
    input.props.onChange({ target: { value: 'mis' } })
    assert.deepEqual(calls, [], 'aucun POST par frappe')

    input.props.onBlur({ target: { value: 'mis' } })
    assert.deepEqual(calls, [{ url: 'missions/api/usage', body: { element: 'filter.search', detail: 'mis' } }])
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('le montage et le tick de rafraîchissement ne comptent rien', async () => {
  const calls = []
  const vraiFetch = globalThis.fetch
  const vraiSetInterval = globalThis.setInterval
  let tick = null
  globalThis.setInterval = (fn) => { tick = fn; return 0 }
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    return { ok: true, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    const { api, ctx, registered, effects } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'missions' }))
    api.apply(ctx)
    registered.main({})
    // Les effets du panneau joués comme React les jouerait au montage.
    for (const effect of effects) effect.fn()
    await new Promise((done) => setTimeout(done, 0))
    // Le montage lit la liste et le compte de la pastille, et ne compte rien.
    assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET'], 'le montage lit la liste et le compte, sans compter')
    assert.deepEqual(calls.map((call) => call.url), ['missions/api/list', 'missions/api/repositories/count'])

    assert.ok(tick, 'le tick de 60 s est armé')
    calls.length = 0
    tick()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET'], 'le tick rafraîchit, sans compter')
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiSetInterval
  }
})

test('Usage se place avant Workflows dans les sections de Settings, et ses verdicts ont leurs deux thèmes', () => {
  const start = SOURCE.indexOf('const SETTINGS_VIEWS = [')
  const sections = SOURCE.slice(start, SOURCE.indexOf(']', start))
  assert.ok(sections.indexOf("'usage'") < sections.indexOf("'workflows'"))

  // Chaque verdict a sa règle, dans le thème par défaut comme dans le manga.
  for (const verdict of ['grow', 'keep', 'improve', 'remove', 'none']) {
    assert.ok(regle(`.missions-usage-verdict--${verdict}`).length > 0, `règle absente : ${verdict}`)
  }
  assert.match(SOURCE, /\.missions-panel\[data-theme="manga"\] \.missions-usage-verdict--grow/)
})

// ---------------------------------------------------------------------------
// Chaque geste se paie un POST, et un seul : le relevé compte des clics, pas
// des intentions. Les tests ci-dessous cliquent chaque gestionnaire rendu et
// lisent la requête qui part vraiment — la lecture statique des `track('…')`
// ne prouve pas qu'un bouton est câblé.
// ---------------------------------------------------------------------------

/** Un `fetch` espion : les GET répondent `{}`, les POST sont relevés. */
function espionUsage() {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    appels.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    })
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }
  return {
    appels,
    postes: () => appels.filter((appel) => appel.url === 'missions/api/usage' && appel.method === 'POST'),
    /** Un clic, un POST — avec le corps exact que le registre attend. */
    geste(element, detail) {
      const postes = this.postes()
      assert.equal(postes.length, 1, `un seul POST pour ${element}, pas ${postes.length}`)
      assert.deepEqual(
        postes[0].body,
        detail === undefined ? { element } : { element, detail },
        `le corps de ${element} nomme le geste et son détail`,
      )
      appels.length = 0
    },
    /** Un clic que le relevé ne compte pas. */
    aucunGeste(raison) {
      assert.deepEqual(this.postes(), [], raison)
      appels.length = 0
    },
    restore() {
      globalThis.fetch = vraiFetch
    },
  }
}

/** Clique une case du menu d'un `ChecklistFilter`, menu ouvert comme React le ferait. */
function cliquerCaseFiltre(brut, queue, label, index = 0) {
  // `StatusFilter` et `PriorityFilter` ne sont pas encore résolus : on rend le
  // composant une fois pour obtenir son `ChecklistFilter`, que l'on rend ensuite
  // menu ouvert, comme le clic du chip l'aurait posé.
  const conteneur = findAll(brut, label === 'Status' ? 'StatusFilter' : 'PriorityFilter')[0]
  assert.ok(conteneur, `le filtre ${label} est monté`)
  const filtre = conteneur.fn({ ...conteneur.props, children: conteneur.children })
  assert.equal(filtre.type, 'ChecklistFilter', `le filtre ${label} passe par le menu à cases`)
  // Le chip pose `open === true` ; le faux React ne relance pas le rendu, le
  // test rejoue donc ce rendu avec l'état que le clic aurait posé.
  queue.push(true)
  const ouvert = renderTree(filtre)
  const cases = findAll(ouvert, 'input').filter((node) => node.props.type === 'checkbox')
  assert.ok(cases.length > index, `le menu ${label} a ses cases`)
  return { ouvert, caisse: cases[index] }
}

test('chaque onglet de la barre compte son geste, sauf celui déjà ouvert', () => {
  const spy = espionUsage()
  try {
    const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
    api.apply(ctx)
    const tree = registered.main({})
    const onglets = findAll(tree, 'button').filter((node) => node.props.className === 'missions-tab')
    assert.equal(onglets.length, 5, 'cinq onglets : dashboard, missions, done, repositories, settings')

    // L'onglet où l'on est déjà ne compte rien : un geste, pas un état.
    const courant = onglets.find((node) => node.props.id === 'missions-tab-dashboard')
    courant.props.onClick()
    spy.aucunGeste('cliquer l’onglet déjà ouvert ne compte rien')

    for (const onglet of onglets) {
      const id = onglet.props.id.replace('missions-tab-', '')
      if (id === 'dashboard') continue
      onglet.props.onClick()
      // Settings compte la section qu'il ouvre : le registre garde `tab.usage`.
      spy.geste(id === 'settings' ? 'tab.usage' : `tab.${id}`)
    }

    // Depuis un autre onglet, le dashboard se compte aussi.
    const { api: api2, ctx: ctx2, registered: registered2 } = charger(
      undefined,
      [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions'],
      memorySession(),
    )
    api2.apply(ctx2)
    findAll(registered2.main({}), 'button')
      .find((node) => node.props.id === 'missions-tab-dashboard')
      .props.onClick()
    spy.geste('tab.dashboard')
  } finally {
    spy.restore()
  }
})

test('chaque filtre de la barre compte un seul POST, avec son détail', () => {
  const spy = espionUsage()
  try {
    const { api, ctx, registered, queue } = charger(
      undefined,
      [
        EMPTY_BAR,
        dashboardView(DASH_MISSIONS),
        'missions',
        '',
        { ...EMPTY_BAR.filters, type: 'bug' },
        null,
      ],
      memorySession(),
    )
    api.apply(ctx)
    const tree = registered.main({})
    const vueNode = findAll(tree, 'MissionsView')[0]
    const view = renderTree(vueNode)
    // Le même rendu, non résolu : les filtres à cases y sont encore des composants.
    const brut = vueNode.fn({ ...vueNode.props, children: vueNode.children })

    const select = (label) => {
      const noeud = findAll(view, 'select').find((node) => node.props['aria-label'] === label)
      assert.ok(noeud, `le sélecteur ${label} est rendu`)
      return noeud
    }

    select('Filter by type').props.onChange({ target: { value: 'story' } })
    spy.geste('filter.type', 'story')

    select('Filter by epic').props.onChange({ target: { value: 'socle' } })
    spy.geste('filter.epic', 'socle')

    select('Filter by project').props.onChange({ target: { value: 'missions' } })
    spy.geste('filter.project', 'missions')

    select('Filter by sort').props.onChange({ target: { value: 'oldest' } })
    spy.geste('filter.sort', 'oldest')

    // Les deux filtres à cases passent par leur menu, ouvert explicitement.
    const etat = cliquerCaseFiltre(brut, queue, 'Status')
    const optionEtat = findAll(etat.ouvert, 'label').find((node) => String(node.props.className) === 'missions-status-option')
    etat.caisse.props.onChange()
    spy.geste('filter.state', optionEtat.props['data-state'])

    const priorite = cliquerCaseFiltre(brut, queue, 'Priority')
    const optionPriorite = findAll(priorite.ouvert, 'label').find((node) => String(node.props.className) === 'missions-status-option')
    priorite.caisse.props.onChange()
    spy.geste('filter.priority', optionPriorite.props['data-state'])

    const interrupteur = findAll(view, 'button').find((node) => node.props.role === 'switch')
    assert.ok(interrupteur, 'l’interrupteur « Missing » est rendu')
    interrupteur.props.onClick()
    spy.geste('filter.missing', 'any')

    // La barre a des filtres actifs : le bouton de nettoyage est là, et son
    // détail dit l'onglet.
    const nettoyer = findAll(view, 'button').find((node) => node.props.className === 'missions-clear')
    assert.ok(nettoyer, 'le bouton de nettoyage est rendu avec un filtre actif')
    nettoyer.props.onClick()
    spy.geste('filter.clear', 'open')
  } finally {
    spy.restore()
  }
})

test('thème, recherche, rafraîchissement, reprise et ouverture de mission comptent leur geste', async () => {
  const spy = espionUsage()
  try {
    const { api, ctx, registered } = charger(
      undefined,
      [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions'],
      memorySession(),
    )
    api.apply(ctx)
    const tree = registered.main({})
    const view = renderTree(findAll(tree, 'MissionsView')[0])

    const themeSelect = findAll(tree, 'ThemeSelect')[0]
    assert.ok(themeSelect, 'le sélecteur de thème est monté')
    const theme = findAll(renderTree(themeSelect), 'select').find((node) => node.props['aria-label'] === 'Theme')
    assert.ok(theme, 'le sélecteur de thème est rendu')
    theme.props.onChange({ target: { value: 'manga' } })
    spy.geste('action.theme', 'manga')

    const recherche = findAll(view, 'input').find((node) => node.props.type === 'search')
    recherche.props.onChange({ target: { value: 'mi' } })
    spy.aucunGeste('aucun POST par frappe')
    recherche.props.onBlur({ target: { value: 'mis' } })
    spy.geste('filter.search', 'mis')

    const rafraichir = findAll(view, 'button').find((node) => node.props['aria-label'] === 'Refresh')
    assert.ok(rafraichir, 'le bouton de rafraîchissement est rendu')
    await rafraichir.props.onClick()
    spy.geste('list.refresh', 'open')

    const carte = findAll(view, 'article').find((node) => node.props.className === 'missions-card')
    assert.ok(carte, 'les cartes de mission sont rendues')
    carte.props.onClick()
    spy.geste('mission.open')
  } finally {
    spy.restore()
  }
})

test('une liste en échec offre une reprise qui compte le geste, dans les deux onglets', async () => {
  const spy = espionUsage()
  const echec = (missions = []) => ({ loading: false, missions, errors: [{ project: 'missions', message: 'boom' }], workspaceId: 'w', workspaceRoot: '/w' })
  try {
    for (const onglet of ['missions', 'done']) {
      const etats = onglet === 'missions'
        ? [EMPTY_BAR, echec(DASH_MISSIONS), 'missions']
        : [
            EMPTY_BAR, dashboardView(DASH_MISSIONS), 'done', '', { ...EMPTY_BAR.filters }, null, null, 'default', null,
            EMPTY_BAR, echec([]), '',
          ]
      const { api, ctx, registered } = charger(undefined, etats, memorySession())
      api.apply(ctx)
      const tree = registered.main({})
      // Le bandeau vit dans le panneau, au-dessus de la vue : il porte la
      // reprise des deux lectures, la liste comme le journal.
      const reprise = findAll(tree, 'button').find((node) => node.props.className === 'missions-retry')
      assert.ok(reprise, `le bandeau de reprise est rendu pour ${onglet}`)
      await reprise.props.onClick()
      spy.geste('list.retry', onglet === 'done' ? 'done' : 'open')
    }
  } finally {
    spy.restore()
  }
})

test('sans `fetch`, le panneau ne compte rien et le geste passe quand même', () => {
  const vraiFetch = globalThis.fetch
  // Le vrai navigateur peut ne pas exposer `fetch` : le compteur doit se taire,
  // pas casser le panneau.
  delete globalThis.fetch
  try {
    const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
    api.apply(ctx)
    const tree = registered.main({})
    const onglet = findAll(tree, 'button').find((node) => node.props.id === 'missions-tab-settings')
    assert.ok(onglet, 'la barre porte l’onglet Settings')
    assert.doesNotThrow(() => onglet.props.onClick(), 'un clic sans `fetch` ne lève pas')
    assert.deepEqual(setters.slice(-2), ['settings', null], 'le clic ouvre quand même sa section')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

/** Le volet avec ses vingt états, préremplis si le test en a besoin. */
function monterVoletAvec(mission, etatsVolet = []) {
  const view = { loading: false, missions: [mission], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const vide = { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null }
  const panneau = [
    EMPTY_BAR, view, 'missions', '', { ...EMPTY_BAR.filters }, null, mission,
    'default', null, EMPTY_BAR, vide, '', { ...EMPTY_BAR.filters, state: ['done'] }, null, null,
    // La section de Settings, restaurée avec l'onglet : le volet vient après.
    'usage',
    // Le compteur de relecture de la liste Repositories.
    0,
  ]
  const { api, ctx, registered, setters, queue } = charger(undefined, [...panneau, ...etatsVolet], memorySession())
  api.apply(ctx)
  const noeud = findAll(registered.main({}), 'MissionDrawer')[0]
  assert.ok(noeud, 'le volet est monté')
  return { inner: renderTree(noeud), setters, queue }
}

test('chaque onglet du volet, la priorité et le tracker comptent un seul POST', () => {
  const spy = espionUsage()
  try {
    const { inner } = monterVoletAvec({ ...MISSION, url: 'https://github.com/daedalforge/missions/issues/42' })

    for (const onglet of findAll(inner, 'button').filter((node) => node.props.className === 'missions-drawer-tab')) {
      const libelle = textOf(onglet).trim()
      onglet.props.onClick()
      spy.geste(`mission.tab.${libelle.toLowerCase()}`)
    }

    const priorite = findAll(inner, 'select').find((node) => node.props.className === 'missions-priority-select')
    assert.ok(priorite, 'le sélecteur de priorité est rendu')
    priorite.props.onChange({ target: { value: 'urgent' } })
    spy.geste('mission.priority', 'urgent')

    const tracker = findAll(inner, 'a').find((node) => node.props['aria-label'] === 'Open on the tracker')
    assert.ok(tracker, 'le lien du tracker est rendu')
    tracker.props.onClick()
    spy.geste('mission.open-tracker')
  } finally {
    spy.restore()
  }
})

test('blocage, déclaration, session et remontées comptent un seul POST', async () => {
  const spy = espionUsage()
  try {
    // Le blocage demande la raison : on la donne, le formulaire armé comme le
    // second clic du menu l'aurait laissé.
    const arme = monterVoletAvec(MISSION, [
      null, MISSION.branch, MISSION.base, false, null, null, null, 'details', false, true, 'Le serveur de test est tombé',
    ])
    const bloquer = findAll(arme.inner, 'button').find((node) => node.props.className === 'missions-blocked-apply')
    assert.ok(bloquer, 'le bouton « Bloquer » est rendu dès que le formulaire est armé')
    await bloquer.props.onClick()
    spy.geste('mission.block', 'block')

    // Déclarer une branche : la mission n'en a pas encore, le formulaire est donc sale.
    const neuve = monterVoletAvec({ ...MISSION, branch: null, base: null })
    const enregistrer = findAll(neuve.inner, 'button').find((node) => node.props.className === 'missions-declare-save')
    assert.ok(enregistrer, 'le bouton de déclaration est rendu')
    assert.equal(enregistrer.props.disabled, false, 'une mission sans branche rend le formulaire sale')
    await enregistrer.props.onClick()
    spy.geste('mission.declare')

    // En revue, les deux sessions : le pas courant et les remontées de la PR.
    const revue = monterVoletAvec({ ...MISSION, state: 'in-review' })
    const session = boutonSession(revue.inner)
    const remontees = boutonGeste(revue.inner, 'Check the PR feedback')
    assert.ok(session, 'la session du pas est rendue')
    assert.ok(remontees, 'la session des remontées est rendue')
    await session.props.onClick().catch(() => {})
    spy.geste('mission.session')
    await remontees.props.onClick().catch(() => {})
    spy.geste('mission.feedback-session')
  } finally {
    spy.restore()
  }
})

test('la clôture locale ne compte qu’au second clic', async () => {
  const spy = espionUsage()
  try {
    const { inner } = monterVoletAvec({ ...MISSION, state: 'ready-for-prod' })
    const fermer = findAll(inner, 'button').find((node) => /close the local checkout/i.test(nomDuGeste(node)))
    assert.ok(fermer, 'le bouton de clôture est rendu en ready-for-prod')
    await fermer.props.onClick()
    spy.aucunGeste('le premier clic arme seulement, il ne compte pas')
    await fermer.props.onClick()
    spy.geste('mission.close-checkout')
  } finally {
    spy.restore()
  }
})

test('ouvrir un dépôt et ses onglets, sa branche, sa page suivante comptent un seul POST', async () => {
  const spy = espionUsage()
  const repository = REPO_SCAN.repositories[1]
  const detail = { ...repository, remote: 'https://github.com/daedalforge/missions.git', ahead: 1, behind: 0 }
  try {
    // La ligne de dépôt est un bouton : le clic ouvre le volet et compte le dépôt.
    const lignes = montrerRepositories(scanReady(REPO_SCAN)).inner
    const ligne = findAll(lignes, 'button').find((node) => node.props['data-repository'] !== undefined)
    assert.ok(ligne, 'la ligne de dépôt est cliquable')
    ligne.props.onClick()
    spy.geste('repository.open', ligne.props['data-repository'])

    // Les trois onglets du volet du dépôt.
    const onglets = volet([
      ...repositoriesStates(scanReady(detail), repository),
      'details', { loading: false, more: false, data: null, error: null }, { loading: false, data: null, error: null },
    ]).inner
    for (const onglet of findAll(onglets, 'button').filter((node) => node.props.className === 'missions-repo-tab')) {
      onglet.props.onClick()
      spy.geste(`repository.tab.${textOf(onglet).trim().toLowerCase()}`)
    }

    // La page de commits : changer de branche compte, et « Show more » aussi.
    const history = {
      loading: false,
      // `more` est l'état « page en cours » : au repos il est faux, et c'est
      // `data.hasMore` qui dit qu'il reste des commits.
      more: false,
      data: { branch: 'main', branches: ['main', 'feat/x'], commits: [{ sha: 'abc1234', date: REPO_NOW, subject: 'main' }], hasMore: true },
      error: null,
    }
    const lecture = volet([
      ...repositoriesStates(scanReady(detail), repository),
      'history', history, { loading: false, data: null, error: null },
    ]).inner
    const branche = findAll(lecture, 'select').find((node) => node.props['aria-label'] === 'Branch')
    assert.ok(branche, 'le sélecteur de branche est rendu')
    branche.props.onChange({ target: { value: 'main' } })
    spy.geste('repository.branch', 'main')

    const plus = findAll(lecture, 'button').find((node) => textOf(node).trim() === 'Show more')
    assert.ok(plus, 'le bouton de page suivante est rendu')
    plus.props.onClick()
    spy.geste('repository.more')
  } finally {
    spy.restore()
  }
})

test('chaque geste du graphe de workflows compte un seul POST', async () => {
  const spy = espionUsage()
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  try {
    const monterGraphe = (chosen = null, arc = null) => {
      const { api, ctx, registered, queue } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'workflows' }))
      api.apply(ctx)
      const vue = findAll(registered.main({}), 'WorkflowsView')[0]
      assert.ok(vue, 'l’onglet Workflows est monté')
      const etats = workflowStates(review, chosen)
      if (arc) etats[6] = arc
      queue.push(...etats)
      return renderTree(vue)
    }
    const bouton = (graph, texte, classe) => {
      const noeud = findAll(graph, 'button').find((node) => (classe ? node.props.className === classe : textOf(node).trim() === texte))
      assert.ok(noeud, `le bouton ${texte ?? classe} est rendu`)
      return noeud
    }

    const graph = monterGraphe()
    bouton(graph, null, 'wf-step').props.onClick()
    spy.geste('workflow.step', 'review')

    bouton(graph, 'Recharger').props.onClick()
    spy.geste('workflow.reload')

    bouton(graph, 'Enregistrer').props.onClick()
    spy.geste('workflow.save')

    // Sans geste choisi, la carte propose l'ajout ; avec, elle propose le retrait.
    bouton(graph, 'Ajouter un geste').props.onClick()
    spy.geste('workflow.gesture.add')

    const choisi = monterGraphe('decider')
    bouton(choisi, 'Supprimer le geste').props.onClick()
    spy.geste('workflow.gesture.remove')

    // Un couple libre : l'arc s'ajoute. Le même couple : il se met à jour.
    const pris = new Set((review.edges ?? []).map((edge) => `${edge.from}→${edge.to}`))
    let libre = null
    for (const depart of review.nodes) {
      for (const arrivee of review.nodes) {
        if (depart.id !== arrivee.id && !pris.has(`${depart.id}→${arrivee.id}`)) { libre = { from: depart.id, to: arrivee.id }; break }
      }
      if (libre) break
    }
    assert.ok(libre, 'le modèle de revue a un couple libre pour un nouvel arc')
    bouton(monterGraphe(null, { ...libre, when: '' }), 'Ajouter l’arc').props.onClick()
    spy.geste('workflow.arc.add')

    const existant = review.edges[0]
    const miseAJour = monterGraphe(null, { from: existant.from, to: existant.to, when: 'encore' })
    bouton(miseAJour, 'Mettre à jour l’arc').props.onClick()
    spy.geste('workflow.arc.update')

    bouton(miseAJour, null, 'wf-arc-del').props.onClick({ stopPropagation() {} })
    spy.geste('workflow.arc.remove')
  } finally {
    spy.restore()
  }
})

test('le dashboard compte l’ouverture d’une ligne et le « View all » de ses cartes', () => {
  const spy = espionUsage()
  try {
    // Onze bugs : de quoi dépasser les dix lignes de la carte et faire
    // apparaître son lien « View all ».
    const bugs = Array.from({ length: 11 }, (_, index) => ({
      ...MISSION,
      key: `MIS-9${index}`,
      type: 'bug',
      state: 'in-review',
      priority: 'urgent',
      updatedAt: MISSION.updated,
    }))
    const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, dashboardView(bugs)], memorySession())
    api.apply(ctx)
    const dash = renderTree(findAll(registered.main({}), 'DashboardView')[0])

    const toutVoir = findAll(dash, 'button').find((node) => node.props.className === 'missions-dash-link')
    assert.ok(toutVoir, 'le lien « View all » est rendu au-delà de dix lignes')
    toutVoir.props.onClick()
    spy.geste('dashboard.view-all', 'type')

    const ligne = findAll(dash, 'button').find((node) => node.props.className === 'missions-row')
    assert.ok(ligne, 'une ligne de mission est rendue')
    ligne.props.onClick()
    spy.geste('mission.open')
  } finally {
    spy.restore()
  }
})

function monterVoletArchive(mission = { ...MISSION, state: 'done', updatedAt: MISSION.updated }) {
  return monterVolet(mission)
}

function boutonArchive(tree) {
  return findAll(tree, 'button').find((node) => nomDuGeste(node) === 'Archive') ?? null
}

test('le volet ne propose l’archive qu’en done', () => {
  for (const state of ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'blocked', null]) {
    const { tree } = monterVoletArchive({ ...MISSION, state, updatedAt: MISSION.updated })
    assert.equal(boutonArchive(tree), null, `aucun bouton d’archive pour ${state}`)
  }

  const { tree } = monterVoletArchive()
  const bouton = boutonArchive(tree)
  assert.ok(bouton, 'le bouton doit être rendu en done')
  assert.equal(bouton.props.className, 'missions-action missions-action--icon')
  assert.equal(bouton.props.disabled, false)
  // Le nom porte le geste ; la conséquence (le dossier part dans les archives)
  // se dit dans la note au premier clic, pas dans une infobulle.
  assert.equal(bouton.props.title, 'Archive')
  assert.equal(bouton.props['aria-label'], 'Archive')
  assert.equal(textOf(bouton), '')
  const dessins = findAll(bouton, 'svg')
  assert.equal(dessins.length, 1, 'une seule icône')
  assert.equal(dessins[0].props['aria-hidden'], 'true')

  // Il précède la session, qui reste le geste primaire en dernier.
  const actions = findAll(tree, 'div').find((node) => node.props.className === 'missions-drawer-actions')
  const boutons = actions.children.filter((child) => child.type === 'button')
  const iArchive = boutons.findIndex((node) => nomDuGeste(node) === 'Archive')
  const iSession = boutons.findIndex((node) => /^Start a session/.test(nomDuGeste(node)))
  assert.ok(iArchive >= 0 && iSession > iArchive)

  // Le câblage du bundle, en plus du rendu.
  assert.match(SOURCE, /const ARCHIVE_URL = 'missions\/api\/archive'/)
  // Armé, le bouton se remplit et sa coche remplace la boîte : l'état se lit
  // dans le dessin, comme pour la clôture locale.
  assert.match(SOURCE, /missions-action missions-action--icon missions-action--armed/)
  assert.match(SOURCE, /'aria-label': archiving \? 'Archiving…' : armedArchive \? 'Confirm — archive the mission' : 'Archive',/)
  assert.match(SOURCE, /h\(ActionIcon, \{ name: armedArchive && !archiving \? 'confirm' : 'archive' \}\)/)
  assert.match(SOURCE, /mission\.state === 'done'/)
  assert.match(SOURCE, /body: JSON\.stringify\(\{ key: mission\.key \}\)/)
  assert.match(SOURCE, /onArchived: applyArchive/)
  assert.match(SOURCE, /const applyArchive = \(archived\) => \{/)
})

test('en done, la note du volet nomme l’archive au lieu du blocage de session', () => {
  const { tree } = monterVoletArchive()
  const texte = textOf(tree)
  // La phrase du ticket #174 ne doit plus être la réponse du volet : elle parlait
  // de session et se lisait comme un refus du clic d'archive.
  assert.doesNotMatch(texte, /Session blocked: mission is done/)
  assert.match(texte, /This mission is done: no session\. Archive moves the folder to missions\/archives\./)

  // La session reste désarmée et décrite par la note, via son identifiant.
  const session = findAll(tree, 'button').find((node) => /^Start a session/.test(nomDuGeste(node)))
  assert.equal(session.props.disabled, true)
  assert.equal(session.props['aria-describedby'], 'missions-session-blocked')
  const note = findAll(tree, 'p').find((node) => node.props.id === 'missions-session-blocked')
  assert.ok(note, 'la note garde son identifiant pour l’infobulle')
  assert.equal(note.props.className, 'missions-drawer-note', 'une indication, pas une alerte')

  // Les autres blocages gardent leur phrase et leur couleur d'alerte.
  const { tree: bloque } = monterVolet({ ...MISSION, state: 'in-progress', branch: null, updatedAt: MISSION.updated })
  assert.match(textOf(bloque), /Session blocked: branch is not declared/)
  const alerte = findAll(bloque, 'p').find((node) => node.props.id === 'missions-session-blocked')
  assert.equal(alerte.props.className, 'missions-drawer-note missions-drawer-note--blocked')
})

test('le premier clic arme l’archive, le second envoie la clé et ferme le volet', async () => {
  const calls = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({ archived: 'missions/archives/MIS-42', folder: 'MIS-42', project: 'missions' }),
    }
  }
  try {
    const archived = []
    const { tree: overridden, setters } = monterVolet({ ...MISSION, state: 'done', updatedAt: MISSION.updated }, {
      onArchived: (entry) => { archived.push(entry) },
    })
    const bouton = boutonArchive(overridden)
    assert.ok(bouton)

    await bouton.props.onClick()
    assert.deepEqual(calls, [], 'le premier clic n’écrit rien')
    const armeNote = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
    assert.equal(armeNote.error, false)
    assert.match(armeNote.text, /missions\/archives\/. Click again to confirm/)

    await bouton.props.onClick()
    // Le geste se compte au clic qui confirme, avant la demande d'archive : sans
    // cette trace, un clic d'archive ne laissait aucune preuve (MIS-174).
    assert.deepEqual(calls, [
      { url: 'missions/api/usage', method: 'POST', body: { element: 'mission.archive' } },
      { url: 'missions/api/archive', method: 'POST', body: { key: 'MIS-42' } },
    ])
    const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
    assert.equal(note.error, false)
    assert.match(note.text, /Archived to missions\/archives\/MIS-42/)
    assert.deepEqual(archived, [{ key: 'MIS-42', folder: 'MIS-42' }])
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('un refus d’archive se dit avec sa cause, et le bouton se réarme', async () => {
  const calls = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: false, status: 409, json: async () => ({ error: 'missions/archives/MIS-42 already exists' }) }
  }
  try {
    const { tree, setters } = monterVoletArchive()
    const bouton = boutonArchive(tree)

    await bouton.props.onClick()
    await bouton.props.onClick()

    assert.equal(calls.filter((url) => url === 'missions/api/archive').length, 1)
    const note = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
    assert.equal(note.error, true)
    assert.match(note.text, /Archive refused: missions\/archives\/MIS-42 already exists/)

    // Le refus ne touche pas la liste : aucun updater reçu ne perd la mission.
    const kept = setters.reduce(
      (state, next) => (typeof next === 'function' ? next(state) : state),
      { missions: [{ key: 'MIS-42' }, { key: 'MIS-43' }] },
    )
    assert.deepEqual(kept.missions.map((mission) => mission.key), ['MIS-42', 'MIS-43'], 'la ligne reste dans la vue')

    // Un refus réarme le geste : le clic suivant redemande confirmation.
    await bouton.props.onClick()
    assert.equal(calls.filter((url) => url === 'missions/api/archive').length, 1, 'le clic après refus réarme sans écrire')
    const rearme = setters.filter((value) => value && typeof value === 'object' && 'error' in value).at(-1)
    assert.match(rearme.text, /Click again to confirm/)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('archiver retire la ligne de Done et referme le volet', async () => {
  const calls = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }),
    }
  }
  try {
    const mission = { ...MISSION, state: 'done', updatedAt: MISSION.updated }
    const { drawer, setters } = monterVolet(mission)
    assert.equal(typeof drawer.props.onArchived, 'function')

    drawer.props.onArchived({ key: 'MIS-42', folder: 'MIS-42' })

    // Le volet est refermé.
    assert.ok(setters.includes(null), 'le volet doit se refermer')
    // La ligne quittée les deux copies de la liste, sans attendre le serveur.
    const filtered = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [{ key: 'MIS-42' }, { key: 'MIS-1' }] }))
    assert.ok(filtered.every((next) => next.missions.length === 1 && next.missions[0].key === 'MIS-1'))
    assert.deepEqual(calls, ['missions/api/list?done=1&refresh=1'])
  } finally {
    globalThis.fetch = vraiFetch
  }
})
