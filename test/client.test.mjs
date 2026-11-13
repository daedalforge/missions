import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { USAGE_ELEMENTS, modelOf } from '../lib/view.js'
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
  const reset = () => { hookIndex = 0; updates.clear() }
  return { api, ctx, registered, id: captured.id, setters, effects, queue, resetHooks, reset }
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
  const manga = regle('.missions-panel[data-skin="paper"] .missions-action')
  assert.match(manga, /border: 1\.5px solid var\(--skin-ink\)/)
  assert.match(manga, /box-shadow: 2px 2px 0 var\(--skin-shadow\)/)
  assert.match(regle('.missions-panel[data-skin="paper"] .missions-action--primary'), /background: var\(--skin-ink\)/)
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
    regle('.missions-panel[data-skin="paper"] .missions-action:focus-visible'),
    /outline-color: var\(--skin-ink\)/,
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
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-drawer-tabs \{/)
  // Le panneau est déjà séparé par le trait des onglets : aucun bloc ne
  // rajoute une bordure haute, propriétés comprises.
  assert.match(SOURCE, /\.missions-drawer-panel \.missions-props, \.missions-drawer-panel \.missions-journal, \.missions-drawer-panel \.missions-checklist \{ padding-top: 0; border-top: 0; \}/)
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-drawer-panel \.missions-props \{ border-top: 0; \}/)
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
  // Done est un onglet déclaré entre Missions et Repositories, pas un filtre, et
  // il porte le compte des closes déclarées : sa pastille a sa route à part.
  assert.match(SOURCE, /\{ id: 'done', label: 'Done', source: 'tracker', badge: 'done' \},/)
  assert.match(SOURCE, /const DONE_COUNT_URL = 'missions\/api\/done\/count'/)
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
  assert.match(flat, /DashboardView/)
  assert.doesNotMatch(flat, /DashboardQueue/)
  assert.doesNotMatch(SOURCE, /missions-drawer--empty \{ display: none; \}/)
  assert.match(SOURCE, /\[data-skin="paper"\] \.missions-card\[data-interactive="true"\]:hover \{[^}]*background: color-mix/)
  assert.doesNotMatch(SOURCE, /\[data-skin="paper"\] \.missions-card\[data-interactive="true"\]:hover \{[^}]*translateY/)
})

test('le compteur de l’onglet prend l’anneau des groupes, pas une pastille pâle', () => {
  const ring = regle('.missions-panel[data-skin="paper"] .missions-tab-count')
  // Même dessin que `.missions-group-ring` : le trait, la taille, le chiffre.
  assert.match(ring, /display: grid/)
  assert.match(ring, /width: 24px/)
  assert.match(ring, /height: 24px/)
  assert.match(ring, /border: 1\.5px solid var\(--skin-ink\)/)
  assert.match(ring, /border-radius: 50%/)
  assert.match(ring, /font: 700 11px\/1 var\(--skin-mono\)/)
  // Un compteur d'onglet n'a pas d'état : l'accent du panneau remplace la
  // teinte d'état que l'anneau des groupes reçoit de son groupe.
  assert.match(ring, /background: var\(--skin-accent\)/)
  // La pastille du thème par défaut ne bouge pas.
  assert.match(regle('.missions-tab-count'), /border-radius: 9px/)
  // En thème sombre, le chiffre reste en encre sombre sur l'orange, comme
  // l'anneau et la marque du titre : c'est le bloc, pas seulement l'entrée de
  // la liste, qui doit porter la couleur.
  for (const prefix of [':root[data-ds-dark-theme]', 'body[data-ds-dark-theme]']) {
    const at = SOURCE.indexOf(`${prefix} .missions-panel[data-skin="paper"] .missions-tab-count,`)
    assert.ok(at >= 0, `sélecteur sombre manquant : ${prefix}`)
    assert.match(SOURCE.slice(at, SOURCE.indexOf('}', at)), /color: var\(--skin-accent-ink\)/)
  }
})

test('le thème Naruto finit le formulaire de branche, le filtre et la liste vide', () => {
  const manga = (name) => regle(`.missions-panel[data-skin="paper"] ${name}`)

  // Le formulaire du volet suivait le thème par défaut : champs blancs, bordure
  // grise. Il prend le cadre encre, le fond page-2 et l'ombre papier.
  for (const field of ['.missions-declare-input', '.missions-declare-save']) {
    assert.match(manga(field), /border: 1\.5px solid var\(--skin-ink\)/)
    assert.match(manga(field), /background: var\(--skin-page-2\)/)
    assert.match(manga(field), /box-shadow: [12]px [12]px 0 var\(--skin-shadow\)/)
  }
  assert.match(manga('.missions-declare'), /border-top: 1\.5px solid var\(--skin-ink\)/)
  // Les cases du filtre Statut prennent les teintes du thème ; la palette
  // GitHub ne reste que sur le thème par défaut.
  const accents = [
    ['in-review', 'var(--skin-info-strong)'],
    ['ready-for-prod', 'var(--skin-alt-strong)'],
    ['in-progress', 'var(--skin-warn-ink)'],
    ['ready', 'var(--skin-good-strong)'],
    ['to-refine', 'var(--skin-quiet-strong)'],
  ]
  for (const [state, color] of accents) {
    assert.ok(
      manga(`.missions-status-option[data-state="${state}"] input`).includes(`accent-color: ${color};`),
      `accent manga manquant pour ${state}`,
    )
  }
  assert.match(regle('.missions-status-option[data-state="to-refine"] input'), /accent-color: #8250df/)
  // La liste vide n'est plus un texte gris nu : un bandeau pointillé.
  assert.match(manga('.missions-empty'), /border: 1\.5px dashed var\(--skin-line-strong\)/)
  assert.match(manga('.missions-empty'), /background: var\(--skin-page-2\)/)
  // L'aide d'erreur repasse au corail clair en thème sombre : le corail profond
  // du thème clair tomberait à 2,6:1 sur le fond sombre.
  const darkError = SOURCE.slice(SOURCE.indexOf(':root[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-declare-note--error,'))
  assert.match(darkError.slice(0, darkError.indexOf('}')), /color: var\(--skin-danger\)/)
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
  assert.ok(SOURCE.includes('body[data-ds-dark-theme] .missions-panel[data-skin="paper"] .missions-prio[data-priority="high"] { color: var(--skin-accent); }'))
  assert.ok(!SOURCE.includes('.missions-prio[data-priority="none"] { opacity: .55; }'))
  // Le remplissage est la seule chose qui rend les barres visibles : sans lui
  // elles prennent le noir par défaut et disparaissent en thème sombre.
  assert.ok(SOURCE.includes('.missions-prio .prio-bar, .missions-prio .prio-mark { fill: currentColor; }'))
})

test('une carte de mission est un bouton qui se tape, sans état pressé', () => {
  const view = { loading: false, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, view, 'missions'])
  api.apply(ctx)
  const list = findAll(registered.main({}), 'MissionsView')[0]
  const tree = renderTree({ ...list, props: list.props })
  const carte = findAll(tree, 'article').find((node) => /missions-card--mission/.test(node.props.className ?? ''))
  assert.ok(carte, 'la carte de mission est rendue')
  assert.equal(carte.props.role, 'button')
  assert.equal(carte.props.tabIndex, 0)
  assert.equal(carte.props['data-interactive'], 'true')
  assert.equal(carte.props['data-priority'], 'high')
  assert.equal('aria-pressed' in carte.props, false, 'une carte ouvre, elle ne s’allume pas')

  // Entrée et espace activent, une autre touche non : et l'espace est bien
  // empêché de faire défiler la page sous le curseur.
  const prevented = []
  carte.props.onClick()
  carte.props.onKeyDown({ key: 'Enter', preventDefault: () => prevented.push('enter') })
  carte.props.onKeyDown({ key: ' ', preventDefault: () => prevented.push('space') })
  carte.props.onKeyDown({ key: 'a', preventDefault: () => prevented.push('a') })
  assert.deepEqual(prevented, ['enter', 'space'])
})

test('une carte statique n’est pas un bouton, une carte active l’est', () => {
  const { tree } = renderDashboard([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'], { now: DASH_NOW })
  const widgets = findAll(tree, 'article').filter((node) => /missions-card--widget/.test(node.props.className ?? ''))
  assert.ok(widgets.length >= 4, 'les widgets sont des cartes')
  for (const carte of widgets) {
    assert.equal(carte.props.role, undefined, 'pas de rôle de bouton')
    assert.equal(carte.props.tabIndex, undefined, 'pas dans l’ordre de tabulation')
    assert.equal(carte.props['data-interactive'], undefined, 'aucune affordance de contrôle')
    assert.equal(carte.props.onClick, undefined, 'aucun clic')
  }
})

test('la carte d’un workflow est un bouton natif, actif et pressé', () => {
  const { rendered } = montrerWorkflows([workflowEntry(), statutsEntry()])
  const cartes = findAll(rendered, 'button').filter((node) => /missions-card--pick/.test(node.props.className ?? ''))
  assert.equal(cartes.length, 2)
  assert.equal(cartes[0].type, 'button')
  assert.equal(cartes[0].props['data-interactive'], 'true')
  assert.equal(cartes[0].props.role, undefined, 'le bouton natif porte déjà le rôle')
  assert.equal(cartes[0].props.tabIndex, undefined, 'le bouton natif est déjà dans l’ordre')
  assert.equal(cartes[0].props['aria-pressed'], true, 'la carte choisie est pressée')
  assert.equal(cartes[1].props['aria-pressed'], false)
})

test('le cadre de carte est commun, la géométrie et l’affordance sont par variante', () => {
  // Une seule coque : la classe de widget ne peint plus son propre cadre.
  assert.match(SOURCE, /^\.missions-card \{ display: flex/m)
  assert.doesNotMatch(SOURCE, /^\.missions-dash-card \{/m, 'la coque du dashboard a rejoint le cadre commun')
  assert.match(regle('.missions-card--mission'), /gap: 10px/)
  assert.match(regle('.missions-card--mission'), /padding: 14px 16px 12px/)
  assert.match(regle('.missions-card--pick'), /width: 100%/)
  // Le survol, le focus et l'état pressé n'existent que sur une carte active.
  assert.match(SOURCE, /\.missions-card\[data-interactive="true"\]:hover/)
  assert.match(SOURCE, /\.missions-card\[data-interactive="true"\]:focus-visible/)
  assert.match(SOURCE, /\.missions-card\[data-interactive="true"\]\[aria-pressed="true"\]/)
  assert.doesNotMatch(SOURCE, /\.wf-pick[ ,{]/, 'la carte pick a quitté sa coque locale')
})

test('la peau papier encadre les trois variantes sans coin sur le texte', () => {
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-card \{/)
  // La géométrie papier reste sur la variante mission.
  assert.match(regle('.missions-panel[data-skin="paper"] .missions-card--mission'), /gap: 7px/)
  assert.match(regle('.missions-panel[data-skin="paper"] .missions-card--mission'), /padding: 11px 14px 9px/)
  // Le coin replié ne peut pas se poser sur le compteur d'un widget ni sur le
  // genre d'une carte workflow : il reste sur la carte de mission.
  assert.doesNotMatch(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-card::after/)
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-card--mission::after/)
})

test('le montage lit l’ouvert et les deux comptes ; Done et le résumé paient leur lecture, le bouton et le tick forcent', () => {
  // Le panneau est remonté à chaque changement de vue : forcer au montage
  // paierait tout le trajet tracker à chaque retour sur Missions. Le cache
  // serveur de 60 s est lu ; le bouton Refresh et le tick de 60 s forcent.
  assert.match(SOURCE, /const load = React\.useCallback\(\(\{ silent = false, refresh = false \} = \{\}\) => \{/)
  assert.match(SOURCE, /const loadDone = React\.useCallback\(\(\{ silent = false, refresh = false \} = \{\}\) => \{/)
  assert.match(SOURCE, /const loadDoneCount = React\.useCallback\(\(\) => \{/)
  assert.match(SOURCE, /const loadSummary = React\.useCallback\(\(\{ refresh = false \} = \{\}\) => \{/)
  assert.match(SOURCE, /const url = refresh \? `\$\{LIST_URL\}\?refresh=1` : LIST_URL/)
  assert.match(SOURCE, /const url = `\$\{LIST_URL\}\?done=1\$\{refresh \? '&refresh=1' : ''\}`/)
  assert.match(SOURCE, /const url = refresh \? `\$\{REPOSITORIES_SUMMARY_URL\}\?refresh=1` : REPOSITORIES_SUMMARY_URL/)
  // Le montage appelle load(), le compte de Done et celui des dépôts, sans
  // option ; les lignes closes et le résumé attendent l'ouverture de leur
  // onglet, et le compte des dépôts se relit au tick quel que soit l'onglet.
  assert.match(SOURCE, /React\.useEffect\(\(\) => \{\n\s+load\(\)\n\s+loadDoneCount\(\)\n\s+loadRepositoryCount\(\)\n\s+\}, \[load, loadDoneCount, loadRepositoryCount\]\)/)
  assert.match(SOURCE, /if \(tab !== 'done'\) return undefined\n\s+loadDone\(\)/)
  assert.match(SOURCE, /if \(tab !== 'dashboard'\) return undefined\n\s+loadSummary\(\)\n\s+loadDone\(\)\n\s+return undefined\n\s+\}, \[tab, loadSummary, loadDone\]\)/)
  // Le tick suit le périmètre de la vue ouverte : le Dashboard relit son
  // résumé, Done relit le clos, les vues tracker lisent l'ouvert, et Settings
  // n'en relit aucune.
  assert.match(SOURCE, /if \(tab === 'dashboard'\) loadSummary\(\)\n\s+else if \(tab === 'done'\) loadDone\(\{ silent: true, refresh: true \}\)\n\s+else if \(trackerTab\) load\(\{ silent: true, refresh: true \}\)/)
  assert.match(SOURCE, /loadRepositoryCount\(\)\n\s+\}, REFRESH_MS\)/)
  assert.match(SOURCE, /doneTab \? loadDone\(\{ refresh: true \}\) : load\(\{ refresh: true \}\)/)
  // Deux lectures savent forcer — la liste ouverte et le résumé du Dashboard ;
  // aucune ne part sans que la fonction ait reçu `refresh`.
  assert.equal((SOURCE.match(/\?refresh=1/g) ?? []).length, 2)
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
  const manga = regle('.missions-panel[data-skin="paper"] .missions-icon-btn')
  assert.match(manga, /1\.5px solid var\(--skin-ink\)/)
  assert.match(manga, /var\(--skin-shadow\)/)
  // Les deux ancrages du thème sombre sont couverts.
  assert.match(SOURCE, /:root\[data-ds-dark-theme\] \.missions-panel\[data-skin="paper"\] \.missions-icon-btn/)
  assert.match(SOURCE, /body\[data-ds-dark-theme\] \.missions-panel\[data-skin="paper"\] \.missions-icon-btn/)
  // Comme le spinner, l'animation du shuriken s'éteint si l'on demande moins de mouvement.
  assert.match(SOURCE, /@media \(prefers-reduced-motion: reduce\) \{ \.missions-icon-shuriken \{ animation: none; \} \}/)
})

test('la source d’un onglet est déclarée dans TABS, pas recopiée', () => {
  // L'ajout d'un onglet (MIS-116) ne doit pas obliger à réécrire les conditions.
  assert.match(SOURCE, /\{ id: 'dashboard', label: 'Dashboard', source: 'tracker' \},/)
  assert.match(SOURCE, /\{ id: 'missions', label: 'Missions', source: 'tracker', badge: 'missions' \},/)
  // Done porte le compte des closes déclarées : son badge est nommé, lui aussi.
  assert.match(SOURCE, /\{ id: 'done', label: 'Done', source: 'tracker', badge: 'done' \},/)
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
  return {
    loading,
    count: missions.filter((mission) => mission.state !== 'done').length,
    missions,
    errors: [],
    workspaceId: 'w',
    workspaceRoot: '/w',
  }
}

/**
 * La liste ouverte avant sa première réponse : rien n'est encore prouvé, donc
 * la pastille de Missions attend son compte comme les deux autres.
 */
function vueSansReponse() {
  return { loading: true, count: null, missions: [], errors: [], workspaceId: null, workspaceRoot: null }
}

/**
 * Les états de la liste ouverte publiés par une lecture : ses setters sont
 * fonctionnels, on les rejoue sur l'état de départ comme React le ferait.
 */
function vuesPubliees(setters, base) {
  return setters
    .filter((next) => typeof next === 'function')
    .map((update) => update(base))
    .filter((next) => next !== null && typeof next === 'object')
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
 * Les seize hooks de `WorkflowsView`, dans l'ordre de leur déclaration : le
 * harnais compte les `useState` par index, donc un état de test se construit
 * par nom — jamais par position, sinon un hook ajouté déplace tout le reste.
 */
const WORKFLOW_HOOKS = [
  'view', 'step', 'draft', 'chosen', 'status', 'saving', 'arc', 'version',
  'baseline', 'selectedArc', 'tab', 'creating', 'form', 'formErrors', 'creatingBusy', 'exitText',
]

/** L'état initial de `WorkflowsView`, par défaut sur l'onglet Informations. */
function workflowStateValues(draft, patch = {}) {
  const base = {
    view: {
      loading: false,
      error: null,
      workflows: [draft],
      writers: ['demandeur', 'session', 'outil'],
      states: ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done'],
    },
    step: draft.workflow,
    draft,
    chosen: null,
    status: null,
    saving: false,
    arc: { from: '', to: '', when: '' },
    version: 0,
    baseline: draft,
    selectedArc: null,
    tab: 'infos',
    creating: false,
    form: { title: '', description: '', kind: 'etape', local: false },
    formErrors: {},
    creatingBusy: false,
    exitText: (draft.exit ?? []).join(', '),
  }
  return WORKFLOW_HOOKS.map((name) => (name in patch ? patch[name] : base[name]))
}

/** L'état du panneau ouvert sur le graphe, pour les tests qui cliquent un nœud. */
function workflowStates(draft, chosen = null) {
  return workflowStateValues(draft, {
    view: { loading: false, error: null, workflows: [draft], writers: ['demandeur', 'session', 'outil'], states: [] },
    step: 'review',
    chosen,
    tab: 'graphe',
  })
}

/** L'état du panneau ouvert sur Informations, pour les tests de création. */
function workflowPanelStates(draft, patch = {}) {
  return workflowStateValues(draft, patch)
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
  assert.match(textOf(findAll(flight, 'div').find((node) => node.props.className === 'missions-card-foot')), /8 pts in flight · oldest 11 d/)
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
  const meta = (card) => textOf(findAll(card, 'span').find((span) => span.props.className === 'missions-card-meta'))
  assert.equal(meta(queue), '14')
  assert.equal(meta(flight), '12')
  assert.equal(meta(bugs), '14')
  assert.equal(meta(stories), '12')

  // Le pied dit ce qui reste, puis le lien porte le total de la liste.
  const foot = (card) => textOf(findAll(card, 'div').find((node) => node.props.className === 'missions-card-foot'))
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
  assert.match(textOf(findAll(flight, 'div').find((node) => node.props.className === 'missions-card-foot')), /8 pts in flight · oldest 11 d/)
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
  const foot = textOf(findAll(flight, 'div').find((node) => node.props.className === 'missions-card-foot'))
  assert.match(foot, /10 pts in flight/)
  assert.doesNotMatch(foot, /more/)
})

/** Le digeste du scan tel que la route le rend : trois lignes à problèmes. */
const DASH_SUMMARY = {
  root: '/Users/moi/projects',
  count: 5,
  durationMs: 1904,
  scannedAt: '2026-11-11T09:00:00Z',
  errors: [],
  repositories: [
    { name: 'missions', kind: 'clone', branch: 'feat/mis-192', upstream: 'origin/main', ahead: 3, behind: 0, dirty: 0, error: null, lastCommit: { sha: 'a1b2c3d', date: '2026-11-11T08:00:00Z', subject: 'MIS-191' }, main: null },
    { name: 'missions-mis-192', kind: 'worktree', branch: 'feat/mis-192', upstream: 'origin/main', ahead: 3, behind: 0, dirty: 0, error: null, lastCommit: { sha: 'a1b2c3d', date: '2026-11-11T08:00:00Z', subject: 'MIS-191' }, main: { name: 'missions', path: '/Users/moi/projects/missions' } },
    { name: 'missions-mis-100', kind: 'worktree', branch: 'feat/mis-100', upstream: null, ahead: 0, behind: 0, dirty: 2, error: null, lastCommit: { sha: 'd4e5f6a', date: '2026-10-01T09:00:00Z', subject: 'MIS-100' }, main: { name: 'missions', path: '/Users/moi/projects/missions' } },
    { name: 'retard', kind: 'clone', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2, dirty: 0, error: null, lastCommit: { sha: 'c3d4e5f', date: '2026-11-11T06:00:00Z', subject: 'main' }, main: null },
    { name: 'casse', kind: 'clone', branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, error: 'not a git repository', lastCommit: null, main: null },
  ],
}

/** Cinq closes, dont une dont la branche traîne encore dans un worktree. */
const DASH_CLOSED = [
  { key: 'MIS-10', title: 'livrée un', state: 'done', points: 5, updatedAt: '2026-11-10T12:00:00Z', branch: 'feat/mis-100' },
  { key: 'MIS-11', title: 'livrée deux', state: 'done', points: 2, updatedAt: '2026-11-09T12:00:00Z', branch: null },
  { key: 'MIS-12', title: 'livrée trois', state: 'done', points: 1, updatedAt: '2026-11-08T12:00:00Z', branch: null },
  { key: 'MIS-13', title: 'livrée quatre', state: 'done', points: 1, updatedAt: '2026-11-07T12:00:00Z', branch: null },
  { key: 'MIS-14', title: 'livrée cinq', state: 'done', points: 0, updatedAt: '2026-11-06T12:00:00Z', branch: null },
]

/** Le dashboard monté avec le digeste du scan et les closes. */
function renderDigest(props = {}) {
  const missions = DASH_MISSIONS.map((mission) => (
    mission.key === 'MIS-1' ? { ...mission, branch: 'feat/mis-192' } : mission
  ))
  const { tree, setters } = renderDashboard([EMPTY_BAR, dashboardView(missions), 'dashboard'], {
    now: DASH_NOW,
    summary: DASH_SUMMARY,
    closed: DASH_CLOSED,
    ...props,
  })
  const section = (title) => findAll(tree, 'section').find((node) => {
    const head = findAll(node, 'h2')[0]
    return head !== undefined && textOf(head) === title
  })
  return { tree, setters, section, missions }
}

test('le dashboard ajoute Repositories et Done, et les quatre cartes ne bougent pas', () => {
  const { tree, section } = renderDigest()

  const sections = findAll(tree, 'section')
  assert.deepEqual(sections.map((node) => textOf(findAll(node, 'h2')[0])), ['Missions', 'Repositories', 'Done'])
  assert.equal(findAll(tree, 'article').length, 8, 'quatre cartes par section')

  // La section Missions garde ses quatre cartes, dans l'ordre et avec leurs
  // lignes : le digeste s'ajoute, il ne réordonne rien.
  const [, , flight, queue] = findAll(section('Missions'), 'article')
  assert.deepEqual(
    findAll(section('Missions'), 'article').map((card) => textOf(findAll(card, 'h3')[0])),
    ['Bugs', 'High-priority stories', 'In flight', 'Needs you'],
  )
  const keys = (card) => findAll(card, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf)
  assert.deepEqual(keys(queue), ['MIS-1', 'MIS-2', 'MIS-5'])
  assert.deepEqual(keys(flight), ['MIS-3', 'MIS-4'])
  assert.match(textOf(findAll(flight, 'div').find((node) => node.props.className === 'missions-card-foot')), /8 pts in flight · oldest 11 d/)

  // Les deux nouvelles sections portent leur périmètre et leur sortie.
  const scope = (title) => textOf(findAll(findAll(section(title), 'header')[0], 'span').find((span) => span.props.className === 'missions-sect-scope'))
  assert.equal(scope('Repositories'), '5 repositories · 3 to fix')
  assert.equal(scope('Done'), '5 closed · 9 pts')
  const links = findAll(tree, 'button').filter((button) => button.props.className === 'missions-sect-link').map(textOf)
  assert.deepEqual(links, ['Open Missions→', 'Open Repositories→', 'Open Done→'])
})

test('les branches à pousser portent leur avance, et leur clic ouvre le dépôt', () => {
  const ouverts = []
  const { section, tree } = renderDigest({ onOpenRepository: (repository) => ouverts.push(repository) })
  const card = findAll(section('Repositories'), 'article').find((node) => textOf(findAll(node, 'h3')[0]) === 'Branches to push')
  const rows = findAll(card, 'button').filter((button) => button.props['data-reason'] !== undefined)

  // Une seule ligne pour la branche tenue par le clone et le worktree, et
  // c'est le worktree qui la porte. La close n'en est pas, la mission sans
  // branche non plus.
  assert.equal(rows.length, 1)
  assert.deepEqual(findAll(card, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf), ['MIS-1'])
  assert.deepEqual(findAll(card, 'span').filter((span) => span.props.className === 'missions-rowwhy').map(textOf), ['+3 commits'])
  assert.match(textOf(findAll(card, 'div').find((node) => node.props.className === 'missions-card-foot')), /0 never pushed · 3 commits ahead · scanned 3 h ago/)

  rows[0].props.onClick()
  assert.equal(ouverts.length, 1)
  assert.equal(ouverts[0].name, 'missions-mis-192')

  // La sortie de section ouvre l'onglet Repositories, comme les cartes ouvrent
  // la liste : le digeste route par le panneau.
  const sortie = findAll(tree, 'button').find((button) => textOf(button) === 'Open Repositories→')
  sortie.props.onClick()
  assert.ok(findAll(tree, 'section').length === 3)
})

test('les dépôts à réparer disent leur raison la plus grave et l’âge du dernier commit', () => {
  const { section } = renderDigest()
  const card = findAll(section('Repositories'), 'article').find((node) => textOf(findAll(node, 'h3')[0]) === 'Checkouts to fix')
  const rows = findAll(card, 'button').filter((button) => button.props['data-reason'] !== undefined)

  // Une raison par ligne, de la plus grave à la moins grave, puis par nom.
  assert.deepEqual(rows.map((row) => row.props['data-reason']), ['error', 'behind', 'dirty'])
  assert.deepEqual(findAll(card, 'span').filter((span) => span.props.className === 'missions-rowwhy').map(textOf), ['unreadable', '2 behind', '2 dirty'])
  assert.deepEqual(findAll(card, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf), ['casse', 'retard', 'missions-mis-100'])
  // L'âge du dernier commit : rien à lire pour l'entrée illisible, six heures
  // pour le retard, et un dépôt qui dort depuis plus d'un mois est marqué.
  const ages = findAll(card, 'span').filter((span) => span.props.className === 'missions-rowage')
  assert.deepEqual(ages.map(textOf), ['', '6 h', '41 d'])
  assert.equal(ages[2].props['data-quiet'], 'true')
  assert.match(textOf(findAll(card, 'div').find((node) => node.props.className === 'missions-card-foot')), /1 cold clone · scanned 3 h ago/)
})

test('les closes récentes portent leurs points, et la carte dit trois sur N', () => {
  const { section, tree } = renderDigest()
  const card = findAll(section('Done'), 'article').find((node) => textOf(findAll(node, 'h3')[0]) === 'Recently closed')

  const keys = findAll(card, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf)
  assert.deepEqual(keys, ['MIS-10', 'MIS-11', 'MIS-12'], 'les trois dernières, par mise à jour')
  const points = findAll(card, 'span').filter((span) => span.props.className === 'missions-rowpoints').map(textOf)
  assert.deepEqual(points, ['5 pts', '2 pts', '1 pt'])
  // Le total dépasse le plafond : la carte dit ce qu'elle montre et le pied le
  // reste, avec un lien vers l'onglet Done.
  const meta = textOf(findAll(card, 'span').find((span) => span.props.className === 'missions-card-meta'))
  assert.equal(meta, '3 of 5')
  const foot = findAll(card, 'div').find((node) => node.props.className === 'missions-card-foot')
  assert.match(textOf(foot), /2 more closed/)
  assert.match(textOf(foot), /View all 5/)

  // La carte des restes nomme le geste, qui reste dans le volet du dépôt.
  const left = findAll(section('Done'), 'article').find((node) => textOf(findAll(node, 'h3')[0]) === 'Left behind')
  assert.match(textOf(findAll(left, 'div').find((node) => node.props.className === 'missions-card-foot')), /Removing a worktree stays in the repository drawer/)
  assert.deepEqual(findAll(left, 'span').filter((span) => span.props.className === 'missions-rowkey').map(textOf), ['MIS-10'], 'seule la close dont la branche vit dans un worktree')

  const sortie = findAll(tree, 'button').find((button) => textOf(button) === 'Open Done→')
  assert.ok(sortie, 'la section Done a sa sortie')
})

test('une close laissée derrière ouvre le volet de son worktree', () => {
  const ouverts = []
  const { section } = renderDigest({ onOpenRepository: (repository) => ouverts.push(repository) })
  const card = findAll(section('Done'), 'article').find((node) => textOf(findAll(node, 'h3')[0]) === 'Left behind')
  const row = findAll(card, 'button').find((button) => button.props['data-reason'] === 'left-behind')
  assert.ok(row, 'la close dont la branche vit dans un worktree a sa ligne')
  assert.match(row.props['aria-label'], /^MIS-10 feat\/mis-100, closed/)

  row.props.onClick()
  assert.equal(ouverts.length, 1)
  // Le volet s'ouvre sur le worktree, pas sur le clone principal : c'est lui
  // qu'il faudra supprimer.
  assert.equal(ouverts[0].name, 'missions-mis-100')
})

test('un scan en échec garde la section, nomme l’échec et propose Retry', () => {
  const essais = []
  const { tree, section } = renderDigest({ summary: null, summaryError: 'permission denied', onRetrySummary: () => essais.push('retry') })

  // Aucune ligne n'a jamais été lue : les cartes ne prétendent pas un zéro.
  const alert = findAll(section('Repositories'), 'div').find((node) => node.props.className === 'missions-sect-error')
  assert.ok(alert, 'la section nomme l’échec')
  assert.equal(alert.props.role, 'alert')
  assert.match(textOf(alert), /The repository scan failed: permission denied/)
  const retry = findAll(alert, 'button').find((button) => button.props.className === 'missions-retry')
  assert.equal(textOf(retry), 'Retry')
  retry.props.onClick()
  assert.deepEqual(essais, ['retry'])

  const metas = findAll(section('Repositories'), 'span').filter((span) => span.props.className === 'missions-card-meta').map(textOf)
  assert.deepEqual(metas, ['—', '—'], 'un scan absent ne se lit pas comme zéro')
  // Les autres sections restent visibles : l'échec est local.
  assert.ok(section('Missions'))
  assert.ok(section('Done'))
  assert.ok(findAll(tree, 'article').length >= 8)
})

test('un échec chaud garde les lignes du scan précédent', () => {
  const { section } = renderDigest({ summaryError: 'offline' })
  const card = findAll(section('Repositories'), 'article').find((node) => textOf(findAll(node, 'h3')[0]) === 'Checkouts to fix')
  // La section nomme l'échec et garde ses trois lignes : un zéro serait un
  // mensonge, une liste effacée aussi.
  assert.deepEqual(findAll(card, 'button').filter((button) => button.props['data-reason'] !== undefined).map((button) => button.props['data-reason']), ['error', 'behind', 'dirty'])
  assert.equal(findAll(section('Repositories'), 'div').filter((node) => node.props.className === 'missions-sect-error').length, 1)
})

test('le résumé se lit à l’ouverture du Dashboard et à son tick, jamais ailleurs', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  const vraiSetInterval = globalThis.setInterval
  const vraiDocument = globalThis.document
  let tick = null
  globalThis.setInterval = (fn) => { tick = fn; return 0 }
  // Le panneau injecte sa feuille de style au montage : le faux document sert
  // aussi ce geste-là, pas seulement le drapeau du tick.
  globalThis.document = {
    hidden: false,
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    head: { append: () => {} },
  }
  globalThis.fetch = async (url) => {
    const cible = String(url)
    appels.push(cible)
    if (cible === 'missions/api/repositories/summary') return { ok: true, json: async () => DASH_SUMMARY }
    return { ok: true, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    // Onglet Missions : l'ouverture du Dashboard ne paie rien.
    const ferme = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'missions' }))
    ferme.api.apply(ferme.ctx)
    ferme.registered.main({})
    const ouverture = ferme.effects.find((effect) => String(effect.fn).includes("if (tab !== 'dashboard')"))
    assert.ok(ouverture, 'le Dashboard a son effet d’ouverture')
    assert.equal(ouverture.deps[0], 'missions')
    ouverture.fn()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(appels, [], 'aucun autre onglet ne paie le résumé')

    // Onglet Dashboard : le résumé et les closes, sans forcer.
    appels.length = 0
    const ouvert = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'dashboard' }))
    ouvert.api.apply(ouvert.ctx)
    ouvert.registered.main({})
    const effet = ouvert.effects.find((effect) => String(effect.fn).includes("if (tab !== 'dashboard')"))
    assert.equal(effet.deps[0], 'dashboard')
    await effet.fn()
    assert.deepEqual(appels, ['missions/api/repositories/summary', 'missions/api/list?done=1'], 'le résumé et les closes, chacun une fois')
    assert.equal(appels.some((url) => url.includes('refresh=1')), false, 'l’ouverture ne force pas')

    // Le tick : page cachée, rien ne part ; page visible, le résumé se relit
    // sans forcer, et le compte toujours.
    appels.length = 0
    for (const effect of ouvert.effects) effect.fn()
    await new Promise((done) => setTimeout(done, 0))
    appels.length = 0
    globalThis.document.hidden = true
    tick()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(appels, [], 'une page cachée ne relit rien')
    globalThis.document.hidden = false
    tick()
    await new Promise((done) => setTimeout(done, 0))
    assert.deepEqual(appels, ['missions/api/repositories/summary', 'missions/api/repositories/count'], 'le tick relit le résumé et le compte')
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiSetInterval
    if (vraiDocument === undefined) delete globalThis.document
    else globalThis.document = vraiDocument
  }
})

test('un résumé en échec nomme l’échec au panneau, et le Retry force le scan', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: false, status: 500, json: async () => ({ error: '/Users/moi/projects: permission denied' }) }
  }
  const panneau = [
    EMPTY_BAR,
    dashboardView(DASH_MISSIONS),
    'dashboard',
    '',
    { ...EMPTY_BAR.filters },
    null,
    null,
    'default',
    null,
    EMPTY_BAR,
    { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null, count: null },
    '',
    { ...EMPTY_BAR.filters, state: ['done'] },
    null,
    null,
    'usage',
    0,
    // Le résumé tel qu'une tentative ratée l'a laissé : la ligne d'échec est là.
    { loading: false, data: null, error: '/Users/moi/projects: permission denied' },
  ]
  try {
    const { api, ctx, registered } = charger(undefined, [...panneau], memorySession())
    api.apply(ctx)
    const view = findAll(registered.main({}), 'DashboardView')[0]
    assert.ok(view, 'l’onglet Dashboard est ouvert')
    const tree = renderTree(view)
    const alert = findAll(tree, 'div').find((node) => node.props.className === 'missions-sect-error')
    assert.ok(alert, 'le panneau reçoit l’échec du résumé')
    assert.match(textOf(alert), /The repository scan failed: \/Users\/moi\/projects: permission denied/)

    const retry = findAll(alert, 'button').find((button) => button.props.className === 'missions-retry')
    await retry.props.onClick()
    // Le seul geste du résumé qui force : le Retry paie un nouveau scan. Le
    // geste est compté au passage, comme tous ceux du panneau.
    assert.equal(appels.at(-1), 'missions/api/repositories/summary?refresh=1')
    assert.equal(appels.filter((url) => url.includes('repositories/summary')).length, 1)
  } finally {
    globalThis.fetch = vraiFetch
  }
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
  const subs = findAll(tree, 'p').filter((node) => node.props.className === 'missions-card-sub')

  assert.deepEqual(subs.map(textOf), [
    'Unresolved, assigned to you. Oldest first.',
    'Urgent or high, oldest first.',
    'Started, not shipped.',
    'Waiting on your next move, most urgent first.',
  ])
  // « sous le titre » : la ligne vient juste après l'en-tête, pas au bas de la carte.
  for (const card of findAll(tree, 'article')) {
    const line = card.children.findIndex((child) => child?.props?.className === 'missions-card-sub')
    assert.equal(line, 1, 'la ligne se place entre l’en-tête et le corps')
    assert.equal(card.children[0].type, 'header')
  }
  assert.match(SOURCE, /^\.missions-card-sub \{/m, 'la règle de style est présente')
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

test('chaque volet garde la famille missions-drawer et son titre', () => {
  // Given l'onglet Missions, le volet d'une mission, celui d'un dépôt.
  const vide = findAll(monter([EMPTY_BAR, dashboardView([]), 'missions']), 'aside')[0]
  const volet = findAll(monterVolet().tree, 'aside')[0]
  const depot = findAll(voletDepot(REPO_SCAN.repositories[0]).inner, 'aside')[0]
  const cas = [
    [volet, MISSION.title],
    [depot, REPO_SCAN.repositories[0].name],
  ]

  // Then chaque volet garde la classe commune et son titre, l'un après l'autre.
  for (const [aside, titre] of cas) {
    assert.ok(aside, 'le volet est monté')
    assert.match(aside.props.className, /(^|\s)missions-drawer(\s|$)/)
    assert.equal(textOf(findAll(aside, 'h2')[0]), titre)
  }
  assert.match(vide.props.className, /missions-drawer--empty/)
  assert.match(textOf(vide), /Select a mission to see its details/)
})

test('le dashboard occupe toute la largeur, sans volet à droite', () => {
  // Given le panneau monté sur le dashboard.
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'])

  // Then le digest est seul : aucun aside, aucun poste de décision.
  assert.equal(findAll(tree, 'aside').length, 0)
  assert.equal(findAll(tree, 'DashboardView').length, 1)
  assert.doesNotMatch(JSON.stringify(tree), /DashboardQueue/)

  // Then une file sans rien à décider ne monte pas non plus de volet vide.
  const vide = monter([EMPTY_BAR, dashboardView([MISSION]), 'dashboard'])
  assert.equal(findAll(vide, 'aside').length, 0)
})

test('sous le dashboard, le corps est le seul occupant de missions-content', () => {
  // Given le panneau monté sur le dashboard.
  const tree = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard'])

  // Then missions-content ne porte que le corps, qui prend la largeur.
  const contenu = findAll(tree, 'div').find((node) => node.props.className === 'missions-content')
  assert.ok(contenu, 'missions-content est monté')
  const enfants = contenu.children.filter((enfant) => enfant !== null && enfant !== undefined)
  assert.equal(enfants.length, 1)
  assert.equal(enfants[0].props.className, 'missions-body')
  assert.match(regle('.missions-body'), /flex: 1/)
})

test('une mission choisie ne rouvre pas de volet sous le dashboard', () => {
  // Given la même mission choisie, sous le dashboard puis sous Missions.
  const surDashboard = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'dashboard', '', EMPTY_BAR.filters, null, MISSION])
  const surMissions = monter([EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions', '', EMPTY_BAR.filters, null, MISSION])

  // Then le dashboard reste sans volet, et l'onglet Missions garde son tiroir.
  assert.equal(findAll(surDashboard, 'aside').length, 0)
  assert.equal(findAll(surDashboard, 'MissionDrawer').length, 0)
  assert.equal(findAll(surMissions, 'MissionDrawer').length, 1)
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
  assert.deepEqual(nav.map((node) => textOf(node)), ['Usage', 'Workflows', 'Playbook'])
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

test('les onglets Informations et Graphe ont leurs règles', () => {
  assert.match(regle('.wf-tabs'), /display: flex/)
  assert.match(regle('.wf-tab--active'), /font-weight: 600/)
  assert.match(regle('.wf-panel'), /border-radius: 12px/)
  assert.match(regle('.wf-panel-head'), /justify-content: space-between/)
  // La règle doit commencer une ligne : un préfixe de concaténation la rendait
  // invalide pour le navigateur, qui la jetait silencieusement.
  assert.match(SOURCE, /\n\.wf-detail-head \{ display: flex/, 'la règle de la tête de détail est intacte')
})

test('les deux onglets se lisent et se choisissent', () => {
  const { rendered, setters } = montrerWorkflows([workflowEntry()], { tab: 'infos' })
  const liste = findAll(rendered, 'div').find((node) => node.props.role === 'tablist')
  assert.ok(liste, 'la barre d’onglets a son rôle')
  const onglets = findAll(rendered, 'button').filter((node) => node.props.role === 'tab')
  assert.deepEqual(onglets.map((node) => textOf(node)), ['Informations', 'Graphe'])
  assert.equal(onglets[0].props['aria-selected'], 'true')
  assert.equal(onglets[1].props['aria-selected'], 'false')

  onglets[1].props.onClick()
  assert.equal(setters.at(-1), 'graphe', 'le clic bascule l’onglet')
})

test('la carte dit la description, à défaut le résumé', () => {
  const decrit = workflowEntry({ description: 'Les incidents qui restent à traiter.' })
  const { rendered } = montrerWorkflows([decrit])
  const carte = findAll(rendered, 'button').find((node) => /missions-card--pick/.test(node.props.className ?? ''))
  assert.match(textOf(carte), /Les incidents qui restent à traiter\./)
  assert.doesNotMatch(textOf(carte), /Comprendre le ticket/, 'la description prend la place du résumé')

  const sansDescription = montrerWorkflows([workflowEntry()]).rendered
  const repliee = findAll(sansDescription, 'button').find((node) => /missions-card--pick/.test(node.props.className ?? ''))
  assert.match(textOf(repliee), /Comprendre le ticket/, 'sans description, la carte garde son résumé')
})

test('Informations montre la clé et le document, jamais en champ de saisie', () => {
  const { rendered } = montrerWorkflows([workflowEntry()], { tab: 'infos' })
  const codes = findAll(rendered, 'code').map(textOf)
  assert.ok(codes.includes('cadrage'), 'la clé se lit')
  assert.ok(codes.includes('workflows/cadrage.md'), 'le document se lit')
  const valeurs = findAll(rendered, 'input').map((node) => node.props.value)
  assert.equal(valeurs.includes('cadrage'), false, 'la clé ne s’édite pas')
  assert.equal(valeurs.includes('workflows/cadrage.md'), false, 'le document ne s’édite pas')
  assert.match(textOf(rendered), /déduisent du titre/, 'le panneau dit d’où ils viennent')
})

test('un brouillon sale refuse d’ouvrir la création', () => {
  const { rendered, setters } = montrerWorkflows([workflowEntry()], {
    tab: 'infos',
    draft: { ...modelOf(workflowEntry()), title: 'Cadrage retouché' },
  })
  findAll(rendered, 'button').find((node) => textOf(node) === 'Nouveau workflow').props.onClick()
  assert.equal(setters.some((value) => value?.kind === 'error' && /d’abord/.test(value.message)), true, 'le panneau demande d’enregistrer ou d’annuler')
})

test('les formulaires empilent leurs champs sur une colonne', () => {
  assert.match(regle('.wf-form'), /grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(regle('.wf-form-actions'), /grid-column: 1 \/ -1/)
  assert.doesNotMatch(SOURCE, /@media \(max-width: 640px\) \{[\s\S]*?\.wf-form \{/, 'le média ne répète plus la grille')
})

test('la liste, le volet et le canevas gardent leurs règles de repli', () => {
  assert.match(regle('.wf-list'), /grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\)/)
  assert.match(SOURCE, /@media \(max-width: 900px\) \{\s*\.wf-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  assert.match(regle('.wf-canvas-wrap'), /overflow: auto/)
  assert.match(regle('.missions-body'), /overflow: auto/)
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
  assert.deepEqual(setters.slice(-3), ['decider', 'graphe', null], 'le clic ouvre le geste et bascule sur Graphe')

  // Avec ce choix, la carte « Geste » s’ouvre et le losange se marque.
  queue.push(...workflowStates(review, 'decider'))
  const chosen = renderTree(vue)
  const titles = findAll(chosen, 'div').filter((node) => node.props.className === 'wf-card-title')
  assert.equal(textOf(titles[0]), 'Geste')
  const marked = findAll(chosen, 'polygon').filter((node) => /wf-node--decision/.test(node.props.className ?? '') && /wf-node--selected/.test(node.props.className ?? ''))
  assert.equal(marked.length, 1, 'le losange du geste choisi se marque')
})

test('Enregistrer envoie le modèle, et la réponse du serveur remplace le brouillon', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return {
      ok: true,
      json: async () => ({ workflow: 'review', file: 'workflows/model/review.yml', entry: review, errors: [], orphanSections: [], headings: review.headings }),
    }
  }
  try {
    const session = memorySession({ 'missions.tab': 'workflows' })
    const { api, ctx, registered, queue, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
    api.apply(ctx)
    const tree = registered.main({})
    queue.push(...workflowPanelStates(review))
    const inner = renderTree(findAll(tree, 'WorkflowsView')[0])
    appels.length = 0

    const enregistrer = findAll(inner, 'button').find((node) => textOf(node) === 'Enregistrer')
    enregistrer.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Le fichier est écrit par la route d'hôte : le panneau envoie le modèle
    // entier et ne juge rien lui-même.
    const envoi = appels.find((appel) => appel.url === 'missions/api/workflows/model')
    assert.equal(envoi?.options?.method, 'POST')
    const corps = JSON.parse(envoi.options.body)
    assert.equal(corps.workflow, 'review')
    assert.equal(corps.model.nodes.length, review.nodes.length)
    assert.equal(setters.some((value) => value?.kind === 'ok' && value.message === 'Enregistré — workflows/model/review.yml'), true)
    assert.equal(setters.some((value) => value?.workflow === 'review' && value?.title === review.title), true, 'la réponse du serveur redevient la liste')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('Annuler rend le brouillon au dernier état lu, sans rien envoyer', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const vraiFetch = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return { ok: true, json: async () => ({ workflows: [review], writers: ['session'], states: [] }) }
  }
  try {
    const session = memorySession({ 'missions.tab': 'workflows' })
    const { api, ctx, registered, queue, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
    api.apply(ctx)
    const tree = registered.main({})
    queue.push(...workflowPanelStates(review))
    const inner = renderTree(findAll(tree, 'WorkflowsView')[0])

    const annuler = findAll(inner, 'button').find((node) => textOf(node) === 'Annuler')
    annuler.props.onClick()

    const rendu = setters.filter((value) => value && value.workflow === 'review').at(-1)
    assert.equal(rendu?.nodes.length, review.nodes.length, 'le brouillon revient à la lecture du serveur')
    assert.equal(setters.some((value) => value?.kind === 'ok' && value.message === 'Modifications annulées.'), true)
    assert.equal(appels.length, 0, 'Annuler n’écrit rien')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('Recharger redemande la liste au serveur', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const vraiFetch = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return { ok: true, json: async () => ({ workflows: [review], writers: ['session'], states: [] }) }
  }
  try {
    const session = memorySession({ 'missions.tab': 'workflows' })
    const { api, ctx, registered, queue } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
    api.apply(ctx)
    const tree = registered.main({})
    queue.push(...workflowPanelStates(review))
    const inner = renderTree(findAll(tree, 'WorkflowsView')[0])
    appels.length = 0

    findAll(inner, 'button').find((node) => textOf(node) === 'Recharger').props.onClick()
    await Promise.resolve()

    assert.equal(appels.filter((appel) => appel.url === 'missions/api/workflows').length, 1)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la création ne demande que le titre, la description et le type', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const session = memorySession({ 'missions.tab': 'workflows' })
  const { api, ctx, registered, queue, reset } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
  api.apply(ctx)
  const vue = findAll(registered.main({}), 'WorkflowsView')[0]
  queue.push(...workflowPanelStates(review))
  let inner = renderTree(vue)

  findAll(inner, 'button').find((node) => textOf(node) === 'Nouveau workflow').props.onClick()
  reset()
  queue.push(...workflowPanelStates(review, { creating: true }))
  inner = renderTree(vue)
  const form = findAll(inner, 'form')[0]
  assert.ok(form, 'le formulaire de création est ouvert')
  const etiquettes = findAll(form, 'label').map((label) => textOf(findAll(label, 'span')[0]))
  assert.deepEqual(etiquettes, ['Titre', 'Description', 'Type'], 'trois champs, pas un de plus')
  assert.equal(findAll(form, 'input').length, 1, 'le titre seulement : la clé et le document ne se tapent pas')
  const description = findAll(form, 'textarea')[0]
  assert.ok(description, 'la description est un textarea')
  assert.ok(Number(description.props.rows) >= 3, 'trois lignes au moins')
  assert.equal(description.props.maxLength, 280)
  assert.equal(findAll(form, 'select').length, 1, 'seul le type se choisit')
  const versionne = findAll(form, 'button').find((node) => node.props.role === 'switch')
  assert.ok(versionne, 'le switch de versionnement est là')
  assert.equal(versionne.props['aria-checked'], 'true', 'coché par défaut : versionné')
  assert.match(textOf(versionne), /Versionné/)
})

test('la création envoie le titre, la description et le type, jamais la clé', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const vraiFetch = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return {
      ok: true,
      json: async () => ({ workflow: 'incidents', file: 'workflows/model/incidents.yml', document: 'workflows/incidents.md', entry: { ...review, workflow: 'incidents' } }),
    }
  }
  try {
    const session = memorySession({ 'missions.tab': 'workflows' })
    const { api, ctx, registered, queue, reset, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
    api.apply(ctx)
    const vue = findAll(registered.main({}), 'WorkflowsView')[0]
    queue.push(...workflowPanelStates(review))
    let inner = renderTree(vue)
    appels.length = 0

    findAll(inner, 'button').find((node) => textOf(node) === 'Nouveau workflow').props.onClick()
    reset()
    queue.push(...workflowPanelStates(review, { creating: true }))
    inner = renderTree(vue)

    const formulaire = findAll(inner, 'form')[0]
    assert.ok(formulaire, 'le dialogue est rendu')
    const champs = findAll(formulaire, 'input')
    const description = findAll(formulaire, 'textarea')[0]

    // Chaque frappe passe par le setter du formulaire : le champ est piloté,
    // pas seulement décoré.
    const avant = setters.length
    champs[0].props.onChange({ target: { value: 'Incidents' } })
    description.props.onChange({ target: { value: 'Les incidents du workspace' } })
    findAll(formulaire, 'select')[0].props.onChange({ target: { value: 'statuts' } })
    // Chaque frappe pose le formulaire puis ses erreurs : le formulaire d'abord.
    const vide = { title: '', description: '', kind: 'etape' }
    const misesAJour = setters.slice(avant).filter((value) => typeof value === 'function')
    const formulaires = [0, 2, 4].map((index) => misesAJour[index](vide))
    assert.equal(formulaires.length, 3, 'chaque champ écrit le formulaire')
    assert.equal(formulaires[0].title, 'Incidents', 'le titre entre dans le formulaire')

    reset()
    queue.push(...workflowPanelStates(review, {
      creating: true,
      form: { title: 'Incidents', description: 'Les incidents du workspace', kind: 'statuts' },
    }))
    inner = renderTree(vue)
    findAll(inner, 'form')[0].props.onSubmit({ preventDefault() {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const envoi = appels.find((appel) => appel.options?.method === 'POST')
    assert.ok(envoi, 'la création part vers la route')
    assert.equal(envoi.url, 'missions/api/workflows')
    assert.deepEqual(JSON.parse(envoi.options.body), {
      title: 'Incidents',
      description: 'Les incidents du workspace',
      kind: 'statuts',
      local: false,
    }, 'la clé et le document se déduisent du titre : ils ne partent pas')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la création refuse un titre vide avant tout envoi', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const vraiFetch = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url, options) => {
    appels.push({ url, options })
    return { ok: true, json: async () => ({ workflows: [review], writers: ['session'], states: [] }) }
  }
  try {
    const session = memorySession({ 'missions.tab': 'workflows' })
    const { api, ctx, registered, queue, setters, reset } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
    api.apply(ctx)
    const vue = findAll(registered.main({}), 'WorkflowsView')[0]
    queue.push(...workflowPanelStates(review))
    let inner = renderTree(vue)
    appels.length = 0

    findAll(inner, 'button').find((node) => textOf(node) === 'Nouveau workflow').props.onClick()
    reset()
    queue.push(...workflowPanelStates(review, { creating: true }))
    inner = renderTree(vue)
    findAll(inner, 'form')[0].props.onSubmit({ preventDefault() {} })

    assert.equal(setters.some((value) => value && typeof value === 'object' && value.title === 'Le titre est obligatoire.'), true, 'l’erreur se pose sous le titre')
    assert.equal(appels.filter((appel) => appel.options?.method === 'POST').length, 0, 'rien ne part au serveur')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('les onglets Informations et Graphe se répartissent le panneau', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const session = memorySession({ 'missions.tab': 'workflows' })
  const { api, ctx, registered, queue, reset } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
  api.apply(ctx)
  const vue = findAll(registered.main({}), 'WorkflowsView')[0]

  queue.push(...workflowPanelStates(review))
  let inner = renderTree(vue)
  const onglets = findAll(inner, 'button').filter((node) => /wf-tab/.test(node.props.className ?? ''))
  assert.deepEqual(onglets.map((node) => textOf(node)), ['Informations', 'Graphe'])
  assert.equal(onglets[0].props['aria-selected'], 'true')
  assert.ok(findAll(inner, 'svg').some((node) => /wf-canvas/.test(node.props.className ?? '')), 'le canevas reste dessiné : le panneau est docké à côté')
  assert.equal(findAll(inner, 'input').some((node) => node.props.value === review.title), true, 'le titre s’édite dans Informations')
  assert.equal(findAll(inner, 'button').some((node) => textOf(node) === 'Ajouter un geste'), false, 'les gestes se posent dans Graphe, pas dans Informations')

  reset()
  queue.push(...workflowPanelStates(review, { tab: 'graphe' }))
  inner = renderTree(vue)
  assert.ok(findAll(inner, 'svg').some((node) => /wf-canvas/.test(node.props.className ?? '')), 'Graphe garde le canevas')
  assert.ok(findAll(inner, 'button').some((node) => textOf(node) === 'Ajouter un geste'), 'les gestes se posent dans Graphe')
})

test('l’éditeur attend le modèle au lieu de lire un brouillon absent', () => {
  // La régression MIS-102 : entre la réponse du serveur (l'entrée est trouvée)
  // et l'effet qui pose le brouillon, le rendu lisait `draft.entry` et levait —
  // React démontait alors le panneau entier, onglets compris.
  assert.match(SOURCE, /if \(!entry \|\| !draft\) \{/, 'le rendu garde les deux attentes')
  assert.match(SOURCE, /'Chargement du modèle du parcours…'/, 'l’attente du modèle se dit')
  assert.ok(SOURCE.indexOf('if (!entry || !draft) {') < SOURCE.indexOf('draft.entry'), 'le brouillon ne se lit qu’après la garde')
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
    regle('.missions-panel[data-skin="paper"] .missions-card[data-blocked="true"]'),
    /border-color: var\(--skin-danger-strong\)/,
  )
})

test('le volet bloque avec un champ de raison et un bouton désarmé sans raison', () => {
  assert.match(SOURCE, /className: 'missions-blocked-input'/)
  // Le bouton reste désarmé tant que la raison est vide : la route exige le
  // texte, le panneau ne laisse pas envoyer un blocage muet.
  assert.match(SOURCE, /disabled: writingBlock \|\| !reason\.trim\(\)/)
  assert.match(regle('.missions-blocked'), /display: grid/)
  assert.match(regle('.missions-blocked-input'), /resize: vertical/)
  assert.match(regle('.missions-panel[data-skin="paper"] .missions-blocked'), /border: 1\.5px solid var\(--skin-ink\)/)
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
  assert.match(regle('.missions-panel[data-skin="paper"] .missions-priority-select'), /border: 1\.5px solid var\(--skin-ink\)/)
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
    { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null, count: null },
    '',
    { ...EMPTY_BAR.filters, state: ['done'] },
    null,
    count,
    // La seizième état est la section de Settings, restaurée avec l'onglet.
    'usage',
    // Le compteur de relecture de la liste Repositories, après une suppression.
    0,
    // Le résumé du Dashboard : lu à l'ouverture de l'onglet, gardé en mémoire.
    { loading: true, data: null, error: null },
    view,
  ]
}

/** L'état que la vue atteint quand le scan a répondu : le payload, pas le wrapper. */
function scanReady(data) {
  return { loading: false, data, error: null }
}

/** La session qui a ouvert les worktrees : la clé que le switch écrit. */
const WORKTREES_SHOWN = { 'missions.repositories.worktrees': '1' }

/** Le panneau monté sur l'onglet Repositories, et la vue résolue. */
function montrerRepositories(view, repository = null, session = memorySession(), storage = undefined) {
  const states = repositoriesStates(view, repository)
  const { api, ctx, registered, effects, setters, queue, resetHooks } = charger(storage, [...states], session)
  api.apply(ctx)
  let tree = null
  const monter = () => {
    tree = registered.main({})
    const node = findAll(tree, 'RepositoriesView')[0]
    assert.ok(node, 'l’onglet Repositories porte sa vue')
    return node
  }
  const node = monter()
  const inner = renderTree(node)
  // Le même onglet, un tour plus tard : les setters du clic alimentent les
  // états, et la session garde ce que la vue y a écrit.
  const rerendre = () => {
    resetHooks()
    queue.length = 0
    queue.push(...states)
    return renderTree(monter())
  }
  return { tree, node, inner, effects, setters, session, rerendre }
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
  const tree = monter([EMPTY_BAR, vueSansReponse()], memorySession())
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

  const badges = findAll(bar, 'span').filter((node) => String(node.props.className ?? '').split(' ').includes('missions-tab-count'))
  assert.equal(badges.length, 3, 'chaque compte de la barre garde sa pastille')
  const attendues = badges.filter((node) => node.props.className === 'missions-tab-count missions-tab-count-loader')
  assert.equal(attendues.length, 3, 'les trois onglets attendent leur compte')
  for (const pill of attendues) {
    assert.equal(pill.props.title, 'Loading…')
    assert.equal(textOf(pill), '', 'une pastille en attente ne porte aucun chiffre')
  }

  const missionsTab = onglets.find((node) => node.props.id === 'missions-tab-missions')
  const rendu = renderTree(missionsTab)
  const dessin = findAll(pastilleEnAttente(rendu), 'svg')
  assert.equal(dessin.length, 1, 'la pastille de Missions porte le dessin du thème')
  assert.equal(dessin[0].props['aria-hidden'], 'true', 'le dessin ne double pas le nom')
  assert.equal(textOf(rendu), 'Missions', 'le loader n’ajoute aucun mot au nom')
  assert.equal(missionsTab.props.role, 'tab')
  assert.equal(missionsTab.props['aria-selected'], 'false')
})

test('l’icône d’un onglet se redessine quand le thème change', () => {
  const dessins = (theme) => {
    const { api, ctx, registered } = charger(
      undefined,
      [EMPTY_BAR, vueSansReponse(), 'missions', '', { ...EMPTY_BAR.filters }, null, null, theme],
      memorySession(),
    )
    api.apply(ctx)
    const tree = registered.main({})
    const bar = findAll(tree, 'div').find((node) => node.props.className === 'missions-tabs')
    const result = {}
    for (const button of findAll(bar, 'button').filter((node) => node.props.role === 'tab')) {
      const icon = findAll(renderTree(button), 'svg')[0]
      result[button.props.id] = {
        paths: findAll(icon, 'path').map((path) => path.props.d),
        strokeWidth: icon.props.strokeWidth,
        // La pastille en attente dessine le thème, elle aussi : un onglet sans
        // compte prouvé en porte une.
        badge: findAll(button, 'span')
          .filter((span) => String(span.props.className ?? '').split(' ').includes('missions-tab-count-loader'))
          .flatMap((span) => findAll(renderTree(span), 'svg').map((svg) => findAll(svg, 'path').map((path) => path.props.d))),
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
  // La pastille en attente suit le même thème : la flèche du thème par défaut
  // devient le shuriken en manga, sans remonter la barre.
  for (const id of ['missions-tab-missions', 'missions-tab-done', 'missions-tab-repositories']) {
    assert.equal(defaults[id].badge.length, 1, `pastille en attente absente : ${id}`)
    assert.equal(manga[id].badge.length, 1, `pastille en attente absente en manga : ${id}`)
    assert.notDeepEqual(manga[id].badge, defaults[id].badge, `pastille identique dans les deux thèmes : ${id}`)
  }
  // L'encre manga est plus épaisse, comme le reste de la barre.
  assert.equal(defaults['missions-tab-dashboard'].strokeWidth, 1.3)
  assert.equal(manga['missions-tab-dashboard'].strokeWidth, 1.7)
})

test('Settings montre ses trois sections dans une navigation verticale, et la section active seule', () => {
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
  assert.deepEqual(sections.map((node) => textOf(node)), ['Usage', 'Workflows', 'Playbook'])
  assert.equal(sections[0].props['aria-selected'], 'true', 'Usage est la section par défaut')
  assert.equal(sections[1].props['aria-selected'], 'false')
  assert.equal(sections[2].props['aria-selected'], 'false')
  assert.equal(sections[0].props['aria-controls'], 'missions-settings-panel-usage')
  assert.equal(sections[1].props['aria-controls'], 'missions-settings-panel-workflows')
  assert.equal(sections[2].props['aria-controls'], 'missions-settings-panel-playbook')

  // Le panneau est décrit par son onglet, et une seule section est montée.
  const panel = findAll(view, 'section').find((node) => node.props.role === 'tabpanel')
  assert.ok(panel, 'la section est un panneau')
  assert.equal(panel.props.id, 'missions-settings-panel-usage')
  assert.equal(panel.props['aria-labelledby'], 'missions-settings-tab-usage')
  assert.equal(findAll(panel, 'UsageTab').length, 1, 'la section Usage porte sa vue')
  assert.equal(findAll(panel, 'WorkflowsView').length, 0, 'la section Workflows ne se monte pas en double')
  assert.equal(findAll(panel, 'PlaybookView').length, 0, 'la section Playbook ne se monte pas en double')

  // Choisir Workflows bascule la section sans quitter l'onglet.
  sections[1].props.onClick()
  assert.deepEqual(setters.slice(-1), ['workflows'], 'la section change, pas l’onglet')

  // Chaque section garde son nom accessible, son icône restant décorative.
  for (const section of sections) {
    const html = renderTree(section)
    assert.equal(findAll(html, 'svg')[0].props['aria-hidden'], 'true')
    assert.match(textOf(html), /Usage|Workflows|Playbook/)
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


/** Les cinq pages que le serveur liste, avec leurs titres et leurs étapes. */
// La forme exacte de la route : `page`, `file`, `step`, `title`, `lines`,
// `exists` — `name` n'en fait pas partie, le client ne doit pas en dépendre.
const PLAYBOOK_VIEW_PAGES = [
  { page: 'cadrage', file: 'playbook/cadrage.md', step: 'cadrage', title: 'Cadrage — la fiche du dépôt', lines: 12, exists: true },
  { page: 'execution', file: 'playbook/execution.md', step: 'exécution', title: 'Exécution — les gestes', lines: 40, exists: true },
  { page: 'revue', file: 'playbook/revue.md', step: 'revue', title: 'Revue — la vérification', lines: 30, exists: true },
  { page: 'cloture', file: 'playbook/cloture.md', step: 'clôture', title: 'Clôture — la sortie', lines: 20, exists: true },
  { page: 'workspace', file: 'playbook/workspace.md', step: null, title: 'Workspace — la fiche du dépôt', lines: 18, exists: true },
]

/** Les dix hooks de `PlaybookView`, dans l'ordre de leur déclaration. */
const PLAYBOOK_HOOKS = ['view', 'chosen', 'draft', 'baseline', 'mtimeMs', 'status', 'pageError', 'saving', 'pending', 'attempt']

/** L'état de `PlaybookView`, par défaut sur la page d'exécution, sans retouche. */
function playbookStates(patch = {}) {
  const base = {
    view: { loading: false, error: null, pages: PLAYBOOK_VIEW_PAGES },
    chosen: 'execution',
    draft: '## Avant d’agir\n',
    baseline: '## Avant d’agir\n',
    mtimeMs: 1234,
    status: null,
    pageError: null,
    saving: false,
    pending: null,
    attempt: 0,
  }
  return PLAYBOOK_HOOKS.map((name) => (name in patch ? patch[name] : base[name]))
}

/** Le panneau monté sur la section Playbook, puis la vue résolue. */
function monterPlaybook(states, session = memorySession({ 'missions.tab': 'playbook' })) {
  const { api, ctx, registered, setters, queue, effects } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], session)
  api.apply(ctx)
  const panneau = registered.main({})
  const node = findAll(panneau, 'PlaybookView')[0]
  assert.ok(node, 'la section Playbook porte sa vue')
  const avant = effects.length
  queue.push(...states)
  const tree = renderTree(node)
  return { panneau, node, tree, setters, effects, session, propres: effects.slice(avant) }
}

/** Laisse filer une chaîne de promesses de `fetch`, sans minuterie. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('la section Playbook liste les cinq pages et ouvre celle de la session', () => {
  const { tree } = monterPlaybook(playbookStates())

  // Cinq pages, dans l'ordre du parcours puis le workspace, chacune avec son
  // nom d'étape lisible — le titre du fichier, puis l'étape.
  const pages = findAll(tree, 'button').filter((node) => node.props.className === 'pb-page')
  assert.equal(pages.length, 5)
  assert.match(textOf(pages[0]), /Cadrage — la fiche du dépôt/)
  assert.match(textOf(pages[0]), /Étape cadrage/)
  assert.match(textOf(pages[4]), /Workspace — la fiche du dépôt/)
  assert.match(textOf(pages[4]), /Workspace/)
  assert.match(textOf(pages[1]), /40 lignes/, 'chaque page dit son nombre de lignes')

  // La page retenue est marquée, les autres non.
  assert.equal(pages[1].props['aria-current'], 'true', 'la page de la session est ouverte')
  assert.equal(pages[0].props['aria-current'], 'false')

  // L'éditeur porte le texte de la page, son chemin et son compte de lignes.
  const champ = findAll(tree, 'textarea').find((node) => node.props.className === 'pb-text')
  assert.equal(champ.props.value, '## Avant d’agir\n')
  assert.match(textOf(tree), /playbook\/execution\.md — 40 lignes/)
  assert.match(textOf(tree), /exécution/)
})

test('une page inconnue retombe sur la première, jamais sur un éditeur vide', () => {
  const { tree } = monterPlaybook(playbookStates({ chosen: 'archive' }))
  const pages = findAll(tree, 'button').filter((node) => node.props.className === 'pb-page')
  assert.equal(pages[0].props['aria-current'], 'true')
  assert.equal(findAll(tree, 'textarea').find((node) => node.props.className === 'pb-text').props.value, '## Avant d’agir\n')
})

test('la page ouverte se range dans la session sous missions.playbook-page', () => {
  const { effects, session } = monterPlaybook(playbookStates())
  const ecriture = effects.find(({ fn }) => String(fn).includes('writePlaybookPage('))
  assert.ok(ecriture, 'la page ouverte est écrite dans la session, pas seulement lue')
  ecriture.fn()
  assert.equal(session.entries.get('missions.playbook-page'), 'execution')
})

test('l’éditeur demande les cinq pages, puis la page choisie, au serveur', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => ({ pages: PLAYBOOK_VIEW_PAGES }) }
  }
  try {
    const { propres } = monterPlaybook(playbookStates({ chosen: null }))
    // Le chargement de la liste, puis celui du texte : deux routes distinctes.
    for (const effect of propres) effect.fn()
    assert.equal(appels[0], 'missions/api/playbooks')
    await tick()
    await tick()
    assert.match(appels[1], /^missions\/api\/playbooks\/page\?page=/)
    assert.match(appels[1], /cadrage/)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('une page illisible montre le refus du serveur et propose une page lisible', async () => {
  const refus = 'playbook/execution.md is missing'
  const vraiFetch = globalThis.fetch
  // La liste dit la page absente, puis la lecture de cette page est refusée.
  globalThis.fetch = async (url) => {
    if (String(url) === 'missions/api/playbooks') {
      return {
        ok: true,
        json: async () => ({ pages: PLAYBOOK_VIEW_PAGES.map((entry) => (entry.page === 'execution' ? { ...entry, exists: false, lines: 0 } : entry)) }),
      }
    }
    return { ok: false, json: async () => ({ error: refus }) }
  }
  try {
    // Le refus du serveur remonte à la vue, tel qu'il est écrit.
    const lecture = monterPlaybook(playbookStates({ chosen: 'execution', draft: null, baseline: null, mtimeMs: null }))
    for (const effect of lecture.propres) effect.fn()
    await tick()
    await tick()
    assert.equal(lecture.setters.filter((value) => value === refus).at(-1), refus, 'le refus de lecture arrive à l’écran')

    // Rendu, la page absente dit le refus et cesse d'attendre.
    const rendu = monterPlaybook(playbookStates({ chosen: 'execution', draft: null, baseline: null, mtimeMs: null, pageError: refus }))
    assert.match(textOf(rendu.tree), /playbook\/execution\.md is missing/)
    assert.doesNotMatch(textOf(rendu.tree), /Chargement de la page…/)

    // Et la première page lisible s'ouvre d'un clic.
    const retour = findAll(rendu.tree, 'button').find((node) => textOf(node) === 'Ouvrir « cadrage »')
    assert.ok(retour, 'une page illisible propose une page lisible')
    retour.props.onClick()
    assert.ok(rendu.setters.includes('cadrage'), 'le clic ouvre la page proposée')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('Enregistrer envoie le texte et la version lues, puis affiche le fichier écrit', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url: String(url), options })
    return { ok: true, json: async () => ({ page: 'execution', file: 'playbook/execution.md', step: 'exécution', title: 'Exécution — les gestes', lines: 41, exists: true, mtimeMs: 9999 }) }
  }
  try {
    const { tree, setters } = monterPlaybook(playbookStates({ draft: '## Avant d’agir\n\nretouche\n' }))
    const bouton = findAll(tree, 'button').find((node) => textOf(node) === 'Save')
    bouton.props.onClick()
    await tick()
    await tick()

    assert.equal(appels[0].url, 'missions/api/playbooks/page')
    assert.equal(appels[0].options.method, 'POST')
    assert.equal(appels[0].options.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(appels[0].options.body), { page: 'execution', text: '## Avant d’agir\n\nretouche\n', mtimeMs: 1234 })

    const statut = setters.filter((value) => value && typeof value === 'object' && value.kind === 'ok').at(-1)
    assert.ok(statut, 'un enregistrement accepté se dit')
    assert.match(statut.message, /Enregistré — playbook\/execution\.md/)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('un refus du serveur s’affiche avec sa cause et la liste des manques', async () => {
  const manque = 'playbook/execution.md : section manquante « Les règles »'
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: 'page invalid', errors: [manque] }) })
  try {
    const { tree, setters } = monterPlaybook(playbookStates({ draft: 'court\n' }))
    findAll(tree, 'button').find((node) => textOf(node) === 'Save').props.onClick()
    await tick()
    await tick()
    const refus = setters.filter((value) => value && typeof value === 'object' && value.kind === 'error').at(-1)
    assert.deepEqual(refus, { kind: 'error', message: 'page invalid', errors: [manque] })

    // Rendue, la liste des manques est un vrai texte, pas un compteur.
    const { tree: rendu } = monterPlaybook(playbookStates({ status: { kind: 'error', message: 'page invalid', errors: [manque] } }))
    const alerte = findAll(rendu, 'div').find((node) => /pb-status pb-status--error/.test(node.props.className ?? ''))
    assert.equal(alerte.props.role, 'alert')
    assert.match(textOf(alerte), /page invalid/)
    assert.equal(findAll(alerte, 'li')[0] && textOf(findAll(alerte, 'li')[0]), manque)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('Save et Cancel restent fermés sans retouche, et s’ouvrent au premier caractère', () => {
  const gestes = (tree) => findAll(tree, 'button').filter((node) => ['Save', 'Saving…', 'Cancel'].includes(textOf(node)))

  // Sans retouche, enregistrer n'aurait rien à écrire et annuler rien à rendre.
  const propre = monterPlaybook(playbookStates())
  assert.deepEqual(gestes(propre.tree).map((node) => node.props.disabled), [true, true])

  // Un caractère de plus réveille les deux gestes.
  const retouche = monterPlaybook(playbookStates({ draft: '## Avant d’agir\n\nretouche\n' }))
  assert.deepEqual(gestes(retouche.tree).map((node) => node.props.disabled), [false, false])

  // Pendant l'envoi, les deux se referment — un second clic ne double pas l'écriture.
  const envoi = monterPlaybook(playbookStates({ draft: '## Avant d’agir\n\nretouche\n', saving: true }))
  assert.deepEqual(gestes(envoi.tree).map((node) => node.props.disabled), [true, true])
})

test('quitter une page au brouillon demande confirmation en ligne, et les deux issues tiennent', () => {
  const { tree, setters } = monterPlaybook(playbookStates({ draft: 'brouillon local\n' }))
  const pages = findAll(tree, 'button').filter((node) => node.props.className === 'pb-page')
  setters.length = 0

  // Un clic sur une autre page n'ouvre rien : il pose la question, et le
  // brouillon reste où il est.
  pages[4].props.onClick()
  assert.deepEqual(setters, ['workspace'], 'la page demandée attend la réponse')
  assert.equal(findAll(tree, 'textarea').length, 1, 'aucune boîte système, le panneau reste monté')

  // « Keep editing » efface la question et laisse la page ouverte.
  const { tree: question } = monterPlaybook(playbookStates({ draft: 'brouillon local\n', pending: 'workspace' }))
  const dialogue = findAll(question, 'div').find((node) => /pb-confirm\b/.test(node.props.className ?? ''))
  assert.ok(dialogue, 'la confirmation vit dans la section')
  assert.equal(dialogue.props.role, 'alertdialog')
  assert.match(textOf(dialogue), /modifications non enregistrées/)
  assert.match(textOf(dialogue), /« workspace »/)
  const garder = findAll(dialogue, 'button').find((node) => textOf(node) === 'Keep editing')
  const abandonner = findAll(dialogue, 'button').find((node) => textOf(node) === 'Discard')
  assert.ok(garder && abandonner, 'les deux issues sont des boutons')

  const { tree: garde, setters: gardeSetters } = monterPlaybook(playbookStates({ draft: 'brouillon local\n', pending: 'workspace' }))
  findAll(garde, 'button').find((node) => textOf(node) === 'Keep editing').props.onClick()
  assert.deepEqual(gardeSetters, [null], 'Keep editing ne change pas de page')

  // « Discard » charge la page demandée, et le brouillon repart du fichier.
  const { tree: abandon, setters: abandonSetters } = monterPlaybook(playbookStates({ draft: 'brouillon local\n', pending: 'workspace' }))
  findAll(abandon, 'button').find((node) => textOf(node) === 'Discard').props.onClick()
  // Discard ouvre la page, vide le brouillon le temps de la relecture (Save
  // retombe désactivé), puis efface la question.
  assert.deepEqual(abandonSetters, ['workspace', null, null, null, null])

  // Jamais de boîte système : la question est du panneau.
  const debut = SOURCE.indexOf('function PlaybookView')
  const fin = SOURCE.indexOf('function RepositoriesView')
  const source = SOURCE.slice(debut, fin)
  assert.ok(debut > -1 && fin > debut)
  assert.equal(/\bconfirm\(/.test(source), false)
})

test('Cancel rend le brouillon au dernier état enregistré', () => {
  const { tree, setters } = monterPlaybook(playbookStates({ draft: 'retouche non enregistrée\n' }))
  findAll(tree, 'button').find((node) => textOf(node) === 'Cancel').props.onClick()
  assert.deepEqual(setters.slice(-2), ['## Avant d’agir\n', { kind: 'ok', message: 'Modifications annulées.' }])
})

test('la page Playbook a ses règles, l’onglet son glyphe dans les deux thèmes', () => {
  assert.match(regle('.pb-layout'), /grid-template-columns: 240px minmax\(0, 1fr\)/)
  assert.match(regle('.pb-page[aria-current="true"]'), /box-shadow/)
  assert.match(regle('.pb-text'), /font-family: var\(--dsw-font-mono/)
  assert.match(regle('.pb-errors'), /color: #a33a2a/)
  // Un dessin par thème, et un seul : le glyphe suit le thème actif.
  assert.equal((SOURCE.match(/playbook: \[/g) ?? []).length, 2)
  assert.match(SOURCE, /missions-tab-icon-\$\{id\}/)
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
    assert.deepEqual(appels.map((appel) => appel.url), ['missions/api/list', 'missions/api/done/count', 'missions/api/repositories/count'], 'le montage lit l’ouvert et les deux pastilles')

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
    const montageOuvert = ouvert.effects.find((effect) => String(effect.fn).includes('loadRepositoryCount()') && String(effect.fn).includes('loadDoneCount()'))
    const doneOuvert = ouvert.effects.find((effect) => String(effect.fn).includes("if (tab !== 'done')"))
    montageOuvert.fn()
    doneOuvert.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(appels, ['missions/api/list', 'missions/api/done/count', 'missions/api/repositories/count'])
    assert.equal(doneOuvert.deps[0], 'missions')

    // Onglet Done : les mêmes effets ne lisent que les closes.
    appels.length = 0
    const done = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'done' }))
    done.api.apply(done.ctx)
    done.registered.main({})
    const montageDone = done.effects.find((effect) => String(effect.fn).includes('loadRepositoryCount()') && String(effect.fn).includes('loadDoneCount()'))
    const doneEffect = done.effects.find((effect) => String(effect.fn).includes("if (tab !== 'done')"))
    montageDone.fn()
    doneEffect.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(appels, ['missions/api/list', 'missions/api/done/count', 'missions/api/repositories/count', 'missions/api/list?done=1'])
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

/** La pastille d'un onglet, quelle qu'en soit la forme : le chiffre ou le loader. */
function pastilleDe(bouton) {
  return findAll(bouton, 'span').find((span) => String(span.props.className ?? '').split(' ').includes('missions-tab-count'))
}

/** La pastille d'un onglet encore en attente de son compte. */
function pastilleEnAttente(bouton) {
  return findAll(bouton, 'span').find((span) => String(span.props.className ?? '').split(' ').includes('missions-tab-count-loader'))
}

test('l’onglet Repositories porte son compte, et une pastille en attente avant de le connaître', () => {
  const panneau = (states) => {
    const { api, ctx, registered } = charger(undefined, states, memorySession())
    api.apply(ctx)
    return registered.main({})
  }
  const onglet = (tree, id) => findAll(tree, 'button').find((button) => button.props.id === `missions-tab-${id}`)

  // Compte lu : la pastille est celle de Missions — même classe, même style —
  // et elle porte les dépôts de la racine, pas le total du scan (30 clones,
  // 39 entrées sur ce poste).
  const avec = panneau(repositoriesStates(scanReady(REPO_SCAN), null, 30))
  assert.equal(textOf(pastilleDe(onglet(avec, 'repositories'))), '30')
  assert.equal(SOURCE.includes("const REPOSITORIES_COUNT_URL = 'missions/api/repositories/count'"), true)
  // Missions garde la sienne, sur la liste ouverte : deux comptes, deux sources.
  const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
  assert.equal(textOf(pastilleDe(onglet(avec, 'missions'))), String(ouvertes))
  // Un compte prouvé ne porte pas de loader.
  assert.equal(pastilleEnAttente(onglet(avec, 'repositories')), undefined)

  // Aucune réponse encore : la pastille est là, à sa place dans le gabarit du
  // chiffre, et porte le dessin de rafraîchissement du thème au lieu d'un 0 que
  // rien ne prouve.
  const avant = panneau([EMPTY_BAR, vueSansReponse()])
  const attente = pastilleDe(onglet(avant, 'repositories'))
  assert.equal(attente.props.className, 'missions-tab-count missions-tab-count-loader')
  assert.equal(attente.props.title, 'Loading…', 'la pastille en attente se nomme')
  assert.equal(textOf(attente), '', 'aucun chiffre avant la première réponse')

  // Le dessin est décoratif : le loader ne change ni le nom de l'onglet ni son
  // rôle de tabulation.
  const rendu = renderTree(onglet(avant, 'repositories'))
  const dessin = findAll(pastilleEnAttente(rendu), 'svg')
  assert.equal(dessin.length, 1, 'la pastille en attente porte le dessin du thème')
  assert.equal(dessin[0].props['aria-hidden'], 'true', 'le dessin ne double pas le nom')
  assert.equal(textOf(rendu), 'Repositories', 'le loader n’ajoute aucun mot au nom')
  assert.equal(onglet(avant, 'repositories').props.role, 'tab')
  assert.equal(onglet(avant, 'repositories').props['aria-selected'], 'false')

  const missionsAttente = pastilleDe(onglet(avant, 'missions'))
  assert.equal(missionsAttente.props.className, 'missions-tab-count missions-tab-count-loader')
  assert.equal(missionsAttente.props.title, 'Loading…')
  assert.equal(textOf(onglet(avant, 'missions')), 'Missions', 'aucun chiffre avant la première réponse')
})

/** L'onglet d'une barre de test, par identifiant. */
function ongletDe(tree, id) {
  return findAll(tree, 'button').find((button) => button.props.id === `missions-tab-${id}`)
}

test('le montage sans réponse laisse la pastille de Missions en attente', () => {
  // Given un panneau monté avant la première réponse de la liste ouverte
  const tree = monter([EMPTY_BAR, vueSansReponse()], memorySession())
  // When la barre est rendue
  const bouton = ongletDe(tree, 'missions')
  // Then la pastille attend le compte, sans porter de chiffre
  const pill = pastilleDe(bouton)
  assert.equal(pill.props.className, 'missions-tab-count missions-tab-count-loader')
  assert.equal(pill.props.title, 'Loading…')
  assert.equal(textOf(pill), '')
  const rendu = renderTree(bouton)
  assert.equal(findAll(pastilleEnAttente(rendu), 'svg').length, 1, 'la pastille en attente porte le dessin du thème')
  assert.equal(textOf(rendu), 'Missions', 'le loader n’ajoute aucun mot au nom')
  assert.equal(bouton.props.role, 'tab')
  assert.equal(bouton.props['aria-selected'], 'false')
})

test('une première réponse entière et vide prouve le zéro de Missions', async () => {
  const vraiFetch = globalThis.fetch
  const repondre = (payload) => async (url) => {
    const cible = String(url)
    if (cible === 'missions/api/done/count') return { ok: true, json: async () => ({ count: 0, errors: [] }) }
    if (cible === 'missions/api/repositories/count') return { ok: true, json: async () => ({ count: 0 }) }
    return { ok: true, json: async () => payload }
  }
  try {
    // Given un panneau monté avant la première réponse, et une réponse vide et entière
    globalThis.fetch = repondre({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' })
    const { api, ctx, registered, effects, setters } = charger(undefined, [EMPTY_BAR, vueSansReponse()], memorySession())
    api.apply(ctx)
    registered.main({})
    // When le montage lit la liste
    await effects.find((effect) => String(effect.fn).includes('loadDoneCount()') && String(effect.fn).includes('loadRepositoryCount()')).fn()
    await new Promise((done) => setTimeout(done, 0))
    // Then la réponse entière publie un compte prouvé, vide, et la pastille affiche 0
    const publie = vuesPubliees(setters, vueSansReponse()).find((next) => next.workspaceId === 'w')
    assert.ok(publie, 'la réponse entière prouve le compte')
    assert.equal(publie.count, 0)
    assert.deepEqual(publie.missions, [])
    const rendu = monter([EMPTY_BAR, publie], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(rendu, 'missions'))), '0')
    assert.equal(pastilleEnAttente(ongletDe(rendu, 'missions')), undefined)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('une première réponse entière publie le compte de la liste ouverte', async () => {
  const vraiFetch = globalThis.fetch
  const repondre = (payload) => async (url) => {
    const cible = String(url)
    if (cible === 'missions/api/done/count') return { ok: true, json: async () => ({ count: 0, errors: [] }) }
    if (cible === 'missions/api/repositories/count') return { ok: true, json: async () => ({ count: 0 }) }
    return { ok: true, json: async () => payload }
  }
  try {
    // Given un panneau monté avant la première réponse, et la liste ouverte entière
    globalThis.fetch = repondre({ missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' })
    const { api, ctx, registered, effects, setters } = charger(undefined, [EMPTY_BAR, vueSansReponse()], memorySession())
    api.apply(ctx)
    registered.main({})
    // When le montage lit la liste
    await effects.find((effect) => String(effect.fn).includes('loadDoneCount()') && String(effect.fn).includes('loadRepositoryCount()')).fn()
    await new Promise((done) => setTimeout(done, 0))
    // Then la pastille publie le compte des missions ouvertes, sans loader
    const publie = vuesPubliees(setters, vueSansReponse()).find((next) => next.workspaceId === 'w')
    assert.ok(publie, 'la réponse entière prouve le compte')
    const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
    assert.equal(publie.count, ouvertes)
    const rendu = monter([EMPTY_BAR, publie], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(rendu, 'missions'))), String(ouvertes))
    assert.equal(pastilleEnAttente(ongletDe(rendu, 'missions')), undefined)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('un premier échec de la liste laisse la pastille de Missions en attente, sans zéro', async () => {
  const vraiFetch = globalThis.fetch
  // Given un panneau monté avant la première réponse, et une lecture qui échoue
  const { api, ctx, registered, effects, setters } = charger(undefined, [EMPTY_BAR, vueSansReponse(), 'missions'], memorySession())
  api.apply(ctx)
  registered.main({})
  try {
    globalThis.fetch = async () => { throw new Error('offline') }
    // When le montage lit la liste
    await effects.find((effect) => String(effect.fn).includes('loadDoneCount()') && String(effect.fn).includes('loadRepositoryCount()')).fn()
    await new Promise((done) => setTimeout(done, 0))
    // Then l'échec est publié sans prouver de compte, et la pastille attend toujours
    const echec = vuesPubliees(setters, vueSansReponse()).find((next) => next.errors.length > 0)
    assert.ok(echec, 'l’échec de la liste est publié')
    assert.equal(echec.count, null)
    assert.deepEqual(echec.missions, [])
    const enEchec = monter([EMPTY_BAR, echec, 'missions'], memorySession())
    assert.equal(textOf(ongletDe(enEchec, 'missions')), 'Missions', 'aucun chiffre, pas même 0')
    assert.equal(pastilleEnAttente(ongletDe(enEchec, 'missions')).props.className, 'missions-tab-count missions-tab-count-loader')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('le bandeau d’erreur d’une liste en échec reste celui de la vue', () => {
  // Given une vue en échec, jamais prouvée
  const vue = { ...vueSansReponse(), loading: false, errors: [{ project: 'panel', message: 'read failed' }] }
  // When le panneau est rendu sur l'onglet Missions
  const tree = monter([EMPTY_BAR, vue, 'missions'], memorySession())
  // Then le bandeau vient de la vue, et la pastille attend sans le doubler
  assert.equal(findAll(tree, 'div').filter((node) => node.props.className === 'missions-errors').length, 1)
  assert.equal(pastilleEnAttente(ongletDe(tree, 'missions')).props.className, 'missions-tab-count missions-tab-count-loader')
})

test('le tick de 60 s retente la liste après un premier échec et publie le compte', async () => {
  const vraiFetch = globalThis.fetch
  const vraiSetInterval = globalThis.setInterval
  let tick = null
  globalThis.setInterval = (fn) => { tick = fn; return 1 }
  const { api, ctx, registered, effects, setters } = charger(undefined, [EMPTY_BAR, vueSansReponse(), 'missions'], memorySession())
  api.apply(ctx)
  registered.main({})
  // Given un panneau dont la première lecture a échoué, et le tick armé
  effects.find((effect) => String(effect.fn).includes('REFRESH_MS')).fn()
  try {
    globalThis.fetch = async () => { throw new Error('offline') }
    await effects.find((effect) => String(effect.fn).includes('loadDoneCount()') && String(effect.fn).includes('loadRepositoryCount()')).fn()
    await new Promise((done) => setTimeout(done, 0))
    // When le tick relit la liste
    globalThis.fetch = async (url) => {
      const cible = String(url)
      if (cible === 'missions/api/done/count') return { ok: true, json: async () => ({ count: 0, errors: [] }) }
      if (cible === 'missions/api/repositories/count') return { ok: true, json: async () => ({ count: 0 }) }
      return { ok: true, json: async () => ({ missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
    }
    setters.length = 0
    tick()
    await new Promise((done) => setTimeout(done, 0))
    // Then la réponse entière prouve le compte des missions ouvertes
    const prouve = vuesPubliees(setters, vueSansReponse()).find((next) => next.workspaceId === 'w')
    assert.ok(prouve, 'le tick publie le compte prouvé')
    const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
    assert.equal(prouve.count, ouvertes)
    const rendu = monter([EMPTY_BAR, prouve], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(rendu, 'missions'))), String(ouvertes))
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiSetInterval
  }
})

test('le Refresh explicite garde le chiffre de Missions pendant la relecture', async () => {
  const vraiFetch = globalThis.fetch
  const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
  const prouve = { loading: false, count: ouvertes, missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  // Given une liste déjà prouvée, son chiffre affiché, et le Refresh de la vue
  const avant = monter([EMPTY_BAR, prouve, 'missions'], memorySession())
  assert.equal(textOf(pastilleDe(ongletDe(avant, 'missions'))), String(ouvertes))
  const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, prouve, 'missions'], memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }) })
    setters.length = 0
    // When le Refresh explicite relit la liste
    await findAll(tree, 'MissionsView')[0].props.onRefresh()
    // Then l'état de chargement reste prouvé, et la pastille ne repasse pas par le loader
    const pendant = setters.filter((next) => typeof next === 'function').map((update) => update(prouve)).find((next) => next.loading === true)
    assert.ok(pendant, 'la relecture passe par l’état chargement')
    assert.equal(pendant.count, ouvertes)
    const enCours = monter([EMPTY_BAR, pendant, 'missions'], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(enCours, 'missions'))), String(ouvertes))
    assert.equal(pastilleEnAttente(ongletDe(enCours, 'missions')), undefined)
    assert.ok(vuesPubliees(setters, prouve).some((next) => next.count === ouvertes && next.missions.length === DASH_MISSIONS.length))
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('le tick silencieux relit la liste sans dé-prouver le compte de Missions', async () => {
  const vraiFetch = globalThis.fetch
  const vraiSetInterval = globalThis.setInterval
  let tick = null
  globalThis.setInterval = (fn) => { tick = fn; return 1 }
  const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
  const prouve = { loading: false, count: ouvertes, missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered, effects, setters } = charger(undefined, [EMPTY_BAR, prouve, 'missions'], memorySession())
  api.apply(ctx)
  registered.main({})
  // Given une liste déjà prouvée et le tick armé
  effects.find((effect) => String(effect.fn).includes('REFRESH_MS')).fn()
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }) })
    setters.length = 0
    // When le tick relit la liste en silence
    tick()
    // Then aucun état de chargement n'est publié, et la réponse prolonge le compte prouvé
    assert.equal(setters.length, 0)
    await new Promise((done) => setTimeout(done, 0))
    const apres = vuesPubliees(setters, prouve).find((next) => next.count === ouvertes && next.missions.length === DASH_MISSIONS.length)
    assert.ok(apres, 'la réponse entière prolonge le compte prouvé')
    const rendu = monter([EMPTY_BAR, apres], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(rendu, 'missions'))), String(ouvertes))
    assert.equal(pastilleEnAttente(ongletDe(rendu, 'missions')), undefined)
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiSetInterval
  }
})

test('une relecture partielle laisse le chiffre de Missions déjà prouvé', async () => {
  const vraiFetch = globalThis.fetch
  const vraiSetInterval = globalThis.setInterval
  let tick = null
  globalThis.setInterval = (fn) => { tick = fn; return 1 }
  const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
  const prouve = { loading: false, count: ouvertes, missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered, effects, setters } = charger(undefined, [EMPTY_BAR, prouve, 'missions'], memorySession())
  api.apply(ctx)
  registered.main({})
  // Given une liste déjà prouvée et une relecture qui revient partielle
  effects.find((effect) => String(effect.fn).includes('REFRESH_MS')).fn()
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ missions: [DASH_MISSIONS[0]], errors: [{ project: 'socle', message: 'open missions: boom' }] }),
    })
    setters.length = 0
    // When le tick silencieux relit la liste
    tick()
    await new Promise((done) => setTimeout(done, 0))
    // Then la réponse partielle laisse le compte publié et la pastille chiffrée
    const partielle = vuesPubliees(setters, prouve).find((next) => next.errors.length > 0)
    assert.ok(partielle, 'la réponse partielle est publiée avec ses erreurs')
    assert.equal(partielle.count, ouvertes)
    const rendu = monter([EMPTY_BAR, partielle], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(rendu, 'missions'))), String(ouvertes))
    assert.equal(pastilleEnAttente(ongletDe(rendu, 'missions')), undefined)
  } finally {
    globalThis.fetch = vraiFetch
    globalThis.setInterval = vraiSetInterval
  }
})

test('un Refresh explicite en échec laisse le chiffre de Missions déjà prouvé', async () => {
  const vraiFetch = globalThis.fetch
  const ouvertes = DASH_MISSIONS.filter((mission) => mission.state !== 'done').length
  const prouve = { loading: false, count: ouvertes, missions: DASH_MISSIONS, errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const { api, ctx, registered, setters } = charger(undefined, [EMPTY_BAR, prouve, 'missions'], memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  try {
    // Given une liste déjà prouvée, et un Refresh explicite qui échoue
    globalThis.fetch = async () => { throw new Error('offline') }
    setters.length = 0
    // When le Refresh relit la liste
    await findAll(tree, 'MissionsView')[0].props.onRefresh()
    // Then l'échec est publié, le compte prouvé reste et la pastille reste chiffrée
    const echec = vuesPubliees(setters, prouve).find((next) => next.errors.length > 0)
    assert.ok(echec, 'l’échec du Refresh est publié')
    assert.equal(echec.count, ouvertes)
    const enEchec = monter([EMPTY_BAR, echec, 'missions'], memorySession())
    assert.equal(textOf(pastilleDe(ongletDe(enEchec, 'missions'))), String(ouvertes))
    assert.equal(pastilleEnAttente(ongletDe(enEchec, 'missions')), undefined)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

/**
 * Les états du panneau pour la pastille de Done : le compte vit dans l'état de
 * la vue close, avec ses lignes et ses erreurs.
 */
function doneCountStates(count, { tab = 'dashboard', missions = [], errors = [] } = {}) {
  return [
    EMPTY_BAR,
    dashboardView(DASH_MISSIONS),
    tab,
    '',
    { ...EMPTY_BAR.filters },
    null,
    null,
    'default',
    null,
    EMPTY_BAR,
    { loading: false, missions, errors, workspaceId: 'w', workspaceRoot: '/w', count },
    '',
    { ...EMPTY_BAR.filters, state: ['done'] },
    null,
    null,
    'usage',
  ]
}

/** La pastille de l'onglet Done, telle que la barre la rend. */
function pastilleDone(tree) {
  const bouton = findAll(tree, 'button').find((node) => node.props.id === 'missions-tab-done')
  const span = pastilleDe(bouton)
  return span === undefined ? undefined : textOf(span)
}

/** Le lecteur du compte de Done, retrouvé par la route qu'il appelle. */
function lecteurDeDone(effects) {
  for (const effect of effects) {
    const dep = (effect.deps ?? []).find((item) => typeof item === 'function' && String(item).includes('DONE_COUNT_URL'))
    if (dep) return dep
  }
  return null
}

test('l’onglet Done porte le compte lu au montage, sans ouvrir ses lignes', () => {
  // Le compte publié s'affiche sur la barre, l'onglet resté fermé.
  const deux = monter(doneCountStates(2), memorySession())
  assert.equal(findAll(deux, 'DashboardView').length, 1, 'l’onglet Done reste fermé')
  assert.equal(pastilleDone(deux), '2')

  // Zéro est un compte prouvé : il s'affiche, il ne s'efface pas.
  assert.equal(pastilleDone(monter(doneCountStates(0), memorySession())), '0')

  // Aucun nombre encore : la pastille en attente porte le loader du thème,
  // jamais un 0 que rien ne prouve.
  const attente = monter(doneCountStates(null), memorySession())
  assert.equal(pastilleDone(attente), '', 'aucun chiffre avant la première réponse')
  const bouton = findAll(attente, 'button').find((node) => node.props.id === 'missions-tab-done')
  const loader = pastilleEnAttente(bouton)
  assert.equal(loader.props.className, 'missions-tab-count missions-tab-count-loader')
  assert.equal(loader.props.title, 'Loading…')
  assert.equal(findAll(pastilleEnAttente(renderTree(bouton)), 'svg').length, 1, 'la pastille en attente porte le dessin du thème')

  // La pastille ne s'invente pas un compte : la vue close seule le porte, et le
  // loader ne se dessine que tant que ce compte vaut `null`.
  assert.match(SOURCE, /if \(entry\.badge === 'done'\) return typeof doneView\.count === 'number' \? \{ count: doneView\.count \} : \{ loading: true \}/)
})

test('le compte de Done est lu au montage, sur sa route, sans payer les lignes closes', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const cible = String(url)
    appels.push(cible)
    if (cible === 'missions/api/done/count') return { ok: true, json: async () => ({ count: 2, errors: [] }) }
    if (cible === 'missions/api/repositories/count') return { ok: true, json: async () => ({ count: 4 }) }
    return { ok: true, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    const { api, ctx, registered, effects, setters } = charger(undefined, doneCountStates(null), memorySession())
    api.apply(ctx)
    registered.main({})
    const montage = effects.find((effect) => String(effect.fn).includes('loadDoneCount()'))
    assert.ok(montage, 'le compte de Done est une dépendance de l’effet de montage')
    await montage.fn()
    await new Promise((done) => setTimeout(done, 0))

    // Une seule route dédiée : le montage ne paie aucune ligne close.
    assert.deepEqual(appels, ['missions/api/list', 'missions/api/done/count', 'missions/api/repositories/count'])
    assert.equal(appels.some((url) => url.includes('done=1')), false, 'le montage ne lit aucune ligne close')

    // Le nombre lu est publié tel quel, prêt pour la pastille.
    const publie = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ count: null }))
      .find((next) => next.count === 2)
    assert.ok(publie, 'le compte lu est publié dans la vue close')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('un compte de Done raté ou partiel ne publie aucun nombre, et n’allume pas de bandeau', async () => {
  const vraiFetch = globalThis.fetch
  const { api, ctx, registered, effects, setters } = charger(undefined, doneCountStates(3), memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  const lecture = lecteurDeDone(effects)
  assert.ok(lecture, 'le compte de Done est une dépendance de l’effet de montage')

  try {
    const lectures = [
      async () => { throw new Error('offline') },
      async () => ({ ok: false, status: 500, json: async () => ({ error: 'count failed' }) }),
      async () => ({ ok: true, json: async () => ({ count: 5, errors: [{ project: 'missions', message: 'done missions: boom' }] }) }),
    ]
    for (const reponse of lectures) {
      globalThis.fetch = (url) => {
        assert.equal(String(url), 'missions/api/done/count')
        return reponse()
      }
      const avant = setters.length
      await lecture()
      assert.equal(setters.length, avant, 'un échec ou un compte partiel ne pousse aucun nombre')
    }

    // La pastille garde le compte déjà prouvé, et aucune lecture de compte
    // n'allume le bandeau : seules les listes le portent.
    assert.equal(pastilleDone(tree), '3')
    assert.equal(findAll(tree, 'div').filter((node) => node.props.className === 'missions-errors').length, 0)

    // La lecture complète publie, zéro compris.
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ count: 0, errors: [] }) })
    await lecture()
    const publie = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ count: 3 }))
      .find((next) => next.count === 0)
    assert.ok(publie, 'un zéro prouvé est publiable')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('ouvrir Done fixe la pastille au nombre de lignes closes, une lecture partielle la laisse', async () => {
  const closed = DASH_MISSIONS.find((mission) => mission.key === 'MIS-6')
  const opened = DASH_MISSIONS.find((mission) => mission.key === 'MIS-1')
  const vraiFetch = globalThis.fetch

  const { api, ctx, registered, effects, setters } = charger(undefined, doneCountStates(9, { tab: 'done' }), memorySession())
  api.apply(ctx)
  registered.main({})
  const ouverture = effects.find((effect) => String(effect.fn).includes("if (tab !== 'done')"))
  assert.ok(ouverture, 'l’ouverture de Done paie sa lecture')

  try {
    // Le serveur promet le périmètre clos : le client ne compte que les lignes
    // closes, et la pastille prend leur nombre, pas celui de la charge reçue.
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'missions/api/list?done=1')
      return { ok: true, json: async () => ({ missions: [closed, opened], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
    }
    await ouverture.fn()
    await new Promise((done) => setTimeout(done, 0))
    const complete = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [], errors: [], count: 9 }))
      .find((next) => next.count === 1)
    assert.ok(complete, 'une lecture complète fixe le compte aux lignes closes')

    // Une lecture qui revient avec des erreurs n'a pas de compte à prouver :
    // celui déjà affiché reste.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ missions: [closed], errors: [{ project: 'missions', message: 'done missions: boom' }] }),
    })
    await ouverture.fn()
    await new Promise((done) => setTimeout(done, 0))
    const partielle = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [], errors: [], count: 9 }))
      .find((next) => next.count === 9)
    assert.ok(partielle, 'une lecture partielle laisse le compte publié')
  } finally {
    globalThis.fetch = vraiFetch
  }
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
      const montage = effects.find((effect) => String(effect.fn).includes('loadRepositoryCount()') && String(effect.fn).includes('loadDoneCount()'))
      assert.ok(montage, `le montage lit le compte (onglet ${onglet})`)
      montage.fn()
      await new Promise((done) => setTimeout(done, 0))
      assert.deepEqual(
        appels,
        ['missions/api/list', 'missions/api/done/count', 'missions/api/repositories/count'],
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

test('un premier échec du compte laisse la pastille en attente, sans zéro ni bandeau', async () => {
  const vraiFetch = globalThis.fetch
  const ongletRepositories = (tree) => findAll(tree, 'button').find((button) => button.props.id === 'missions-tab-repositories')
  const bandeaux = (tree) => findAll(tree, 'div').filter((node) => node.props.className === 'missions-errors')

  // Aucun compte prouvé : la pastille porte le loader dès le montage.
  const { api, ctx, registered, effects, setters } = charger(undefined, repositoriesStates(scanReady(REPO_SCAN), null, null), memorySession())
  api.apply(ctx)
  const tree = registered.main({})
  assert.equal(pastilleEnAttente(ongletRepositories(tree)).props.className, 'missions-tab-count missions-tab-count-loader')
  const lecture = lecteurDeCompte(effects)
  assert.ok(lecture, 'le compte est une dépendance de l’effet de montage')

  try {
    // Le premier échec ne pousse aucun nombre : la pastille reste en attente,
    // sans 0 et sans bandeau, jusqu'au tick suivant.
    globalThis.fetch = async () => { throw new Error('offline') }
    const avant = setters.length
    await lecture()
    assert.equal(setters.length, avant, 'un premier échec ne pousse aucun compte')
    const attente = pastilleEnAttente(ongletRepositories(tree))
    assert.equal(attente.props.className, 'missions-tab-count missions-tab-count-loader', 'le loader reste jusqu’au tick')
    assert.equal(textOf(attente), '', 'aucun zéro n’est affiché')
    assert.equal(textOf(ongletRepositories(tree)).includes('0'), false, 'aucun 0 ne prend la place du loader')
    assert.equal(bandeaux(tree).length, 0, 'une pastille n’allume pas de bandeau')

    // Le zéro prouvé, lui, se publie : la barre le rend en chiffre et le loader
    // quitte la pastille.
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ count: 0 }) })
    await lecture()
    assert.ok(setters.includes(0), 'un zéro prouvé se publie')
    const rendu = charger(undefined, repositoriesStates(scanReady(REPO_SCAN), null, 0), memorySession())
    rendu.api.apply(rendu.ctx)
    const arbre = rendu.registered.main({})
    assert.equal(textOf(pastilleDe(ongletRepositories(arbre))), '0', 'le chiffre remplace le loader')
    assert.equal(pastilleEnAttente(ongletRepositories(arbre)), undefined)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la pastille en attente prend le gabarit du chiffre et tourne', () => {
  // Même pastille que le chiffre — la classe du compte — et la hauteur de son
  // interligne : la barre ne saute pas quand le nombre arrive.
  assert.match(regle('.missions-tab-count'), /min-width: 18px/)
  const attente = regle('.missions-tab-count-loader')
  assert.match(attente, /display: inline-flex/)
  assert.match(attente, /height: 1lh/)
  // Elle tourne, et le dessin reste visible quand on demande moins de mouvement.
  assert.match(regle('.missions-tab-count-loader svg'), /animation: missions-tab-count-spin 1\.1s linear infinite/)
  assert.match(SOURCE, /@keyframes missions-tab-count-spin \{ to \{ transform: rotate\(360deg\); \} \}/)
  assert.match(SOURCE, /@media \(prefers-reduced-motion: reduce\) \{ \.missions-tab-count-loader svg \{ animation: none; \} \}/)
  // L'anneau manga garde ses 24 px : la pastille en attente est la même pastille.
  const ring = regle('.missions-panel[data-skin="paper"] .missions-tab-count')
  assert.match(ring, /width: 24px/)
  assert.match(ring, /height: 24px/)
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
  assert.match(regle('.missions-panel[data-skin="paper"] .missions-tab-count'), /background: var\(--skin-accent\)/)
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
    const { inner, effects, rerendre, session } = montrerRepositories(scanReady(REPO_SCAN), null, memorySession())
    // Les effets du panneau (dont son rafraîchissement de 60 s) ne sont pas
    // joués : la vue arme le chargement, puis la barre arme la fermeture de son
    // menu d'état au clic extérieur. Le scan, lui, part une fois.
    const poses = effects.slice(-2)
    assert.equal(poses.length, 2, 'le chargement, puis la fermeture du menu de l’état')
    for (const pose of poses.slice(0, 1)) pose.fn()
    await new Promise((done) => setTimeout(done, 0))

    assert.equal(appels.length, 1, 'un scan par ouverture de l’onglet')
    assert.equal(appels[0].url, 'missions/api/repositories')
    assert.equal(appels[0].options.headers.accept, 'application/json')

    // When un état s'ajoute à la barre, puis qu'une seconde frappe cherche
    const puce = findAll(inner, 'button').find((button) => /^Filter by state \(All\)$/.test(button.props['aria-label']))
    assert.ok(puce, 'le filtre d’état est rendu')
    puce.props.onClick()
    const ouvert = rerendre()
    const caseDirty = findAll(ouvert, 'label').find((label) => label.props['data-state'] === 'dirty')
    assert.ok(caseDirty, 'l’état Dirty est offert quand le menu est ouvert')
    findAll(caseDirty, 'input')[0].props.onChange()
    const filtre = rerendre()
    findAll(filtre, 'input').find((node) => node.props['aria-label'] === 'Filter repositories')
      .props.onChange({ target: { value: 'fe' } })
    const seconde = rerendre()
    findAll(seconde, 'input').find((node) => node.props['aria-label'] === 'Filter repositories')
      .props.onChange({ target: { value: 'feat' } })

    // Then ni l'état ni les deux frappes ne relisent la racine : le scan est le
    // seul appel, le geste se contente d'écrire la session.
    assert.equal(appels.length, 1, 'un scan au montage, aucune lecture pour un filtre')
    assert.equal(session.entries.get('missions.repositories.filters'), '{"query":"feat","state":["dirty"]}')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la barre des dépôts filtre la liste affichée, sans relire la racine', () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => REPO_SCAN }
  }
  try {
    // Given le scan, et la barre au repos : deux contrôles, pas de Clear
    const { inner, session, rerendre } = montrerRepositories(scanReady(REPO_SCAN), null, memorySession())
    const barre = findAll(inner, 'div').find((node) => node.props.className === 'missions-filters missions-repos-filters')
    assert.ok(barre, 'la barre se place entre l’en-tête et la liste')
    const recherche = findAll(inner, 'input').find((node) => node.props['aria-label'] === 'Filter repositories')
    assert.equal(recherche.props.type, 'search')
    assert.equal(recherche.props.placeholder, 'Filter by name, branch or commit…')
    assert.equal(findAll(inner, 'button').some((button) => textOf(button) === 'Clear'), false, 'aucun Clear sans filtre')
    assert.ok(findAll(inner, 'button').some((button) => /^Filter by state \(All\)$/.test(button.props['aria-label'])))

    // When la recherche filtre sur la branche
    recherche.props.onChange({ target: { value: 'feat/mis' } })
    const filtre = rerendre()
    const lignes = findAll(filtre, 'button').filter((button) => button.props['data-repository'] !== undefined)
    assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions'])
    // The flag writes the session, and the search does not read the root again
    assert.equal(session.entries.get('missions.repositories.filters'), '{"query":"feat/mis","state":null}')
    assert.equal(appels.length, 0, 'aucune requête pendant la saisie')

    // When le Clear efface la barre
    const clear = findAll(filtre, 'button').find((button) => textOf(button) === 'Clear')
    assert.ok(clear, 'le Clear apparaît avec le filtre')
    clear.props.onClick()
    const repos = rerendre()
    const ramenees = findAll(repos, 'button').filter((button) => button.props['data-repository'] !== undefined)
    assert.deepEqual(ramenees.map((ligne) => ligne.props['data-repository']), ['missions', 'zeta'])
    assert.equal(session.entries.has('missions.repositories.filters'), false, 'une barre vide ne laisse aucune clé')
    assert.equal(appels.length, 0)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('le menu State compte les lignes de la liste affichée', () => {
  // Given un scan dont chaque ligne répond à un état, une ligne à deux à la fois
  const scan = {
    ...REPO_SCAN,
    count: 4,
    repositories: [
      { name: 'propre', kind: 'clone', branch: 'main', dirty: 0, lastCommit: null, error: null },
      { name: 'sale', kind: 'clone', branch: 'main', dirty: 2, lastCommit: null, error: null },
      { name: 'detache-et-sale', kind: 'clone', branch: null, detached: true, head: 'abc1234', dirty: 1, lastCommit: null, error: null },
      { name: 'casse', kind: 'clone', branch: null, detached: false, dirty: 0, lastCommit: null, error: 'not a git repository' },
    ],
  }
  const { inner, rerendre } = montrerRepositories(scanReady(scan), null, memorySession())

  // When le menu des états s'ouvre
  const puce = findAll(inner, 'button').find((button) => /^Filter by state \(All\)$/.test(button.props['aria-label']))
  assert.ok(puce, 'le filtre d’état est rendu')
  puce.props.onClick()
  const ouvert = rerendre()

  // Then chaque valeur porte son compte, et les comptes se recouvrent : la
  // ligne détachée et sale compte dans les deux états, la ligne cassée dans un seul.
  const comptes = {}
  for (const label of findAll(ouvert, 'label').filter((node) => node.props['data-state'] !== undefined)) {
    const compte = findAll(label, 'span').find((span) => span.props.className === 'missions-status-count')
    assert.ok(compte, `la valeur ${label.props['data-state']} porte son compte`)
    comptes[label.props['data-state']] = textOf(compte)
  }
  assert.deepEqual(comptes, { clean: '1', dirty: '2', detached: '1', unreadable: '1' })
})

test('une barre restaurée rouvre la recherche et l’état', () => {
  // Given la session qui a laissé une recherche et un état
  const session = memorySession({ 'missions.repositories.filters': '{"query":"116","state":["dirty"]}' })
  const { inner } = montrerRepositories(scanReady(REPO_SCAN), null, session)

  // Then la barre retrouve sa recherche et son état, et la liste ses deux filtres
  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions'], 'la recherche et l’état se cumulent')
  assert.equal(findAll(inner, 'input').find((node) => node.props['aria-label'] === 'Filter repositories').props.value, '116')
  assert.ok(findAll(inner, 'button').some((button) => /^Filter by state \(Dirty\)$/.test(button.props['aria-label'])))
  // L'en-tête reste celui du scan entier, pas celui des lignes gardées
  assert.match(textOf(inner), /2 repositories · 1 worktree · scanned in 1\.9 s/)
})

test('le même état filtre les clones puis les worktrees, sans que l’en-tête bouge', () => {
  // Given la session qui garde l'état Dirty, le switch fermé sur les clones
  const session = memorySession({ 'missions.repositories.filters': '{"query":"","state":["dirty"]}' })
  const clones = montrerRepositories(scanReady(REPO_SCAN), null, session)
  const clone = findAll(clones.inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(clone.map((ligne) => ligne.props['data-repository']), ['missions'], 'l’état écarte le clone propre')
  assert.match(textOf(clones.inner), /2 repositories · 1 worktree · scanned in 1\.9 s/)

  // When le switch ouvre les worktrees, la même session porte le même état
  const ouverts = memorySession({ ...Object.fromEntries(session.entries), 'missions.repositories.worktrees': '1' })
  const worktrees = montrerRepositories(scanReady(REPO_SCAN), null, ouverts)
  const worktree = findAll(worktrees.inner, 'button').filter((button) => button.props['data-repository'] !== undefined)

  // Then l'état a suivi le switch, sa liste est filtrée, et l'en-tête reste celui du scan
  assert.ok(
    findAll(worktrees.inner, 'button').some((button) => /^Filter by state \(Dirty\)$/.test(button.props['aria-label'])),
    'le même état est restauré sur les worktrees',
  )
  assert.deepEqual(worktree.map((ligne) => ligne.props['data-repository']), ['missions-gh20'])
  assert.match(textOf(worktrees.inner), /2 repositories · 1 worktree · scanned in 1\.9 s/)
})

test('aucune ligne ne répond : la barre le dit et son bouton efface', () => {
  // Given une recherche qui ne garde rien
  const session = memorySession({ 'missions.repositories.filters': '{"query":"introuvable"}' })
  const { inner, rerendre } = montrerRepositories(scanReady(REPO_SCAN), null, session)

  // Then l'état vide de la barre, distinct des trois états du genre
  assert.match(textOf(inner), /No repository matches these filters\./)
  assert.equal(findAll(inner, 'li').filter((li) => li.props.className === 'missions-repo-rowitem').length, 0)
  const clear = findAll(inner, 'button').find((button) => textOf(button) === 'Clear filters')
  assert.ok(clear, 'le bouton de l’état vide')
  assert.match(textOf(inner), /Show worktrees/, 'le switch reste offert')

  // When on efface
  clear.props.onClick()
  const rendu = rerendre()
  assert.equal(session.entries.has('missions.repositories.filters'), false)
  const lignes = findAll(rendu, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions', 'zeta'])
})

test('chaque clone est une ligne : nom, branche, état, dernier commit, âge', () => {
  // Given le scan, et le switch au repos : les worktrees restent cachés
  const { inner } = montrerRepositories(scanReady(REPO_SCAN), null, memorySession())

  // L'en-tête dit ce que le scan a lu : les clones d'un côté, les worktrees de
  // l'autre, le tout sans gonfler le compte des dépôts.
  assert.match(textOf(inner), /2 repositories · 1 worktree · scanned in 1\.9 s/)
  assert.match(textOf(inner), /\/Users\/moi\/projects/)

  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  // Le plus récent d'abord ; un dépôt sans commit ferme la liste.
  assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions', 'zeta'])

  const [missions, vide] = lignes
  assert.equal(missions.props.title, '/Users/moi/projects/missions')
  assert.match(missions.props['aria-label'], /^missions, feat\/mis-116, 2 files, MIS-116: ajoute l’onglet$/)
  assert.match(textOf(missions), /feat\/mis-116/)
  assert.match(textOf(missions), /2 files/)
  assert.match(textOf(missions), /MIS-116: ajoute l’onglet/)
  assert.match(textOf(missions), /now/, 'le commit a moins d’une minute')

  // Un dépôt vide est une ligne, pas une absence.
  assert.match(textOf(vide), /clean/)
  assert.match(textOf(vide), /no commit yet/)
  assert.equal(vide.props['aria-label'], 'zeta, main, clean, no commit yet')
})

test('le worktree montré garde sa ligne, son badge et son âge', () => {
  // Given le scan, et le switch qui a demandé les worktrees
  const { inner } = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN))

  // When la liste ne porte que les worktrees
  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)

  // Then il se distingue d'un clone : même enfant de la racine, autre nature.
  assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions-gh20'])
  const [worktree] = lignes
  assert.equal(worktree.props['aria-label'], 'missions-gh20, gh-20-hover, 1 file, gh-20: le survol')
  assert.match(textOf(worktree), /worktree/)
  assert.match(textOf(worktree), /3 h/)
})

test('par défaut, les worktrees restent hors de la liste et l’en-tête les compte', () => {
  const session = memorySession()
  const { inner } = montrerRepositories(scanReady(REPO_SCAN), null, session)

  // Le scan a bien lu trois checkouts : l'en-tête le dit, les lignes n'en
  // montrent que les clones.
  assert.match(textOf(inner), /2 repositories · 1 worktree · scanned in 1\.9 s/)
  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions', 'zeta'])
  assert.equal(findAll(inner, 'li').filter((li) => li.props.className === 'missions-repo-rowitem').length, 2)

  // Le switch est là, fermé, et se nomme d'un nom lisible.
  const interrupteur = findAll(inner, 'button').find((button) => button.props.role === 'switch')
  assert.ok(interrupteur, 'la liste porte son switch')
  assert.equal(interrupteur.props['aria-checked'], 'false')
  assert.equal(textOf(interrupteur), 'Show worktrees')
  assert.equal(session.entries.size, 0, 'un montage ne range aucune clé')
})

test('le switch ne laisse que les worktrees, et un second clic ramène les clones', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    appels.push(String(url))
    return { ok: true, json: async () => ({}) }
  }
  try {
    // Given le scan et une session vierge : les clones
    const session = memorySession()
    const premier = montrerRepositories(scanReady(REPO_SCAN), null, session)

    // When le switch s'ouvre
    findAll(premier.inner, 'button').find((button) => button.props.role === 'switch').props.onClick()

    // Then la session retient le choix, et la liste ne garde que le worktree
    assert.deepEqual(premier.setters, [true], 'un clic arme le switch')
    assert.equal(session.entries.get('missions.repositories.worktrees'), '1', 'la session retient le choix')

    const ouvert = premier.rerendre()
    const lignes = findAll(ouvert, 'button').filter((button) => button.props['data-repository'] !== undefined)
    assert.deepEqual(lignes.map((ligne) => ligne.props['data-repository']), ['missions-gh20'])
    assert.equal(findAll(ouvert, 'button').find((button) => button.props.role === 'switch').props['aria-checked'], 'true')
    assert.ok(
      findAll(ouvert, 'button').some((button) => button.props['aria-label'] === 'Bring missions-gh20 into missions'),
      'le worktree montré porte sa bascule',
    )

    // When un second clic referme le switch
    findAll(ouvert, 'button').find((button) => button.props.role === 'switch').props.onClick()

    // Then la clé disparaît et la liste revient aux clones, sans relire la racine
    assert.deepEqual(premier.setters, [true, false])
    assert.equal(session.entries.has('missions.repositories.worktrees'), false)
    assert.deepEqual(appels, [], 'la bascule ne relit jamais la racine')
    const ferme = premier.rerendre()
    assert.deepEqual(
      findAll(ferme, 'button').filter((button) => button.props['data-repository'] !== undefined).map((ligne) => ligne.props['data-repository']),
      ['missions', 'zeta'],
    )
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la session rouvre les worktrees, et le choix ne touche pas localStorage', () => {
  const local = {
    entries: new Map(),
    getItem(key) { return this.entries.has(key) ? this.entries.get(key) : null },
    setItem(key, value) { this.entries.set(key, String(value)) },
    removeItem(key) { this.entries.delete(key) },
  }

  // Une session qui a déjà ouvert le switch rend la vue des worktrees dès le
  // montage : c'est le retour sur l'onglet après une visite.
  const rouverte = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN), local)
  const ouvertes = findAll(rouverte.inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(ouvertes.map((ligne) => ligne.props['data-repository']), ['missions-gh20'])
  assert.equal(findAll(rouverte.inner, 'button').find((button) => button.props.role === 'switch').props['aria-checked'], 'true')
  assert.equal(local.entries.size, 0, 'aucune clé de worktree dans localStorage')

  // Une valeur qui n'est pas « 1 » garde le défaut fermé.
  for (const value of ['0', 'true', 'oui']) {
    const ferme = montrerRepositories(scanReady(REPO_SCAN), null, memorySession({ 'missions.repositories.worktrees': value }))
    assert.deepEqual(
      findAll(ferme.inner, 'button').filter((button) => button.props['data-repository'] !== undefined).map((ligne) => ligne.props['data-repository']),
      ['missions', 'zeta'],
      `« ${value} » ne vaut pas « 1 »`,
    )
  }
})

test('une racine qui ne porte que des worktrees le dit, au lieu de paraître vide', () => {
  const unSeul = { ...REPO_SCAN, count: 1, repositories: [REPO_SCAN.repositories[2]] }
  const ferme = montrerRepositories(scanReady(unSeul))

  assert.doesNotMatch(textOf(ferme.inner), /No repository in the workspace root\./)
  assert.equal(
    findAll(ferme.inner, 'input').some((node) => node.props['aria-label'] === 'Filter repositories'),
    false,
    'un genre vide ne monte pas la barre',
  )
  assert.match(textOf(ferme.inner), /0 repositories · 1 worktree · scanned in 1\.9 s/)
  assert.match(textOf(ferme.inner), /The only worktree of the workspace root is hidden\./)
  assert.match(textOf(ferme.inner), /Show worktrees lists it\. Scanned \/Users\/moi\/projects\./)

  const interrupteur = findAll(ferme.inner, 'button').find((button) => button.props.role === 'switch')
  assert.ok(interrupteur, 'le switch reste à portée pour révéler les lignes')
  interrupteur.props.onClick()
  const ouvertes = findAll(ferme.rerendre(), 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(ouvertes.map((ligne) => ligne.props['data-repository']), ['missions-gh20'])

  // Deux worktrees se comptent : le texte change de nombre, pas de nature.
  const deux = {
    ...REPO_SCAN,
    count: 2,
    repositories: [
      REPO_SCAN.repositories[2],
      { ...REPO_SCAN.repositories[2], name: 'missions-gh21', path: '/Users/moi/projects/missions-gh21' },
    ],
  }
  assert.match(textOf(montrerRepositories(scanReady(deux)).inner), /All 2 worktrees of the workspace root are hidden\./)
  assert.match(textOf(montrerRepositories(scanReady(deux)).inner), /Show worktrees lists them\./)
})

test('le switch activé sans worktree le dit, au lieu de rendre les clones', () => {
  // Given un scan sans worktree, et une session qui a déjà ouvert le switch
  const sansWorktree = { ...REPO_SCAN, count: 2, repositories: REPO_SCAN.repositories.slice(0, 2) }
  const rendu = montrerRepositories(scanReady(sansWorktree), null, memorySession(WORKTREES_SHOWN))

  // When la liste se rend
  const lignes = findAll(rendu.inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  const interrupteur = findAll(rendu.inner, 'button').find((button) => button.props.role === 'switch')

  // Then la liste est vide, l'état vide le dit, et le switch reste désactivable
  assert.deepEqual(lignes, [], 'aucun clone ne remplace les worktrees manquants')
  assert.equal(
    findAll(rendu.inner, 'input').some((node) => node.props['aria-label'] === 'Filter repositories'),
    false,
    'un genre vide ne monte pas la barre',
  )
  assert.match(textOf(rendu.inner), /2 repositories · scanned in 1\.9 s/)
  assert.match(textOf(rendu.inner), /No worktree in the workspace root\./)
  assert.match(textOf(rendu.inner), /Show worktrees is on: turn it off to see the 2 repositories\./)
  assert.ok(interrupteur, 'le switch reste à portée')
  assert.equal(interrupteur.props['aria-checked'], 'true')
  assert.equal(interrupteur.props.disabled, false)

  // When le switch se referme
  interrupteur.props.onClick()

  // Then les clones reviennent
  assert.deepEqual(rendu.setters, [false])
  const clones = findAll(rendu.rerendre(), 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.deepEqual(clones.map((ligne) => ligne.props['data-repository']), ['missions', 'zeta'])
})

test('un worktree porte la bascule vers son principal, un clone n’en a pas', () => {
  // Given le switch au repos : deux clones, sans bascule
  const ferme = montrerRepositories(scanReady(REPO_SCAN), null, memorySession())
  const bascule = (li) => findAll(li, 'button').find((button) => button.props.className === 'missions-repo-main')
  const créneau = (li) => findAll(li, 'span').find((span) => span.props.className === 'missions-repo-main-slot')
  const clones = findAll(ferme.inner, 'li').filter((li) => li.props.className === 'missions-repo-rowitem')
  assert.equal(clones.length, 2)
  for (const clone of clones) {
    assert.equal(bascule(clone), undefined, 'un clone ne bascule nulle part')
    assert.ok(créneau(clone), 'un clone réserve la colonne de la bascule')
    assert.equal(créneau(clone).props['aria-hidden'], 'true')
  }

  // When le switch passe aux worktrees
  const ouvert = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN))
  const lignes = findAll(ouvert.inner, 'li').filter((li) => li.props.className === 'missions-repo-rowitem')
  assert.equal(lignes.length, 1)
  const [worktree] = lignes

  // Then le worktree porte la bascule, et pas de créneau vide
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
  const head = findAll(ouvert.inner, 'div').find((div) => div.props.className === 'missions-repo-head')
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
  const { inner } = montrerRepositories(scanReady(scan), null, memorySession(WORKTREES_SHOWN))
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
    const rendu = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN))
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
    const rendu = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN))
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
    const rendu = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN))
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
    const rendu = montrerRepositories(scanReady(REPO_SCAN), null, memorySession(WORKTREES_SHOWN))
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
  assert.equal(
    findAll(vide.inner, 'input').some((node) => node.props['aria-label'] === 'Filter repositories'),
    false,
    'une racine vide ne monte pas la barre',
  )
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
  const { tree, inner, effects, setters } = montrerRepositories(scanReady(REPO_SCAN), repository, memorySession())

  // La ligne est un bouton, pas un dessin de bouton : son gestionnaire remet le
  // dépôt au sélecteur du panneau, et le changement d'onglet le remet à `null`.
  const lignes = findAll(inner, 'button').filter((button) => button.props['data-repository'] !== undefined)
  assert.equal(lignes.length, 2)
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
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-repo \{/)
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-repo-head \{/)
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
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-action--danger-armed \{[^}]*--skin-accent-strong/)

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
      { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null, count: null },
      '',
      { ...EMPTY_BAR.filters, state: ['done'] },
      null,
      // Le compte des dépôts de la pastille, lu au montage et gardé dans le panneau.
      null,
      // Le seizième état est la section de Settings, restaurée avec l'onglet.
      'usage',
      // Le dix-septième est le compteur de relecture de la liste Repositories.
      0,
      // Le dix-huitième est le résumé du Dashboard, lu à l'ouverture du sien.
      { loading: true, data: null, error: null },
      // Le dix-neuvième est celui de `UsageTab`, consommé quand on la rend.
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
  assert.match(texte, /Never used \(48\)/)
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
  assert.match(textOf(zero.inner), /Never used \(51\)/)
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
    // Le montage lit la liste et les deux comptes de pastilles, et ne compte rien.
    assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'GET'], 'le montage lit la liste et les comptes, sans compter')
    assert.deepEqual(calls.map((call) => call.url), ['missions/api/list', 'missions/api/done/count', 'missions/api/repositories/count'])

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
  assert.match(SOURCE, /\.missions-panel\[data-skin="paper"\] \.missions-usage-verdict--grow/)
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

    const carte = findAll(view, 'article').find((node) => node.props.className === 'missions-card missions-card--mission')
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
  const vide = { loading: false, missions: [], errors: [], workspaceId: null, workspaceRoot: null, count: null }
  const panneau = [
    EMPTY_BAR, view, 'missions', '', { ...EMPTY_BAR.filters }, null, mission,
    'default', null, EMPTY_BAR, vide, '', { ...EMPTY_BAR.filters, state: ['done'] }, null, null,
    // La section de Settings, restaurée avec l'onglet : le volet vient après.
    'usage',
    // Le compteur de relecture de la liste Repositories.
    0,
    // Le résumé du Dashboard, avant le volet comme dans le panneau.
    { loading: true, data: null, error: null },
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
    const carte = findAll(graph, 'button').find((node) => /missions-card--pick/.test(node.props.className ?? ''))
    assert.ok(carte, 'la carte du workflow est rendue')
    carte.props.onClick()
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
    // La pastille perd la mission archivée tout de suite, elle aussi.
    const pastille = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [{ key: 'MIS-42' }, { key: 'MIS-1' }], count: 3 }))
      .find((next) => next.count === 2)
    assert.ok(pastille, 'la pastille décroît sans attendre la relecture')
    assert.deepEqual(calls, ['missions/api/list?done=1&refresh=1'])
  } finally {
    globalThis.fetch = vraiFetch
  }
})

const WORKFLOW_STATES = ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done']

/** Une entrée de la liste, telle que la route la rend. */
function workflowEntry(over = {}) {
  return {
    workflow: 'cadrage',
    kind: 'etape',
    title: 'Cadrage',
    document: 'workflows/cadrage.md',
    summary: 'Comprendre le ticket.',
    entry: 'to-refine',
    exit: ['ready'],
    nodes: [
      { id: 'lire', label: 'Lire le ticket', section: "Ce qu'on fait", writer: 'session' },
      { id: 'ecrire', label: 'Écrire la fiche', section: "Ce qu'on fait", writer: 'session' },
    ],
    edges: [
      { from: 'to-refine', to: 'lire' },
      { from: 'lire', to: 'ecrire' },
      { from: 'ecrire', to: 'ready' },
    ],
    counts: { nodes: 2, edges: 3 },
    headings: ["Ce qu'on fait"],
    errors: [],
    orphanSections: [],
    file: 'workflows/model/cadrage.yml',
    text: 'workflow: cadrage',
    ...over,
  }
}

/** Le workflow des statuts, l'autre genre de modèle. */
function statutsEntry() {
  return {
    workflow: 'statuts',
    kind: 'statuts',
    title: 'Statuts des missions',
    document: 'workflows/statuts.md',
    summary: 'Les six états canoniques et les huit transitions qui les relient.',
    entry: 'to-refine',
    exit: ['done'],
    nodes: [
      { id: 'to-refine', label: 'À cadrer', description: 'Rien n’est décidé.', tracker: 'label to-refine' },
      { id: 'ready', label: 'Prête', description: 'Le cadrage est validé.', tracker: 'label ready' },
      { id: 'in-progress', label: 'En cours', description: 'La branche est poussée.', tracker: 'label in-progress' },
      { id: 'in-review', label: 'En revue', description: 'La PR est ouverte.', tracker: 'label in-review' },
      { id: 'ready-for-prod', label: 'Prête à partir', description: 'La PR est approuvée.', tracker: 'label ready-for-prod' },
      { id: 'done', label: 'Terminée', description: 'Merge fait.', tracker: 'issue fermée (map: null)' },
    ],
    edges: [
      { from: 'to-refine', to: 'ready', when: 'cadrage validé', writer: 'session' },
      { from: 'ready', to: 'in-progress', when: 'branche poussée', writer: 'session' },
      { from: 'in-progress', to: 'in-review', when: 'PR ouverte et complète', writer: 'session' },
      { from: 'in-progress', to: 'to-refine', when: 'cadrage faux', writer: 'demandeur' },
      { from: 'in-review', to: 'ready-for-prod', when: 'revue approuvée', writer: 'session' },
      { from: 'in-review', to: 'in-progress', when: 'changements demandés', writer: 'demandeur' },
      { from: 'in-review', to: 'to-refine', when: 'diff hors périmètre', writer: 'demandeur' },
      { from: 'ready-for-prod', to: 'done', when: 'merge et ticket fermé', writer: 'demandeur' },
    ],
    counts: { nodes: 6, edges: 8 },
    headings: [],
    errors: [],
    orphanSections: [],
    file: 'workflows/model/statuts.yml',
    text: 'workflow: statuts',
  }
}

/** Le panneau monté sur Workflows, avec la liste et l'entrée voulues. */
function montrerWorkflows(workflows, options = {}) {
  const active = workflows.find((workflow) => workflow.workflow === options.step) ?? workflows[0]
  const { api, ctx, registered, queue, setters } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession({ 'missions.tab': 'workflows' }))
  api.apply(ctx)
  const vue = findAll(registered.main({}), 'WorkflowsView')[0]
  assert.ok(vue, 'l’onglet Workflows est monté')
  const model = options.draft ?? modelOf(active)
  queue.push(...WORKFLOW_HOOKS.map((name) => {
    if (name in options) return options[name]
    if (name === 'view') return { loading: false, error: null, workflows, writers: ['demandeur', 'session', 'outil'], states: WORKFLOW_STATES }
    if (name === 'step') return options.step ?? active.workflow
    if (name === 'draft') return model
    if (name === 'baseline') return modelOf(active)
    if (name === 'exitText') return (model.exit ?? []).join(', ')
    if (name === 'tab') return options.tab ?? 'graphe'
    if (name === 'form') return { title: '', description: '', kind: 'etape' }
    if (name === 'arc') return { from: '', to: '', when: '' }
    if (name === 'status' || name === 'chosen' || name === 'selectedArc') return null
    return false
  }))
  return { rendered: renderTree(vue), setters, queue }
}

test('la liste des workflows montre genre, résumé, compteurs et entrée → sorties', () => {
  const { rendered, setters } = montrerWorkflows([workflowEntry(), statutsEntry()])

  const cartes = findAll(rendered, 'button').filter((node) => /missions-card--pick/.test(node.props.className ?? ''))
  assert.equal(cartes.length, 2)
  assert.deepEqual(cartes.map((carte) => carte.props['data-workflow']), ['cadrage', 'statuts'])
  assert.equal(cartes[0].props['data-kind'], 'etape')
  assert.equal(cartes[1].props['data-kind'], 'statuts')
  assert.match(textOf(cartes[0]), /Cadrage/)
  assert.match(textOf(cartes[0]), /étapes/)
  assert.match(textOf(cartes[0]), /Comprendre le ticket/)
  assert.match(textOf(cartes[0]), /2 gestes · 3 arcs/)
  assert.match(textOf(cartes[1]), /6 états · 8 événements/)
  assert.match(textOf(cartes[1]), /to-refine/)
  assert.match(textOf(cartes[1]), /done/)

  cartes[1].props.onClick()
  assert.equal(setters.at(-1), 'statuts', 'le clic choisit le workflow')
})

test('le workflow des statuts dessine six états, huit événements et sa légende', () => {
  const { rendered } = montrerWorkflows([workflowEntry(), statutsEntry()], { step: 'statuts' })

  const nodes = findAll(rendered, 'g').filter((node) => node.props['data-node'])
  assert.deepEqual(nodes.map((node) => node.props['data-node']), WORKFLOW_STATES)
  assert.ok(nodes.every((node) => node.props['data-kind'] === 'etat'), 'les points sont des états')
  const links = findAll(rendered, 'g').filter((node) => node.props.className === 'wf-link-group')
  assert.equal(links.length, 8, 'les huit transitions sont des arcs')
  assert.match(textOf(rendered), /arc retour/, 'la légende dit le retour')
  assert.match(textOf(rendered), /initial/)
  assert.match(textOf(rendered), /terminal/)

  const table = findAll(rendered, 'table').find((node) => node.props.className === 'wf-map-table')
  assert.ok(table, 'le mapping tracker est là')
  assert.equal(findAll(table, 'tr').length, 7, 'un en-tête et six états')
  assert.match(textOf(table), /issue fermée \(map: null\)/)
})

test('un état de statuts se modifie par son libellé et sa description, le reste est en lecture seule', () => {
  const { rendered, setters } = montrerWorkflows([statutsEntry()], { step: 'statuts', chosen: 'in-review' })

  const titres = findAll(rendered, 'div').filter((node) => node.props.className === 'wf-card-title')
  assert.equal(textOf(titres[0]), 'État')
  const champs = findAll(rendered, 'input')
  const libelle = champs.find((input) => input.props.value === 'En revue')
  assert.ok(libelle, 'le libellé de l’état est un champ')
  libelle.props.onChange({ target: { value: 'En relecture' } })
  const miseAJour = setters.at(-2)
  const draft = typeof miseAJour === 'function' ? miseAJour(modelOf(statutsEntry())) : miseAJour
  assert.equal(draft.nodes.find((node) => node.id === 'in-review').label, 'En relecture')
  const description = findAll(rendered, 'textarea').find((node) => node.props.value === 'La PR est ouverte.')
  assert.ok(description, 'la description est un champ')
  assert.match(textOf(rendered), /Identifiant/)
  assert.match(textOf(rendered), /Rôle/)
  assert.match(textOf(rendered), /Tracker/)
  assert.match(textOf(rendered), /lecture seule/)
  const carteEtat = findAll(rendered, 'div').find((node) => node.props.className === 'wf-card' && textOf(node).includes('Identifiant'))
  assert.equal(findAll(carteEtat, 'select').length, 0, 'id, rôle et tracker ne sont pas des selects')
})

test('un événement montre départ et arrivée en lecture seule et s’édite par ses quatre champs', () => {
  const { rendered, setters } = montrerWorkflows([statutsEntry()], {
    step: 'statuts',
    selectedArc: { from: 'in-review', to: 'in-progress' },
  })

  const titres = findAll(rendered, 'div').filter((node) => node.props.className === 'wf-card-title')
  assert.equal(textOf(titres[0]), 'Événement')
  assert.match(textOf(rendered), /Dein-review/)
  assert.match(textOf(rendered), /Versin-progress/)
  assert.match(textOf(rendered), /changements demandés/)
  const quand = findAll(rendered, 'input').find((input) => input.props.value === 'changements demandés')
  quand.props.onChange({ target: { value: 'la revue demande un correctif' } })
  const miseAJour = setters.at(-2)
  const draft = typeof miseAJour === 'function' ? miseAJour(modelOf(statutsEntry())) : miseAJour
  assert.equal(draft.edges.find((edge) => edge.from === 'in-review' && edge.to === 'in-progress').when, 'la revue demande un correctif')
  const ecrivain = findAll(rendered, 'select').find((select) => select.props.value === 'demandeur')
  assert.ok(ecrivain, 'l’écrivain de l’arc est un select')
  assert.match(textOf(rendered), /lecture seule/)
})

test('Enregistrer envoie le brouillon entier à la route du modèle', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    appels.push({ url: String(url), options })
    return { ok: true, json: async () => ({ workflow: 'statuts', file: 'workflows/model/statuts.yml', entry: statutsEntry() }) }
  }
  try {
    const { rendered } = montrerWorkflows([statutsEntry()], { step: 'statuts' })
    findAll(rendered, 'button').find((node) => textOf(node).trim() === 'Enregistrer').props.onClick()
    await new Promise((done) => setTimeout(done, 0))
    const envois = appels.filter((appel) => String(appel.url).includes('workflows/model'))
    assert.equal(envois.length, 1)
    assert.equal(envois[0].url, 'missions/api/workflows/model')
    const body = JSON.parse(envois[0].options.body)
    assert.equal(body.workflow, 'statuts')
    assert.equal(body.model.kind, 'statuts')
    assert.equal(body.model.nodes.length, 6)
    assert.equal(body.model.edges.length, 8)
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('Annuler rend le brouillon au fichier lu, sans rien poster', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { appels.push(args); return { ok: true, json: async () => ({}) } }
  try {
    const { rendered, setters } = montrerWorkflows([statutsEntry()], { step: 'statuts', chosen: 'done' })
    const annuler = findAll(rendered, 'button').find((node) => textOf(node).trim() === 'Annuler')
    assert.ok(annuler, 'Annuler est rendu')
    annuler.props.onClick()
    const draft = setters.findLast((value) => value && typeof value === 'object' && value.workflow === 'statuts')
    assert.equal(draft.nodes.find((node) => node.id === 'done').label, 'Terminée')
    assert.equal(appels.length, 0, 'Annuler n’écrit rien')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

test('la création dans le panneau ne demande que le titre, la description et le type', async () => {
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { appels.push(args); return { ok: true, json: async () => ({}) } }
  try {
    const { rendered, setters } = montrerWorkflows([workflowEntry()], { creating: true, tab: 'infos' })
    assert.match(textOf(rendered), /Nouveau workflow/)
    assert.match(textOf(rendered), /la clé et le document s’en déduisent/)
    assert.match(textOf(rendered), /280 caractères/)
    assert.equal(findAll(rendered, 'form').length, 1, 'un seul formulaire : celui du panneau')
    assert.equal(findAll(rendered, 'div').some((node) => /wf-modal/.test(node.props.className ?? '')), false, 'aucune modale')

    const formulaire = findAll(rendered, 'form')[0]
    formulaire.props.onSubmit({ preventDefault() {} })
    const erreurs = setters.at(-1)
    assert.equal(erreurs.title, 'Le titre est obligatoire.')
    assert.equal(erreurs.key, undefined, 'aucun champ clé : il ne peut pas manquer')
    assert.equal(erreurs.document, undefined, 'aucun champ document : il ne peut pas manquer')
    assert.equal(appels.length, 0, 'un formulaire vide n’écrit rien')
  } finally {
    globalThis.fetch = vraiFetch
  }
})

// --- Peau illustrée (MIS-170) ---------------------------------------------
// Un seul thème illustré : la structure vit une fois sous data-skin="paper",
// le thème n'apporte que ses tokens et ses rares variantes de décor.

const SANS_IMAGES = SOURCE.replace(/[A-Za-z0-9+/=]{200,}/g, '')

function paletteDe(debut) {
  const at = SOURCE.indexOf(debut)
  assert.ok(at >= 0, `palette absente : ${debut}`)
  const open = SOURCE.indexOf('{', at)
  const body = SOURCE.slice(open + 1, SOURCE.indexOf('}', open))
  const tokens = new Map()
  for (const match of body.matchAll(/--skin-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens.set(match[1], match[2].toLowerCase())
  return tokens
}

function contraste(texte, fond) {
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    const canaux = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * canaux[0] + 0.7152 * canaux[1] + 0.0722 * canaux[2]
  }
  const [haut, bas] = [luminance(texte), luminance(fond)].sort((a, b) => b - a)
  return (haut + 0.05) / (bas + 0.05)
}

function reglesDeTheme() {
  const start = SOURCE.indexOf('const THEME_CSS = `')
  assert.ok(start >= 0)
  const css = SOURCE.slice(start, SOURCE.indexOf('\n`', start)).replace(/\/\*[\s\S]*?\*\//g, '')
  const regles = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (selector) regles.push({ selector, body: match[2] })
  }
  return regles
}

const MANGA_CLAIR = '.missions-panel[data-skin="paper"][data-theme="manga"]'
const MANGA_SOMBRE = ':root[data-ds-dark-theme] .missions-panel[data-skin="paper"][data-theme="manga"]'
const CLASSES_PARTAGEES = ['missions-card', 'missions-row', 'missions-group', 'missions-toolbar', 'missions-tabs', 'missions-tab-count', 'missions-drawer-tabs', 'missions-empty-state']
const SEUILS_CONTRASTE = [7, 4.5, 4.5]

function arbreTheme(theme, session = {}, vue = { loading: false, missions: [MISSION], errors: [], workspaceId: 'w', workspaceRoot: '/w' }, initial = [EMPTY_BAR, vue]) {
  const { api, ctx, registered } = charger({ getItem: () => theme, setItem: () => {} }, initial, memorySession(session))
  api.apply(ctx)
  return registered.main({})
}

function renduTheme(theme, session = {}, vue) {
  return renderTree(arbreTheme(theme, session, vue))
}

function themeDuStockage(storage) {
  const { api, ctx, registered } = charger(storage, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
  api.apply(ctx)
  const panneau = findAll(registered.main({}), 'div').find((node) => node.props.className === 'missions-panel')
  assert.ok(panneau, 'le panneau est monté')
  return panneau.props['data-theme']
}

test('le thème illustré est unique et sa peau reste partagée', () => {
  // Given les deux thèmes rendus
  const manga = JSON.stringify(renduTheme('manga', { 'missions.tab': 'missions' }))
  const defaut = JSON.stringify(renduTheme('default'))

  // When la peau sombre surcharge la peau claire
  const clairs = new Set([...paletteDe(MANGA_CLAIR).keys()])
  const sombres = [...paletteDe(MANGA_SOMBRE).keys()]

  // Then la peau n'est demandée que par Naruto
  assert.match(manga, /"data-skin":"paper"/)
  assert.doesNotMatch(defaut, /"data-skin"/)

  // Then le bloc sombre ne nomme que des tokens déjà définis en clair
  assert.ok(clairs.size > 0, 'la palette claire porte ses tokens')
  for (const nom of sombres) assert.ok(clairs.has(nom), `token sombre inconnu : ${nom}`)

  // Then la structure vit sous data-skin et aucune règle de thème ne la recopie
  for (const classe of CLASSES_PARTAGEES) {
    assert.match(SOURCE, new RegExp(`\\.missions-panel\\[data-skin="paper"\\] \\.${classe}[ ,{]`), `${classe} absente de la peau`)
    assert.doesNotMatch(SOURCE, new RegExp(`\\[data-theme="manga"\\] \\.${classe}\\b`), `${classe} dupliquée par thème`)
  }
  assert.doesNotMatch(SOURCE, /\[data-skin="paper"\]\[data-theme="manga"\] \.missions-(card|row|group|toolbar|tabs|tab-count|drawer-tabs)\b/)
})

test('la palette Naruto garde les textes lisibles, clair comme sombre', () => {
  // Given la palette claire et sa surcharge sombre
  const claire = paletteDe(MANGA_CLAIR)
  const sombre = new Map([...claire, ...paletteDe(MANGA_SOMBRE)])

  // When chaque couple texte / fond est mesuré
  const paires = ['ink|page', 'ink-2|page-2', 'ink-3|page']

  // Then les textes restent au-dessus des seuils, dans les deux variantes
  for (const [nom, tokens] of [['clair', claire], ['sombre', sombre]]) {
    for (const [index, paire] of paires.entries()) {
      const [encre, fond] = paire.split('|')
      assert.ok(tokens.get(encre) && tokens.get(fond), `${nom} : token manquant pour ${encre} sur ${fond}`)
      const ratio = contraste(tokens.get(encre), tokens.get(fond))
      assert.ok(ratio >= SEUILS_CONTRASTE[index], `${nom} : ${encre} sur ${fond} sous le seuil (${ratio.toFixed(2)})`)
    }
  }

  // Then le thème sombre suit les deux attributs que le host pose
  assert.ok(SOURCE.includes(MANGA_SOMBRE), 'la variante sombre vise root')
  assert.ok(SOURCE.includes(`body[data-ds-dark-theme] .missions-panel[data-skin="paper"][data-theme="manga"]`), 'la variante sombre vise body')
})

test('la peau partagée ne porte aucun constant de Konoha', () => {
  // Given les règles de la peau, sans aucune variante de thème
  const partagees = reglesDeTheme().filter(({ selector }) => selector.includes('[data-skin="paper"]') && !selector.includes('[data-theme='))
  const texte = partagees.map(({ selector, body }) => `${selector} {${body}}`).join('\n')

  // When la part de la peau dans le bloc de thème est mesurée
  assert.ok(partagees.length > 50, 'la peau partagée est bien le gros du bloc de thème')

  // Then elle ne contient ni image, ni glyphe, ni teinte propre à Naruto
  assert.doesNotMatch(texte, /data:image|webp/i, 'aucune image embarquée dans la peau')
  assert.doesNotMatch(texte, /Naruto|忍/, 'aucun glyphe ni nom de Konoha dans la peau')
  assert.doesNotMatch(texte, /#f2a26f|#a85526|#fbf4e6|#aec7a7/i, 'aucune teinte Naruto en dur dans la peau')
})

test('le thème Naruto garde sa photo, son kicker et son glyphe', () => {
  // Given le thème Naruto monté sur la vue Missions
  const flat = JSON.stringify(renduTheme('manga', { 'missions.tab': 'missions' }))

  // When le panneau est rendu
  assert.match(flat, /"data-theme":"manga"/)
  assert.match(flat, /"data-skin":"paper"/)

  // Then le décor de Konoha est intact : photo, kicker et marque
  assert.match(flat, /missions-hero-photo/)
  assert.match(flat, /data:image\/webp/)
  assert.match(flat, /Konoha · mission log/)
  assert.match(flat, /忍/)
})

test('la source ne garde aucune trace du thème Noël', () => {
  // Given la source et le bundle, images embarquées mises de côté
  const sources = [SANS_IMAGES, SANS_IMAGES.replace(/\s+/g, ' ')]

  // When chaque motif du thème supprimé est cherché
  const motifs = [/noel/i, /noël/i, /snow/i, /flocon/i, /❄/, /missions-hero-scene/, /missions-empty-scene/, /missions-snowflake-turn/]

  // Then aucun n'apparaît
  for (const source of sources) {
    for (const motif of motifs) assert.doesNotMatch(source, motif, `trace restante : ${motif}`)
  }
})

test('le sélecteur de thème propose Default puis Naruto', () => {
  // Given
  const { api, ctx, registered } = charger(undefined, [EMPTY_BAR, dashboardView(DASH_MISSIONS), 'missions'])
  api.apply(ctx)
  const themeSelect = findAll(registered.main({}), 'ThemeSelect')[0]
  assert.ok(themeSelect, 'le sélecteur de thème est monté')

  // When
  const select = findAll(renderTree(themeSelect), 'select').find((node) => node.props['aria-label'] === 'Theme')

  // Then
  assert.ok(select, 'le select « Theme » est rendu')
  assert.deepEqual(select.children.map((option) => option.props.value), ['default', 'manga'])
  assert.deepEqual(select.children.map((option) => textOf(option)), ['Default', 'Naruto'])
  assert.equal(select.props.value, 'default')
})

test('THEMES déclare les deux thèmes dans l’ordre', () => {
  // Given
  const debut = SOURCE.indexOf('const THEMES = [')
  assert.ok(debut >= 0, 'THEMES est déclaré')

  // When
  const bloc = SOURCE.slice(debut, SOURCE.indexOf('\n    ]', debut))

  // Then
  const entrees = [...bloc.matchAll(/\{ id: '([^']+)', label: '([^']+)' \}/g)].map((match) => [match[1], match[2]])
  assert.deepEqual(entrees, [['default', 'Default'], ['manga', 'Naruto']])
})

test('un thème noel stocké retombe sur Default, sélecteur compris', () => {
  // Given un stockage qui garde encore l'identifiant du thème supprimé
  const stockage = { getItem: () => 'noel', setItem: () => {} }
  const { api, ctx, registered } = charger(stockage, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
  api.apply(ctx)
  const tree = registered.main({})

  // When le panneau et son sélecteur lisent ce stockage
  const panneau = findAll(tree, 'div').find((node) => node.props.className === 'missions-panel')
  const select = findAll(renderTree(findAll(tree, 'ThemeSelect')[0]), 'select')
    .find((node) => node.props['aria-label'] === 'Theme')

  // Then le thème courant est Default, sans peau illustrée
  assert.equal(panneau.props['data-theme'], 'default')
  assert.equal(panneau.props['data-skin'], undefined)
  assert.equal(select.props.value, 'default')
  assert.equal(select.children.length, 2)
  assert.equal(themeDuStockage(stockage), 'default')
})

test('un thème stocké inconnu retombe sur Default', () => {
  // Given
  const stockage = { getItem: () => 'sapin', setItem: () => {} }

  // When
  const theme = themeDuStockage(stockage)

  // Then
  assert.equal(theme, 'default')
})

test('un stockage absent laisse le panneau en Default', () => {
  // Given
  const stockage = undefined

  // When
  const theme = themeDuStockage(stockage)

  // Then
  assert.equal(theme, 'default')
})

test('un stockage qui échoue laisse le panneau en Default', () => {
  // Given
  const stockage = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }

  // When
  const theme = themeDuStockage(stockage)

  // Then
  assert.equal(theme, 'default')
})

test('changer de thème écrit missions.theme et compte le geste', () => {
  // Given
  const ecritures = []
  const stockage = { getItem: () => 'manga', setItem: (cle, valeur) => ecritures.push([cle, valeur]) }
  const { api, ctx, registered, setters } = charger(stockage, [EMPTY_BAR, dashboardView(DASH_MISSIONS)], memorySession())
  api.apply(ctx)
  const select = findAll(renderTree(findAll(registered.main({}), 'ThemeSelect')[0]), 'select')
    .find((node) => node.props['aria-label'] === 'Theme')
  const spy = espionUsage()

  try {
    // When
    select.props.onChange({ target: { value: 'default' } })

    // Then
    assert.deepEqual(ecritures, [['missions.theme', 'default']])
    assert.ok(setters.includes('default'), 'le thème courant redevient Default')
    spy.geste('action.theme', 'default')
  } finally {
    spy.restore()
  }
})

/*
 * L'archivage en lot : la liste Done archive exactement les lignes affichées,
 * en deux clics, et le refus d'une ligne ne défait pas les autres. Le harnais
 * monte le panneau sur l'onglet Done ; le bouton et sa note vivent dans
 * `MissionsView`, qui les tient d'un composant sans état propre au-dessus du
 * panneau.
 */
const BATCH_DONE = [
  { key: 'MIS-1', title: 'alpha one', state: 'done', type: 'bug', priority: 'high', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-09T12:00:00Z' },
  { key: 'MIS-2', title: 'alpha two', state: 'done', type: 'bug', priority: 'normal', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-09T11:00:00Z' },
  { key: 'MIS-3', title: 'beta three', state: 'done', type: 'story', priority: 'low', project: 'missions', projectName: 'Missions', updatedAt: '2026-11-09T10:00:00Z' },
]

/** Le panneau sur Done : la liste, le compte du badge et la sélection du volet. */
function monterDoneBatch(missions, { count = missions.length, selected = null, query = '' } = {}) {
  const view = { loading: false, missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }
  const doneView = { loading: false, missions, errors: [], workspaceId: 'w', workspaceRoot: '/w', count }
  const panneau = [
    EMPTY_BAR, view, 'done', '', EMPTY_BAR.filters, null, selected, 'default', null,
    EMPTY_BAR, doneView, '', { ...EMPTY_BAR.filters, state: ['done'] }, null,
  ]
  const { api, ctx, registered, setters, queue, resetHooks } = charger(undefined, [...panneau])
  api.apply(ctx)
  const rendu = ({ query: nextQuery = query, missions: nextMissions = missions } = {}) => {
    resetHooks()
    queue.length = 0
    queue.push(...panneau)
    // Done reads its own query and filters: index 11 is `doneQuery`, not the
    // open list's query at index 3. A silent refresh only replaces the read.
    queue[10] = { ...doneView, missions: nextMissions }
    queue[11] = nextQuery
    return findAll(registered.main({}), 'MissionsView')[0]
  }
  const arbre = (options) => renderTree(rendu(options))
  return { setters, arbre, rendu }
}

/** Le bouton du lot, quel que soit son état, dans la barre de la liste. */
function boutonLot(tree) {
  return findAll(tree, 'button').find((node) => /missions-batch-btn/.test(node.props.className ?? '')) ?? null
}

/** La dernière note posée par le geste de lot : elle voyage dans l'état du composant. */
function noteLot(setters) {
  return setters
    .filter((value) => value && typeof value === 'object' && 'note' in value)
    .at(-1)?.note ?? null
}

/** Un faux `fetch` qui répond à la route de lot et note chaque requête. */
function fauxFetchLot(reponse) {
  const appels = []
  const vrai = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    appels.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null })
    const donnee = typeof reponse === 'function' ? reponse(String(url), options) : reponse
    if (donnee && donnee.reponse) {
      return donnee.reponse
    }
    return { ok: true, status: 200, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  return { appels, rendre: () => { globalThis.fetch = vrai } }
}

test('le bouton de lot n’existe qu’en Done et compte les lignes affichées', () => {
  // La liste ouverte ne reçoit pas la prop : aucun bouton de lot.
  const ouvert = renderTree(monter([EMPTY_BAR, dashboardView(DASH_MISSIONS.filter((mission) => mission.state !== 'done')), 'missions']))
  assert.equal(boutonLot(ouvert), null, 'la liste ouverte ne porte pas le geste de lot')

  // Done le porte, compté sur `filtered` : trois done, la recherche en garde deux.
  const { arbre } = monterDoneBatch(BATCH_DONE, { query: 'alpha' })
  const bouton = boutonLot(arbre())
  assert.ok(bouton, 'Done porte le bouton de lot')
  assert.equal(bouton.props['aria-label'], 'Archive 2 missions')
  assert.equal(bouton.props.title, 'Archive 2 missions')
  assert.equal(bouton.props.disabled, false)

  // Zéro ligne affichée : le bouton reste, désactivé, et ne nomme aucune ligne.
  const vide = boutonLot(arbre({ query: 'zzz' }))
  assert.ok(vide, 'le bouton reste dans la barre')
  assert.equal(vide.props.disabled, true)
  assert.equal(vide.props['aria-label'], 'Archive 0 missions')
  assert.match(textOf(renderTree({ ...arbre({ query: 'zzz' }) })), /No mission matches these filters\./)
})

test('le lot confirmé n’envoie que les clés affichées', async () => {
  const fetchLot = fauxFetchLot(null)
  try {
    const { arbre } = monterDoneBatch(BATCH_DONE, { query: 'alpha' })
    const bouton = boutonLot(arbre())
    await bouton.props.onClick()
    await bouton.props.onClick()

    const envois = fetchLot.appels.filter((appel) => appel.url === 'missions/api/archive-batch')
    assert.equal(envois.length, 1, 'un seul envoi pour le lot')
    assert.deepEqual(envois[0].body, { keys: ['MIS-1', 'MIS-2'] }, 'les clés envoyées sont exactement les lignes visibles')
  } finally {
    fetchLot.rendre()
  }
})

test('deux clics : le premier arme sans requête, le second envoie une fois', async () => {
  const fetchLot = fauxFetchLot({
    reponse: {
      ok: true,
      status: 200,
      json: async () => ({
        archived: [
          { key: 'MIS-1', folder: 'MIS-1', archived: 'missions/archives/MIS-1' },
          { key: 'MIS-2', folder: 'MIS-2', archived: 'missions/archives/MIS-2' },
        ],
        refused: [],
      }),
    },
  })
  try {
    const { setters, arbre } = monterDoneBatch(BATCH_DONE, { query: 'alpha' })
    const bouton = boutonLot(arbre())

    await bouton.props.onClick()
    assert.equal(fetchLot.appels.filter((appel) => appel.url === 'missions/api/archive-batch').length, 0, 'le premier clic n’envoie rien')
    const arme = noteLot(setters)
    assert.match(arme.text, /missions\/archives\//, 'la note dit où vont les dossiers')
    assert.match(arme.text, /Click again to confirm/)

    // Le rendu suivant porte l'état armé : le libellé et l'infobulle nomment la
    // confirmation, et le bouton garde les deux clés.
    const confirme = boutonLot(arbre())
    assert.equal(confirme.props['aria-label'], 'Confirm — archive 2 missions')
    assert.match(confirme.props.className, /missions-batch-btn--armed/)

    // Le même nœud, pas un rendu neuf : un composant remonté repart d'un garde
    // vierge, comme le fait un remontage React — c'est le même geste qui doit
    // se souvenir du premier clic.
    await bouton.props.onClick()
    assert.equal(fetchLot.appels.filter((appel) => appel.url === 'missions/api/archive-batch').length, 1, 'le second clic envoie une fois')
    assert.match(noteLot(setters).text, /Archived 2 mission folders to missions\/archives\/\./)
  } finally {
    fetchLot.rendre()
  }
})

test('un changement de liste entre les deux clics réarme au lieu d’envoyer', async () => {
  const fetchLot = fauxFetchLot(null)
  try {
    const { setters, arbre } = monterDoneBatch(BATCH_DONE, { query: 'alpha' })
    await boutonLot(arbre()).props.onClick()
    assert.match(noteLot(setters).text, /This moves 2 mission folders/)

    // La recherche est vidée : la liste affichée passe de deux à trois lignes.
    const suivant = boutonLot(arbre({ query: '' }))
    assert.doesNotMatch(suivant.props.className, /missions-batch-btn--armed/, 'le bouton n’est plus en état de confirmation')
    await suivant.props.onClick()

    assert.equal(fetchLot.appels.filter((appel) => appel.url === 'missions/api/archive-batch').length, 0, 'aucune clé de l’ancienne liste n’est envoyée')
    assert.match(noteLot(setters).text, /This moves 3 mission folders/, 'le clic a armé la nouvelle liste')

    const arme = boutonLot(arbre({ query: '' }))
    assert.match(arme.props.className, /missions-batch-btn--armed/)
    assert.equal(arme.props['aria-label'], 'Confirm — archive 3 missions')

    // La même garde vaut pour une relecture silencieuse : une ligne close de
    // plus dans la lecture Done change la liste affichée sans toucher aux
    // filtres, et le clic suivant arme la nouvelle liste.
    const ferme = { ...BATCH_DONE[2], key: 'MIS-4', title: 'delta four' }
    const rafraichi = boutonLot(arbre({ query: '', missions: [...BATCH_DONE, ferme] }))
    assert.doesNotMatch(rafraichi.props.className, /missions-batch-btn--armed/)
    await rafraichi.props.onClick()
    assert.equal(fetchLot.appels.filter((appel) => appel.url === 'missions/api/archive-batch').length, 0, 'un rafraîchissement silencieux n’est jamais confirmé à l’aveugle')
    assert.match(noteLot(setters).text, /This moves 4 mission folders/)
  } finally {
    fetchLot.rendre()
  }
})

test('le refus partiel se dit et laisse les refusées dans la liste', async () => {
  const fetchLot = fauxFetchLot({
    reponse: {
      ok: true,
      status: 200,
      json: async () => ({
        archived: [{ key: 'MIS-1', folder: 'MIS-1', archived: 'missions/archives/MIS-1' }],
        refused: [{ key: 'MIS-2', error: 'MIS-2 is not done' }],
      }),
    },
  })
  try {
    const { setters, arbre } = monterDoneBatch(BATCH_DONE)
    const bouton = boutonLot(arbre())
    await bouton.props.onClick()
    await bouton.props.onClick()

    const note = noteLot(setters)
    assert.equal(note.error, true)
    assert.match(note.text, /Archived 1 of 2; 1 refused: MIS-2 \(MIS-2 is not done\)/)

    // Seule la ligne archived quitte la liste : celle qui a refusé reste.
    const restants = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [{ key: 'MIS-1' }, { key: 'MIS-2' }, { key: 'MIS-3' }], count: 3 }))
      .filter((next) => next && Array.isArray(next.missions) && next.missions.length === 2)
    assert.ok(restants.length >= 1, 'le retrait suit les seules archivées')
    for (const restant of restants) {
      assert.deepEqual(restant.missions.map((mission) => mission.key), ['MIS-2', 'MIS-3'])
    }
  } finally {
    fetchLot.rendre()
  }
})

test('un échec de la route ne retire aucune ligne et laisse le bouton réarmable', async () => {
  const fetchLot = fauxFetchLot({ reponse: { ok: false, status: 502, json: async () => ({ error: 'done missions: token missing' }) } })
  try {
    const { setters, arbre } = monterDoneBatch(BATCH_DONE)
    const bouton = boutonLot(arbre())
    await bouton.props.onClick()
    await bouton.props.onClick()

    const note = noteLot(setters)
    assert.equal(note.error, true)
    assert.match(note.text, /Archive failed: done missions: token missing/)
    const retire = setters.filter((value) => typeof value === 'function' && value({ missions: [{ key: 'MIS-1' }] }).missions.length === 0)
    assert.equal(retire.length, 0, 'aucune ligne n’est retirée')

    // Un échec réarme : le clic suivant redemande confirmation sans envoyer.
    await boutonLot(arbre()).props.onClick()
    assert.equal(fetchLot.appels.filter((appel) => appel.url === 'missions/api/archive-batch').length, 1)
    assert.match(noteLot(setters).text, /Click again to confirm/)
  } finally {
    fetchLot.rendre()
  }
})

test('le lot retire les lignes, décrémente le compte et referme le volet', async () => {
  const fetchLot = fauxFetchLot({
    reponse: {
      ok: true,
      status: 200,
      json: async () => ({
        archived: [
          { key: 'MIS-1', folder: 'MIS-1', archived: 'missions/archives/MIS-1' },
          { key: 'MIS-2', folder: 'MIS-2', archived: 'missions/archives/MIS-2' },
        ],
        refused: [],
      }),
    },
  })
  try {
    // Le volet montre une mission du lot : il doit se refermer avec elle.
    const { setters, arbre } = monterDoneBatch(BATCH_DONE, { count: 4, selected: BATCH_DONE[0] })
    const bouton = boutonLot(arbre())
    await bouton.props.onClick()
    await bouton.props.onClick()

    const reduits = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: BATCH_DONE.map((mission) => ({ key: mission.key })), count: 4 }))
    // Chaque reducer du retrait rend la même liste amputée : la vue et le volet
    // lisent les mêmes clés archivées.
    const retraits = reduits.filter((next) => next && Array.isArray(next.missions) && next.missions.length === 1)
    assert.ok(retraits.length >= 2, 'la vue et le compte suivent les deux archivées')
    for (const retrait of retraits) {
      assert.deepEqual(retrait.missions.map((mission) => mission.key), ['MIS-3'], 'les lignes archivées quittent les deux copies')
    }
    assert.ok(reduits.some((next) => next.count === 2), 'le compte Done décroît du nombre archivé')

    // Le volet ouvert sur une mission archivée est refermé ; un updater rend null.
    const fermeture = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [], count: 4, key: 'MIS-1' }))
      .some((next) => next === null)
    assert.equal(fermeture, true, 'le volet se referme sur la mission archivée')

    // Une seule relecture silencieuse de Done, sans attendre.
    const relues = fetchLot.appels.filter((appel) => appel.url === 'missions/api/list?done=1&refresh=1')
    assert.equal(relues.length, 1)
  } finally {
    fetchLot.rendre()
  }
})

test('le lot se compte au clic confirmé seulement, avec son nombre de clés', async () => {
  const fetchLot = fauxFetchLot(null)
  try {
    const { arbre } = monterDoneBatch(BATCH_DONE, { query: 'alpha' })
    const bouton = boutonLot(arbre())
    await bouton.props.onClick()
    const usageArme = fetchLot.appels.filter((appel) => appel.url === 'missions/api/usage')
    assert.equal(usageArme.length, 0, 'l’armement ne compte rien')

    await bouton.props.onClick()
    const usage = fetchLot.appels.filter((appel) => appel.url === 'missions/api/usage')
    assert.equal(usage.length, 1, 'un seul POST d’usage')
    assert.deepEqual(usage[0].body, { element: 'mission.archive.batch', detail: '2' })
  } finally {
    fetchLot.rendre()
  }
})

test('le bouton dit son état, sa note est une région de statut, et l’envoi le désactive', async () => {
  let resoudre
  const reponseLot = new Promise((resolve) => { resoudre = resolve })
  const vrai = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url) === 'missions/api/archive-batch') {
      return reponseLot.then(() => ({ ok: true, status: 200, json: async () => ({ archived: [], refused: [] }) }))
    }
    return { ok: true, status: 200, json: async () => ({ missions: [], errors: [], workspaceId: 'w', workspaceRoot: '/w' }) }
  }
  try {
    const { setters, arbre } = monterDoneBatch(BATCH_DONE, { query: 'alpha' })
    const bouton = boutonLot(arbre())
    await bouton.props.onClick()
    const arme = boutonLot(arbre())
    // La note est une région de statut, et le bouton armé reste actif.
    const notes = findAll(arbre(), 'p').filter((node) => node.props.role === 'status')
    assert.ok(notes.some((node) => /Click again to confirm/.test(textOf(node))))
    assert.equal(arme.props.disabled, false)

    // L'envoi en cours désactive le bouton et l'annonce.
    const envoi = bouton.props.onClick()
    const enCours = boutonLot(arbre())
    assert.equal(enCours.props.disabled, true, 'le bouton est inactif pendant l’envoi')
    assert.equal(enCours.props.title, 'Archiving…')
    assert.equal(enCours.props['aria-label'], 'Archiving…')
    assert.equal(enCours.props['aria-busy'], 'true')

    resoudre()
    await envoi
    assert.match(noteLot(setters).text, /Archived 0 mission folders/)
  } finally {
    globalThis.fetch = vrai
  }
})

test('un lot d’une seule archivée ne referme pas le volet d’une autre mission', async () => {
  const fetchLot = fauxFetchLot({
    reponse: {
      ok: true,
      status: 200,
      json: async () => ({
        archived: [{ key: 'MIS-1', folder: 'MIS-1', archived: 'missions/archives/MIS-1' }],
        refused: [],
      }),
    },
  })
  try {
    // Given : le volet montre une mission que le lot n'archive pas.
    const { setters, arbre } = monterDoneBatch(BATCH_DONE, { count: 4, selected: BATCH_DONE[2] })
    const bouton = boutonLot(arbre())

    // When : les deux clics du lot archivent une seule ligne.
    await bouton.props.onClick()
    await bouton.props.onClick()

    // Then : la sélection survit au geste de la liste.
    const fermetures = setters
      .filter((value) => typeof value === 'function')
      .map((update) => update({ missions: [], count: 4, key: 'MIS-3' }))
      .filter((next) => next === null)
    assert.equal(fermetures.length, 0, 'le volet garde une mission hors du lot')
  } finally {
    fetchLot.rendre()
  }
})


test('la carte et la tête du détail portent la pastille Local, et seulement pour un local', () => {
  const local = montrerWorkflows([workflowEntry({ local: true })], { tab: 'infos' })
  const carte = findAll(local.rendered, 'button').find((node) => /missions-card--pick/.test(node.props.className ?? ''))
  const pastilles = findAll(carte, 'span').filter((node) => node.props.className === 'wf-pick-local')
  assert.equal(pastilles.length, 1, 'la carte porte la pastille')
  assert.equal(textOf(pastilles[0]), 'Local')
  const tete = findAll(local.rendered, 'div').find((node) => node.props.className === 'wf-detail-head')
  assert.ok(tete, 'la tête du détail est rendue')
  assert.match(textOf(tete), /Local/, 'la tête du détail porte la pastille')

  const versionne = montrerWorkflows([workflowEntry({ local: false })]).rendered
  const carteVersionnee = findAll(versionne, 'button').find((node) => /missions-card--pick/.test(node.props.className ?? ''))
  assert.equal(findAll(carteVersionnee, 'span').filter((node) => node.props.className === 'wf-pick-local').length, 0)
  assert.match(regle('.wf-pick-local'), /color: #8250df/, 'la pastille locale a sa teinte, distincte du type')
  assert.match(regle('.wf-pick-summary'), /white-space: pre-line/)
  assert.match(regle('.wf-pick-summary'), /-webkit-line-clamp: 2/)
})

test('Informations rend la description en textarea et le versionnement en switch', () => {
  const { rendered, setters } = montrerWorkflows([workflowEntry({ local: false })], { tab: 'infos' })
  const description = findAll(rendered, 'textarea')[0]
  assert.ok(description, 'la description est un textarea')
  assert.ok(Number(description.props.rows) >= 3)
  assert.equal(description.props.maxLength, 280)

  const versionne = findAll(rendered, 'button').find((node) => node.props.role === 'switch')
  assert.ok(versionne, 'le switch est dans Informations')
  assert.equal(versionne.props['aria-checked'], 'true', 'versionné par défaut')

  const avant = setters.length
  versionne.props.onClick()
  const misesAJour = setters.slice(avant).filter((value) => typeof value === 'function')
  assert.ok(misesAJour.length, 'le basculement marque le brouillon')
  const bascule = misesAJour[0](modelOf(workflowEntry({ local: false })))
  assert.equal(bascule.local, true, 'décocher range en local')
  assert.notDeepEqual(bascule, modelOf(workflowEntry({ local: false })), 'le brouillon devient sale')

  const local = montrerWorkflows([workflowEntry({ local: true })], { tab: 'infos' }).rendered
  const switchLocal = findAll(local, 'button').find((node) => node.props.role === 'switch')
  assert.equal(switchLocal.props['aria-checked'], 'false', 'un local n’est pas coché versionné')
})
