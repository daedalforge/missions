import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actionVerb,
  endPoints,
  layoutWorkflow,
  modelOf,
  repositoryScope,
  PLAYBOOK_PAGE_KEY,
  readPlaybookPage,
  readStep,
  readStoredView,
  storedView,
  writePlaybookPage,
  writeStep,
  writeStoredView,
  nextGestureId,
  withoutEdge,
  upsertEdge,
  withoutNode,
  ageDays,
  assignedBugs,
  blockedReasonAfterWrite,
  blockerKeys,
  branchesToPush,
  branchFieldValue,
  checkoutsToFix,
  COLD_CHECKOUT_DAYS,
  EMPTY_FILTERS,
  epicOptions,
  epicParts,
  clipTitle,
  matchActions,
  matchOutline,
  outlineCount,
  outlineEntries,
  outlineFamily,
  outlineOpen,
  OUTLINE_ANCHORS,
  parseChecklist,
  dashboardScope,
  executionBlocker,
  freeSessionBlocker,
  missionStep,
  missionWorktree,
  NO_PROJECT,
  missionSessionPrompt,
  feedbackSessionPrompt,
  freeSessionPrompt,
  repositoryConflictPrompt,
  repositorySquashPrompt,
  FEEDBACK_BRIEF,
  FREE_BRIEF,
  ticketReadLine,
  STEP_BRIEFS,
  STEP_BY_STATE,
  FILTERS_KEY,
  DONE_FILTERS_KEY,
  filterBarState,
  filterMissions,
  filterSnapshot,
  historyLabel,
  groupByState,
  hasActiveFilters,
  highPriorityStories,
  inFlight,
  isWaitingOnBlock,
  missionAge,
  needsYou,
  parseFilterSnapshot,
  POINTS_SCALE,
  pointsText,
  pointsTotal,
  priorityOptions,
  projectOptions,
  QUIET_AFTER_DAYS,
  readFilterSnapshot,
  readTab,
  readWorktreesShown,
  readRepositoryFilters,
  relativeAge,
  REPOSITORIES_FILTERS_KEY,
  REPOSITORIES_WORKTREES_KEY,
  REPOSITORY_FILTER_LABELS,
  REPOSITORY_FILTER_OPTIONS,
  repositoryBranch,
  repositoryCommit,
  repositoryFilterCounts,
  repositoryFilterSnapshot,
  repositoryState,
  parseRepositoryFilters,
  placeTooltip,
  TIP_GAP,
  TIP_MARGIN,
  hasActiveRepositoryFilters,
  filterRepositories,
  writeRepositoryFilters,
  scanDuration,
  scanLabel,
  searchBucket,
  pinnedFirst,
  respectBlockers,
  sortMissions,
  sortRepositories,
  stateInRange,
  stateOptions,
  suggestBranch,
  TAB_KEY,
  USAGE_ELEMENTS,
  USAGE_GATE_DAYS,
  USAGE_GATE_EVENTS,
  USAGE_GROW_COUNT,
  USAGE_GROW_SHARE,
  USAGE_IMPROVE_COUNT,
  USAGE_MAX_DETAIL,
  USAGE_MAX_VALUES,
  USAGE_STALE_DAYS,
  USAGE_VERDICTS,
  usageElement,
  usageGate,
  usageReport,
  usageVerdict,
  writeFilterSnapshot,
  worktreeLabel,
  writeTab,
  writeWorktreesShown,
} from '../lib/view.js'
// L'échelle est définie dans `view.js` et ré-exportée par `mission.js` : la
// route lit ce second nom, le volet lit le premier, et les deux sont la même
// liste. Le test le prouve au lieu de le supposer.
import { POINTS_SCALE as missionScale } from '../lib/mission.js'
import { loadWorkflows, MODELS_DIR, readWorkflow } from '../lib/workflows.js'

/** Un stockage de session en mémoire, comme celui de la fenêtre. */
function memoryStorage() {
  const entries = new Map()
  return {
    entries,
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  }
}

const MISSIONS = [
  {
    key: 'a#1',
    title: 'Panneau vide',
    project: 'missions',
    projectName: 'Workspace missions',
    epic: 'Workspace',
    state: 'in-review',
    type: 'bug',
    priority: 'urgent',
    points: 3,
  },
  {
    key: 'a#2',
    title: 'Lecture Jira',
    project: 'alpha',
    projectName: 'Alpha',
    epic: null,
    state: 'to-refine',
    type: 'story',
    priority: 'normal',
    points: 5,
  },
  {
    key: 'a#3',
    title: 'Cartes et filtres',
    project: 'missions',
    projectName: 'Workspace missions',
    epic: 'Workspace',
    state: 'ready',
    type: 'story',
    priority: 'low',
    points: 2,
  },
]

test('la recherche porte sur le titre, la clé, le projet et l’epic', () => {
  assert.deepEqual(filterMissions(MISSIONS, { query: 'panneau' }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'A#3' }).map((m) => m.key), ['a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'alpha' }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'workspace' }).map((m) => m.key), ['a#1', 'a#3'])
})

test('le filtre de type se combine avec la recherche', () => {
  assert.deepEqual(filterMissions(MISSIONS, { type: 'story' }).map((m) => m.key), ['a#2', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { type: 'bug', query: 'cartes' }), [])
})

test('les filtres epic, priorité et projet se combinent en ET', () => {
  assert.deepEqual(filterMissions(MISSIONS, { epic: 'Workspace' }).map((m) => m.key), ['a#1', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { priority: 'normal' }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(MISSIONS, { project: 'missions' }).map((m) => m.key), ['a#1', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { project: 'missions', type: 'story' }).map((m) => m.key), ['a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { epic: 'Workspace', priority: 'urgent' }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { query: 'cartes', project: 'missions' }).map((m) => m.key), ['a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { project: 'alpha', type: 'bug' }), [])
})

test('le filtre projet sépare les dépôts et garde les missions sans projet', () => {
  // Given une mission que nul dépôt ne travaille
  const sansProjet = { ...MISSIONS[0], key: 'a#9', project: null, projectName: null }
  // When le filtre demande « sans projet », Then seule cette ligne reste
  assert.deepEqual(
    filterMissions([...MISSIONS, sansProjet], { project: [NO_PROJECT] }).map((mission) => mission.key),
    ['a#9'],
  )
  // Then les dépôts nommés ne la retiennent pas
  assert.deepEqual(filterMissions([...MISSIONS, sansProjet], { project: ['missions'] }).map((mission) => mission.key), ['a#1', 'a#3'])
  // Then l'option « sans projet » n'apparaît que si une ligne en a besoin
  assert.deepEqual(projectOptions(MISSIONS), [
    { id: 'alpha', name: 'Alpha' },
    { id: 'missions', name: 'Workspace missions' },
  ])
  assert.deepEqual(projectOptions([...MISSIONS, sansProjet]), [
    { id: 'alpha', name: 'Alpha' },
    { id: NO_PROJECT, name: 'No project' },
    { id: 'missions', name: 'Workspace missions' },
  ])
})

test('les filtres type, epic et projet prennent plusieurs valeurs, réunies en OU', () => {
  // Cocher deux valeurs dans une dimension élargit au lieu de restreindre : la
  // mission doit porter l'une ou l'autre, et les dimensions restent en ET.
  assert.deepEqual(filterMissions(MISSIONS, { type: ['bug', 'story'] }).map((m) => m.key), ['a#1', 'a#2', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { type: ['bug'] }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { epic: ['Workspace'] }).map((m) => m.key), ['a#1', 'a#3'])
  // Un épic nul n'est pas « une valeur » : cocher un épic ne ramène pas les
  // missions sans épic.
  assert.deepEqual(filterMissions(MISSIONS, { epic: ['Workspace', 'Autre'] }).map((m) => m.key), ['a#1', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { project: ['missions', 'alpha'] }).map((m) => m.key), ['a#1', 'a#2', 'a#3'])
  assert.deepEqual(
    filterMissions(MISSIONS, { project: ['missions'], type: ['story'], priority: ['urgent', 'low'] }).map((m) => m.key),
    ['a#3'],
  )
  assert.deepEqual(filterMissions(MISSIONS, { epic: ['Workspace'], query: 'cartes' }).map((m) => m.key), ['a#3'])
  // Une liste vide ne filtre rien, comme pour la priorité et le statut.
  assert.deepEqual(filterMissions(MISSIONS, { type: [], epic: [], project: [] }).map((m) => m.key), ['a#1', 'a#2', 'a#3'])
})

test('la priorité prend plusieurs valeurs, et un tableau vide ne filtre rien', () => {
  const withHigh = [...MISSIONS, { key: 'a#4', state: 'ready', type: 'story', priority: 'high', points: 1 }]
  assert.deepEqual(filterMissions(withHigh, { priority: ['urgent', 'high'] }).map((m) => m.key), ['a#1', 'a#4'])
  assert.deepEqual(filterMissions(withHigh, { priority: ['normal'] }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(withHigh, { priority: [] }).map((m) => m.key), ['a#1', 'a#2', 'a#3', 'a#4'])
  assert.deepEqual(filterMissions(withHigh, { priority: 'high' }).map((m) => m.key), ['a#4'])
  // La barre garde la liste telle que le widget la transporte, et la session
  // doit la retrouver au montage.
  assert.deepEqual(filterSnapshot({ filters: { priority: ['urgent', 'high'] } }).priority, ['urgent', 'high'])
})

test('le statut prend plusieurs valeurs, et un tableau vide ne filtre rien', () => {
  // Un widget du dashboard ouvre la liste sur tous ses états d'un coup : le
  // filtre doit donc accepter une liste, pas seulement une valeur.
  assert.deepEqual(filterMissions(MISSIONS, { state: ['ready', 'in-review'] }).map((m) => m.key), ['a#1', 'a#3'])
  assert.deepEqual(filterMissions(MISSIONS, { state: ['in-review'] }).map((m) => m.key), ['a#1'])
  // Aucun état coché, c'est la barre au repos : tout passe.
  assert.deepEqual(filterMissions(MISSIONS, { state: [] }).map((m) => m.key), ['a#1', 'a#2', 'a#3'])
  // « unknown » dans une liste garde les états hors workflow, sans les autres.
  const withUnknown = [...MISSIONS, { key: 'a#4', state: null, type: 'story', priority: null, points: null }]
  assert.deepEqual(
    filterMissions(withUnknown, { state: ['ready', 'unknown'] }).map((m) => m.key),
    ['a#3', 'a#4'],
  )
})

test('le filtre de statut isole un groupe et distingue unknown', () => {
  assert.deepEqual(filterMissions(MISSIONS, { state: 'in-review' }).map((m) => m.key), ['a#1'])
  assert.deepEqual(filterMissions(MISSIONS, { state: 'to-refine' }).map((m) => m.key), ['a#2'])
  assert.deepEqual(filterMissions(MISSIONS, { state: 'ready' }).map((m) => m.key), ['a#3'])

  const withUnknown = [...MISSIONS, { key: 'a#4', state: null, type: 'story', priority: null, points: null }]
  assert.deepEqual(filterMissions(withUnknown, { state: 'unknown' }).map((m) => m.key), ['a#4'])
  assert.deepEqual(filterMissions(withUnknown, { state: 'ready' }).map((m) => m.key), ['a#3'])
})

test('les statuts proposés suivent l’ordre du workflow, unknown en dernier', () => {
  assert.deepEqual(stateOptions(MISSIONS), ['to-refine', 'ready', 'in-review'])
  const withMore = [
    ...MISSIONS,
    { key: 'a#6', state: null },
  ]
  assert.deepEqual(stateOptions(withMore), ['to-refine', 'ready', 'in-review', 'unknown'])
  assert.deepEqual(
    stateOptions([...withMore, { key: 'a#7', state: 'ready-for-prod' }]),
    ['to-refine', 'ready', 'in-review', 'ready-for-prod', 'unknown'],
  )
  assert.deepEqual(stateOptions([]), [])
})

test('le seuil d’état couvre le travail en cours et sa relecture, bornes comprises', () => {
  // Given: la fenêtre du geste, du travail en cours à la relecture.
  const from = 'in-progress'
  const to = 'in-review'
  const parcours = ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done']

  // When: le seuil juge les six états du workflow, puis il ouvre la fenêtre
  // entière du parcours.
  const verdicts = parcours.map((state) => stateInRange(state, from, to))
  const ouverts = parcours.filter((state) => stateInRange(state, 'to-refine', 'done'))

  // Then: seuls les deux états de la fenêtre passent, et l'ordre lu est celui
  // du workflow : une fenêtre ouverte sur tout le parcours laisse tout passer.
  assert.deepEqual(verdicts, [false, false, true, true, false, false])
  assert.deepEqual(ouverts, parcours)
})

test('un état inconnu ne tombe dans aucune fenêtre', () => {
  // Given: des valeurs que le workflow ne connaît pas.
  const inconnus = [null, 'unknown', 'shipped']

  // When: le seuil les juge contre la fenêtre du geste, puis contre deux
  // bornes qui ne sont pas des états.
  const verdicts = inconnus.map((state) => stateInRange(state, 'in-progress', 'in-review'))
  const bornes = [
    stateInRange('in-progress', 'nowhere', 'in-review'),
    stateInRange('in-progress', 'in-progress', 'nowhere'),
  ]

  // Then: aucun n'est offert par défaut, et une borne hors liste ferme tout.
  assert.deepEqual(verdicts, [false, false, false])
  assert.deepEqual(bornes, [false, false])
})

test('done garde son groupe en dernier, mais la liste ouverte ne le relit jamais', () => {
  const done = [{ key: 'a#5', state: 'done', type: 'story', priority: 'high', project: 'missions' }]
  // L'onglet Missions est le périmètre ouvert : ni la recherche, ni un filtre
  // Statut nommant done ne font entrer une mission close.
  assert.deepEqual(filterMissions(done, {}), [])
  assert.deepEqual(filterMissions(done, { state: ['ready'] }), [])
  assert.deepEqual(filterMissions(done, { query: 'a#5' }), [])
  assert.deepEqual(filterMissions(done, { state: ['done'] }), [])
  // Le périmètre Done est le seul à demander explicitement les closes.
  assert.deepEqual(filterMissions(done, { allowDone: true }).map((m) => m.key), ['a#5'])
  assert.deepEqual(
    filterMissions([...MISSIONS, ...done], { allowDone: true }).map((m) => m.key),
    ['a#1', 'a#2', 'a#3', 'a#5'],
  )
  // Le groupe reste en dernier : la liste ouverte garde la file en tête.
  assert.deepEqual(groupByState([...MISSIONS, ...done]).map((g) => g.state), ['in-review', 'ready', 'to-refine', 'done'])
  // Missions ne propose pas done ; Done le propose, et lui seul.
  assert.deepEqual(stateOptions([...MISSIONS, ...done]), ['to-refine', 'ready', 'in-review'])
  assert.deepEqual(
    stateOptions([...MISSIONS, ...done], { allowDone: true }),
    ['to-refine', 'ready', 'in-review', 'done'],
  )
  // Une barre ouverte relue ne rouvre pas done ; celle de Done le garde.
  assert.equal(filterSnapshot({ filters: { state: ['done'] } }).state, null)
  assert.deepEqual(filterSnapshot({ filters: { state: ['done'] } }, { allowDone: true }).state, ['done'])
})

test('les deux barres de session sont séparées, y compris pour done', () => {
  const storage = memoryStorage()
  const doneBar = { query: 'close', filters: { ...EMPTY_FILTERS, state: ['done'], project: 'missions' } }
  writeFilterSnapshot(storage, doneBar, DONE_FILTERS_KEY, { allowDone: true })
  writeFilterSnapshot(storage, { query: 'open' })
  assert.deepEqual([...storage.entries.keys()].sort(), [DONE_FILTERS_KEY, FILTERS_KEY].sort())
  assert.deepEqual(readFilterSnapshot(storage), filterSnapshot({ query: 'open' }))
  assert.deepEqual(
    readFilterSnapshot(storage, DONE_FILTERS_KEY, { allowDone: true }),
    filterSnapshot(doneBar, { allowDone: true }),
  )
  // Vider la barre ouverte ne touche pas celle de Done, et réciproquement.
  writeFilterSnapshot(storage, {})
  assert.deepEqual(
    readFilterSnapshot(storage, DONE_FILTERS_KEY, { allowDone: true }),
    filterSnapshot(doneBar, { allowDone: true }),
  )
  writeFilterSnapshot(storage, {}, DONE_FILTERS_KEY, { allowDone: true })
  assert.equal(storage.entries.has(DONE_FILTERS_KEY), false)
})

test('l’ordre est fixe : priorité décroissante, puis points croissants, puis clé', () => {
  // Given six missions : deux urgentes, deux normales, deux à un point.
  const missions = [
    { key: 'm#5', priority: 'low', points: 3 },
    { key: 'm#1', priority: 'urgent', points: 5 },
    { key: 'm#4', priority: 'normal', points: 1 },
    { key: 'm#3', priority: 'high', points: 2 },
    { key: 'm#6', priority: 'normal', points: 1 },
    { key: 'm#2', priority: 'urgent', points: 1 },
  ]

  // When la liste est triée, sans réglage à passer.
  const ordered = sortMissions(missions)

  // Then l'urgence passe devant, les points départagent dans une priorité, et
  // la clé sépare deux missions de même priorité et de mêmes points.
  assert.deepEqual(ordered.map((mission) => mission.key), ['m#2', 'm#1', 'm#3', 'm#4', 'm#6', 'm#5'])
  // Then l'entrée n'est pas mutée : le tri travaille sur une copie.
  assert.deepEqual(missions.map((mission) => mission.key), ['m#5', 'm#1', 'm#4', 'm#3', 'm#6', 'm#2'])
})

test('les missions sans priorité ni points connus ferment la liste', () => {
  // Given une priorité absente, une priorité inconnue, des points nuls,
  // illisibles, et zéro — qui reste un point connu.
  const missions = [
    { key: 'b#1', priority: 'low', points: 3 },
    { key: 'b#3', priority: 'blocker', points: 1 },
    { key: 'b#4', priority: 'high', points: null },
    { key: 'b#2', priority: null, points: 1 },
    { key: 'b#5', priority: 'high', points: 'abc' },
    { key: 'b#6', priority: 'high', points: 0 },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then `high` ouvre sur `0 pt`, les points manquants suivent, `low` vient
  // après, et les priorités inconnues ferment le tout.
  assert.deepEqual(ordered, ['b#6', 'b#4', 'b#5', 'b#1', 'b#2', 'b#3'])
})

test('isWaitingOnBlock ignore une mission close', () => {
  // Given une bloquée ouverte, une bloquée close et une ouverte actionnable.
  const open = { state: 'ready', blocked: true }
  const closed = { state: 'done', blocked: true }
  const workable = { state: 'ready' }

  // When le prédicat les lit.
  const waiting = [open, closed, workable].map(isWaitingOnBlock)

  // Then seule la bloquée ouverte attend.
  assert.deepEqual(waiting, [true, false, false])
})

test('blockerKeys ne lit que les clés des missions bloquées visibles', () => {
  // Given une raison qui cite une clé connue, sa propre clé et une inconnue.
  const mission = { key: 'MIS-5', blockedReason: { state: 'found', body: 'Bloquée par mis-7 puis MIS-5, hors MIS-99' } }
  const known = ['MIS-7', 'MIS-5']

  // When les clés sont extraites pour les bloquées visibles.
  const keys = blockerKeys(mission, known)
  const unread = blockerKeys({ key: 'MIS-5', blockedReason: { state: 'empty' } }, known)

  // Then la clé connue sort en majuscules, la sienne et l'inconnue sont
  // écartées, et une raison non lue ne crée aucune arête.
  assert.deepEqual(keys, ['MIS-7'])
  assert.deepEqual(unread, [])
})

test('une mission bloquée ferme la liste', () => {
  // Given une mission urgente bloquée et une mission basse actionnable.
  const missions = [
    { key: 'MIS-1', state: 'ready', priority: 'urgent', points: 1, blocked: true },
    { key: 'MIS-2', state: 'ready', priority: 'low', points: 8 },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then l'actionnable ouvre, quels que soient l'urgence et les points de la
  // bloquée.
  assert.deepEqual(ordered, ['MIS-2', 'MIS-1'])
})

test('l’ordre actuel reste inchangé à l’intérieur de chaque groupe', () => {
  // Given quatre missions actionnables et deux bloquées, dans le désordre.
  const missions = [
    { key: 'MIS-1', state: 'ready', priority: 'high', points: 3 },
    { key: 'MIS-2', state: 'ready', priority: 'low', points: 1 },
    { key: 'MIS-3', state: 'ready', priority: 'urgent', points: 5 },
    { key: 'MIS-4', state: 'ready', priority: 'normal', points: 2 },
    { key: 'MIS-5', state: 'ready', priority: 'low', points: 1, blocked: true },
    { key: 'MIS-6', state: 'ready', priority: 'urgent', points: 2, blocked: true },
  ]
  const priorities = ['urgent', 'high', 'normal', 'low']
  const priorityRank = (mission) => {
    const index = priorities.indexOf(mission.priority)
    return index === -1 ? priorities.length : index
  }
  const pointsRank = (mission) => {
    if (mission.points === null || mission.points === undefined || mission.points === '') return Infinity
    const value = Number(mission.points)
    return Number.isFinite(value) ? value : Infinity
  }
  const replica = (items) =>
    [...items].sort(
      (a, b) => priorityRank(a) - priorityRank(b) || pointsRank(a) - pointsRank(b) || String(a.key).localeCompare(String(b.key)),
    )

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)
  const workable = missions.filter((mission) => !isWaitingOnBlock(mission))
  const waiting = missions.filter(isWaitingOnBlock)

  // Then chaque groupe garde exactement l'ordre de la réplique du comparateur.
  assert.deepEqual(ordered, [...replica(workable), ...replica(waiting)].map((mission) => mission.key))
})

test('une mission bloquée attend celle que sa raison nomme, et la contrainte se propage', () => {
  // Given A bloquée par B, B bloquée par C, C bloquée sans raison, toutes
  // visibles et triées A, B, C par le comparateur actuel.
  const missions = [
    {
      key: 'MIS-1',
      state: 'ready',
      priority: 'urgent',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-2 : contrat non signé' },
    },
    {
      key: 'MIS-2',
      state: 'ready',
      priority: 'high',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-3 : maquette absente' },
    },
    { key: 'MIS-3', state: 'ready', priority: 'low', blocked: true },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then C passe avant B, qui passe avant A.
  assert.deepEqual(ordered, ['MIS-3', 'MIS-2', 'MIS-1'])
})

test('une clé absente des missions bloquées visibles ne déplace rien', () => {
  // Given une mission bloquée urgente qui cite une clé inconnue, et une basse.
  const missions = [
    {
      key: 'MIS-1',
      state: 'ready',
      priority: 'urgent',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-9 : hors du panneau' },
    },
    { key: 'MIS-2', state: 'ready', priority: 'low', blocked: true },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then la clé inconnue ne crée aucune arête et l'ordre de base demeure.
  assert.deepEqual(ordered, ['MIS-1', 'MIS-2'])
})

test('la clé d’une mission done ne retient pas une mission bloquée', () => {
  // Given une mission done urgente, une bloquée urgente qui la cite, et une
  // bloquée basse.
  const missions = [
    {
      key: 'MIS-1',
      state: 'ready',
      priority: 'urgent',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-9 : livraison close' },
    },
    { key: 'MIS-2', state: 'ready', priority: 'low', blocked: true },
    { key: 'MIS-9', state: 'done', priority: 'urgent' },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then Done reste hors du groupe bloqué, et la bloquée garde l'ordre de base.
  assert.deepEqual(ordered, ['MIS-9', 'MIS-1', 'MIS-2'])
})

test('une mission qui cite sa propre clé garde sa place de base', () => {
  // Given une mission bloquée urgente dont la raison la nomme elle-même, et
  // une bloquée basse.
  const missions = [
    {
      key: 'MIS-1',
      state: 'ready',
      priority: 'urgent',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-1 : dépendance circulaire' },
    },
    { key: 'MIS-2', state: 'ready', priority: 'low', blocked: true },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then sa propre clé ne crée aucune arête.
  assert.deepEqual(ordered, ['MIS-1', 'MIS-2'])
})

test('un cycle de blocages ne perd ni ne duplique aucune mission', () => {
  // Given A bloquée par B, B bloquée par A, et C actionnable.
  const missions = [
    {
      key: 'MIS-1',
      state: 'ready',
      priority: 'urgent',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-2' },
    },
    {
      key: 'MIS-2',
      state: 'ready',
      priority: 'normal',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-1' },
    },
    { key: 'MIS-3', state: 'ready', priority: 'low' },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then C ouvre, le cycle garde l'ordre de base, et chaque clé sort une fois.
  assert.deepEqual(ordered, ['MIS-3', 'MIS-1', 'MIS-2'])
  assert.equal(new Set(ordered).size, ordered.length)
})

test('une raison absente, vide ou indisponible ne crée aucune arête', () => {
  // Given trois missions bloquées sans raison lisible, une raison vide, et
  // une actionnable.
  const missions = [
    { key: 'MIS-1', state: 'ready', priority: 'urgent', blocked: true },
    { key: 'MIS-2', state: 'ready', priority: 'normal', blocked: true, blockedReason: { state: 'empty' } },
    { key: 'MIS-3', state: 'ready', priority: 'low', blocked: true, blockedReason: { state: 'unavailable' } },
    { key: 'MIS-5', state: 'ready', priority: 'low', blocked: true, blockedReason: { state: 'found', body: '' } },
    { key: 'MIS-4', state: 'ready', priority: 'low' },
  ]

  // When la liste est triée.
  const ordered = sortMissions(missions).map((mission) => mission.key)

  // Then les bloquées restent dans le groupe bloqué, dans l'ordre de base, et
  // le tri ne jette pas.
  assert.deepEqual(ordered, ['MIS-4', 'MIS-1', 'MIS-2', 'MIS-3', 'MIS-5'])
})

test('les missions done ignorent le blocage : l’ordre de Done ne bouge pas', () => {
  // Given deux missions closes, l'une urgente encore marquée bloquée.
  const missions = [
    { key: 'MIS-1', state: 'done', priority: 'low' },
    {
      key: 'MIS-2',
      state: 'done',
      priority: 'urgent',
      blocked: true,
      blockedReason: { state: 'found', body: 'Bloquée par MIS-1' },
    },
  ]

  // When la liste est triée puis groupée comme l'onglet Done.
  const ordered = sortMissions(missions)
  const groups = groupByState(ordered)

  // Then le comparateur actuel décide seul, et le groupe Done est inchangé.
  assert.deepEqual(ordered.map((mission) => mission.key), ['MIS-2', 'MIS-1'])
  assert.deepEqual(
    groups.map((group) => [group.state, group.missions.map((mission) => mission.key)]),
    [['done', ['MIS-2', 'MIS-1']]],
  )
})

test('une mission bloquée épinglée ouvre la liste', () => {
  // Given une mission bloquée épinglée et deux actionnables.
  const missions = [
    { key: 'MIS-1', state: 'ready', priority: 'urgent', blocked: true, pinned: true },
    { key: 'MIS-2', state: 'ready', priority: 'high' },
    { key: 'MIS-3', state: 'ready', priority: 'low' },
  ]

  // When le tri puis la partition des épingles passent.
  const ordered = pinnedFirst(sortMissions(missions)).map((mission) => mission.key)

  // Then l'épingle passe devant, même bloquée, et les autres gardent l'ordre.
  assert.deepEqual(ordered, ['MIS-1', 'MIS-2', 'MIS-3'])
})

test('deux épinglées gardent l’ordre du tri, bloquée comprise', () => {
  // Given une épingle actionnable, une épingle bloquée et deux non épinglées.
  const missions = [
    { key: 'MIS-1', state: 'ready', priority: 'urgent' },
    { key: 'MIS-2', state: 'ready', priority: 'low', blocked: true, pinned: true },
    { key: 'MIS-3', state: 'ready', priority: 'normal', pinned: true },
    { key: 'MIS-4', state: 'ready', priority: 'normal', blocked: true },
  ]

  // When le tri puis la partition des épingles passent.
  const ordered = pinnedFirst(sortMissions(missions)).map((mission) => mission.key)

  // Then les épinglées passent devant dans l'ordre du tri, et les autres
  // ferment la liste.
  assert.deepEqual(ordered, ['MIS-3', 'MIS-2', 'MIS-1', 'MIS-4'])
})

test('le tri ne mute pas son entrée, rend une permutation et reste déterministe', () => {
  // Given une entrée gelée dont une bloquée attend une autre.
  const missions = Object.freeze([
    Object.freeze({ key: 'MIS-1', state: 'ready', priority: 'low' }),
    Object.freeze({
      key: 'MIS-2',
      state: 'ready',
      priority: 'urgent',
      blocked: true,
      blockedReason: Object.freeze({ state: 'found', body: 'Bloquée par MIS-3' }),
    }),
    Object.freeze({ key: 'MIS-3', state: 'ready', priority: 'normal', blocked: true }),
  ])

  // When la liste est triée deux fois sur la même entrée.
  const first = sortMissions(missions).map((mission) => mission.key)
  const second = sortMissions(missions).map((mission) => mission.key)

  // Then la bloquée attend, chaque clé sort une fois, et les deux appels
  // rendent le même ordre sans toucher l'entrée.
  assert.deepEqual(first, ['MIS-1', 'MIS-3', 'MIS-2'])
  assert.deepEqual(second, first)
  assert.deepEqual([...first].sort(), missions.map((mission) => mission.key).sort())
  assert.deepEqual(missions.map((mission) => mission.key), ['MIS-1', 'MIS-2', 'MIS-3'])
})

test('pinnedFirst remonte les épingles sans changer l’ordre relatif', () => {
  // Given quatre missions dont deux épinglées.
  const missions = [
    { key: 'a#1', pinned: false },
    { key: 'a#2', pinned: true },
    { key: 'a#3', pinned: false },
    { key: 'a#4', pinned: true },
  ]

  // When la partition les sépare.
  const ordered = pinnedFirst(missions)

  // Then les épingles passent devant, chacune à sa place relative, et l'entrée
  // n'est pas mutée.
  assert.deepEqual(ordered.map((mission) => mission.key), ['a#2', 'a#4', 'a#1', 'a#3'])
  assert.deepEqual(missions.map((mission) => mission.key), ['a#1', 'a#2', 'a#3', 'a#4'])
})

test('pinnedFirst se compose avec le tri : deux épingles gardent l’ordre du tri', () => {
  const missions = [
    { key: 'a#1', priority: 'low', pinned: true },
    { key: 'a#2', priority: 'high', pinned: false },
    { key: 'a#3', priority: 'urgent', pinned: true },
  ]

  assert.deepEqual(
    pinnedFirst(sortMissions(missions)).map((mission) => mission.key),
    ['a#3', 'a#1', 'a#2'],
  )
})

test('pinnedFirst lit le drapeau ou un prédicat, et ne devine jamais', () => {
  // Given des entrées dont le drapeau vit sur la ligne portée.
  const entries = [{ row: { key: 'b', pinned: true } }, { row: { key: 'a' } }, { row: { key: 'c', pinned: true } }]

  // Then le prédicat du client lit la ligne, le défaut lit le drapeau absent.
  assert.deepEqual(pinnedFirst(entries, (entry) => entry.row.pinned === true).map((entry) => entry.row.key), ['b', 'c', 'a'])
  assert.deepEqual(pinnedFirst([{ key: 'x' }, { key: 'y' }]).map((item) => item.key), ['x', 'y'])
})

test('respectBlockers place chaque mission après ses bloqueuses visibles', () => {
  // Given une mission urgente en tête du tri, retenue par deux dépendances.
  const missions = [
    { key: 'MIS-3', state: 'ready', priority: 'urgent', blockers: [{ key: 'MIS-2' }, { key: 'MIS-1' }] },
    { key: 'MIS-2', state: 'ready', priority: 'low' },
    { key: 'MIS-1', state: 'ready', priority: 'normal' },
  ]

  // When la contrainte est appliquée.
  const ordered = respectBlockers(missions)

  // Then les bloqueuses passent dans leur ordre de base, puis la mission
  // retenue, et l'entrée n'est pas mutée.
  assert.deepEqual(ordered.map((mission) => mission.key), ['MIS-2', 'MIS-1', 'MIS-3'])
  assert.deepEqual(missions.map((mission) => mission.key), ['MIS-3', 'MIS-2', 'MIS-1'])
})

test('un bloqueur hors de la liste ne contraint rien', () => {
  // Given une mission qui cite une clé filtrée et une mission libre.
  const missions = [
    { key: 'MIS-1', state: 'ready', blockers: [{ key: 'MIS-9', state: 'in-progress' }] },
    { key: 'MIS-2', state: 'ready' },
  ]

  // When la contrainte est appliquée.
  const ordered = respectBlockers(missions).map((mission) => mission.key)

  // Then l'ordre de base reste tel quel.
  assert.deepEqual(ordered, ['MIS-1', 'MIS-2'])
})

test('respectBlockers rend une permutation et garde l’ordre d’un cycle', () => {
  // Given deux missions qui se retiennent l'une l'autre, et une libre.
  const missions = [
    { key: 'MIS-1', state: 'ready', blockers: [{ key: 'MIS-2' }] },
    { key: 'MIS-2', state: 'ready', blockers: [{ key: 'MIS-1' }] },
    { key: 'MIS-3', state: 'ready' },
  ]

  // When la contrainte est appliquée.
  const ordered = respectBlockers(missions).map((mission) => mission.key)

  // Then aucune mission n'est perdue ni doublée, et le cycle garde son ordre.
  assert.deepEqual([...ordered].sort(), ['MIS-1', 'MIS-2', 'MIS-3'])
  assert.ok(ordered.indexOf('MIS-1') < ordered.indexOf('MIS-2'))
})

test('épingler une mission bloquée ne la fait pas passer avant son bloqueur', () => {
  // Given une mission épinglée que retient une mission libre.
  const missions = [
    { key: 'MIS-1', state: 'ready', pinned: true, blockers: [{ key: 'MIS-2' }] },
    { key: 'MIS-2', state: 'ready' },
  ]

  // When la contrainte passe après les épingles.
  const ordered = respectBlockers(pinnedFirst(missions)).map((mission) => mission.key)

  // Then la règle prime sur l'épingle.
  assert.deepEqual(ordered, ['MIS-2', 'MIS-1'])
})

test('une section dont une mission attend une autre section passe derrière elle', () => {
  // Given une mission ready retenue par une mission to-refine.
  const groups = groupByState([
    { key: 'a#1', state: 'ready', blockers: [{ key: 'a#2', state: 'to-refine' }] },
    { key: 'a#2', state: 'to-refine' },
    { key: 'a#3', state: 'in-progress' },
  ])

  // Then la section qui porte le bloqueur remonte devant la section retenue.
  assert.deepEqual(groups.map((group) => group.state), ['in-progress', 'to-refine', 'ready'])
})

test('une section retenue par un bloqueur masqué ne bouge pas', () => {
  // Given une mission ready retenue par une mission to-refine absente de la
  // liste filtrée.
  const groups = groupByState([
    { key: 'a#1', state: 'ready', blockers: [{ key: 'a#9', state: 'to-refine' }] },
    { key: 'a#2', state: 'in-progress' },
  ])

  // Then l'ordre des sections reste celui du workflow.
  assert.deepEqual(groups.map((group) => group.state), ['in-progress', 'ready'])
})

test('un bloqueur masqué ne déplace pas sa section, même portée par une autre mission', () => {
  // Given une mission in-progress retenue par une mission ready absente de la
  // liste filtrée, et une mission ready visible qui porte sa section.
  const groups = groupByState([
    { key: 'a#1', state: 'in-progress', blockers: [{ key: 'a#9', state: 'ready' }] },
    { key: 'a#2', state: 'ready' },
  ])

  // Then l'arête n'existe pas : la section retenue garde sa place de workflow.
  assert.deepEqual(groups.map((group) => group.state), ['in-progress', 'ready'])
})

test('le filtre Missing ne garde que les tickets à qui il manque un champ', () => {
  assert.deepEqual(filterMissions(MISSIONS, { missing: 'any' }).map((m) => m.key), ['a#2'])

  const complete = [
    ...MISSIONS,
    { key: 'a#4', points: 0, priority: 'urgent', epic: 'Workspace', type: 'bug' },
    { key: 'a#6', points: 0.5, priority: 'low', epic: 'Workspace', type: 'story' },
  ]
  assert.deepEqual(filterMissions(complete, { missing: 'any' }).map((m) => m.key), ['a#2'])

  const sparse = [...MISSIONS, { key: 'a#5', points: null, priority: null, epic: null, type: null }]
  assert.deepEqual(filterMissions(sparse, { missing: 'any' }).map((m) => m.key), ['a#2', 'a#5'])
  assert.equal(filterMissions(complete, { missing: null }).length, complete.length)
})

test('une recherche vide ne filtre rien', () => {
  assert.equal(filterMissions(MISSIONS).length, 3)
  assert.equal(filterMissions(MISSIONS, { query: '   ' }).length, 3)
})

test('les options viennent des missions chargées, sans doublon et triées', () => {
  assert.deepEqual(epicOptions(MISSIONS), ['Workspace'])
  assert.deepEqual(priorityOptions(MISSIONS), ['urgent', 'normal', 'low'])
  assert.deepEqual(projectOptions(MISSIONS), [
    { id: 'alpha', name: 'Alpha' },
    { id: 'missions', name: 'Workspace missions' },
  ])
  assert.deepEqual(epicOptions([]), [])
  assert.deepEqual(priorityOptions([]), [])
  assert.deepEqual(projectOptions([]), [])
})

test('un filtre actif est détecté, le type et le statut compris', () => {
  assert.equal(
    hasActiveFilters({ type: null, state: null, epic: null, priority: null, project: null }),
    false,
  )
  assert.equal(hasActiveFilters({ type: 'bug', state: null, epic: null, priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: 'ready', epic: null, priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: 'Workspace', priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: null, priority: 'normal', project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: null, priority: null, project: 'missions' }), true)
  assert.equal(hasActiveFilters({ type: null, state: null, epic: null, priority: null, project: null, missing: 'any' }), true)
  // Une liste d'états compte quand elle porte quelque chose ; vide, elle est
  // le repos, pas un filtre qui ne rendrait rien.
  assert.equal(hasActiveFilters({ type: null, state: ['ready'], epic: null, priority: null, project: null }), true)
  assert.equal(hasActiveFilters({ type: null, state: [], epic: null, priority: null, project: null }), false)
})

test('les groupes suivent l’ordre d’attention, l’inconnu en dernier', () => {
  const groupes = groupByState([
    ...MISSIONS,
    { key: 'a#5', state: 'in-progress' },
    { key: 'a#6', state: 'ready-for-prod' },
    { key: 'a#4', state: null },
  ])
  assert.deepEqual(groupes.map((g) => g.state), ['in-progress', 'in-review', 'ready', 'to-refine', 'ready-for-prod', 'unknown'])
  assert.equal(groupes[0].missions.length, 1)
  assert.deepEqual(groupes[4].missions.map((m) => m.key), ['a#6'])
})

test('l’âge relatif reste court et lisible', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  assert.equal(relativeAge('2026-11-10T11:59:40Z', now), 'now')
  assert.equal(relativeAge('2026-11-10T11:30:00Z', now), '30 min')
  assert.equal(relativeAge('2026-11-10T08:00:00Z', now), '4 h')
  assert.equal(relativeAge('2026-11-08T12:00:00Z', now), '2 d')
  assert.equal(relativeAge(null, now), '')
})

test('la raison d’un blocage écrit s’affiche tout de suite, sans nouvelle lecture', () => {
  const now = Date.parse('2026-11-12T21:25:58Z')
  assert.deepEqual(
    blockedReasonAfterWrite({
      next: true,
      message: '  Attente du ticket de données.  ',
      comment: 'https://github.com/daedalforge/missions/issues/144#issuecomment-9',
      now,
    }),
    {
      state: 'found',
      author: null,
      body: 'Attente du ticket de données.',
      createdAt: '2026-11-12T21:25:58.000Z',
      url: 'https://github.com/daedalforge/missions/issues/144#issuecomment-9',
    },
  )
  // A reason the tracker did not answer with a URL keeps the text alone.
  assert.equal(blockedReasonAfterWrite({ next: true, message: 'Attente.', now }).url, null)
  // Unblocking clears the field: the next read will bring the tracker's answer.
  assert.equal(blockedReasonAfterWrite({ next: false, message: 'Attente.' }), null)
})

test('une session exige un projet, un état unique, une branche et une base déclarées', () => {
  assert.equal(executionBlocker({ project: 'missions', branch: 'gh-41', base: 'main' }), null)
  assert.equal(executionBlocker({ project: 'missions', branch: 'gh-41', base: 'main', stateConflict: [] }), null)
  assert.equal(
    executionBlocker({ project: 'missions', branch: 'gh-41', base: 'main', stateConflict: ['in-review', 'ready-for-prod'] }),
    'state labels conflict (in-review, ready-for-prod), keep one',
  )
  assert.equal(
    executionBlocker({ branch: 'gh-41', base: 'main' }),
    'project is not declared, choose the repository that works this mission',
  )
  assert.equal(
    executionBlocker({ project: 'missions', branch: 'gh-41' }),
    'base branch is not declared, set it below or in the mission folder',
  )
  assert.equal(
    executionBlocker({ project: 'missions', base: 'main' }),
    'branch is not declared, set it below or in the mission folder',
  )
  assert.equal(
    executionBlocker({ project: 'missions', branch: 'gh-41', base: 'main', state: 'done' }),
    'mission is done: a closed mission plays no session',
  )
  assert.equal(executionBlocker({}), 'project is not declared, choose the repository that works this mission')
  assert.equal(
    executionBlocker({ branch: null, base: null }),
    'project is not declared, choose the repository that works this mission',
  )
  assert.equal(executionBlocker(), 'project is not declared, choose the repository that works this mission')
})

test('une session libre ne se ferme que sur done, jamais sur un champ manquant', () => {
  // Une session libre n'exécute rien : elle s'ouvre en cadrage, avant la
  // branche, et un conflit d'états ne la concerne pas.
  for (const state of ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod']) {
    assert.equal(freeSessionBlocker({ state }), null, `session libre ouverte pour ${state}`)
    assert.equal(freeSessionBlocker({ state, branch: null, base: null }), null, `sans branche pour ${state}`)
  }
  assert.equal(
    freeSessionBlocker({ state: 'in-review', stateConflict: ['in-review', 'ready-for-prod'] }),
    null,
    'un conflit d’états ne ferme pas une session qui n’écrit rien',
  )
  assert.equal(freeSessionBlocker({}), null)
  assert.equal(freeSessionBlocker(), null)
  assert.equal(
    freeSessionBlocker({ state: 'done', branch: 'fix/mis-42', base: 'main' }),
    'mission is done: a closed mission plays no session',
  )
})

test('chaque statut nomme l’étape de son workflow, et done n’en a pas', () => {
  assert.equal(missionStep({ state: 'to-refine' }), 'cadrage')
  assert.equal(missionStep({ state: 'ready' }), 'exécution')
  // La revue renvoie en in-progress : c'est encore l'exécution qu'on reprend.
  assert.equal(missionStep({ state: 'in-progress' }), 'exécution')
  assert.equal(missionStep({ state: 'in-review' }), 'revue')
  assert.equal(missionStep({ state: 'ready-for-prod' }), 'clôture')
  assert.equal(missionStep({ state: 'done' }), null)
  // Un statut hors des six états ne joue aucune étape : la session relit le ticket.
  assert.equal(missionStep({ state: 'blocked' }), null)
  assert.equal(missionStep({}), null)
  // Chaque étape a son brief : le prompt ne retombe jamais sur du vide.
  for (const step of Object.values(STEP_BY_STATE)) {
    assert.ok(STEP_BRIEFS[step], `brief missing for ${step}`)
  }
})

test('le nom de branche suggéré suit le type et la clé de la mission', () => {
  assert.equal(suggestBranch({ key: 'MIS-1', type: 'story' }), 'feat/mis-1')
  assert.equal(suggestBranch({ key: 'MIS-1', type: 'bug' }), 'fix/mis-1')
  assert.equal(suggestBranch({ key: 'MIS-1', type: 'epic' }), 'epic/mis-1')
  assert.equal(suggestBranch({ key: ' EX-1184 ', type: null }), 'feat/ex-1184')
  assert.equal(suggestBranch({ key: 'MIS-1' }), 'feat/mis-1')
  assert.equal(suggestBranch({}), '')
})

test('une branche déclarée prime sur le nom suggéré', () => {
  assert.equal(branchFieldValue({ key: 'MIS-1', type: 'story' }), 'feat/mis-1')
  assert.equal(branchFieldValue({ key: 'MIS-1', type: 'bug', branch: 'fix/mis-1' }), 'fix/mis-1')
  assert.equal(branchFieldValue({ key: 'MIS-1', type: 'story', branch: '' }), 'feat/mis-1')
  assert.equal(branchFieldValue({}), '')
})

test('la checklist se lit en blocs : titres, cases et texte', () => {
  const source = [
    '# Checklist — MIS-70',
    '',
    '## Cadrage',
    '',
    '- [x] Le cadrage est validé. — *commentaire* : #issuecomment-1',
    '- [ ] La branche est ouverte.',
    '- [~] Le rendu visuel a été joué.',
    '',
    'Une phrase de contexte.',
    '- une puce libre',
  ].join('\n')

  const { blocks, counts } = parseChecklist(source)
  assert.deepEqual(counts, { total: 3, checked: 1, partial: 1, open: 1 })
  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'heading', 'item', 'item', 'item', 'text', 'bullet',
  ])
  assert.deepEqual(blocks[2], { type: 'item', state: 'checked', text: 'Le cadrage est validé. — *commentaire* : #issuecomment-1' })
  assert.equal(blocks[3].state, 'open')
  assert.equal(blocks[4].state, 'partial')
  assert.equal(blocks[0].level, 1)
})

test('une checklist vide ou absente ne casse pas le rendu', () => {
  assert.deepEqual(parseChecklist(''), { blocks: [], counts: { total: 0, checked: 0, partial: 0, open: 0 } })
  assert.deepEqual(parseChecklist(null), { blocks: [], counts: { total: 0, checked: 0, partial: 0, open: 0 } })
  const { blocks } = parseChecklist('- [X] Majuscule acceptée.\r\n')
  assert.equal(blocks[0].state, 'checked')
})

test('l’instantané de la barre garde recherche et filtres', () => {
  const bar = {
    query: 'panneau',
    filters: { type: ['bug'], state: ['ready'], epic: ['Workspace'], priority: ['urgent'], project: ['missions'], missing: 'any' },
  }
  const snapshot = filterSnapshot(bar)
  assert.deepEqual(snapshot, {
    query: 'panneau',
    type: ['bug'],
    state: ['ready'],
    epic: ['Workspace'],
    priority: ['urgent'],
    project: ['missions'],
    missing: 'any',
  })
  // L'instantané revient en deux états : la barre telle que le panneau la tient.
  assert.deepEqual(filterBarState(snapshot), bar)
  // Une barre vide n'a rien d'actif : le panneau la traite comme au repos.
  assert.equal(hasActiveFilters(filterBarState(filterSnapshot({})).filters), false)
})

test('une valeur unique rangée par une barre d’avant la liste se relit en liste', () => {
  // La session d'avant MIS-94 garde un statut seul, et celle d'avant MIS-99 une
  // priorité seule : les relire ne doit ni les perdre ni les rendre en texte,
  // sinon le menu ne les cocherait pas.
  const legacy = filterSnapshot({ filters: { type: 'story', state: 'ready', epic: 'Workspace', project: 'missions' } })
  assert.deepEqual(legacy.type, ['story'])
  assert.deepEqual(legacy.state, ['ready'])
  assert.deepEqual(legacy.epic, ['Workspace'])
  assert.deepEqual(legacy.project, ['missions'])
  assert.deepEqual(filterBarState({ state: 'ready' }).filters.state, ['ready'])
  const legacyPriority = filterSnapshot({ filters: { priority: 'high' } })
  assert.deepEqual(legacyPriority.priority, ['high'])
  assert.deepEqual(filterBarState({ priority: 'high' }).filters.priority, ['high'])
  // Une liste relue est rangée selon le panneau, pas selon l'ordre du clic :
  // deux sessions qui ont coché les mêmes cases gardent le même instantané.
  assert.deepEqual(filterSnapshot({ filters: { type: ['story', 'bug'], state: ['ready', 'to-refine'] } }).type, ['bug', 'story'])
  assert.deepEqual(filterSnapshot({ filters: { state: ['ready', 'to-refine'] } }).state, ['to-refine', 'ready'])
})

test('un instantané ne retient que ce que la barre peut sélectionner', () => {
  const snapshot = filterSnapshot({
    query: 42,
    filters: { type: 'feat', state: 'cancelled', epic: '  Workspace  ', priority: '', project: 7, missing: 'yes' },
  })
  // Type et état hors vocabulaire, priorité vide, projet non textuel : la barre
  // ne peut pas les afficher, ils tombent au lieu d'être restaurés.
  assert.deepEqual(snapshot, {
    query: '',
    type: null,
    state: null,
    epic: ['Workspace'],
    priority: null,
    project: null,
    missing: null,
  })
  // L'épic d'une mission est du texte libre : il reste tel quel, en liste.
  assert.deepEqual(filterSnapshot({ filters: { epic: ['Hors périmètre'] } }).epic, ['Hors périmètre'])
})

test('une barre héritée qui porte un tri se relit sans lui', () => {
  // Given une barre de session d'avant MIS-18, avec sa recherche, ses filtres
  // et le tri qu'elle offrait encore.
  const stored = JSON.stringify({
    query: 'panneau',
    type: ['bug'],
    state: ['ready'],
    project: ['missions'],
    sort: 'points',
  })
  const expected = {
    query: 'panneau',
    type: ['bug'],
    state: ['ready'],
    epic: null,
    priority: null,
    project: ['missions'],
    missing: null,
  }

  // When la barre est relue par la session et par le panneau.
  assert.deepEqual(parseFilterSnapshot(stored), expected)
  assert.deepEqual(
    filterBarState(expected),
    {
      query: 'panneau',
      filters: { type: ['bug'], state: ['ready'], epic: null, priority: null, project: ['missions'], missing: null },
    },
  )

  // Then le tri n'a plus de clé : l'ordre est celui de la liste, pas une
  // préférence de session.
  assert.equal('sort' in parseFilterSnapshot(stored), false)
  assert.deepEqual(Object.keys(filterBarState(expected)).sort(), ['filters', 'query'])
})

test('un contenu illisible redonne la barre par défaut', () => {
  const empty = filterSnapshot({})
  for (const raw of [null, undefined, '', '   ', 'pas du json', '[]', '"texte"', 'null', '{}']) {
    assert.deepEqual(parseFilterSnapshot(raw), empty, `contenu ${String(raw)}`)
  }
  // Un instantané partiel garde ce qu'il porte et complète le reste.
  assert.deepEqual(
    parseFilterSnapshot(JSON.stringify({ query: 'abc', type: 'story' })),
    { ...empty, query: 'abc', type: ['story'] },
  )
})

test('la session écrit la barre et retire la clé quand elle est vide', () => {
  const storage = memoryStorage()
  const bar = { query: 'panneau', filters: { ...EMPTY_FILTERS, project: 'missions' } }

  writeFilterSnapshot(storage, bar)
  assert.deepEqual([...storage.entries.keys()], [FILTERS_KEY])
  assert.deepEqual(JSON.parse(storage.entries.get(FILTERS_KEY)), filterSnapshot(bar))
  assert.deepEqual(readFilterSnapshot(storage), filterSnapshot(bar))

  // Effacer la barre ne laisse pas de clé derrière elle : le prochain montage
  // repart du repos, pas d'une sélection vide.
  writeFilterSnapshot(storage, { query: '   ', filters: { ...EMPTY_FILTERS } })
  assert.equal(storage.entries.has(FILTERS_KEY), false)
  assert.deepEqual(readFilterSnapshot(storage), filterSnapshot({}))
})

test('un stockage absent ou en panne laisse la barre par défaut', () => {
  assert.deepEqual(readFilterSnapshot(undefined), filterSnapshot({}))
  assert.deepEqual(readFilterSnapshot({}), filterSnapshot({}))

  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.deepEqual(readFilterSnapshot(throwing), filterSnapshot({}))
  assert.doesNotThrow(() => writeFilterSnapshot(throwing, { query: 'x' }))
  assert.doesNotThrow(() => writeFilterSnapshot(throwing, {}))
  // Pas de stockage du tout : écrire est un no-op, pas une erreur.
  assert.doesNotThrow(() => writeFilterSnapshot(null, { query: 'x' }))
})

test('la session retient l’onglet ouvert, et rien de plus', () => {
  const tabs = ['dashboard', 'missions']
  const storage = memoryStorage()

  // Rien de rangé : le panneau ouvre sur le premier onglet, le dashboard.
  assert.equal(readTab(storage, tabs), 'dashboard')
  assert.equal(storage.entries.has(TAB_KEY), false)

  writeTab(storage, 'missions', tabs)
  assert.deepEqual([...storage.entries.keys()], [TAB_KEY])
  assert.equal(readTab(storage, tabs), 'missions')

  // Revenir au repos ne laisse pas de clé : la prochaine session rouvre sur le
  // dashboard sans avoir à lire une valeur par défaut.
  writeTab(storage, 'dashboard', tabs)
  assert.equal(storage.entries.has(TAB_KEY), false)
  assert.equal(readTab(storage, tabs), 'dashboard')
})

test('un onglet rangé qui n’existe plus retombe sur le dashboard', () => {
  const tabs = ['dashboard', 'missions']
  const storage = memoryStorage()
  storage.setItem(TAB_KEY, 'epics')
  assert.equal(readTab(storage, tabs), 'dashboard')

  // Une écriture inconnue ne remplace pas l'onglet courant par une vue absente.
  writeTab(storage, 'epics', tabs)
  assert.equal(storage.entries.has(TAB_KEY), false)
})

test('un stockage absent ou en panne ne casse pas l’onglet', () => {
  const tabs = ['dashboard', 'missions']
  assert.equal(readTab(undefined, tabs), 'dashboard')
  assert.equal(readTab({}, tabs), 'dashboard')

  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.equal(readTab(throwing, tabs), 'dashboard')
  assert.doesNotThrow(() => writeTab(throwing, 'missions', tabs))
  assert.doesNotThrow(() => writeTab(throwing, 'dashboard', tabs))
  assert.doesNotThrow(() => writeTab(null, 'missions', tabs))
})

test('la session range l’onglet et la section de Settings sous la même clé', () => {
  const tabs = ['dashboard', 'missions', 'settings']
  const sections = ['usage', 'workflows']
  const storage = memoryStorage()

  // Rien de rangé : le dashboard, et la première section de Settings.
  assert.deepEqual(readStoredView(storage, tabs, sections), { tab: 'dashboard', settingsView: 'usage' })
  assert.equal(storage.entries.has(TAB_KEY), false)

  writeStoredView(storage, { tab: 'settings', settingsView: 'workflows' }, tabs, sections)
  assert.deepEqual([...storage.entries.keys()], [TAB_KEY])
  // Une seule clé : la section tient lieu d�onglet tant que Settings est ouvert.
  assert.equal(storage.entries.get(TAB_KEY), 'workflows')
  assert.deepEqual(readStoredView(storage, tabs, sections), { tab: 'settings', settingsView: 'workflows' })

  // Revenir au dashboard retire la clé, comme l'onglet au repos.
  writeStoredView(storage, { tab: 'dashboard', settingsView: 'workflows' }, tabs, sections)
  assert.equal(storage.entries.has(TAB_KEY), false)
})

test('une session stockée sur usage ou workflows rouvre la section, pas le dashboard', () => {
  const tabs = ['dashboard', 'missions', 'settings']
  const sections = ['usage', 'workflows']
  const storage = memoryStorage()

  // `usage` et `workflows` étaient des onglets : leur valeur rangée nomme
  // désormais la section de Settings, sans second passage de migration.
  for (const section of sections) {
    storage.setItem(TAB_KEY, section)
    assert.deepEqual(readStoredView(storage, tabs, sections), { tab: 'settings', settingsView: section })
    assert.equal(storedView('settings', section, sections), section)
  }

  // Une section illisible retombe sur la première, jamais sur un onglet absent.
  assert.equal(storedView('settings', 'epics', sections), 'usage')
  storage.setItem(TAB_KEY, 'epics')
  assert.deepEqual(readStoredView(storage, tabs, sections), { tab: 'dashboard', settingsView: 'usage' })

  // Un onglet inconnu ne remplace pas la vue courante par une vue absente.
  writeStoredView(storage, { tab: 'epics', settingsView: 'usage' }, tabs, sections)
  assert.equal(storage.entries.has(TAB_KEY), false)
})

test('un stockage absent ou en panne ne casse pas la section', () => {
  const tabs = ['dashboard', 'missions', 'settings']
  const sections = ['usage', 'workflows']

  assert.deepEqual(readStoredView(undefined, tabs, sections), { tab: 'dashboard', settingsView: 'usage' })
  assert.deepEqual(readStoredView({}, tabs, sections), { tab: 'dashboard', settingsView: 'usage' })

  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.deepEqual(readStoredView(throwing, tabs, sections), { tab: 'dashboard', settingsView: 'usage' })
  assert.doesNotThrow(() => writeStoredView(throwing, { tab: 'settings', settingsView: 'workflows' }, tabs, sections))
  assert.doesNotThrow(() => writeStoredView(null, { tab: 'settings', settingsView: 'usage' }, tabs, sections))
})

test('la file du dashboard suit l’urgence, puis la plus ancienne, sans l’en-cours', () => {
  const missions = [
    { key: 'M-1', state: 'to-refine', updatedAt: '2026-11-10T12:00:00Z' },
    { key: 'M-2', state: 'in-review', updatedAt: '2026-11-09T12:00:00Z' },
    { key: 'M-3', state: 'in-progress', updatedAt: '2026-10-01T12:00:00Z' },
    { key: 'M-4', state: 'in-review', updatedAt: '2026-11-05T12:00:00Z' },
    { key: 'M-5', state: 'ready', updatedAt: '2026-11-11T11:00:00Z' },
  ]

  // Une mission prête pour la prod attend une mise en production, pas une
  // décision : elle n'entre pas dans la file, même très ancienne.
  missions.push({ key: 'M-6', state: 'ready-for-prod', updatedAt: '2026-10-01T12:00:00Z' })

  // Deux en revue : la plus ancienne passe devant. L'en-cours n'est jamais
  // dans la file, il vit dans In flight.
  assert.deepEqual(needsYou(missions).map((mission) => mission.key), ['M-4', 'M-2', 'M-5', 'M-1'])
  assert.deepEqual(inFlight(missions).map((mission) => mission.key), ['M-3'])
  assert.deepEqual(needsYou([]), [])
})

test('un bug ou une story prêt pour la production ne prend plus la tête des widgets', () => {
  // Given un bug et une story prêts à partir, les plus anciens de leur famille,
  // parmi des voisins à tous les états ouverts.
  const missions = [
    { key: 'bug-prod', type: 'bug', state: 'ready-for-prod', updatedAt: '2026-07-01T00:00:00Z' },
    { key: 'bug-old', type: 'bug', state: 'to-refine', updatedAt: '2026-10-01T00:00:00Z' },
    { key: 'bug-progress', type: 'bug', state: 'in-progress', updatedAt: '2026-10-15T00:00:00Z' },
    { key: 'bug-review', type: 'bug', state: 'in-review', updatedAt: '2026-10-20T00:00:00Z' },
    { key: 'bug-new', type: 'bug', state: 'ready', updatedAt: '2026-11-01T00:00:00Z' },
    { key: 'bug-unknown', type: 'bug', state: null, updatedAt: '2026-11-02T00:00:00Z' },
    { key: 'bug-done', type: 'bug', state: 'done', updatedAt: '2026-09-01T00:00:00Z' },
    { key: 'story-prod', type: 'story', priority: 'urgent', state: 'ready-for-prod', updatedAt: '2026-06-01T00:00:00Z' },
    { key: 'story-prod-high', type: 'story', priority: 'high', state: 'ready-for-prod', updatedAt: '2026-06-05T00:00:00Z' },
    { key: 'story-high', type: 'story', priority: 'high', state: 'ready', updatedAt: '2026-11-03T00:00:00Z' },
    { key: 'story-urgent', type: 'story', priority: 'urgent', state: 'in-progress', updatedAt: '2026-11-05T00:00:00Z' },
    { key: 'task-high', type: 'story', priority: 'high', state: null, updatedAt: '2026-11-04T00:00:00Z' },
    { key: 'story-review', type: 'story', priority: 'urgent', state: 'in-review', updatedAt: '2026-11-06T00:00:00Z' },
    { key: 'story-refine', type: 'story', priority: 'high', state: 'to-refine', updatedAt: '2026-11-07T00:00:00Z' },
    { key: 'story-normal', type: 'story', priority: 'normal', state: 'ready', updatedAt: '2026-10-01T00:00:00Z' },
    { key: 'story-done', type: 'story', priority: 'urgent', state: 'done', updatedAt: '2026-08-01T00:00:00Z' },
  ]

  // When les deux lentilles du digest retiennent leur famille.
  const bugs = assignedBugs(missions).map((mission) => mission.key)
  const stories = highPriorityStories(missions).map((mission) => mission.key)

  // Then le prêt à partir et le clos restent dehors, tous les autres états
  // ouverts restent rendus, les plus anciens d'abord.
  assert.deepEqual(bugs, ['bug-old', 'bug-progress', 'bug-review', 'bug-new', 'bug-unknown'])
  assert.deepEqual(stories, ['story-high', 'task-high', 'story-urgent', 'story-review', 'story-refine'])
  assert.deepEqual(assignedBugs([]), [])
  assert.deepEqual(highPriorityStories([]), [])
})

test('les quatre lentilles du digest écartent une mission bloquée, par label comme par dépendance', () => {
  // Given deux missions qu'une lentille prendrait sans la règle — l'une
  // bloquée par la seule étiquette, l'autre par la seule dépendance — plus une
  // dont la dépendance a atteint la revue, et trois saines.
  const missions = [
    { key: 'bug-label', type: 'bug', priority: 'urgent', state: 'in-review', blocked: true, blockedByLabel: true, blockers: [], updatedAt: '2026-09-01T00:00:00Z' },
    { key: 'bug-vieux', type: 'bug', priority: 'normal', state: 'to-refine', blocked: false, blockers: [], updatedAt: '2026-10-10T00:00:00Z' },
    { key: 'bug-neuf', type: 'bug', priority: 'normal', state: 'to-refine', blocked: false, blockers: [], updatedAt: '2026-10-20T00:00:00Z' },
    { key: 'story-dépendance', type: 'story', priority: 'high', state: 'in-progress', blocked: true, blockedByLabel: false, blockers: [{ key: 'MIS-9', title: 'Contrat', state: 'ready', url: null }], updatedAt: '2026-09-02T00:00:00Z' },
    { key: 'story-revue', type: 'story', priority: 'high', state: 'in-review', blocked: false, blockers: [], updatedAt: '2026-10-12T00:00:00Z' },
    { key: 'en-cours-saine', type: 'story', priority: 'normal', state: 'in-progress', blocked: false, blockers: [], updatedAt: '2026-10-05T00:00:00Z' },
  ]

  // When les quatre lentilles du digest lisent la même liste.
  const bugs = assignedBugs(missions).map((mission) => mission.key)
  const stories = highPriorityStories(missions).map((mission) => mission.key)
  const queue = needsYou(missions).map((mission) => mission.key)
  const flight = inFlight(missions).map((mission) => mission.key)

  // Then chaque lentille écarte la bloquée qu'elle aurait prise — le bug par
  // l'étiquette, la story par la dépendance, les deux empruntant la même porte
  // — et rend les non bloquées comme avant, dans son ordre : la plus ancienne
  // d'abord, le rang d'état pour la file.
  assert.deepEqual(bugs, ['bug-vieux', 'bug-neuf'])
  assert.deepEqual(stories, ['story-revue'])
  assert.deepEqual(queue, ['story-revue', 'bug-vieux', 'bug-neuf'])
  assert.deepEqual(flight, ['en-cours-saine'])

  // Then un `blocked` que l'hôte peut poser — le label suffit — reste la seule
  // porte : dans chaque lentille, elle écarte une mission que son état, son
  // type et sa priorité laissaient passer.
  const retenue = { key: 'seule', blocked: true, blockedByLabel: true, blockers: [] }
  assert.deepEqual(needsYou([{ ...retenue, state: 'ready' }]), [])
  assert.deepEqual(inFlight([{ ...retenue, state: 'in-progress' }]), [])
  assert.deepEqual(
    assignedBugs([{ ...retenue, key: 'isolée', type: 'bug', state: 'to-refine', priority: 'low' }]),
    [],
  )
  assert.deepEqual(
    highPriorityStories([{ ...retenue, key: 'haute', type: 'story', state: 'ready', priority: 'high' }]),
    [],
  )

  // Then la dépendance seule ferme les mêmes portes : un bug en revue et une
  // demande en attente qu'elle retient restent dehors, sans étiquette.
  const dépendance = { blocked: true, blockedByLabel: false, blockers: [{ key: 'MIS-9', title: 'Contrat', state: 'to-refine', url: null }] }
  assert.deepEqual(
    assignedBugs([{ ...dépendance, key: 'bug-retenu', type: 'bug', state: 'in-review', priority: 'urgent' }]),
    [],
  )
  assert.deepEqual(needsYou([{ ...dépendance, key: 'demande-retenue', state: 'ready' }]), [])
})

test('rien à décider ne fait pas une file : le prêt pour la prod n’y est pas', () => {
  const missions = [
    { key: 'prod', state: 'ready-for-prod', updatedAt: '2026-09-01T12:00:00Z' },
    { key: 'prod-2', state: 'ready-for-prod', updatedAt: '2026-10-01T12:00:00Z' },
  ]
  assert.deepEqual(needsYou(missions), [])

  // Le rang des états qui restent ne bouge pas : revue, prêt, à raffiner,
  // puis l'état inconnu en dernier.
  const mixed = [
    { key: 'raffiner', state: 'to-refine', updatedAt: '2026-11-01T00:00:00Z' },
    { key: 'prête', state: 'ready', updatedAt: '2026-11-01T00:00:00Z' },
    { key: 'revue', state: 'in-review', updatedAt: '2026-11-01T00:00:00Z' },
    { key: 'inconnue', state: null, updatedAt: '2026-11-01T00:00:00Z' },
    { key: 'prod', state: 'ready-for-prod', updatedAt: '2026-11-01T00:00:00Z' },
  ]
  assert.deepEqual(needsYou(mixed).map((mission) => mission.key), ['revue', 'prête', 'raffiner', 'inconnue'])

  // Le périmètre de la section compte la même file que les cartes.
  const scope = dashboardScope([...mixed, { key: 'en cours', state: 'in-progress', project: 'p', projectName: 'P' }])
  assert.equal(scope.needYou, 4)
  assert.equal(scope.open, 6)
})

test('une date illisible ne casse pas la file : elle passe en dernier', () => {
  const missions = [
    { key: 'sans-date', state: 'in-progress', updatedAt: null },
    { key: 'datée', state: 'in-progress', updatedAt: '2026-11-01T00:00:00Z' },
  ]
  assert.deepEqual(inFlight(missions).map((mission) => mission.key), ['datée', 'sans-date'])
})

test('l’âge du dashboard reste en jours et signale ce qui dort', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')

  assert.equal(missionAge('2026-11-11T11:58:00Z', now).label, '2 min')
  assert.equal(missionAge('2026-11-11T08:00:00Z', now).label, '4 h')
  // Passé une semaine, `relativeAge` bascule sur une date absolue : ici on veut
  // encore un nombre de jours, et le drapeau qui dit « ça n'a pas bougé ».
  assert.deepEqual(missionAge('2026-11-02T12:00:00Z', now), { label: '9 d', days: 9, quiet: true })
  assert.equal(missionAge('2026-11-04T12:00:00Z', now).quiet, true)
  assert.equal(missionAge('2026-11-04T13:00:00Z', now).quiet, false)
  assert.equal(QUIET_AFTER_DAYS, 7)

  assert.deepEqual(missionAge(null, now), { label: '', days: null, quiet: false })
  assert.equal(ageDays('pas une date', now), null)
  assert.equal(ageDays('2026-11-11T12:00:00Z', now), 0)
})

test('chaque état de la file a son verbe, l’inconnu retombe sur Open', () => {
  assert.equal(actionVerb('in-review'), 'Review')
  assert.equal(actionVerb('ready-for-prod'), 'Ship')
  assert.equal(actionVerb('ready'), 'Start')
  assert.equal(actionVerb('to-refine'), 'Refine')
  assert.equal(actionVerb('in-progress'), 'Continue')
  assert.equal(actionVerb('done'), 'Open')
})

test('le périmètre résume la file, l’ouvert et les projets ; les points sautent les absents', () => {
  const missions = [
    { key: 'a#1', state: 'ready', project: 'a', projectName: 'Alpha', points: 3 },
    { key: 'a#2', state: 'in-progress', project: 'a', projectName: 'Alpha', points: 5 },
    { key: 'b#3', state: null, project: 'b', projectName: 'Beta' },
  ]

  // Une mission sans état connu compte dans la file : sans elle, le périmètre
  // annoncerait plus de missions ouvertes que les cartes n'en montrent.
  assert.deepEqual(dashboardScope(missions), { needYou: 2, open: 3, projects: 2 })
  assert.deepEqual(dashboardScope([]), { needYou: 0, open: 0, projects: 0 })

  // Une mission sans points compte comme une mission, pas comme zéro point.
  assert.deepEqual(pointsTotal(missions), { total: 8, counted: 2 })
  assert.deepEqual(pointsTotal([]), { total: 0, counted: 0 })
})

test('un point s’écrit « 1 pt », une demi-pointe « 0.5 pt », et une absence ne s’écrit pas', () => {
  // Given les formes que prend le compte de points d'une mission.
  const comptes = [5, 1, 0.5, 2.5, 0, null, undefined, '', 'n/a']

  // When chaque compte est mis en mots.
  const mots = comptes.map(pointsText)

  // Then le pluriel ne commence qu'au-delà de 1, et une absence ne rend rien.
  assert.deepEqual(mots, ['5 pts', '1 pt', '0.5 pt', '2.5 pts', '0 pt', '', '', '', ''])
})

test('l’échelle des points est celle du panneau, la demi-pointe comprise', () => {
  // Given la liste que la route refuse hors échelle, et celle que le volet offre.
  const scale = POINTS_SCALE

  // When la route et le volet lisent la même constante.
  const fromMission = missionScale

  // Then les sept tailles sont là, une seule fois, et `0.5` ouvre l'échelle.
  assert.deepEqual(scale, [0.5, 1, 2, 3, 5, 8, 13])
  assert.deepEqual(fromMission, scale)
  assert.equal(new Set(scale).size, scale.length)
})

test('une mission sans état connu reste dans la file, en dernier', () => {
  const missions = [
    { key: 'inconnue', state: null, updatedAt: '2026-11-01T00:00:00Z' },
    { key: 'à raffiner', state: 'to-refine', updatedAt: '2026-11-10T00:00:00Z' },
    { key: 'en cours', state: 'in-progress', updatedAt: '2026-11-02T00:00:00Z' },
  ]

  // C'est la mission qui demande un arbitrage : la cacher rendrait le compte de
  // la bande faux, et l'arbitrage invisible.
  assert.deepEqual(needsYou(missions).map((mission) => mission.key), ['à raffiner', 'inconnue'])
  assert.deepEqual(inFlight(missions).map((mission) => mission.key), ['en cours'])
})

test('une mission close ne compte ni dans la file ni dans le périmètre', () => {
  const missions = [
    { key: 'close', state: 'done', project: 'p', projectName: 'Projet' },
    { key: 'ouverte', state: 'ready', project: 'p', projectName: 'Projet' },
  ]

  assert.deepEqual(needsYou(missions).map((mission) => mission.key), ['ouverte'])
  assert.deepEqual(dashboardScope(missions), { needYou: 1, open: 1, projects: 1 })
})


// Le modèle de référence : quatre colonnes, un aller simple et un retour.
const MODELE = {
  workflow: 'cadrage',
  title: 'Cadrage',
  entry: 'to-refine',
  exit: ['ready'],
  nodes: [
    { id: 'lire', label: 'Lire le ticket' },
    { id: 'ecrire', label: 'Écrire la fiche' },
  ],
  edges: [
    { from: 'to-refine', to: 'lire' },
    { from: 'lire', to: 'ecrire' },
    { from: 'ecrire', to: 'ready' },
    { from: 'ecrire', to: 'lire', when: 'si le plan manque' },
  ],
}

test('la géométrie suit le plus long chemin, et l’entrée passe avant les gestes', () => {
  const graph = layoutWorkflow(MODELE)

  assert.deepEqual(graph.boxes.map((box) => [box.id, box.kind, box.level]), [
    ['to-refine', 'etat', 0],
    ['lire', 'geste', 1],
    ['ecrire', 'geste', 2],
    ['ready', 'etat', 3],
  ])
  // Deux rangées voisines ne se chevauchent pas : la boîte suivante commence
  // après la fin de la précédente, et le dessin contient tout le monde.
  const lire = graph.boxes.find((box) => box.id === 'lire')
  const ecrire = graph.boxes.find((box) => box.id === 'ecrire')
  assert.ok(ecrire.y > lire.y + lire.height)
  assert.ok(graph.height > ecrire.y + ecrire.height - 1)
  assert.ok(graph.width > lire.x + lire.width)
})

test('un arc de retour sort à droite du graphe, en pointillé', () => {
  const graph = layoutWorkflow(MODELE)

  const back = graph.links.find((link) => link.back)
  assert.ok(back, 'l’arc « si le plan manque » revient en arrière')
  assert.deepEqual([back.from, back.to], ['ecrire', 'lire'])
  assert.equal(back.when, 'si le plan manque')
  assert.equal(graph.links.filter((link) => !link.back).length, 3)
  // Le retour contourne les rangées par la droite : il ne les traverse pas.
  const ecrire = graph.boxes.find((box) => box.id === 'ecrire')
  assert.ok(back.labelX > ecrire.x + ecrire.width)
  assert.ok(graph.width > back.labelX)
})

test('un geste injoignable ne se cache pas : il prend sa propre colonne', () => {
  const graph = layoutWorkflow({ ...MODELE, nodes: [...MODELE.nodes, { id: 'perdu', label: 'Perdu' }] })
  const perdu = graph.boxes.find((box) => box.id === 'perdu')

  assert.equal(perdu.level, 4, 'après la dernière colonne du chemin')
})

test('un modèle vide ne lève pas et ne dessine rien', () => {
  for (const model of [{}, undefined]) {
    const graph = layoutWorkflow(model)
    assert.deepEqual(graph.boxes, [])
    assert.deepEqual(graph.links, [])
    assert.ok(Number.isFinite(graph.width) && Number.isFinite(graph.height), 'une toile vide a quand même une taille')
  }
})

test('retirer un geste retire ses arcs, et un id neuf ne collide pas', () => {
  const without = withoutNode(MODELE, 'ecrire')
  assert.deepEqual(without.nodes.map((node) => node.id), ['lire'])
  assert.deepEqual(without.edges.map((edge) => `${edge.from}→${edge.to}`), ['to-refine→lire'])

  assert.deepEqual(withoutEdge(MODELE, 'to-refine', 'lire').edges.map((edge) => `${edge.from}→${edge.to}`), ['lire→ecrire', 'ecrire→ready', 'ecrire→lire'])
  assert.equal(nextGestureId({ nodes: [{ id: 'geste-1' }, { id: 'geste-2' }] }), 'geste-3')
  assert.equal(nextGestureId({ nodes: [] }), 'geste-1')
})

test('un geste à plusieurs sorties porte un losange, un geste linéaire n’en a pas', () => {
  const graph = layoutWorkflow(MODELE)
  const ecrire = graph.boxes.find((box) => box.id === 'ecrire')
  const decision = graph.decisions.find((item) => item.id === 'ecrire')

  assert.ok(decision, 'deux sorties — la sortie avant et le retour — font un choix')
  assert.equal(graph.decisions.length, 1)
  // Le losange se centre sous son geste et reste détaché de sa boîte.
  assert.equal(decision.x + decision.width / 2, ecrire.x + ecrire.width / 2)
  assert.ok(decision.y >= ecrire.y + ecrire.height)
  assert.equal(graph.decisions.some((item) => item.id === 'lire'), false, 'une seule sortie : pas de losange')

  const alone = layoutWorkflow({ ...MODELE, nodes: [...MODELE.nodes, { id: 'isole', label: 'Isolé' }] })
  assert.equal(alone.decisions.some((item) => item.id === 'isole'), false, 'aucune sortie : pas de losange')
})

test('les arcs d’un losange partent de son sommet bas, le reste ne bouge pas', () => {
  const graph = layoutWorkflow(MODELE)
  const ecrire = graph.boxes.find((box) => box.id === 'ecrire')
  const decision = graph.decisions.find((item) => item.id === 'ecrire')
  const vertex = { x: decision.x + decision.width / 2, y: decision.y + decision.height }
  const startOf = (path) => {
    const [, x, y] = path.match(/^M (\S+) (\S+)/)
    return [Number(x), Number(y)]
  }

  // Les sorties avant quittent le losange, pas le bas de la boîte du geste.
  for (const link of graph.links.filter((item) => item.from === 'ecrire' && !item.back)) {
    assert.deepEqual(startOf(link.path), [vertex.x, vertex.y])
  }
  // Le retour garde sa sortie à droite, et l'arc entrant arrive sur le geste.
  const back = graph.links.find((link) => link.from === 'ecrire' && link.back)
  assert.deepEqual(startOf(back.path), [ecrire.x + ecrire.width, ecrire.y + ecrire.height / 2])
  const incoming = graph.links.find((link) => link.to === 'ecrire')
  assert.ok(incoming.path.endsWith(`${ecrire.x + ecrire.width / 2} ${ecrire.y}`), 'l’arc entrant continue d’arriver sur le geste')

  // Deux calculs du même modèle donnent la même image.
  assert.deepEqual(layoutWorkflow(MODELE), graph)
})

test('chaque condition s’affiche en entier, sans sortir du cadre ni recouvrir une boîte', async () => {
  const { workflows } = await loadWorkflows(MODELS_DIR, { states: [] })

  for (const model of workflows) {
    const graph = layoutWorkflow(model)
    for (const link of graph.links.filter((item) => item.when)) {
      const half = link.labelAnchor === 'middle' ? link.labelWidth / 2 : 0
      const left = link.labelX - half
      const right = left + link.labelWidth
      const top = link.labelY - 9
      const bottom = link.labelY + 3

      assert.ok(left >= 0, `${model.workflow} : « ${link.when} » sort à gauche`)
      assert.ok(right <= graph.width, `${model.workflow} : « ${link.when} » sort à droite`)
      assert.ok(top >= 0 && bottom <= graph.height, `${model.workflow} : « ${link.when} » sort du cadre`)
      for (const box of graph.boxes) {
        const crosses = left < box.x + box.width && right > box.x && top < box.y + box.height && bottom > box.y
        assert.equal(crosses, false, `${model.workflow} : « ${link.when} » recouvre ${box.id}`)
      }
    }
  }
})

test('aucune étiquette de condition n’en recouvre une autre, sur les quatre modèles', async () => {
  const { workflows } = await loadWorkflows(MODELS_DIR, { states: [] })

  for (const model of workflows) {
    const graph = layoutWorkflow(model)
    const labels = graph.links.filter((link) => link.when).map((link) => {
      const half = link.labelAnchor === 'middle' ? link.labelWidth / 2 : 0
      const left = link.labelX - half
      return { link, left, right: left + link.labelWidth, top: link.labelY - 9, bottom: link.labelY + 3 }
    })
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i]
        const b = labels[j]
        const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
        assert.equal(overlap, false, `${model.workflow} : « ${a.link.when} » recouvre « ${b.link.when} »`)
      }
    }
  }
})

test('la géométrie reste déterministe d’un calcul à l’autre', async () => {
  const { workflows } = await loadWorkflows(MODELS_DIR, { states: [] })

  for (const model of workflows) {
    // L'empilement des retours ne dépend d'aucun état de module : deux calculs
    // successifs donnent la même géométrie, boîtes et étiquettes comprises.
    assert.deepEqual(layoutWorkflow(model), layoutWorkflow(model))
  }
})

test('sur cadrage, les deux retours vers la fiche tiennent sur deux lignes', async () => {
  const { workflows } = await loadWorkflows(MODELS_DIR, { states: [] })
  const model = workflows.find((item) => item.workflow === 'cadrage')
  const graph = layoutWorkflow(model)
  const target = graph.boxes.find((box) => box.id === 'ecrire-fiche')
  const backs = graph.links.filter((link) => link.back && link.to === 'ecrire-fiche' && link.when)

  assert.equal(backs.length, 2)
  assert.deepEqual(
    backs.map((link) => link.when).sort(),
    ['chaque nouveau ticket repart au cadrage', 'une case n\'est pas cochée'].sort(),
    'les deux conditions sont affichées en entier',
  )
  // Le premier retour garde la ligne de bf9e191 ; le second descend d'une ligne
  // de texte, assez pour que les deux rectangles ne se touchent pas.
  const first = target.y + target.height / 2 + 4
  assert.deepEqual(backs.map((link) => link.labelY), [first, first + 12])
  // L'empilement reste dans la bande de rangée : il n'entre ni dans une boîte
  // déjà en place, ni dans la rangée suivante.
  const below = Math.min(...graph.boxes.filter((box) => box.level > target.level).map((box) => box.y))
  for (const link of backs) {
    assert.ok(link.labelY + 3 <= below, `« ${link.when} » entre dans la rangée suivante`)
    for (const box of graph.boxes) {
      const crosses = link.labelX < box.x + box.width && link.labelX + link.labelWidth > box.x && link.labelY - 9 < box.y + box.height && link.labelY + 3 > box.y
      assert.equal(crosses, false, `« ${link.when} » recouvre ${box.id}`)
    }
  }
})

test('trois branches empilent leurs conditions sans se recouvrir', () => {
  const model = {
    workflow: 'essai',
    title: 'Essai',
    entry: 'depart',
    exit: ['un', 'deux', 'trois'],
    nodes: [{ id: 'choix', label: 'Choisir' }, { id: 'seul', label: 'Seul' }],
    edges: [
      { from: 'depart', to: 'choix' },
      { from: 'choix', to: 'un', when: 'le premier cas se présente' },
      { from: 'choix', to: 'deux', when: 'le deuxième cas se présente' },
      { from: 'choix', to: 'trois', when: 'le troisième cas se présente' },
      { from: 'depart', to: 'seul' },
      { from: 'seul', to: 'un' },
    ],
  }
  const graph = layoutWorkflow(model)
  const decision = graph.decisions.find((item) => item.id === 'choix')
  const labels = graph.links.filter((link) => link.from === 'choix' && link.when)

  assert.ok(decision)
  assert.equal(labels.length, 3, 'trois sorties conditionnelles')
  assert.deepEqual(labels.map((link) => link.labelAnchor), ['start', 'start', 'start'])

  const rectangles = labels.map((link) => ({ left: link.labelX, right: link.labelX + link.labelWidth, top: link.labelY - 9, bottom: link.labelY + 3 }))
  for (let i = 0; i < rectangles.length; i += 1) {
    for (let j = i + 1; j < rectangles.length; j += 1) {
      const a = rectangles[i]
      const b = rectangles[j]
      const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      assert.equal(overlap, false, `les conditions ${i + 1} et ${j + 1} se recouvrent`)
    }
  }
  // La rangée suivante reste sous le losange et sous la dernière condition.
  const below = Math.min(...graph.boxes.filter((box) => box.level > decision.level).map((box) => box.y))
  assert.ok(below > decision.y + decision.height)
  assert.ok(below > Math.max(...rectangles.map((rect) => rect.bottom)))
})

test('la revue porte un losange sur chaque geste qui tranche', async () => {
  const review = await readWorkflow(MODELS_DIR, 'review', { states: [] })
  const graph = layoutWorkflow(review)
  const deciding = graph.decisions.map((item) => item.id).sort()

  assert.deepEqual(deciding, ['decider', 'verifier-perimetre'])
  const labels = graph.links.filter((link) => link.from === 'decider' && link.when).map((link) => link.when).sort()
  assert.deepEqual(labels, ['tout est conforme', "un critère n'a pas de scénario", 'une preuve manque'])
  // Aucun autre geste n'en porte : le losange ne se pose que sur un vrai choix.
  for (const node of review.nodes) {
    const outs = review.edges.filter((edge) => edge.from === node.id).length
    assert.equal(graph.decisions.some((item) => item.id === node.id), outs >= 2, node.id)
  }
})


test('une condition d’arc se met à jour sur place, un arc neuf s’ajoute', () => {
  const updated = upsertEdge(MODELE, 'lire', 'ecrire', 'si le plan manque')
  assert.deepEqual(updated.edges.map((edge) => `${edge.from}→${edge.to}`), ['to-refine→lire', 'lire→ecrire', 'ecrire→ready', 'ecrire→lire'], 'un arc existant garde sa place')
  assert.equal(updated.edges[1].when, 'si le plan manque', 'la condition remplace celle qui n’existait pas')

  const added = upsertEdge(MODELE, 'lire', 'ready', 'si la fiche suffit')
  assert.equal(added.edges.at(-1).to, 'ready')
  assert.equal(added.edges.length, 5)

  // Vider la condition retire le champ : le fichier ne garde pas de `when: ''`.
  assert.equal('when' in upsertEdge(MODELE, 'lire', 'ecrire', '').edges[1], false)
  assert.equal(upsertEdge(MODELE, 'ecrire', 'lire', '').edges.at(-1).when, undefined)
})


test('l’étape ouverte se garde comme l’onglet, et retombe sur la première', () => {
  const steps = ['cadrage', 'execution', 'review', 'cloture']
  const memoire = () => {
    const map = new Map()
    return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
  }

  const session = memoire()
  assert.equal(readStep(session, steps), 'cadrage', 'une session neuve ouvre la première étape')
  writeStep(session, 'review', steps)
  assert.equal(session.map.get('missions.workflow-step'), 'review')
  assert.equal(readStep(session, steps), 'review', 'l’étape survit à un remontage')
  writeStep(session, 'cadrage', steps)
  assert.equal(session.map.has('missions.workflow-step'), false, 'la première étape ne laisse pas de clé')
  writeStep(session, 'archive', steps)
  assert.equal(session.map.has('missions.workflow-step'), false, 'une étape que le panneau ne rend pas ne s’écrit pas')
  assert.equal(readStep(session, steps), 'cadrage')
  assert.equal(readStep(null, steps), 'cadrage')
})

test('la page du playbook se garde comme l’étape, et retombe sur la première', () => {
  const pages = ['cadrage', 'execution', 'review', 'cloture', 'workspace']
  const memoire = () => {
    const map = new Map()
    return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
  }

  const session = memoire()
  assert.equal(readPlaybookPage(session, pages), 'cadrage', 'une session neuve ouvre la première page')
  writePlaybookPage(session, 'workspace', pages)
  assert.equal(session.map.get(PLAYBOOK_PAGE_KEY), 'workspace')
  assert.equal(readPlaybookPage(session, pages), 'workspace', 'la page survit à un remontage')
  writePlaybookPage(session, 'cadrage', pages)
  assert.equal(session.map.has(PLAYBOOK_PAGE_KEY), false, 'la première page ne laisse pas de clé')

  // Une page que la liste ne porte plus ne rouvre pas un éditeur vide : la
  // première page reprend la main, et l'écriture ne garde pas la valeur morte.
  session.setItem(PLAYBOOK_PAGE_KEY, 'archive')
  assert.equal(readPlaybookPage(session, pages), 'cadrage')
  writePlaybookPage(session, 'archive', pages)
  assert.equal(session.map.has(PLAYBOOK_PAGE_KEY), false)

  // Un stockage absent, en panne, ou une liste vide ne lèvent pas.
  assert.equal(readPlaybookPage(null, pages), 'cadrage')
  assert.equal(readPlaybookPage(session, []), null)
  const enPanne = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.equal(readPlaybookPage(enPanne, pages), 'cadrage')
  assert.doesNotThrow(() => writePlaybookPage(enPanne, 'review', pages))
  assert.doesNotThrow(() => writePlaybookPage(null, 'review', pages))
})

test('modelOf ne renvoie que le modèle, jamais les champs d’affichage du serveur', () => {
  const entree = {
    workflow: 'cadrage',
    title: 'Cadrage',
    document: 'workflows/cadrage.md',
    entry: 'to-refine',
    exit: ['ready'],
    nodes: [{ id: 'lire', label: 'Lire', section: 'Ce qu’on fait', writer: 'session' }],
    edges: [{ from: 'to-refine', to: 'lire' }],
    errors: [{ field: 'nodes', code: 'x', message: 'y' }],
    orphanSections: ['Sur le tracker'],
    headings: [{ level: 2, text: 'Ce qu’on fait' }],
    file: 'workflows/model/cadrage.yml',
    text: 'workflow: cadrage',
  }
  const modele = modelOf(entree)
  assert.deepEqual(Object.keys(modele), ['workflow', 'title', 'document', 'entry', 'exit', 'nodes', 'edges'])
  assert.deepEqual(modele.nodes, entree.nodes)
  assert.deepEqual(modelOf(), {}, 'une entrée absente ne lève pas')
  assert.deepEqual(modelOf(null), {})
})

test('endPoints énumère entrée, gestes et sorties, et tolère un modèle absent', () => {
  const modele = {
    entry: 'to-refine',
    exit: ['ready'],
    nodes: [
      { id: 'lire', label: 'Lire', section: 'Ce qu’on fait', writer: 'session' },
      { id: 'ecrire', label: 'Écrire', section: 'Ce qu’on fait', writer: 'session' },
    ],
    edges: [],
  }
  assert.deepEqual(endPoints(null), [], 'un brouillon absent ne lève pas')
  assert.deepEqual(endPoints(undefined), [])
  assert.deepEqual(endPoints(modele), [
    { id: 'to-refine', kind: 'etat' },
    { id: 'lire', kind: 'geste' },
    { id: 'ecrire', kind: 'geste' },
    { id: 'ready', kind: 'etat' },
  ], 'l’entrée d’abord, les gestes dans l’ordre du fichier, les sorties ensuite')
  assert.deepEqual(endPoints({ entry: 'a', nodes: [] }), [{ id: 'a', kind: 'etat' }], 'une étape sans sortie déclarée')
})

test('la session garde le switch des worktrees, et rien quand il est fermé', () => {
  const storage = memoryStorage()

  // Le défaut est fermé : une session vierge ne range aucune clé.
  assert.equal(readWorktreesShown(storage), false)
  assert.equal(storage.entries.has(REPOSITORIES_WORKTREES_KEY), false)

  writeWorktreesShown(storage, true)
  assert.deepEqual([...storage.entries], [[REPOSITORIES_WORKTREES_KEY, '1']])
  assert.equal(readWorktreesShown(storage), true)

  // Fermer le switch revient au défaut sans laisser de valeur « 0 ».
  writeWorktreesShown(storage, false)
  assert.equal(storage.entries.has(REPOSITORIES_WORKTREES_KEY), false)
  assert.equal(readWorktreesShown(storage), false)
})

test('une valeur étrangère ou un stockage en panne garde les worktrees cachés', () => {
  const storage = memoryStorage()
  for (const value of ['0', 'true', 'oui', '']) {
    storage.setItem(REPOSITORIES_WORKTREES_KEY, value)
    assert.equal(readWorktreesShown(storage), false, `« ${value} » ne vaut pas « 1 »`)
  }
  storage.setItem(REPOSITORIES_WORKTREES_KEY, '1')
  assert.equal(readWorktreesShown(storage), true)

  assert.equal(readWorktreesShown(undefined), false)
  assert.equal(readWorktreesShown({}), false)
  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('blocked') },
  }
  assert.equal(readWorktreesShown(throwing), false)
  assert.doesNotThrow(() => writeWorktreesShown(throwing, true))
  assert.doesNotThrow(() => writeWorktreesShown(throwing, false))
  assert.doesNotThrow(() => writeWorktreesShown(null, true))
})

test('les dépôts se lisent du plus récent au plus ancien, et à nom égal par nom', () => {
  const rows = [
    { name: 'delta', lastCommit: null },
    { name: 'charlie', lastCommit: { date: 1000 } },
    { name: 'bravo', lastCommit: { date: 2000 } },
    { name: 'alpha', lastCommit: { date: 2000 } },
  ]
  const ordered = sortRepositories(rows)

  // Le tri du panneau est le contrat du widget : même réponse à chaque scan,
  // sans commit en fin de liste, et deux commits de la même seconde par nom.
  assert.deepEqual(ordered.map((row) => row.name), ['alpha', 'bravo', 'charlie', 'delta'])
  assert.deepEqual(rows.map((row) => row.name), ['delta', 'charlie', 'bravo', 'alpha'], 'la liste reçue n’est pas modifiée')
  assert.deepEqual(sortRepositories([]), [])
  assert.deepEqual(sortRepositories(undefined), [])
})

test('une ligne dit sa branche, son état et son dernier commit', () => {
  assert.equal(repositoryBranch({ branch: 'feat/mis-116' }), 'feat/mis-116')
  assert.equal(repositoryBranch({ detached: true, head: 'abc1234' }), 'detached @ abc1234')
  assert.equal(repositoryBranch({ detached: true }), 'detached')
  assert.equal(repositoryBranch({ error: 'not a git repository' }), 'unreadable')
  assert.equal(repositoryBranch({}), 'unknown')

  // L'état compte les fichiers, au singulier quand il n'y en a qu'un.
  assert.deepEqual(repositoryState({ dirty: 0 }), { dirty: false, error: false, label: 'clean' })
  assert.deepEqual(repositoryState({ dirty: 1 }), { dirty: true, error: false, label: '1 file' })
  assert.deepEqual(repositoryState({ dirty: 12 }), { dirty: true, error: false, label: '12 files' })
  assert.deepEqual(repositoryState({}), { dirty: false, error: false, label: 'clean' })
  assert.deepEqual(repositoryState({ dirty: null }), { dirty: false, error: false, label: 'clean' })
  assert.deepEqual(repositoryState({ error: 'boom', dirty: 3 }), { dirty: false, error: true, label: 'unreadable' })

  assert.equal(repositoryCommit({ lastCommit: { subject: 'MIS-116: ajoute l’onglet' } }), 'MIS-116: ajoute l’onglet')
  assert.equal(repositoryCommit({ lastCommit: { sha: 'abc1234', subject: '' } }), 'abc1234')
  assert.equal(repositoryCommit({ lastCommit: null }), 'no commit yet')
  assert.equal(repositoryCommit({ error: 'boom' }), '')
})

test('la session garde la barre des dépôts, et l’efface quand on la vide', () => {
  const storage = memoryStorage()

  // Given a session that has never opened the bar
  assert.deepEqual(readRepositoryFilters(storage), { query: '', state: null })
  assert.equal(storage.entries.has(REPOSITORIES_FILTERS_KEY), false)

  // When the bar is written
  writeRepositoryFilters(storage, { query: 'missions', state: ['clean'] })

  // Then the session keeps the snapshot, and reads it back
  assert.deepEqual([...storage.entries], [[REPOSITORIES_FILTERS_KEY, '{"query":"missions","state":["clean"]}']])
  assert.deepEqual(readRepositoryFilters(storage), { query: 'missions', state: ['clean'] })

  // When nothing is left in the bar
  writeRepositoryFilters(storage, { query: '   ', state: null })

  // Then the key is dropped instead of keeping an empty snapshot
  assert.equal(storage.entries.has(REPOSITORIES_FILTERS_KEY), false)
})

test('un stockage en panne ou absent garde la barre vide sans lever', () => {
  // Given no storage at all
  assert.deepEqual(readRepositoryFilters(undefined), { query: '', state: null })
  assert.deepEqual(readRepositoryFilters({}), { query: '', state: null })
  assert.doesNotThrow(() => writeRepositoryFilters(null, { query: 'x' }))

  // Given a storage that refuses everything
  const throwing = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('quota') },
    removeItem: () => { throw new Error('blocked') },
  }

  // Then the bar falls back to the empty snapshot, both ways
  assert.deepEqual(readRepositoryFilters(throwing), { query: '', state: null })
  assert.doesNotThrow(() => writeRepositoryFilters(throwing, { query: 'x', state: ['dirty'] }))
  assert.doesNotThrow(() => writeRepositoryFilters(throwing, {}))
})

test('une barre enregistrée ne revient qu’avec les états que le panneau propose', () => {
  // Given junk in the session
  for (const raw of ['', 'null', 'true', '[]', '"missions"', '{', '{"state":"nope"}', '{"query":42,"state":["dirty"]}']) {
    assert.deepEqual(parseRepositoryFilters(raw), { query: '', state: null }, `« ${raw} » garde la barre vide`)
  }

  // Given a snapshot with a foreign state, a single value and a reversed list
  assert.deepEqual(
    parseRepositoryFilters('{"query":"gh","state":["dirty","nope"]}'),
    { query: 'gh', state: ['dirty'] },
    'un état que le panneau n’offre pas disparaît',
  )
  assert.deepEqual(
    parseRepositoryFilters('{"state":"detached"}'),
    { query: '', state: ['detached'] },
    'une valeur seule venue d’une session plus ancienne est acceptée',
  )
  assert.deepEqual(
    parseRepositoryFilters('{"state":["unreadable","clean"]}'),
    { query: '', state: ['clean', 'unreadable'] },
    'la liste revient dans l’ordre du panneau',
  )

  // Given the canonical snapshot and its working copy
  assert.deepEqual(repositoryFilterSnapshot({ query: 'gh', state: ['dirty'] }), { query: 'gh', state: ['dirty'] })
  assert.equal(hasActiveRepositoryFilters({}), false)
  assert.equal(hasActiveRepositoryFilters({ query: '  ' }), false)
  assert.equal(hasActiveRepositoryFilters({ query: 'gh' }), true)
  assert.equal(hasActiveRepositoryFilters({ state: ['clean'] }), true)
  assert.deepEqual(REPOSITORY_FILTER_OPTIONS, ['clean', 'dirty', 'detached', 'unreadable'])
  assert.deepEqual(REPOSITORY_FILTER_LABELS, { clean: 'Clean', dirty: 'Dirty', detached: 'Detached', unreadable: 'Unreadable' })
})

test('les quatre états comptent des lignes qui se recouvrent', () => {
  // Given a displayed list of one row per state, one row in two states at once,
  // and a detached row git then refused
  const rows = [
    { name: 'propre', dirty: 0 },
    { name: 'sale', dirty: 2 },
    { name: 'detache-et-sale', detached: true, dirty: 1 },
    { name: 'casse', error: 'not a git repository' },
    { name: 'detache-casse', detached: true, head: 'abc1234', error: 'git log failed' },
  ]

  // Then each count asks the row itself: Clean 1, Dirty 2, Detached 2, Unreadable 2
  assert.deepEqual(repositoryFilterCounts(rows), { clean: 1, dirty: 2, detached: 2, unreadable: 2 })
  assert.deepEqual(repositoryFilterCounts([]), { clean: 0, dirty: 0, detached: 0, unreadable: 0 })
  assert.deepEqual(repositoryFilterCounts(undefined), { clean: 0, dirty: 0, detached: 0, unreadable: 0 })
})

test('le filtre des dépôts cherche le nom, la branche affichée et le dernier commit', () => {
  // Given the rows the tab shows, in the order the scan gave them
  const rows = [
    { name: 'zeta', branch: 'main', path: '/Users/moi/projects/zeta', dirty: 0 },
    { name: 'missions', branch: 'feat/mis-116', path: '/Users/moi/projects/missions', dirty: 2, lastCommit: { subject: 'MIS-116: ajoute l’onglet' } },
    { name: 'missions-gh20', branch: 'gh-20-hover', dirty: 1, lastCommit: { subject: 'gh-20: le survol' } },
    { name: 'socle', detached: true, head: 'abc1234' },
    { name: 'casse', error: 'not a git repository' },
    { name: 'detache-casse', detached: true, head: 'abc1234', error: 'git log failed' },
  ]
  const names = (list) => list.map((row) => row.name)

  // Then the search is case-insensitive and trims its needle
  assert.deepEqual(names(filterRepositories(rows, { query: 'GH-20' })), ['missions-gh20'])
  assert.deepEqual(names(filterRepositories(rows, { query: 'feat/mis' })), ['missions'])
  assert.deepEqual(names(filterRepositories(rows, { query: 'MIS-116' })), ['missions'])
  assert.deepEqual(names(filterRepositories(rows, { query: '  ' })), names(rows))
  assert.deepEqual(names(filterRepositories(rows, {})), names(rows))
  // The path is never searched: what the row shows is the contract.
  assert.deepEqual(names(filterRepositories(rows, { query: 'projects/missions' })), [])
  assert.deepEqual(names(filterRepositories(rows, { query: 'introuvable' })), [])

  // Then a state keeps the rows that answer it, the same way the counts do
  assert.deepEqual(names(filterRepositories(rows, { state: ['dirty'] })), ['missions', 'missions-gh20'])
  assert.deepEqual(names(filterRepositories(rows, { state: ['clean'] })), ['zeta', 'socle'])
  // A detached row stays Detached even when git then refused to read it, and
  // it answers Unreadable too: the two states are read one by one.
  assert.deepEqual(names(filterRepositories(rows, { state: ['detached'] })), ['socle', 'detache-casse'])
  assert.deepEqual(names(filterRepositories(rows, { state: ['unreadable'] })), ['casse', 'detache-casse'])
  assert.deepEqual(names(filterRepositories(rows, { state: ['clean', 'unreadable'] })), ['zeta', 'socle', 'casse', 'detache-casse'])

  // Then the search and the states combine with AND, and the order survives
  assert.deepEqual(names(filterRepositories(rows, { query: 'missions', state: ['dirty'] })), ['missions', 'missions-gh20'])
  assert.deepEqual(names(filterRepositories(rows, { query: 'missions', state: ['clean'] })), [])
})

test('l’en-tête dit ce que le scan a lu, et ce qu’il n’a pas pu lire', () => {
  assert.equal(scanLabel({ count: 3, durationMs: 1904, errors: [] }), '3 repositories · scanned in 1.9 s')
  assert.equal(scanLabel({ count: 1, durationMs: 250, errors: [] }), '1 repository · scanned in 0.3 s')
  assert.equal(scanLabel({ count: 2, durationMs: 1600, errors: [{ name: 'a', message: 'x' }] }), '2 repositories · scanned in 1.6 s · 1 unreadable')
  assert.equal(scanLabel({ count: 0 }), '0 repositories')
  assert.equal(scanLabel({}), '0 repositories')

  // Les lignes portent leur nature : l'en-tête sépare les clones des worktrees
  // au lieu de compter un checkout comme un dépôt. C'est le compte de la
  // pastille, aligné sur celui de l'onglet.
  const lignes = [
    { name: 'missions', kind: 'clone' },
    { name: 'socle', kind: 'clone' },
    { name: 'missions-gh20', kind: 'worktree' },
  ]
  assert.equal(scanLabel({ repositories: lignes, durationMs: 1904, errors: [] }), '2 repositories · 1 worktree · scanned in 1.9 s')
  assert.equal(scanLabel({ repositories: lignes.slice(0, 2), durationMs: 1904, errors: [] }), '2 repositories · scanned in 1.9 s')
  assert.equal(scanLabel({ repositories: [lignes[2]], durationMs: 900, errors: [] }), '0 repositories · 1 worktree · scanned in 0.9 s')
  assert.equal(scanLabel({ repositories: [{ name: 'missions', kind: 'clone' }], durationMs: 900, errors: [{ name: 'b', message: 'x' }] }), '1 repository · scanned in 0.9 s · 1 unreadable')
  assert.equal(scanLabel({ repositories: [], durationMs: 40, errors: [] }), '0 repositories · scanned in 0.0 s')

  assert.equal(scanDuration(1904), '1.9 s')
  assert.equal(scanDuration(0), '0.0 s')
  assert.equal(scanDuration(-1), '')
  assert.equal(scanDuration(Number.NaN), '')
  assert.equal(scanDuration(undefined), '')
})

test('le prompt de session nomme la commande gh, jamais l’URL de la page', () => {
  const ligne = ticketReadLine('https://github.com/daedalforge/missions/issues/119')
  assert.match(ligne, /^Lis d'abord le ticket avec le CLI/)
  assert.match(ligne, /gh issue view 119 -R daedalforge\/missions --json /)
  assert.ok(!ligne.includes('https://github.com'), 'l’URL de la page ne doit pas être proposée : elle est tronquée')
})

test('un ticket non-GitHub ou absent garde son lien, avec la consigne du CLI', () => {
  const jira = ticketReadLine('https://example.atlassian.net/browse/EX-1541')
  assert.match(jira, /^Ouvre d'abord le ticket : https:/)
  assert.match(jira, /depuis le CLI du tracker, jamais la page HTML/)
  assert.match(ticketReadLine(undefined), /\(lien indisponible\)/)
})

/** La mission témoin des deux prompts : branche, base, dossier et dépôt déclarés. */
const TEMOIN = {
  key: 'MIS-42',
  title: 'Reload onglet mission',
  url: 'https://github.com/daedalforge/missions/issues/42',
  state: 'in-progress',
  branch: 'fix/mis-42',
  base: 'main',
  folder: 'MIS-42',
  project: 'missions',
  repo: '~/projects/missions',
}

test('le prompt de session est la chaîne d’hier, au caractère près', () => {
  // Cette chaîne est celle que le volet construisait en ligne : l'extraction en
  // helper ne doit pas la réécrire, les tests du bundle la pincent déjà.
  const attendu =
    'Travaille sur la mission MIS-42 — Reload onglet mission.\n\n' +
    "Lis d'abord le ticket avec le CLI, jamais sa page HTML (tronquée) :\n" +
    'gh issue view 42 -R daedalforge/missions --json number,title,state,body,labels,milestone,assignees,comments\n' +
    "Étape en cours : exécution (statut in-progress). Tu ne fais que l’exécution : la branche depuis la base, les commits, la PR vers la base avec `Closes #N`, la revue interne à l'aveugle du diff, le journal et la checklist à jour ; si elle valide, le ticket passe en in-review et tu t’arrêtes, sinon tu corriges les constats et tu fais relire jusqu’à validation.\n\n" +
    "Chaque étape se joue dans une nouvelle session : à la fin de celle-ci, arrête-toi ; l'étape suivante sera une nouvelle session.\n\n" +
    'Branche : fix/mis-42 ; base : main.\n' +
    'Worktree de mission : ~/projects/missions-MIS-42 — le clone ~/projects/missions garde sa base, réservé aux tests manuels.\n\n' +
    'Playbook à lire : playbook/execution.md.\n\n' +
    'Journal de mission : missions/MIS-42/journal.md — tiens-le à jour à chaque étape.\n\n' +
    'Checklist de mission : missions/MIS-42/checklist.md — coche chaque point avec sa preuve.\n\n' +
    "Garde-fou : tu ne merges jamais la PR et tu n'écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s'il te le demande."

  assert.equal(missionSessionPrompt(TEMOIN), attendu)
  assert.doesNotMatch(missionSessionPrompt(TEMOIN), /Dépôt du projet/)
})

test('le worktree de la mission dérive du clone et de la clé', () => {
  // Given une mission qui déclare son clone, sa clé, sa branche et sa base
  // When le chemin du worktree est dérivé
  // Then il vaut le clone suffixé par la clé, un enfant direct de ~/projects
  assert.equal(missionWorktree(TEMOIN), '~/projects/missions-MIS-42')

  // Then un champ manquant interdit la dérivation au lieu d'inventer un chemin
  assert.equal(missionWorktree({ ...TEMOIN, repo: null }), null)
  assert.equal(missionWorktree({ ...TEMOIN, key: null }), null)
  assert.equal(missionWorktree({ ...TEMOIN, branch: null }), null)
  assert.equal(missionWorktree({ ...TEMOIN, base: null }), null)
})

test('le prompt d’exécution nomme le worktree de la mission, les autres étapes non', () => {
  // Given une mission déclarée avec son clone, sa branche et sa base
  // When le prompt de session est composé pour l'exécution
  // Then les deux états de l'exécution nomment le worktree et le clone gardé sur sa base
  for (const state of ['ready', 'in-progress']) {
    const prompt = missionSessionPrompt({ ...TEMOIN, state })
    assert.match(
      prompt,
      /Worktree de mission : ~\/projects\/missions-MIS-42 — le clone ~\/projects\/missions garde sa base, réservé aux tests manuels\./,
    )
  }

  // Then cadrage, revue et clôture n'en portent aucun
  for (const state of ['to-refine', 'in-review', 'ready-for-prod']) {
    assert.doesNotMatch(missionSessionPrompt({ ...TEMOIN, state }), /Worktree de mission/)
  }
})

test('les remontées de revue et la session libre nomment le même worktree', () => {
  // Given une mission dont la branche vit dans un worktree, quel que soit l'état
  // When les prompts des remontées et de la session libre sont composés
  // Then les deux nomment le worktree et le clone qui garde sa base
  for (const state of ['in-progress', 'in-review']) {
    const prompt = feedbackSessionPrompt({ ...TEMOIN, state })
    assert.match(prompt, /Dépôt du projet : ~\/projects\/missions\./)
    assert.match(
      prompt,
      /Worktree de mission : ~\/projects\/missions-MIS-42 — le clone ~\/projects\/missions garde sa base, réservé aux tests manuels\./,
    )
  }

  const libre = freeSessionPrompt(TEMOIN)
  assert.match(libre, /Dépôt du projet : ~\/projects\/missions\./)
  assert.match(libre, /Branche : fix\/mis-42 ; base : main\./)
  assert.match(
    libre,
    /Worktree de mission : ~\/projects\/missions-MIS-42 — le clone ~\/projects\/missions garde sa base, réservé aux tests manuels\./,
  )

  // Then sans clone déclaré, aucun des deux prompts n'invente de worktree
  assert.doesNotMatch(feedbackSessionPrompt({ ...TEMOIN, repo: null }), /Worktree de mission/)
  assert.doesNotMatch(freeSessionPrompt({ ...TEMOIN, repo: null }), /Worktree de mission/)
})

test('le brief de revue constate la validation des collègues, mot pour mot', () => {
  // La revue n'est plus la relecture du diff : ce brief est celui des
  // collègues, et il est épinglé comme celui de l'exécution.
  assert.equal(
    STEP_BRIEFS.revue,
    'Tu ne fais que la revue : la revue du diff est celle de tes collègues et a eu lieu en exécution ; tu constates leur validation sur la PR (`gh pr view --json reviewDecision,reviews`), tu vérifies que chaque critère d’acceptation porte sa preuve, que le périmètre et les tests tiennent, que le journal et la checklist sont à jour, tu écris la décision datée dans le ticket, tu poses le label ready-for-prod et tu t’arrêtes ; sans validation des collègues, tu nommes ce qui manque et tu ne déplaces pas les labels.',
  )

  const prompt = missionSessionPrompt({ ...TEMOIN, state: 'in-review' })
  assert.match(prompt, /Étape en cours : revue \(statut in-review\)\. Tu ne fais que la revue : la revue du diff est celle de tes collègues/)
  assert.match(prompt, /constates leur validation sur la PR/)
  assert.match(prompt, /chaque critère d’acceptation porte sa preuve/)
  assert.match(prompt, /tu poses le label ready-for-prod/)
  assert.match(prompt, /sans validation des collègues, tu nommes ce qui manque et tu ne déplaces pas les labels/)
  assert.match(prompt, /Playbook à lire : playbook\/revue\.md\./)
  assert.match(prompt, /Journal de mission : missions\/MIS-42\/journal\.md/)
  assert.match(prompt, /Checklist de mission : missions\/MIS-42\/checklist\.md/)
  assert.match(prompt, /tu ne merges jamais la PR/)
  // La relecture du diff n'est plus le geste : l'ancien brief ne survit pas.
  assert.doesNotMatch(prompt, /chaque critère avec sa preuve, le diff/)
  assert.doesNotMatch(prompt, /tu approuves/)
})

test('chaque état nomme la page de playbook de son étape', () => {
  // La correspondance est épinglée ici, indépendamment de lib/view.js : une
  // table retournée doit casser ce test, pas le traverser.
  const PAGE_BY_STATE = {
    'to-refine': 'playbook/cadrage.md',
    ready: 'playbook/execution.md',
    'in-progress': 'playbook/execution.md',
    'in-review': 'playbook/revue.md',
    'ready-for-prod': 'playbook/cloture.md',
  }
  for (const [state, page] of Object.entries(PAGE_BY_STATE)) {
    const prompt = missionSessionPrompt({ ...TEMOIN, state })
    assert.ok(prompt.includes(`Playbook à lire : ${page}.`), `${state} → ${page}`)
  }
})

test('la session libre et les remontées nomment la page workspace', () => {
  assert.match(freeSessionPrompt(TEMOIN), /Playbook à lire : playbook\/workspace\.md\./)
  assert.match(feedbackSessionPrompt(TEMOIN), /Playbook à lire : playbook\/workspace\.md\./)
})

test('le prompt des remontées demande la PR, le tri, le push et le garde-fou', () => {
  assert.match(FEEDBACK_BRIEF, /<branche>/, 'le brief porte le gabarit de branche')
  const prompt = feedbackSessionPrompt(TEMOIN)

  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  // Le ticket se lit avec le CLI, commentaires compris, comme pour la session.
  assert.match(prompt, /gh issue view 42 -R daedalforge\/missions --json [^\n]*comments/)
  // Le clone du projet est nommé : la session n'a pas à le deviner.
  assert.match(prompt, /Dépôt du projet : ~\/projects\/missions\./)
  assert.match(prompt, /Branche : fix\/mis-42 ; base : main\./)
  // La PR se retrouve par la branche, et ses fils se lisent en ligne.
  assert.match(prompt, /gh pr list --head fix\/mis-42 --state all/)
  assert.match(prompt, /pulls\/<n>\/comments/)
  // Chaque remontée est triée, sans élargir le périmètre.
  assert.match(prompt, /corriger \/ répondre \/ hors périmètre/)
  assert.match(prompt, /corrige sur la branche et pousse/)
  assert.match(prompt, /`<CLÉ>: <impératif>`/)
  // Journal et checklist restent les preuves de l'étape.
  assert.match(prompt, /Journal de mission : missions\/MIS-42\/journal\.md/)
  assert.match(prompt, /Checklist de mission : missions\/MIS-42\/checklist\.md/)
  // Le fil n'est jamais résolu par la session : elle répond, le relecteur ferme.
  assert.match(prompt, /sans en résoudre aucun, même corrigé/)
  assert.match(prompt, /au relecteur, et à lui seul, de fermer son fil/)
  // Le garde-fou est complet : merge, main, labels, fermeture.
  assert.match(prompt, /tu ne merges jamais la PR/)
  assert.match(prompt, /tu n'écris jamais sur main/)
  assert.match(prompt, /tu ne touches pas aux labels/)
  assert.match(prompt, /tu ne fermes pas le ticket/)
})

test('sans dépôt déclaré, le prompt des remontées n’invente pas de clone', () => {
  const prompt = feedbackSessionPrompt({ ...TEMOIN, repo: null })
  assert.doesNotMatch(prompt, /Dépôt du projet/)
  assert.match(prompt, /gh pr list --head fix\/mis-42 --state all/)
})

test('le prompt de session libre porte l’identité, le ticket, le statut et les chemins', () => {
  const prompt = freeSessionPrompt(TEMOIN)

  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  // Le ticket se lit au CLI, commentaires compris, jamais sur sa page HTML.
  assert.match(prompt, /gh issue view 42 -R daedalforge\/missions --json [^\n]*comments/)
  assert.doesNotMatch(prompt, /https:\/\/github\.com/)
  // Le statut est une information, pas une étape.
  assert.match(prompt, /Statut du ticket : in-progress \(information seule\)\./)
  // Le clone du projet et la branche déclarée : la session n'a rien à deviner.
  assert.match(prompt, /Dépôt du projet : ~\/projects\/missions\./)
  assert.match(prompt, /Branche : fix\/mis-42 ; base : main\./)
  // Journal et checklist sont nommés pour être tenus à jour, pas en lecture seule.
  assert.match(prompt, /Journal de mission : missions\/MIS-42\/journal\.md — tiens-le à jour\./)
  assert.match(
    prompt,
    /Checklist de mission : missions\/MIS-42\/checklist\.md — coche chaque point avec sa preuve\./,
  )
  assert.doesNotMatch(prompt, /en lecture seule/)
})

test('un ticket Jira en session libre garde son lien, sans commande gh inventée', () => {
  const prompt = freeSessionPrompt({ ...TEMOIN, url: 'https://example.atlassian.net/browse/EX-1541' })

  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  assert.match(prompt, /Ouvre d'abord le ticket : https:\/\/example\.atlassian\.net\/browse\/EX-1541 — depuis le CLI du tracker, jamais la page HTML/)
  // Aucune commande `gh` ne s'invente pour un tracker qui n'en a pas.
  assert.doesNotMatch(prompt, /gh issue view/)
})

test('le prompt de session libre ne joue aucune étape du workflow', () => {
  const prompt = freeSessionPrompt(TEMOIN)

  assert.match(prompt, /Session libre/)
  assert.match(prompt, /aucune étape du workflow/)
  // Aucune ligne d'étape, et chacun des quatre briefs est absent.
  assert.doesNotMatch(prompt, /Étape en cours/)
  for (const brief of Object.values(STEP_BRIEFS)) {
    assert.ok(!prompt.includes(brief), `le brief d'étape ne doit pas fuiter : ${brief.slice(0, 40)}…`)
  }
  assert.doesNotMatch(prompt, /Chaque étape se joue dans une nouvelle session/)
  assert.doesNotMatch(prompt, /la branche depuis la base/)
})

test('le prompt de session libre ouvre les écritures de la mission, ferme le workflow', () => {
  const prompt = freeSessionPrompt(TEMOIN)

  // L'ancien interdit tombe : la libre écrit dans la mission.
  assert.doesNotMatch(prompt, /Tu n’écris rien/)
  assert.match(prompt, /Tu peux écrire dans la mission/)
  assert.match(prompt, /le journal, la checklist, le ticket \(corps et commentaires\)/)
  assert.match(
    prompt,
    /le dépôt du projet \(fichiers, commits, push sur la branche, ouverture de la PR\)/,
  )
  // Le workflow reste fermé : statut, labels, étape, fermeture du ticket.
  assert.match(prompt, /Ce qui t’est interdit, c’est de toucher au workflow/)
  assert.match(prompt, /pas de changement de statut ni de label/)
  assert.match(prompt, /pas de fermeture du ticket/)
  assert.match(prompt, /tu ne joues aucune étape/)
  // Le garde-fou de mission : ni merge, ni écriture sur main.
  assert.match(prompt, /Tu ne merges jamais la PR/)
  assert.match(prompt, /tu n’écris jamais sur main/)
  assert.match(prompt, /le merge et la fermeture du ticket sont les gestes du demandeur/)
  // La sortie de la session : répondre, puis s'arrêter.
  assert.match(prompt, /Réponds à la question écrite à la suite de ce message/)
  assert.match(prompt, /Tu réponds, puis tu t’arrêtes\./)
})

test('sans branche ni base, le prompt libre n’invente pas de branche', () => {
  const prompt = freeSessionPrompt({ ...TEMOIN, branch: null, base: null })

  assert.doesNotMatch(prompt, /Branche : /)
  // Les chemins et l'identité restent : seule la déclaration manque.
  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  assert.match(prompt, /Journal de mission : missions\/MIS-42\/journal\.md/)
})

test('sans dossier, le prompt libre omet journal et checklist', () => {
  const prompt = freeSessionPrompt({ ...TEMOIN, folder: null })

  assert.doesNotMatch(prompt, /Journal de mission/)
  assert.doesNotMatch(prompt, /Checklist de mission/)
})

test('le prompt des conflits nomme le chemin, la branche, le geste et le garde-fou', () => {
  const depot = { name: 'missions', path: '/Users/moi/projects/missions', branch: 'feat/mis-163' }
  // La chaîne est pinnée au caractère près, comme celle du prompt de session :
  // elle est écrite une fois ici, pas recopiée dans le gabarit client.
  const attendu = [
    'Travaille sur les conflits du dépôt missions — résous ceux de sa branche courante.',
    '',
    'Chemin : /Users/moi/projects/missions.',
    'Branche courante : feat/mis-163.',
    '',
    'Inspecte d’abord l’état du dépôt avec `git status` et `git diff --name-only --diff-filter=U` : les fichiers qu’ils listent sont les conflits en cours (merge, rebase ou cherry-pick). S’il n’y a rien à résoudre, dis-le et arrête-toi, sans geste git.',
    '',
    'Sinon, résous chaque conflit en gardant l’intention des deux côtés, sans écraser le travail en cours et sans `--ours` ni `--theirs`, marque les fichiers résolus (`git add`) et termine l’opération commencée. Tu ne lances ni `git merge --abort`, ni `git rebase --abort`, ni `git stash` sans le demander.',
    '',
    'Garde-fou : tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s’il te le demande.',
    '',
    'Quand la branche est propre, résume ce que tu as résolu et arrête-toi.',
  ].join('\n')

  assert.equal(repositoryConflictPrompt(depot), attendu)
  // Le geste ne joue aucune étape : ce n'est pas une session de mission.
  assert.doesNotMatch(repositoryConflictPrompt(depot), /Étape en cours/)
  assert.doesNotMatch(repositoryConflictPrompt(depot), /Chaque étape se joue dans une nouvelle session/)
})

test('sans branche, le prompt des conflits dit le HEAD détaché et ne ment pas', () => {
  const prompt = repositoryConflictPrompt({ name: 'missions', path: '/Users/moi/projects/missions', branch: null })

  assert.match(prompt, /Branche courante : \(HEAD détaché\)\./)
  // Le geste ne connaît pas de conflit : le prompt le dit, sans le promettre.
  assert.match(prompt, /S’il n’y a rien à résoudre, dis-le et arrête-toi, sans geste git\./)
})

test('sans dépôt nommé, le prompt des conflits ne laisse pas de trou dans la phrase', () => {
  const prompt = repositoryConflictPrompt({})

  assert.match(prompt, /^Travaille sur les conflits du dépôt \(dépôt inconnu\)/)
  assert.match(prompt, /Chemin : \(chemin inconnu\)\./)
})

test('le prompt du squash nomme le chemin, la branche, la mission et le garde-fou', () => {
  const depot = { name: 'missions', path: '/Users/moi/projects/missions', branch: 'feat/mis-165' }
  // La chaîne est pinnée au caractère près, comme celle du prompt de session :
  // elle est écrite une fois ici, pas recopiée dans le gabarit client.
  const attendu = [
    'Travaille sur la remise en un seul commit du dépôt missions — replie sa branche courante sur sa base.',
    '',
    'Chemin : /Users/moi/projects/missions.',
    'Branche courante : feat/mis-165.',
    '',
    'Trouve d’abord la mission qui déclare cette branche : parcours missions/*/mission.yml et retiens celui dont le champ branch vaut exactement feat/mis-165. Si aucune mission ne la déclare, dis-le et arrête-toi sans geste git. Sinon, lis son ticket avec le CLI, jamais sa page HTML, puis lis son playbook : playbook/execution.md pour les gestes et playbook/workspace.md pour les quatorze interdits.',
    '',
    'Replie ensuite la branche sur sa base déclarée (le champ base de mission.yml), en capturant la pointe avant tout geste :',
    '',
    '- `git fetch origin` ;',
    '- `git rev-parse HEAD` : sa sortie est l’ancienne tête, la pointe de la branche avant le reset ; c’est elle que la preuve et le lease attendent ;',
    '- `git merge-base origin/<base> HEAD` : sa sortie est la cible du reset, pas l’ancienne tête ;',
    '- lis les commits à replier avec `git log --oneline <cible du reset>..HEAD` ;',
    "- `git reset --soft <cible du reset>`, puis un seul commit : son titre vient de `gh pr view --json title --jq .title` s’il existe une PR, sinon du sujet du dernier commit local ; ne le préfixe par '<clé>: ' que s’il ne l’est pas déjà, puis `git commit -m '<titre>'`.",
    '',
    'Avant de pousser, prouve que l’arbre ne bouge pas : `git diff <ancienne tête> HEAD` doit sortir vide.',
    '',
    'Puis :',
    '',
    '- `npm test` ;',
    '- `node tools/build.mjs`, puis `git diff --exit-code lib/client.js` doit sortir vide ;',
    '- mets à jour le journal de mission, la checklist et le corps de la PR (avec `Closes #N`) ;',
    '- `git push --force-with-lease=<branche>:<ancienne tête>` — une seule fois, sur cette branche seulement. Si la tête distante a bougé, si la branche n’est pas réductible ou si elle n’a déjà qu’un seul commit au-dessus de la base, arrête-toi et dis-le sans toucher à l’historique.',
    '',
    'Garde-fou : tu ne merges jamais la PR et tu n’écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s’il te le demande. Tu ne touches ni aux labels, ni au statut du ticket, ni à une autre branche, et tu ne demandes pas de revue.',
    '',
    'Quand c’est fait, résume le commit obtenu et arrête-toi.',
  ].join('\n')

  assert.equal(repositorySquashPrompt(depot), attendu)
  // Le geste ne joue aucune étape : ce n'est pas une session de mission.
  assert.doesNotMatch(repositorySquashPrompt(depot), /Étape en cours/)
  assert.doesNotMatch(repositorySquashPrompt(depot), /Chaque étape se joue dans une nouvelle session/)
})

test('le prompt du squash dit ce qu’il prouve : pointe capturée, cible du reset, un commit', () => {
  const prompt = repositorySquashPrompt({ name: 'missions', path: '/Users/moi/projects/missions', branch: 'feat/mis-165' })

  // La base n'est pas dans le détail du dépôt : la session la lit dans la mission.
  assert.match(prompt, /le champ base de mission\.yml/)
  assert.match(prompt, /git rev-parse HEAD/)
  assert.match(prompt, /git merge-base origin\/<base> HEAD/)
  // La cible du reset n'est pas l'ancienne tête : le diff et le lease
  // comparent à la pointe capturée avant le reset.
  assert.match(prompt, /git reset --soft <cible du reset>/)
  assert.match(prompt, /git diff <ancienne tête> HEAD` doit sortir vide/)
  assert.match(prompt, /git push --force-with-lease=<branche>:<ancienne tête>/)
  // Le titre ne double jamais le préfixe déjà présent.
  assert.match(prompt, /gh pr view --json title --jq \.title/)
  assert.match(prompt, /ne le préfixe par '<clé>: ' que s’il ne l’est pas déjà/)
  // Une mission déclare la branche ; aucune ne doit laisser la session deviner.
  assert.match(prompt, /Si aucune mission ne la déclare, dis-le et arrête-toi sans geste git\./)
  // Le garde-fou et la sortie, comme les autres sessions du panneau.
  assert.match(prompt, /tu ne merges jamais la PR/)
  assert.match(prompt, /tu n’écris jamais sur main/)
  assert.match(prompt, /Quand c’est fait, résume le commit obtenu et arrête-toi\./)
})

test('sans branche, le prompt du squash dit le HEAD détaché et ne ment pas', () => {
  const prompt = repositorySquashPrompt({ name: 'missions', path: '/Users/moi/projects/missions', branch: null })

  assert.match(prompt, /Branche courante : \(HEAD détaché\)\./)
})

test('sans dépôt nommé, le prompt du squash ne laisse pas de trou dans la phrase', () => {
  const prompt = repositorySquashPrompt({})

  assert.match(prompt, /^Travaille sur la remise en un seul commit du dépôt \(dépôt inconnu\)/)
  assert.match(prompt, /Chemin : \(chemin inconnu\)\./)
})

test('historyLabel chiffre le total par milliers, et nomme sa branche', () => {
  assert.equal(historyLabel({ total: 3094, branch: 'main' }), '3 094 commits on main')
  assert.equal(historyLabel({ total: 1, branch: 'feat/a' }), '1 commit on feat/a')
  assert.equal(historyLabel({ total: 0, branch: 'main' }), '0 commits on main')
  assert.equal(historyLabel({ total: 1234567, branch: 'main' }), '1 234 567 commits on main')
  assert.equal(historyLabel({}), '', 'un total inconnu ne s’invente pas')
  assert.equal(historyLabel({ total: 12 }), '', 'sans branche, pas de phrase')
})

test('worktreeLabel la fin du chemin', () => {
  assert.equal(worktreeLabel('/Users/moi/projects/myapp'), 'myapp')
  assert.equal(worktreeLabel('/Users/moi/projects/myapp/'), 'myapp')
  assert.equal(worktreeLabel('C:\\projects\\myapp'), 'myapp')
  assert.equal(worktreeLabel(null), '')
})

// ---------------------------------------------------------------------------
// Le relevé d'usage : le registre, les verdicts, le rapport.

const DAY = 86_400_000
const NOW = Date.parse('2026-11-12T12:00:00.000Z')
const ago = (days) => new Date(NOW - days * DAY).toISOString()

function counted(count = 1, { firstUsed = ago(10), lastUsed = ago(1), values = {} } = {}) {
  return { count, firstUsed, lastUsed, values }
}

// Une porte ouverte : le relevé a trente jours et cent gestes derrière lui.
function opened(events = 100) {
  return { startedAt: ago(30), updatedAt: ago(0), elements: { 'tab.dashboard': counted(events, { lastUsed: ago(0) }) } }
}

test('le registre déclare chaque geste du ticket, une fois, avec son libellé et sa section', () => {
  const ids = USAGE_ELEMENTS.map((element) => element.id)
  assert.equal(new Set(ids).size, ids.length, 'un identifiant est déclaré deux fois')

  for (const element of USAGE_ELEMENTS) {
    assert.match(element.id, /^[a-z][a-z-]*(\.[a-z][a-z-]*)+$/, `forme de l’identifiant : ${element.id}`)
    assert.ok(element.label.trim().length > 0, `libellé manquant : ${element.id}`)
    assert.ok(element.section.trim().length > 0, `section manquante : ${element.id}`)
    assert.ok(element.id.length <= USAGE_MAX_DETAIL, `identifiant trop long : ${element.id}`)
    assert.equal(usageElement(element.id)?.label, element.label)
  }

  // Les ids sont ceux des Notes techniques du ticket MIS-147, dans leur ordre ;
  // le geste d'archive, livré après par MIS-150, s'ajoute à sa place dans le
  // volet, l'épingle de MIS-14 suit le blocage qu'elle côtoie, et l'estimation
  // de MIS-53 suit la priorité qu'elle prolonge. Le registre ne prend pas
  // d'autre liberté avec le contrat.
  assert.deepEqual(ids, [
    'tab.dashboard', 'tab.missions', 'tab.done', 'tab.repositories', 'tab.workflows', 'tab.usage',
    'tab.playbook',
    'filter.search', 'filter.state', 'filter.type', 'filter.epic', 'filter.project', 'filter.priority',
    'filter.missing', 'filter.clear', 'list.refresh', 'list.retry',
    'search.q', 'search.family', 'preview.kind', 'mission.open',
    'dashboard.view-all', 'mission.archive.batch',
    'mission.tab.details', 'mission.tab.journal', 'mission.tab.checklist', 'mission.priority',
    'mission.points', 'mission.block', 'mission.pin', 'mission.declare', 'mission.open-tracker', 'mission.close-checkout', 'mission.archive', 'mission.tolgee',
    'mission.session', 'mission.feedback-session',
    'repository.open', 'repository.adopt', 'repository.remove', 'repository.tab.details', 'repository.tab.history',
    'repository.branch', 'repository.more', 'repository.resolve', 'repository.squash',
    'workflow.step', 'workflow.save', 'workflow.reload', 'workflow.gesture.add', 'workflow.gesture.remove',
    'workflow.arc.add', 'workflow.arc.update', 'workflow.arc.remove',
    'action.theme',
  ])

  // Les sections sont contiguës et dans l'ordre du registre : le rapport les
  // suit sans tri, donc l'ordre du fichier ne décide jamais de la lecture.
  const sections = USAGE_ELEMENTS.map((element) => element.section)
    .filter((section, index, all) => index === 0 || all[index - 1] !== section)
  assert.deepEqual(sections, ['Tabs', 'Mission list', 'Mission drawer', 'Repositories', 'Workflows', 'Panel'])
  assert.equal(usageElement('made.up'), null)
})

test('la porte passe avant tout verdict, puis le silence, puis les bornes du compte', () => {
  // Sous la porte, rien n'est jugé — même un geste utilisé cinquante fois.
  assert.equal(usageVerdict({ count: 50, lastUsed: ago(0) }, { now: NOW, total: 100, usage: { startedAt: ago(3), elements: { 'tab.dashboard': counted(100) } } }), 'none')
  // Vingt gestes en trois jours ne font pas une semaine, et sept jours à deux
  // gestes ne font pas vingt gestes : les deux moitiés de la porte comptent.
  assert.equal(usageVerdict({ count: 50, lastUsed: ago(0) }, { now: NOW, total: 100, usage: { startedAt: ago(3), elements: { 'tab.dashboard': counted(100) } } }), 'none')
  assert.equal(usageVerdict({ count: 50, lastUsed: ago(0) }, { now: NOW, total: 9, usage: { startedAt: ago(30), elements: { 'tab.dashboard': counted(9) } } }), 'none')
  assert.equal(usageGate({ startedAt: ago(30), elements: { 'tab.dashboard': counted(20) } }, NOW).open, true)
  assert.equal(usageGate({ startedAt: ago(6), elements: { 'tab.dashboard': counted(200) } }, NOW).open, false)
  assert.equal(usageGate(null, NOW).open, false)

  const open = { now: NOW, total: 1000, usage: opened(1000) }
  // Zéro usage après la porte : à supprimer, sans détour.
  assert.equal(usageVerdict({ count: 0, lastUsed: null }, open), 'remove')
  // 1–2 usages : à améliorer.
  assert.equal(usageVerdict({ count: 1, lastUsed: ago(1) }, open), 'improve')
  assert.equal(usageVerdict({ count: USAGE_IMPROVE_COUNT, lastUsed: ago(1) }, open), 'improve')
  // 3–14 usages : on garde.
  assert.equal(usageVerdict({ count: USAGE_IMPROVE_COUNT + 1, lastUsed: ago(1) }, open), 'keep')
  assert.equal(usageVerdict({ count: USAGE_GROW_COUNT - 1, lastUsed: ago(1) }, open), 'keep')
  // ≥ 15 usages, ou ≥ 10 % des gestes : le compte ou la part suffit.
  assert.equal(usageVerdict({ count: USAGE_GROW_COUNT, lastUsed: ago(1) }, open), 'grow')
  assert.equal(usageVerdict({ count: 10, lastUsed: ago(1) }, { now: NOW, total: 100, usage: opened(100) }), 'grow')
  assert.equal(usageVerdict({ count: 9, lastUsed: ago(1) }, { now: NOW, total: 100, usage: opened(100) }), 'keep')
  // Un usage puis l'abandon au-delà de trente jours : à améliorer, pas « remove »
  // ni « grow » — le passé ne rachète pas le silence.
  assert.equal(usageVerdict({ count: 40, lastUsed: ago(USAGE_STALE_DAYS + 1) }, open), 'improve')
  assert.equal(usageVerdict({ count: 40, lastUsed: ago(USAGE_STALE_DAYS) }, open), 'grow')
  // Une date illisible est un silence, pas une exception.
  assert.equal(usageVerdict({ count: 40, lastUsed: 'hier' }, open), 'improve')
  for (const verdict of ['grow', 'keep', 'improve', 'remove', 'none']) {
    assert.ok(USAGE_VERDICTS[verdict].label.length > 0, `libellé du verdict ${verdict}`)
  }
})

test('le rapport range les gestes par section et par compte, et garde les retirés dans le total', () => {
  const usage = {
    version: 1,
    startedAt: ago(40),
    updatedAt: ago(0),
    elements: {
      'tab.missions': counted(25, { lastUsed: ago(0) }),
      'tab.dashboard': counted(3, { lastUsed: ago(2) }),
      'tab.done': counted(3, { lastUsed: ago(5) }),
      'filter.state': counted(7, { values: { 'in-review': 4, ready: 3 } }),
      'old.gesture': counted(4, { lastUsed: ago(40) }),
    },
  }

  const report = usageReport(usage, NOW)

  // Les retirés comptent dans le total : un geste disparu du registre n'est
  // pas un geste qui n'a jamais eu lieu.
  assert.equal(report.total, 42)
  assert.equal(report.startedAt, ago(40))
  assert.equal(report.days, 40)
  assert.equal(report.gate.open, true)
  assert.equal(report.gate.events, 42)

  // Deux sections seulement — celles qui ont servi — et dans l'ordre du
  // registre, pas dans l'ordre du fichier.
  assert.deepEqual(report.sections.map((section) => section.title), ['Tabs', 'Mission list'])
  assert.deepEqual(report.sections[0].rows.map((row) => row.id), ['tab.missions', 'tab.dashboard', 'tab.done'])
  assert.deepEqual(report.sections[1].rows.map((row) => row.id), ['filter.state'])
  assert.deepEqual(report.top.map((row) => row.id), ['tab.missions', 'filter.state', 'tab.dashboard', 'tab.done'])

  const missions = report.rows.find((row) => row.id === 'tab.missions')
  assert.equal(missions.verdict, 'grow')
  assert.equal(missions.verdictLabel, 'Grow')
  assert.match(missions.reason, /25 gestures — the most used\./)
  assert.equal(report.rows.find((row) => row.id === 'tab.dashboard').count, 3)
  assert.equal(report.rows.find((row) => row.id === 'tab.dashboard').verdict, 'keep')

  // Les détails sont un compte par valeur, du plus utilisé au moins utilisé.
  assert.deepEqual(report.rows.find((row) => row.id === 'filter.state').details, [
    { detail: 'in-review', count: 4 },
    { detail: 'ready', count: 3 },
  ])

  assert.deepEqual(report.retired.map((row) => row.id), ['old.gesture'])
  assert.equal(report.retired[0].count, 4)
  // Le jamais-utilisé reste « sans verdict » quand la porte est ouverte : il a
  // eu sa chance, et le rapport le dit.
  assert.equal(report.idle.length, USAGE_ELEMENTS.length - 4)
  assert.ok(report.idle.every((row) => row.count === 0))
  assert.ok(report.idle.every((row) => row.verdict === 'remove'))

  // L'ordre du fichier ne change pas la lecture.
  const reordered = { ...usage, elements: Object.fromEntries(Object.entries(usage.elements).reverse()) }
  assert.deepEqual(usageReport(reordered, NOW).sections, report.sections)
})

test('un relevé d’avant MIS-18 garde ses clics de tri dans les retirés', () => {
  // Given un usage.json qui compte encore le select de tri, retiré depuis.
  const usage = {
    version: 1,
    startedAt: ago(10),
    updatedAt: ago(0),
    elements: {
      'tab.missions': counted(3, { lastUsed: ago(0) }),
      'filter.sort': counted(7, { values: { points: 5, priority: 2 } }),
    },
  }

  // When le rapport le lit.
  const report = usageReport(usage, NOW)

  // Then le geste n'est plus une ligne du registre, mais son compte reste dans
  // les retirés et dans le total : un geste disparu n'est pas un geste qui n'a
  // jamais eu lieu.
  assert.equal(report.rows.some((row) => row.id === 'filter.sort'), false)
  assert.deepEqual(report.retired.map((row) => row.id), ['filter.sort'])
  assert.equal(report.retired[0].count, 7)
  assert.equal(report.total, 10)
})

test('le rapport est total : un relevé absent, sale ou cassé parle quand même', () => {
  const empty = usageReport(null, NOW)
  assert.equal(empty.total, 0)
  assert.equal(empty.broken, false)
  assert.deepEqual(empty.sections, [])
  assert.deepEqual(empty.top, [])
  assert.deepEqual(empty.retired, [])
  assert.equal(empty.days, 0)
  assert.equal(empty.gate.open, false)
  assert.equal(empty.idle.length, USAGE_ELEMENTS.length)
  assert.ok(empty.idle.every((row) => row.verdict === 'none'))

  const broken = usageReport({ broken: true, elements: {} }, NOW)
  assert.equal(broken.broken, true)
  assert.equal(broken.total, 0)

  const values = { ok: '3.7', '': 4, 'x\u0000y': 2 }
  values['z'.repeat(90)] = 1
  const dirty = usageReport({ startedAt: 'hier', elements: { 'tab.missions': { count: '2.9', firstUsed: 'hier', lastUsed: null, values } } }, NOW)
  const row = dirty.rows.find((entry) => entry.id === 'tab.missions')
  assert.equal(row.count, 2)
  assert.equal(row.firstUsed, null)
  assert.equal(row.lastUsed, null)
  assert.equal(dirty.total, 2)
  assert.equal(dirty.startedAt, null)
  // Un détail vide, à caractères de contrôle ou trop long est écarté à la
  // lecture : la ligne reste lisible même si le fichier a été édité à la main.
  assert.deepEqual(row.details, [{ detail: 'ok', count: 3 }])
  assert.equal(USAGE_MAX_VALUES >= 5, true)
})

test('les branches à pousser croisent les missions ouvertes et le scan', () => {
  const missions = [
    { key: 'M-1', state: 'in-progress', branch: 'feat/mis-192' },
    { key: 'M-2', state: 'ready', branch: 'feat/mis-200' },
    // Une branche que la racine ne porte pas n'a pas de ligne : le widget
    // n'ouvre que ce qu'il peut montrer.
    { key: 'M-3', state: 'ready', branch: 'feat/absente' },
    // Sans branche déclarée, rien à pousser.
    { key: 'M-4', state: 'ready', branch: null },
    // Une close ne pousse plus rien, même si son worktree traîne encore.
    { key: 'M-5', state: 'done', branch: 'feat/closes' },
  ]
  const repositories = [
    { name: 'missions', kind: 'clone', branch: 'feat/mis-192', upstream: 'origin/main', ahead: 2, behind: 0, dirty: 0 },
    { name: 'missions-mis-192', kind: 'worktree', branch: 'feat/mis-192', upstream: 'origin/main', ahead: 4, behind: 0, dirty: 0 },
    { name: 'missions-mis-200', kind: 'worktree', branch: 'feat/mis-200', upstream: null, ahead: 0, behind: 0, dirty: 0 },
    { name: 'missions-closes', kind: 'worktree', branch: 'feat/closes', upstream: 'origin/main', ahead: 7, behind: 0, dirty: 0 },
  ]

  const rows = branchesToPush(missions, repositories)
  // Une branche tenue par un clone et par un worktree est une ligne, et c'est
  // le worktree qui la porte : c'est là que le travail se fait.
  assert.deepEqual(rows.map((row) => row.mission.key), ['M-1', 'M-2'])
  assert.equal(rows[0].repository.name, 'missions-mis-192')
  assert.equal(rows[0].label, '+4 commits')
  assert.equal(rows[0].neverPushed, false)
  // Jamais partie : aucun amont, donc aucune avance à afficher.
  assert.equal(rows[1].neverPushed, true)
  assert.equal(rows[1].label, 'never pushed')
  assert.equal(rows[1].reason, 'never-pushed')

  assert.deepEqual(branchesToPush([], repositories), [])
  assert.deepEqual(branchesToPush(missions, []), [])
})

test('une branche avec amont et rien à envoyer ne fait pas de ligne', () => {
  const rows = branchesToPush(
    [{ key: 'M-1', state: 'in-progress', branch: 'feat/tranquille' }],
    [{ name: 'missions', kind: 'clone', branch: 'feat/tranquille', upstream: 'origin/feat/tranquille', ahead: 0, behind: 0, dirty: 0 }],
  )
  assert.deepEqual(rows, [])

  // Une avance d'un seul commit se dit au singulier.
  const une = branchesToPush(
    [{ key: 'M-1', state: 'in-progress', branch: 'feat/tranquille' }],
    [{ name: 'missions', kind: 'clone', branch: 'feat/tranquille', upstream: 'origin/feat/tranquille', ahead: 1, behind: 0, dirty: 0 }],
  )
  assert.equal(une[0].label, '+1 commit')
})

test('les dépôts à réparer portent une raison, la plus grave, et jamais deux', () => {
  const rows = checkoutsToFix([
    { name: 'propre', error: null, behind: 0, dirty: 0 },
    { name: 'sale', error: null, behind: 0, dirty: 3 },
    // Un retard et de la saleté : le retard passe, il demande un autre geste.
    { name: 'retard', error: null, behind: 2, dirty: 5 },
    // Illisible : la gravité l'emporte sur tout le reste.
    { name: 'casse', error: 'fatal: not a git repository', behind: 4, dirty: 1 },
  ])

  assert.deepEqual(rows.map((row) => [row.repository.name, row.reason, row.label]), [
    ['casse', 'error', 'unreadable'],
    ['retard', 'behind', '2 behind'],
    ['sale', 'dirty', '3 dirty'],
  ])
  // Un dépôt propre n'est pas une ligne : le dashboard est un digest.
  assert.equal(rows.some((row) => row.repository.name === 'propre'), false)
  assert.deepEqual(checkoutsToFix([]), [])
})

test('les périmètres de la section Repositories comptent ce que les cartes montrent', () => {
  const summary = {
    count: 3,
    repositories: [
      { name: 'propre', error: null, behind: 0, dirty: 0 },
      { name: 'retard', error: null, behind: 2, dirty: 0 },
      { name: 'sale', error: null, behind: 0, dirty: 1 },
    ],
  }
  assert.deepEqual(repositoryScope(summary), { count: 3, toFix: 2, label: '3 repositories · 2 to fix' })
  // Sans compte annoncé, la longueur du scan fait foi.
  assert.equal(repositoryScope({ repositories: [summary.repositories[0]] }).label, '1 repository · 0 to fix')
  // Un scan absent ne prétend rien : zéro ligne, zéro à réparer.
  assert.equal(repositoryScope().label, '0 repositories · 0 to fix')
})

test('un clone froid se compte en jours, pas en heures', () => {
  // La constante est la règle du pied de carte : trois dépôts, pas un de moins.
  assert.equal(COLD_CHECKOUT_DAYS, 30)
})

const STATUTS = {
  workflow: 'statuts',
  kind: 'statuts',
  title: 'Statuts des missions',
  entry: 'to-refine',
  exit: ['done'],
  nodes: [
    { id: 'to-refine', label: 'À cadrer' },
    { id: 'ready', label: 'Prête' },
    { id: 'in-progress', label: 'En cours' },
    { id: 'in-review', label: 'En revue' },
    { id: 'ready-for-prod', label: 'Prête à partir' },
    { id: 'done', label: 'Terminée' },
  ],
  edges: [
    { from: 'to-refine', to: 'ready', when: 'cadrage validé' },
    { from: 'ready', to: 'in-progress', when: 'branche poussée' },
    { from: 'in-progress', to: 'in-review', when: 'PR ouverte et complète' },
    { from: 'in-progress', to: 'to-refine', when: 'cadrage faux' },
    { from: 'in-review', to: 'ready-for-prod', when: 'revue approuvée' },
    { from: 'in-review', to: 'in-progress', when: 'changements demandés' },
    { from: 'in-review', to: 'to-refine', when: 'diff hors périmètre' },
    { from: 'ready-for-prod', to: 'done', when: 'merge et ticket fermé' },
  ],
}

test('les six états d’un workflow de statuts se dessinent dans l’ordre du parcours', () => {
  const graph = layoutWorkflow(STATUTS)

  assert.deepEqual(graph.boxes.map((box) => [box.id, box.kind, box.level]), [
    ['to-refine', 'etat', 0],
    ['ready', 'etat', 1],
    ['in-progress', 'etat', 2],
    ['in-review', 'etat', 3],
    ['ready-for-prod', 'etat', 4],
    ['done', 'etat', 5],
  ])
  assert.equal(graph.boxes[0].id, STATUTS.entry, 'to-refine est l’état initial')
  assert.equal(graph.boxes.at(-1).id, STATUTS.exit[0], 'done est l’état terminal')
  assert.deepEqual(graph.decisions, [], 'un état n’a pas de losange de décision')
})

test('les huit transitions d’un workflow de statuts sont des arcs, les retours en pointillé', () => {
  const graph = layoutWorkflow(STATUTS)

  assert.equal(graph.links.length, 8)
  assert.deepEqual(
    graph.links.filter((link) => link.back).map((link) => [link.from, link.to]),
    [
      ['in-progress', 'to-refine'],
      ['in-review', 'in-progress'],
      ['in-review', 'to-refine'],
    ],
  )
  assert.ok(graph.links.every((link) => link.when), 'chaque transition porte son libellé')
  // Les retours passent à droite de toutes les boîtes.
  const right = Math.max(...graph.boxes.map((box) => box.x + box.width))
  for (const link of graph.links.filter((link) => link.back)) {
    assert.ok(link.labelX > right)
  }
  assert.ok(graph.width > right)
})

test('un workflow de statuts neuf se dessine en échelle, un état par rangée', () => {
  const graph = layoutWorkflow({ ...STATUTS, edges: [] })

  assert.deepEqual(graph.boxes.map((box) => box.id), STATUTS.nodes.map((node) => node.id))
  assert.deepEqual(graph.boxes.map((box) => box.level), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(graph.links, [])
})

test('endPoints d’un workflow de statuts énumère les six états une fois, sans doublon', () => {
  const points = endPoints(STATUTS)

  assert.deepEqual(points, STATUTS.nodes.map((node) => ({ id: node.id, kind: 'etat' })))
})

// ---------------------------------------------------------------------------
// L'arbre de l'onglet Missions : le matcher, ses familles, ses comptes.
//
// La fixture ne porte que ce que le composant générique exige — une clé, un
// titre, des lignes de checklist — pour que ces tests restent vrais même si
// l'onglet change de rendu : la logique pure est ce qui décide.
// ---------------------------------------------------------------------------

test('epicParts rend la clé courte et le titre que les trackers composent', () => {
  // Given la valeur composée que posent GitHub et Jira
  const epic = 'MIS-2 · Missions v1'

  // When le découpage la lit
  const parts = epicParts(epic)

  // Then la clé et le titre sont deux textes, chacun une fois
  assert.deepEqual(parts, { key: 'MIS-2', title: 'Missions v1' })
})

test('epicParts découpe au premier séparateur et garde le reste du titre entier', () => {
  // Given un titre qui contient lui-même le séparateur
  const epic = 'SO-483 · Ouvrir · la réservation'

  // When le découpage le lit
  const parts = epicParts(epic)

  // Then le titre garde son séparateur interne
  assert.deepEqual(parts, { key: 'SO-483', title: 'Ouvrir · la réservation' })
})

test('epicParts rend la valeur seule comme clé quand elle n’a pas de séparateur', () => {
  // Given un epic Jira sans summary
  const epic = 'SO-483'

  // When le découpage le lit
  const parts = epicParts(epic)

  // Then il n’y a pas de titre à côté de la clé
  assert.deepEqual(parts, { key: 'SO-483', title: '' })
})

test('epicParts ne rend ni clé ni titre pour une valeur vide', () => {
  // Given une valeur absente, vide ou sans texte
  const vides = ['', '   ', null, undefined, 42]

  // When le découpage les lit
  const parts = vides.map((epic) => epicParts(epic))

  // Then aucun des deux textes n’est rendu
  assert.deepEqual(parts, vides.map(() => ({ key: '', title: '' })))
})

const OUTLINE_ROWS = [
  {
    id: 'MIS-206',
    key: 'MIS-206',
    title: 'Supprimer le panneau droit et son contenu',
    group: 'MIS-4',
    groupLabel: 'Missions v2',
    lines: [
      { text: 'Remove the right pane from the dashboard', state: 'checked' },
      { text: 'Session key still restores the tab', state: 'checked' },
      { text: 'Tests for the empty right pane', state: 'open' },
    ],
  },
  {
    id: 'MIS-207',
    key: 'MIS-207',
    title: 'Playbook : éditer une page sans la perdre',
    group: 'MIS-4',
    groupLabel: 'Missions v2',
    lines: [{ text: 'Relire la page avant de la fermer', state: 'open' }],
  },
  {
    id: 'MIS-214',
    key: 'MIS-214',
    title: 'Afficher les workflows non versionnés',
    group: 'MIS-2',
    groupLabel: 'Workflows v1',
    lines: [],
  },
]

/** Les groupes d'une liste de lignes, tels que le matcher les lit. */
function groupRows(rows = []) {
  const groups = new Map()
  for (const row of rows) {
    const id = row.group === null || row.group === undefined ? '' : String(row.group)
    if (!groups.has(id)) groups.set(id, { id, label: String(row.groupLabel ?? id), rows: [] })
    groups.get(id).rows.push(row)
  }
  return [...groups.values()].sort((left, right) => {
    if (left.id === '' && right.id !== '') return 1
    if (right.id === '' && left.id !== '') return -1
    return left.label.localeCompare(right.label)
  })
}

const OUTLINE_GROUPS = groupRows(OUTLINE_ROWS)

/** Un portefeuille de douze missions, pour les comptes. */
function twelveGroups() {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `MIS-${200 + index}`,
    key: `MIS-${200 + index}`,
    title: `Mission ${index + 1}`,
    group: 'MIS-4',
    groupLabel: 'Missions v2',
    lines: index === 0 ? [{ text: 'Session key still restores the tab', state: 'open' }] : [],
  }))
  return groupRows(rows)
}

const OUTLINE_ACTIONS = [
  { id: 'declare-mission', label: 'Declare a mission', keywords: ['declare', 'new', 'create'] },
  { id: 'declare-tracker', label: 'Declare from a tracker key', keywords: ['declare', 'tracker', 'key'] },
  { id: 'refresh', label: 'Refresh the list', keywords: ['refresh', 'reload'] },
]

test('le matcher lit la clé, le titre, puis la checklist — dans cet ordre', () => {
  const result = matchOutline(OUTLINE_GROUPS, 'workflows')

  // « workflows » est dans un titre de mission et dans un libellé d'épic : les
  // deux familles répondent, et la mission passe devant l'épic.
  assert.deepEqual(result.matches.map((match) => match.kind), ['mission', 'epic'])
  assert.equal(result.matches[0].id, 'MIS-214')
  assert.equal(result.counts.mission, 1)
  assert.equal(result.counts.epic, 1)
})

test('un nombre trouve la clé qu’il désigne, et pas une clé qui l’allonge', () => {
  const byNumber = matchOutline(OUTLINE_GROUPS, '206')
  assert.equal(byNumber.matches[0].kind, 'mission')
  assert.equal(byNumber.matches[0].id, 'MIS-206')

  // Le nombre est lu comme la clé, pas comme un préfixe : 2060 ne trouve rien.
  const longer = matchOutline(OUTLINE_GROUPS, '2060')
  assert.deepEqual(longer.matches, [])
})

test('« session » trouve une mission par sa checklist, avec sa ligne d’ancrage', () => {
  const result = matchOutline(OUTLINE_GROUPS, 'session')

  assert.equal(result.counts.mission, 0)
  assert.equal(result.counts.checklist, 1)
  const [match] = result.matches
  assert.equal(match.kind, 'checklist')
  assert.equal(match.id, 'MIS-206')
  assert.match(match.anchors[0].text, /Session key/)
  assert.equal(match.hidden, 0)
  // L'arbre ne garde que la mission trouvée : les autres sont hors résultat.
  assert.equal(result.groups.length, 1)
  assert.deepEqual(result.groups[0].rows.map((entry) => entry.row.id), ['MIS-206'])
})

test('au plus deux lignes d’ancrage par mission, le reste en +N', () => {
  const rows = [{
    id: 'MIS-9',
    key: 'MIS-9',
    title: 'Trois fois le même mot',
    group: 'MIS-2',
    groupLabel: 'Workflows v1',
    lines: [
      { text: 'anchor un', state: 'open' },
      { text: 'anchor deux', state: 'open' },
      { text: 'anchor trois', state: 'open' },
    ],
  }]
  const [match] = matchOutline(groupRows(rows), 'anchor').matches

  assert.equal(match.anchors.length, OUTLINE_ANCHORS)
  assert.equal(match.hidden, 1)
})

test('un épic est un résultat : il déplie ses missions et compte ses ouvertes', () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `MIS-2${index}`,
    key: `MIS-2${index}`,
    title: `Tâche ${index + 1}`,
    group: 'MIS-2',
    groupLabel: 'Workflows v1',
    lines: [],
  }))
  const result = matchOutline(groupRows(rows), 'workflows')
  const [group] = result.groups

  assert.equal(result.counts.epic, 1)
  assert.equal(group.epic, true)
  assert.equal(group.rows.length, 4)
  assert.equal(outlineOpen(group.open), '4 open')
  // Quatre lignes de contexte, aucune mission trouvée par elle-même : le
  // compte des missions reste à zéro, et n'est pas additionné à l'épic.
  assert.equal(result.counts.mission, 0)
  assert.equal(result.matches.at(-1).kind, 'epic')
})

test('le compte du champ dit une seule unité par famille, jamais un total', () => {
  const rest = matchOutline(twelveGroups(), '')
  assert.equal(outlineCount(rest), '12 missions')

  const one = matchOutline(twelveGroups(), 'session')
  assert.equal(outlineCount(one, { esc: true }), '1 of 12 · esc')

  const checklist = matchOutline(twelveGroups(), 'session')
  assert.equal(outlineFamily(checklist), 'checklist')

  const epic = matchOutline(twelveGroups(), 'missions v2')
  assert.equal(outlineCount(epic, { esc: true }), '0 of 12 · 1 epic · esc')

  // Deux familles, deux libellés : jamais « 2 résultats ».
  assert.ok(!outlineCount(epic, { esc: true }).startsWith('2 '))
})

test('« declare » ne rend aucune mission et deux actions, avant tout le reste', () => {
  const result = matchOutline(OUTLINE_GROUPS, 'declare')
  const actions = matchActions(OUTLINE_ACTIONS, 'declare')

  assert.equal(actions.length, 2)
  assert.deepEqual(actions.map((action) => action.id), ['declare-mission', 'declare-tracker'])
  assert.equal(result.counts.mission, 0)
  assert.equal(result.counts.epic, 0)
  assert.deepEqual(result.groups, [])
  assert.equal(outlineFamily(result, actions.length), 'action')
  assert.equal(outlineCount(result, { esc: true, actions: actions.length }), '0 of 3 · 2 actions · esc')

  // Au repos, aucune action : elles ne sont pas une barre d'outils.
  assert.deepEqual(matchActions(OUTLINE_ACTIONS, ''), [])
})

test('les trois familles ne dépassent jamais trois actions', () => {
  const crowded = [...OUTLINE_ACTIONS, { id: 'a4', label: 'Declare one more', keywords: ['declare'] }]
  assert.equal(matchActions(crowded, 'declare').length, 3)
})

test('le clavier parcourt la même liste que l’œil : actions, épic, puis missions', () => {
  const result = matchOutline(OUTLINE_GROUPS, '')
  const actions = matchActions(OUTLINE_ACTIONS, 'declare')
  const entries = outlineEntries(matchOutline(twelveGroups(), 'declare'), actions)

  assert.deepEqual(entries.map((entry) => entry.kind), ['action', 'action'])
  // Plus de groupe : la liste ne connaît que les actions et les missions.
  assert.deepEqual(outlineEntries(result, []).slice(0, 2).map((entry) => entry.kind), ['mission', 'mission'])
  assert.ok(outlineEntries(result, []).every((entry) => entry.kind !== 'epic'))

  // La sélection est un identifiant stable : une requête qui garde la ligne
  // garde l'identifiant, donc le volet.
  const before = outlineEntries(result, []).find((entry) => entry.kind === 'mission')
  const after = outlineEntries(matchOutline(OUTLINE_GROUPS, 'session'), []).find((entry) => entry.kind === 'mission')
  assert.equal(before.id, 'mission:MIS-206')
  assert.equal(after.id, 'mission:MIS-206')
})

test('une recherche est comptée par sa longueur, jamais par son texte', () => {
  assert.equal(searchBucket(''), '0')
  assert.equal(searchBucket('a'), '1')
  assert.equal(searchBucket('mis'), '2-3')
  assert.equal(searchBucket('declare'), '4-7')
  assert.equal(searchBucket('  a long search term '), '8+')
})

test('un titre long se coupe sur un espace, pas au milieu d’un mot', () => {
  const title = 'Attendre une décision de design avant de supprimer le panneau droit'
  const clipped = clipTitle(title, 30)

  assert.ok(clipped.endsWith('…'))
  const kept = clipped.slice(0, -1)
  assert.ok(title.startsWith(kept))
  assert.ok(!kept.endsWith(' '))
  assert.ok(title[kept.length] === ' ')
  // Un titre qui tient ne bouge pas.
  assert.equal(clipTitle('Court', 30), 'Court')
})

test('l’infobulle s’ouvre au-dessus du déclencheur quand le panneau laisse la place', () => {
  const placed = placeTooltip(
    { top: 200, left: 100, width: 34, height: 34 },
    { top: 0, left: 0, width: 800, height: 600 },
    { width: 120, height: 30 },
  )

  assert.equal(placed.side, 'top')
  assert.equal(placed.top, 200 - 30 - TIP_GAP)
  assert.equal(placed.left, 100 + (34 - 120) / 2)
})

test('l’infobulle passe sous le déclencheur quand le haut du panneau manque', () => {
  const placed = placeTooltip(
    { top: 10, left: 300, width: 34, height: 34 },
    { top: 0, left: 0, width: 800, height: 600 },
    { width: 120, height: 30 },
  )

  assert.equal(placed.side, 'bottom')
  assert.equal(placed.top, 10 + 34 + TIP_GAP)
})

test('l’infobulle est ramenée dans la boîte du panneau, à droite comme à gauche', () => {
  const panel = { top: 0, left: 0, width: 800, height: 600 }
  const tip = { width: 120, height: 30 }

  const aDroite = placeTooltip({ top: 200, left: 760, width: 34, height: 34 }, panel, tip)
  assert.equal(aDroite.left, 800 - 120 - TIP_MARGIN)

  const aGauche = placeTooltip({ top: 200, left: 0, width: 34, height: 34 }, panel, tip)
  assert.equal(aGauche.left, TIP_MARGIN)

  // Un décalage hors du panneau rendu par un panneau qui défile ne sort pas :
  // la boîte mesurée est déjà relative au panneau, la marge la garde dedans.
  const decale = placeTooltip({ top: 200, left: 900, width: 34, height: 34 }, panel, tip)
  assert.equal(decale.left, 800 - 120 - TIP_MARGIN)
})
