import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actionVerb,
  ageDays,
  branchFieldValue,
  EMPTY_FILTERS,
  epicOptions,
  parseChecklist,
  dashboardScope,
  executionBlocker,
  FILTERS_KEY,
  filterBarState,
  filterMissions,
  filterSnapshot,
  groupByState,
  hasActiveFilters,
  inFlight,
  missionAge,
  needsYou,
  parseFilterSnapshot,
  pointsTotal,
  priorityOptions,
  projectOptions,
  QUIET_AFTER_DAYS,
  readFilterSnapshot,
  relativeAge,
  sortMissions,
  stateOptions,
  suggestBranch,
  writeFilterSnapshot,
} from '../lib/view.js'

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

test('done n’est plus un état du panneau : ni groupe, ni option de filtre', () => {
  const done = [{ key: 'a#5', state: 'done' }]
  assert.deepEqual(groupByState(done).map((g) => g.state), ['unknown'])
  assert.deepEqual(stateOptions(done), ['unknown'])
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

test('une session exige un état unique, une branche et une base déclarées', () => {
  assert.equal(executionBlocker({ branch: 'gh-41', base: 'main' }), null)
  assert.equal(executionBlocker({ branch: 'gh-41', base: 'main', stateConflict: [] }), null)
  assert.equal(
    executionBlocker({ branch: 'gh-41', base: 'main', stateConflict: ['in-review', 'ready-for-prod'] }),
    'state labels conflict (in-review, ready-for-prod), keep one',
  )
  assert.equal(executionBlocker({ branch: 'gh-41' }), 'base branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker({ base: 'main' }), 'branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker({}), 'branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker({ branch: null, base: null }), 'branch is not declared, set it below or in the mission folder')
  assert.equal(executionBlocker(), 'branch is not declared, set it below or in the mission folder')
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
    filters: { type: 'bug', state: 'ready', epic: 'Workspace', priority: 'urgent', project: 'missions', missing: 'any' },
    sort: 'points',
  }
  const snapshot = filterSnapshot(bar)
  assert.deepEqual(snapshot, {
    query: 'panneau',
    type: 'bug',
    state: 'ready',
    epic: 'Workspace',
    priority: 'urgent',
    project: 'missions',
    missing: 'any',
    sort: 'points',
  })
  // L'instantané revient en trois états : la barre telle que le panneau la tient.
  assert.deepEqual(filterBarState(snapshot), bar)
  // Une barre vide n'a rien d'actif : le panneau la traite comme au repos.
  assert.equal(hasActiveFilters(filterBarState(filterSnapshot({})).filters), false)
})

test('un instantané ne retient que ce que la barre peut sélectionner', () => {
  const snapshot = filterSnapshot({
    query: 42,
    filters: { type: 'feat', state: 'done', epic: '  Workspace  ', priority: '', project: 7, missing: 'yes' },
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

test('la file du dashboard suit l’urgence, puis la plus ancienne, sans l’en-cours', () => {
  const missions = [
    { key: 'M-1', state: 'to-refine', updatedAt: '2026-11-10T12:00:00Z' },
    { key: 'M-2', state: 'in-review', updatedAt: '2026-11-09T12:00:00Z' },
    { key: 'M-3', state: 'in-progress', updatedAt: '2026-10-01T12:00:00Z' },
    { key: 'M-4', state: 'in-review', updatedAt: '2026-11-05T12:00:00Z' },
    { key: 'M-5', state: 'ready', updatedAt: '2026-11-11T11:00:00Z' },
  ]

  // Deux en revue : la plus ancienne passe devant. L'en-cours n'est jamais
  // dans la file, il vit dans In flight.
  assert.deepEqual(needsYou(missions).map((mission) => mission.key), ['M-4', 'M-2', 'M-5', 'M-1'])
  assert.deepEqual(inFlight(missions).map((mission) => mission.key), ['M-3'])
  assert.deepEqual(needsYou([]), [])
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
