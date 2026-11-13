import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actionVerb,
  endPoints,
  layoutWorkflow,
  modelOf,
  readStep,
  writeStep,
  nextGestureId,
  withoutEdge,
  upsertEdge,
  withoutNode,
  ageDays,
  assignedBugs,
  blockedReasonAfterWrite,
  branchFieldValue,
  EMPTY_FILTERS,
  epicOptions,
  parseChecklist,
  dashboardScope,
  executionBlocker,
  freeSessionBlocker,
  missionStep,
  missionSessionPrompt,
  feedbackSessionPrompt,
  freeSessionPrompt,
  FEEDBACK_BRIEF,
  FREE_BRIEF,
  ticketReadLine,
  standardsFiles,
  standardsProject,
  standardsReadLine,
  STANDARDS_DIR,
  STANDARDS_STEP_FILES,
  treeIndent,
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
  missionAge,
  needsYou,
  parseFilterSnapshot,
  pointsTotal,
  priorityOptions,
  projectOptions,
  QUIET_AFTER_DAYS,
  readFilterSnapshot,
  readTab,
  relativeAge,
  repositoryBranch,
  repositoryCommit,
  repositoryState,
  scanDuration,
  scanLabel,
  sortMissions,
  sortRepositories,
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
} from '../lib/view.js'
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
    project: 'manager',
    projectName: 'Manager',
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
  assert.deepEqual(filterMissions(MISSIONS, { query: 'manager' }).map((m) => m.key), ['a#2'])
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
  assert.deepEqual(filterMissions(MISSIONS, { project: 'manager', type: 'bug' }), [])
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
  const doneBar = { query: 'close', filters: { ...EMPTY_FILTERS, state: ['done'], project: 'missions' }, sort: 'priority' }
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

test('le tri priorité va du plus haut au plus bas, les sans-priorité en fin', () => {
  assert.deepEqual(sortMissions(MISSIONS, 'priority').map((m) => m.key), ['a#1', 'a#2', 'a#3'])
  const extra = [...MISSIONS, { key: 'a#0', priority: null, points: null }]
  assert.deepEqual(sortMissions(extra, 'priority').map((m) => m.key), ['a#1', 'a#2', 'a#3', 'a#0'])
  const tie = [
    { key: 'b#2', priority: 'normal', points: 2 },
    { key: 'b#1', priority: 'normal', points: 2 },
  ]
  assert.deepEqual(sortMissions(tie, 'priority').map((m) => m.key), ['b#1', 'b#2'])
})

test('le tri story points va du plus petit au plus grand, les sans-SP en fin', () => {
  assert.deepEqual(sortMissions(MISSIONS, 'points').map((m) => m.key), ['a#3', 'a#1', 'a#2'])
  const extra = [...MISSIONS, { key: 'a#0', priority: null, points: null }]
  assert.deepEqual(sortMissions(extra, 'points').map((m) => m.key), ['a#3', 'a#1', 'a#2', 'a#0'])
  assert.deepEqual(sortMissions(MISSIONS, null).map((m) => m.key), ['a#1', 'a#2', 'a#3'])
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
    { id: 'manager', name: 'Manager' },
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

test('une session exige un état unique, une branche et une base déclarées', () => {
  assert.equal(executionBlocker({ branch: 'gh-41', base: 'main' }), null)
  assert.equal(executionBlocker({ branch: 'gh-41', base: 'main', stateConflict: [] }), null)
  assert.equal(
    executionBlocker({ branch: 'gh-41', base: 'main', stateConflict: ['in-review', 'ready-for-prod'] }),
    'state labels conflict (in-review, ready-for-prod), keep one',
  )
  assert.equal(executionBlocker({ branch: 'gh-41' }), 'base branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker({ base: 'main' }), 'branch is not declared, set it below or in the mission folder')
  assert.equal(
    executionBlocker({ branch: 'gh-41', base: 'main', state: 'done' }),
    'mission is done: a closed mission plays no session',
  )
  assert.equal(executionBlocker({}), 'branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker({ branch: null, base: null }), 'branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker(), 'branch is not declared, set it below or in the mission folder')
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
  assert.equal(suggestBranch({ key: ' SO-1184 ', type: null }), 'feat/so-1184')
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

test('l’instantané de la barre garde recherche, filtres et tri', () => {
  const bar = {
    query: 'panneau',
    filters: { type: 'bug', state: ['ready'], epic: 'Workspace', priority: ['urgent'], project: 'missions', missing: 'any' },
    sort: 'points',
  }
  const snapshot = filterSnapshot(bar)
  assert.deepEqual(snapshot, {
    query: 'panneau',
    type: 'bug',
    state: ['ready'],
    epic: 'Workspace',
    priority: ['urgent'],
    project: 'missions',
    missing: 'any',
    sort: 'points',
  })
  // L'instantané revient en trois états : la barre telle que le panneau la tient.
  assert.deepEqual(filterBarState(snapshot), bar)
  // Une barre vide n'a rien d'actif : le panneau la traite comme au repos.
  assert.equal(hasActiveFilters(filterBarState(filterSnapshot({})).filters), false)
})

test('une valeur unique rangée par une barre d’avant la liste se relit en liste', () => {
  // La session d'avant MIS-94 garde un statut seul, et celle d'avant MIS-99 une
  // priorité seule : les relire ne doit ni les perdre ni les rendre en texte,
  // sinon le menu ne les cocherait pas.
  const legacy = filterSnapshot({ filters: { state: 'ready' } })
  assert.deepEqual(legacy.state, ['ready'])
  assert.deepEqual(filterBarState({ state: 'ready' }).filters.state, ['ready'])
  const legacyPriority = filterSnapshot({ filters: { priority: 'high' } })
  assert.deepEqual(legacyPriority.priority, ['high'])
  assert.deepEqual(filterBarState({ priority: 'high' }).filters.priority, ['high'])
})

test('un instantané ne retient que ce que la barre peut sélectionner', () => {
  const snapshot = filterSnapshot({
    query: 42,
    filters: { type: 'feat', state: 'cancelled', epic: '  Workspace  ', priority: '', project: 7, missing: 'yes' },
    sort: 'title',
  })
  // Type et état hors vocabulaire, priorité vide, projet non textuel : la barre
  // ne peut pas les afficher, ils tombent au lieu d'être restaurés.
  assert.deepEqual(snapshot, {
    query: '',
    type: null,
    state: null,
    epic: 'Workspace',
    priority: null,
    project: null,
    missing: null,
    sort: null,
  })
  // L'épic d'une mission est du texte libre : il reste tel quel.
  assert.equal(filterSnapshot({ filters: { epic: 'Hors périmètre' } }).epic, 'Hors périmètre')
})

test('un contenu illisible redonne la barre par défaut', () => {
  const empty = filterSnapshot({})
  for (const raw of [null, undefined, '', '   ', 'pas du json', '[]', '"texte"', 'null', '{}']) {
    assert.deepEqual(parseFilterSnapshot(raw), empty, `contenu ${String(raw)}`)
  }
  // Un instantané partiel garde ce qu'il porte et complète le reste.
  assert.deepEqual(
    parseFilterSnapshot(JSON.stringify({ query: 'abc', type: 'story' })),
    { ...empty, query: 'abc', type: 'story' },
  )
})

test('la session écrit la barre et retire la clé quand elle est vide', () => {
  const storage = memoryStorage()
  const bar = { query: 'panneau', filters: { ...EMPTY_FILTERS, project: 'missions' }, sort: 'priority' }

  writeFilterSnapshot(storage, bar)
  assert.deepEqual([...storage.entries.keys()], [FILTERS_KEY])
  assert.deepEqual(JSON.parse(storage.entries.get(FILTERS_KEY)), filterSnapshot(bar))
  assert.deepEqual(readFilterSnapshot(storage), filterSnapshot(bar))

  // Effacer la barre ne laisse pas de clé derrière elle : le prochain montage
  // repart du repos, pas d'une sélection vide.
  writeFilterSnapshot(storage, { query: '   ', filters: { ...EMPTY_FILTERS }, sort: null })
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

test('les widgets sélectionnent les bugs non résolus et les stories hautes, les plus anciennes d’abord', () => {
  const missions = [
    { key: 'bug-old', type: 'bug', state: 'to-refine', updatedAt: '2026-10-01T00:00:00Z' },
    { key: 'bug-new', type: 'bug', state: 'ready', updatedAt: '2026-11-01T00:00:00Z' },
    // Un bug clos n'est pas « non résolu » : le tracker peut l'envoyer (une
    // mission done déclarée sur le poste), le helper ne dépend pas de cette promesse.
    { key: 'bug-done', type: 'bug', state: 'done', updatedAt: '2026-09-01T00:00:00Z' },
    { key: 'story-urgent', type: 'story', priority: 'urgent', state: 'in-progress', updatedAt: '2026-11-05T00:00:00Z' },
    { key: 'story-high', type: 'story', priority: 'high', state: 'ready', updatedAt: '2026-11-03T00:00:00Z' },
    { key: 'story-normal', type: 'story', priority: 'normal', state: 'ready', updatedAt: '2026-10-01T00:00:00Z' },
    // Aucun état connu : la story reste dans le widget, tous états confondus.
    { key: 'task-high', type: 'story', priority: 'high', state: null, updatedAt: '2026-11-04T00:00:00Z' },
    // Une story close reste close : les widgets ne comptent que l'ouvert.
    { key: 'story-done', type: 'story', priority: 'urgent', state: 'done', updatedAt: '2026-08-01T00:00:00Z' },
  ]
  assert.deepEqual(assignedBugs(missions).map((m) => m.key), ['bug-old', 'bug-new'])
  assert.deepEqual(highPriorityStories(missions).map((m) => m.key), ['story-high', 'task-high', 'story-urgent'])
  assert.deepEqual(assignedBugs([]), [])
  assert.deepEqual(highPriorityStories([]), [])
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
  assert.deepEqual(labels, ['tout est conforme', 'un critère ou une preuve manque'])
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
  const jira = ticketReadLine('https://saasoffice.atlassian.net/browse/SOC-1541')
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
  repo: '~/projects/missions',
}

test('le prompt de session est la chaîne d’hier, au caractère près', () => {
  // Given
  const attendu =
    'Travaille sur la mission MIS-42 — Reload onglet mission.\n\n' +
    "Lis d'abord le ticket avec le CLI, jamais sa page HTML (tronquée) :\n" +
    'gh issue view 42 -R daedalforge/missions --json number,title,state,body,labels,milestone,assignees,comments\n' +
    'Étape en cours : exécution (statut in-progress). Tu ne fais que l’exécution : la branche depuis la base, les commits, la PR vers la base avec `Closes #N`, le journal et la checklist à jour ; à la fin, le ticket passe en in-review et tu t’arrêtes.\n\n' +
    "Chaque étape se joue dans une nouvelle session : à la fin de celle-ci, arrête-toi ; l'étape suivante sera une nouvelle session.\n\n" +
    'Branche : fix/mis-42 ; base : main.\n\n' +
    'Standards à lire : standards/code.md, standards/interdits.md, standards/repos/missions.md.\n\n' +
    'Journal de mission : missions/MIS-42/journal.md — tiens-le à jour à chaque étape.\n\n' +
    'Checklist de mission : missions/MIS-42/checklist.md — coche chaque point avec sa preuve.\n\n' +
    "Garde-fou : tu ne merges jamais la PR et tu n'écris jamais sur main — le merge et la fermeture du ticket sont les gestes du demandeur, même s'il te le demande."

  // When
  const prompt = missionSessionPrompt(TEMOIN)

  // Then
  assert.equal(prompt, attendu)
  assert.doesNotMatch(prompt, /Dépôt du projet/)
})

test('le prompt de chaque étape nomme ses standards et la fiche du dépôt', () => {
  // Given
  const cas = [
    ['to-refine', '~/projects/missions', [
      'standards/README.md',
      'standards/repos/missions.md',
    ]],
    ['ready', '~/projects/Manager', [
      'standards/code.md',
      'standards/interdits.md',
      'standards/repos/manager.md',
    ]],
    ['in-review', '~/projects/Connect', [
      'standards/revue.md',
      'standards/code.md',
      'standards/interdits.md',
      'standards/repos/connect.md',
    ]],
    ['ready-for-prod', '~/projects/missions', [
      'standards/interdits.md',
      'standards/revue.md',
    ]],
  ]

  // When
  const prompts = cas.map(([state, repo, files]) => [
    state,
    missionSessionPrompt({ ...TEMOIN, state, repo }),
    `Standards à lire : ${files.join(', ')}.`,
  ])

  // Then
  for (const [state, prompt, ligne] of prompts) {
    assert.ok(prompt.includes(ligne), `${state} lit « ${ligne} »`)
  }
})

test('sans dépôt déclaré, le prompt d’étape omet la fiche du dépôt', () => {
  // Given
  const mission = { ...TEMOIN, repo: null }

  // When
  const prompt = missionSessionPrompt(mission)

  // Then
  assert.ok(prompt.includes('Standards à lire : standards/code.md, standards/interdits.md.'))
  assert.doesNotMatch(prompt, /<projet>/)
})

test('la fiche d’un dépôt se déduit de son clone', () => {
  // Given
  const cas = [
    ['~/projects/Manager', 'manager'],
    ['~/projects/Connect/', 'connect'],
    ['~/projects/missions', 'missions'],
    ['missions', 'missions'],
    [null, null],
    ['  ', null],
  ]

  // When
  const fiches = cas.map(([repo]) => standardsProject(repo))

  // Then
  assert.deepEqual(fiches, cas.map(([, attendu]) => attendu))
})

test('les fichiers d’une étape sont des chemins de standards, dans l’ordre', () => {
  // Given
  const cas = [
    ['cadrage', 'missions', ['standards/README.md', 'standards/repos/missions.md']],
    ['clôture', 'manager', ['standards/interdits.md', 'standards/revue.md']],
    ['revue', null, ['standards/revue.md', 'standards/code.md', 'standards/interdits.md']],
    ['inconnue', 'missions', null],
  ]

  // When
  const fichiers = cas.map(([step, project]) => standardsFiles(step, project))

  // Then
  assert.deepEqual(fichiers, cas.map(([, , attendu]) => attendu))
  assert.equal(standardsReadLine('inconnue', 'missions'), null)
  assert.equal(STANDARDS_DIR, 'standards')
  assert.deepEqual(Object.keys(STANDARDS_STEP_FILES).sort(), [
    'cadrage',
    'clôture',
    'exécution',
    'revue',
  ])
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
  const prompt = freeSessionPrompt({ ...TEMOIN, url: 'https://saasoffice.atlassian.net/browse/SOC-1541' })

  assert.match(prompt, /^Travaille sur la mission MIS-42 — Reload onglet mission\./)
  assert.match(prompt, /Ouvre d'abord le ticket : https:\/\/saasoffice\.atlassian\.net\/browse\/SOC-1541 — depuis le CLI du tracker, jamais la page HTML/)
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

test('historyLabel chiffre le total par milliers, et nomme sa branche', () => {
  assert.equal(historyLabel({ total: 3094, branch: 'main' }), '3 094 commits on main')
  assert.equal(historyLabel({ total: 1, branch: 'feat/a' }), '1 commit on feat/a')
  assert.equal(historyLabel({ total: 0, branch: 'main' }), '0 commits on main')
  assert.equal(historyLabel({ total: 1234567, branch: 'main' }), '1 234 567 commits on main')
  assert.equal(historyLabel({}), '', 'un total inconnu ne s’invente pas')
  assert.equal(historyLabel({ total: 12 }), '', 'sans branche, pas de phrase')
})

test('treeIndent un cran par profondeur, worktreeLabel la fin du chemin', () => {
  assert.equal(treeIndent(0), 10)
  assert.equal(treeIndent(null), 10)
  assert.equal(treeIndent(-2), 10)
  assert.equal(treeIndent(1), 24)
  assert.equal(treeIndent(3), 52)

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

  // Les ids sont ceux des Notes techniques du ticket, dans l'ordre du ticket :
  // le registre ne prend pas de liberté avec le contrat.
  assert.deepEqual(ids, [
    'tab.dashboard', 'tab.missions', 'tab.done', 'tab.repositories', 'tab.workflows', 'tab.usage',
    'filter.search', 'filter.state', 'filter.type', 'filter.epic', 'filter.project', 'filter.priority',
    'filter.sort', 'filter.missing', 'filter.clear', 'list.refresh', 'list.retry', 'mission.open',
    'dashboard.view-all',
    'mission.tab.details', 'mission.tab.journal', 'mission.tab.checklist', 'mission.priority',
    'mission.block', 'mission.declare', 'mission.open-tracker', 'mission.close-checkout',
    'mission.session', 'mission.feedback-session',
    'repository.open', 'repository.adopt', 'repository.tab.details', 'repository.tab.history', 'repository.tab.worktrees',
    'repository.branch', 'repository.more',
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
