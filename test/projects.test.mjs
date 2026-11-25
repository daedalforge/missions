import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadProjects, readerFor, resolveMissionProject, trackerForKey } from '../lib/projects.js'

const FIXTURE = new URL('./fixtures/projects.yml', import.meta.url)

const HEADER = [
  'canonical:',
  '  states: [to-refine]',
  '  types: [bug]',
]

/** One complete tracker block; the caller only varies what the case is about. */
const TRACKER = [
  '  - id: mis',
  '    reference: MIS',
  '    tracker: github',
  '    github: { owner: a, repo: b }',
  '    map:',
  '      states: { to-refine: to-refine }',
  '      types: { bug: bug }',
]

/** Write a workspace with a `trackers:` and a `projects:` section. */
async function writeWorkspace(trackers, projects) {
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [...HEADER, 'trackers:', ...trackers, 'projects:', ...(projects ?? []), ''].join('\n'),
  )
  return new URL(`file://${file}`)
}

/** Write a workspace with the standard tracker and the given project blocks. */
async function writeProjects(projects, trackers = TRACKER) {
  return writeWorkspace(trackers, projects)
}

test('the workspace file declares its trackers and repositories, complete', async () => {
  const { canonical, products, trackers, projects } = await loadProjects(FIXTURE)

  assert.deepEqual(canonical.states, ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done'])
  assert.deepEqual(canonical.types, ['bug', 'story'])
  assert.deepEqual(canonical.priorities, ['urgent', 'high', 'normal', 'low'])
  assert.deepEqual(products, {
    alpha: 'Alpha',
    shop: 'Shop',
    core: 'Core',
    beta: 'Beta',
    hub: 'Hub',
  })
  assert.deepEqual(
    trackers.map((tracker) => tracker.id),
    ['mis', 'alp', 'bet'],
  )
  assert.deepEqual(
    projects.map((project) => project.id),
    ['missions', 'alpha', 'beta'],
  )

  const [mis, alp, bet] = trackers
  assert.equal(mis.reference, 'MIS')
  assert.equal(mis.tracker, 'github')
  assert.equal(mis.github.owner, 'example')
  assert.equal(mis.github.repo, 'missions')
  assert.equal(mis.map.states.done, null)
  assert.equal(mis.map.states.ready, 'ready')
  assert.equal(mis.map.states['ready-for-prod'], 'ready-for-prod')
  assert.equal(mis.map.types.story, 'Feature')
  assert.equal(mis.map.priorities.urgent, 'priority:urgent')
  assert.equal(mis.map.points, 'sp:')

  assert.equal(alp.reference, 'ALP')
  assert.equal(alp.tracker, 'jira')
  assert.equal(alp.jira.site, 'https://example.atlassian.net')
  assert.equal(alp.jira.story_points_field, 'customfield_10032')
  assert.deepEqual(alp.map.states['in-progress'], ['In Progress'])
  assert.deepEqual(alp.map.states['ready-for-prod'], ['Local Testing', 'Staging Test', 'Ready for prod'])
  assert.deepEqual(alp.map.states.done, ['Released'])
  assert.deepEqual(alp.map.labels, products)
  // Jira nomme `Story` et `Task` : les deux se lisent `story` en local.
  assert.deepEqual(alp.map.types.story, ['Story', 'Task'])

  assert.equal(bet.reference, 'BET')
  assert.equal(bet.tracker, 'jira')
  assert.deepEqual(bet.map.states['to-refine'], ['To Refine', 'Inbox'])
  assert.equal(bet.map.states.ready, 'Ready for dev')
  assert.deepEqual(bet.map.types.story, ['Story', 'Task'])

  assert.deepEqual(projects[0], {
    id: 'missions',
    name: 'Missions workspace',
    repo: '~/projects/missions',
    translations: null,
  })
  assert.deepEqual(
    projects.map((project) => Object.keys(project).sort()),
    [
      ['id', 'name', 'repo', 'translations'],
      ['id', 'name', 'repo', 'translations'],
      ['id', 'name', 'repo', 'translations'],
    ],
  )
})

test('le bloc translations est rendu pour alpha, absent ailleurs', async () => {
  const { projects } = await loadProjects(FIXTURE)
  const [, alpha] = projects

  assert.deepEqual(alpha.translations, {
    locales: ['ar', 'de', 'en', 'es', 'fil', 'fr', 'hi', 'pt', 'ru', 'zh'],
    languageFile: 'src/locales/{locale}/translations.json',
    reference: 'fr',
  })
})

test('deux dépôts peuvent travailler la même board sans la déclarer', async () => {
  const url = await writeProjects([
    '  - id: clienthub',
    '    repo: ~/projects/clienthub',
    '  - id: backend',
    '    repo: ~/projects/backend',
  ])

  const { trackers, projects } = await loadProjects(url)
  assert.equal(trackers.length, 1)
  assert.deepEqual(
    projects.map((project) => project.id),
    ['clienthub', 'backend'],
  )
  assert.equal(trackerForKey(trackers, 'MIS-3')?.id, 'mis')
})

test('un dépôt qui ne nomme aucune board se lit tel quel', async () => {
  const url = await writeProjects([
    '  - id: docs',
    '    repo: ~/projects/docs',
  ])

  const { projects } = await loadProjects(url)
  assert.deepEqual(projects[0], { id: 'docs', name: 'docs', repo: '~/projects/docs', translations: null })
})

test('un dépôt qui garde un tracker est refusé en nommant le dépôt et le champ', async () => {
  const url = await writeProjects([
    '  - id: docs',
    '    repo: ~/projects/docs',
    '    tracker: soc',
  ])

  await assert.rejects(
    () => loadProjects(url),
    /docs declares tracker; the board comes from the mission key, not from a repository\. Remove tracker from docs\./,
  )
})

test('un projet sans repo est refusé en nommant le champ', async () => {
  const url = await writeProjects([
    '  - id: docs',
    '    name: Documentation',
  ])

  await assert.rejects(() => loadProjects(url), /docs has no repo/)
})

test('un projet qui garde reference ou map est refusé vers les trackers', async () => {
  const url = await writeProjects([
    '  - id: docs',
    '    repo: ~/projects/docs',
    '    reference: DOC',
  ])

  await assert.rejects(() => loadProjects(url), /docs declares reference; reference belongs to a tracker/)
})

test('un fichier resté à l’ancien schéma explique la migration', async () => {
  const url = await writeProjects([], [])
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [
      ...HEADER,
      'projects:',
      '  - id: old',
      '    reference: OLD',
      '    tracker: github',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => loadProjects(new URL(`file://${file}`)), /`trackers:` is missing.*old schema/s)
  assert.ok(url)
})

test('deux trackers ne peuvent pas partager une référence', async () => {
  const tracker = (id) => [
    `  - id: ${id}`,
    '    reference: MIS',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    map:',
    '      states: { to-refine: to-refine }',
    '      types: { bug: bug }',
  ]
  const url = await writeWorkspace([...tracker('one'), ...tracker('two')], [])

  await assert.rejects(() => loadProjects(url), /reference "MIS" is used by both one and two/)
})

test('un tracker de type inconnu est refusé', async () => {
  const url = await writeWorkspace(
    [
      '  - id: x',
      '    reference: X',
      '    tracker: gitlab',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
    ],
    [],
  )

  await assert.rejects(() => loadProjects(url), /tracker x has an unknown tracker \("gitlab"\)/)
})

test('une référence invalide est refusée en nommant le champ', async () => {
  const url = await writeWorkspace(
    [
      '  - id: x',
      '    reference: mis',
      '    tracker: github',
      '    github: { owner: a, repo: b }',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
    ],
    [],
  )

  await assert.rejects(() => loadProjects(url), /tracker x has an invalid reference \("mis"\)/)
})

test('un tracker avec une projection incomplète est refusé', async () => {
  const url = await writeWorkspace(
    [
      '  - id: x',
      '    reference: X',
      '    tracker: github',
      '    github: { owner: a, repo: b }',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
    ],
    [],
  )
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [
      'canonical:',
      '  states: [to-refine, ready]',
      '  types: [bug]',
      'trackers:',
      '  - id: x',
      '    reference: X',
      '    tracker: github',
      '    github: { owner: a, repo: b }',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => loadProjects(new URL(`file://${file}`)), /tracker x has no mapping for ready/)
  assert.ok(url)
})

test('un état peut nommer plusieurs valeurs du tracker', async () => {
  const url = await writeWorkspace(
    [
      '  - id: jira',
      '    reference: X',
      '    tracker: jira',
      '    map:',
      '      states: { to-refine: [Inbox, To Refine], done: [Released, Ready for prod] }',
      '      types: { bug: Bug }',
    ],
    [],
  )

  const { trackers } = await loadProjects(url)
  assert.deepEqual(trackers[0].map.states.done, ['Released', 'Ready for prod'])
})

test('une valeur du tracker projetée sur deux états est refusée', async () => {
  const url = await writeWorkspace(
    [
      '  - id: jira',
      '    reference: X',
      '    tracker: jira',
      '    map:',
      '      states: { to-refine: [Inbox, Released], done: [Released] }',
      '      types: { bug: Bug }',
    ],
    [],
  )

  await assert.rejects(() => loadProjects(url), /maps "Released" to both/)
})

test('un bloc translations incomplet est refusé', async () => {
  const project = (translations) => [
    '  - id: so',
    '    repo: ~/projects/so',
    '    translations:',
    ...(translations.length > 0 ? translations.map((line) => `      ${line}`) : ['      {}']),
  ]

  const cases = [
    [[], /translations\.locales is missing/],
    [['locales: [fr, fr]', 'languageFile: x/{locale}.json', 'reference: fr'], /translations\.locales is declared twice/],
    [['locales: [fr]', 'reference: fr'], /translations\.languageFile is missing/],
    [['locales: [fr]', 'languageFile: x/fr.json', 'reference: fr'], /needs a \{locale\} placeholder/],
    [['locales: [fr]', 'languageFile: x/{locale}.json'], /translations\.reference is missing/],
    [['locales: [fr]', 'languageFile: x/{locale}.json', 'reference: en'], /is not one of its locales/],
  ]

  for (const [lines, expected] of cases) {
    const url = await writeProjects(project(lines))
    await assert.rejects(() => loadProjects(url), expected)
  }
})

test('le tracker se lit par préfixe et le dépôt se résout par son id', async () => {
  const { trackers, projects } = await loadProjects(FIXTURE)

  assert.equal(trackerForKey(trackers, 'ALP-12')?.id, 'alp')
  assert.equal(trackerForKey(trackers, 'XXX-1'), null)

  // Sans dépôt nommé, le lecteur ne choisit pas à la place de la mission : le
  // repli sur l'unique dépôt de la board a disparu.
  assert.throws(
    () => resolveMissionProject({ projects, trackers }, 'MIS-3'),
    (error) => error.status === 400 && error.message === 'project is required',
  )
  assert.equal(resolveMissionProject({ projects, trackers }, 'MIS-3', 'missions').project.id, 'missions')
  assert.throws(
    () => resolveMissionProject({ projects, trackers }, 'MIS-3', 'unknown'),
    (error) => error.status === 400 && error.message === 'project "unknown" is not declared',
  )
  assert.throws(
    () => resolveMissionProject({ projects, trackers }, 'NOPE-3', 'missions'),
    (error) => error.status === 404 && /no project declares NOPE-3/.test(error.message),
  )
})

test('un dépôt se résout sur sa board ou sur une autre, sans rattachement', async () => {
  const url = await writeProjects([
    '  - id: clienthub',
    '    repo: ~/projects/clienthub',
    '  - id: backend',
    '    repo: ~/projects/backend',
  ])
  const workspace = await loadProjects(url)

  assert.equal(resolveMissionProject(workspace, 'MIS-3', 'backend').project.id, 'backend')
  assert.equal(resolveMissionProject(workspace, 'MIS-3', 'clienthub').project.id, 'clienthub')
})

test('le lecteur de tracker porte le dépôt du projet', async () => {
  const { trackers, projects } = await loadProjects(FIXTURE)
  const [mis] = trackers
  const reader = readerFor(mis, projects[0])

  assert.equal(reader.id, 'mis')
  assert.equal(reader.projectId, 'missions')
  assert.equal(reader.projectName, 'Missions workspace')
  assert.equal(reader.reference, 'MIS')
  assert.equal(reader.repo, '~/projects/missions')
  assert.equal(reader.map.states.ready, 'ready')
})

test("le gabarit d'exemple reste valide", async () => {
  const example = new URL('../missions/projects.example.yml', import.meta.url)
  const { trackers, projects } = await loadProjects(example)
  assert.equal(trackers.length, 1)
  assert.equal(trackers[0].reference, 'EX')
  assert.equal(projects.length, 1)
  assert.equal(projects[0].id, 'example')
  assert.equal(projects[0].repo.startsWith('~/projects/'), true)
  assert.equal('tracker' in projects[0], false)
})

test('un fichier projects.yml absent explique où copier le gabarit', async () => {
  const missing = new URL('./fixtures/projects-absent.yml', import.meta.url)
  await assert.rejects(() => loadProjects(missing), /copy missions\/projects\.example\.yml there/)
})

test('une board GitHub peut porter son état, sa priorité et son estimation par des champs d’organisation', async () => {
  const file = await writeWorkspace([
    '  - id: cfg',
    '    reference: CFG',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    fields: { state: Workflow stage, priority: Priority, points: Story point }',
    '    map:',
    '      states: { to-refine: To refine }',
    '      types: { bug: Bug }',
  ], [])

  const { trackers } = await loadProjects(file)
  assert.deepEqual(trackers[0].fields, {
    state: 'Workflow stage',
    priority: 'Priority',
    points: 'Story point',
  })
})

test('les champs restent une affaire de GitHub et ne portent pas `blocked`', async () => {
  const jira = await writeWorkspace([
    '  - id: alp',
    '    reference: ALP',
    '    tracker: jira',
    '    jira: { site: https://example.atlassian.net, email: a@b.c }',
    '    fields: { state: Stage }',
    '    map:',
    '      states: { to-refine: To Do }',
    '      types: { bug: Bug }',
  ], [])
  await assert.rejects(() => loadProjects(jira), /organization fields exist on GitHub only/)

  const blocked = await writeWorkspace([
    '  - id: cfg',
    '    reference: CFG',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    fields: { blocked: Blocked }',
    '    map:',
    '      states: { to-refine: To refine }',
    '      types: { bug: Bug }',
  ], [])
  await assert.rejects(() => loadProjects(blocked), /unknown role "blocked"/)

  const empty = await writeWorkspace([
    '  - id: cfg',
    '    reference: CFG',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    fields: { state: "  " }',
    '    map:',
    '      states: { to-refine: To refine }',
    '      types: { bug: Bug }',
  ], [])
  await assert.rejects(() => loadProjects(empty), /fields\.state needs a field name/)
})

test('un champ d’estimation et un préfixe de label ne se déclarent pas ensemble', async () => {
  const file = await writeWorkspace([
    '  - id: cfg',
    '    reference: CFG',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    fields: { points: Story point }',
    '    map:',
    '      states: { to-refine: To refine }',
    '      types: { bug: Bug }',
    '      points: "sp:"',
  ], [])

  await assert.rejects(() => loadProjects(file), /both fields\.points and map\.points/)
})
