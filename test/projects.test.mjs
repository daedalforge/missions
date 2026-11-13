import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadProjects } from '../lib/projects.js'

/** Write a minimal workspace around the given project blocks. */
async function writeProjects(projects) {
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    ['canonical:', '  states: [to-refine]', '  types: [bug]', 'projects:', ...projects, ''].join('\n'),
  )
  return new URL(`file://${file}`)
}

test('the workspace file declares its projects, complete', async () => {
  const { canonical, products, projects } = await loadProjects()

  assert.deepEqual(canonical.states, ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done'])
  assert.deepEqual(canonical.types, ['bug', 'story'])
  assert.deepEqual(canonical.priorities, ['urgent', 'high', 'normal', 'low'])
  assert.deepEqual(products, {
    manager: 'Manager',
    marketplace: 'Marketplace',
    core: 'Core',
    connect: 'Connect',
    clienthub: 'Clienthub',
  })
  assert.deepEqual(
    projects.map((project) => project.id),
    ['missions', 'manager', 'connect'],
  )
  const [missions, manager, connect] = projects
  assert.equal(missions.id, 'missions')
  assert.equal(missions.reference, 'MIS')
  assert.equal(missions.tracker, 'github')
  assert.equal(missions.github.owner, 'daedalforge')
  assert.equal(missions.github.repo, 'missions')
  assert.equal(missions.map.states.done, null)
  assert.equal(missions.map.states.ready, 'ready')
  assert.equal(missions.map.states['ready-for-prod'], 'ready-for-prod')
  assert.equal(missions.map.types.story, 'Feature')
  assert.equal(missions.map.priorities.urgent, 'priority:urgent')
  assert.equal(missions.map.points, 'sp:')

  assert.equal(manager.tracker, 'jira')
  assert.equal(manager.reference, 'SO')
  assert.equal(manager.jira.site, 'https://saas-office.atlassian.net')
  assert.equal(manager.jira.story_points_field, 'customfield_10032')
  assert.deepEqual(manager.map.states['in-progress'], ['In Progress'])
  assert.deepEqual(manager.map.states['ready-for-prod'], ['Local Testing', 'Staging Test', 'Ready for prod'])
  assert.deepEqual(manager.map.states.done, ['Released'])
  assert.deepEqual(manager.map.labels, products)
  // Jira nomme `Story` et `Task` : les deux se lisent `story` en local.
  assert.deepEqual(manager.map.types.story, ['Story', 'Task'])

  assert.equal(connect.name, 'Connect')
  assert.equal(connect.reference, 'SOC')
  assert.equal(connect.tracker, 'jira')
  assert.equal(connect.jira.site, 'https://saas-office.atlassian.net')
  assert.equal(connect.jira.story_points_field, 'customfield_10032')
  assert.deepEqual(connect.map.states['to-refine'], ['To Refine', 'Inbox'])
  assert.equal(connect.map.states.ready, 'Ready for dev')
  assert.deepEqual(connect.map.states['in-progress'], ['In Progress'])
  assert.equal(connect.map.states['in-review'], 'Code review')
  assert.equal(connect.map.states['ready-for-prod'], 'Ready for prod')
  assert.equal(connect.map.states.done, 'Done')
  assert.deepEqual(connect.map.types.story, ['Story', 'Task'])
})

test('le bloc translations est rendu pour manager, absent ailleurs', async () => {
  const { projects } = await loadProjects()
  const [missions, manager, connect] = projects

  assert.equal(missions.translations, null)
  assert.equal(connect.translations, null)
  assert.deepEqual(manager.translations, {
    locales: ['ar', 'de', 'en', 'es', 'fil', 'fr', 'hi', 'pt', 'ru', 'zh'],
    languageFile: 'src/locales/{locale}/translations.json',
    reference: 'fr',
  })
})

test('un bloc translations incomplet est refusé', async () => {
  const project = (translations) => [
    '  - id: so',
    '    reference: SO',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    translations:',
    ...(translations.length > 0 ? translations.map((line) => `      ${line}`) : ['      {}']),
    '    map:',
    '      states: { to-refine: to-refine }',
    '      types: { bug: bug }',
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

test('the connect map covers the statuses of the SOC workflow', async () => {
  const { projects } = await loadProjects()
  const connect = projects.find((project) => project.id === 'connect')
  const covered = new Set(Object.values(connect.map.states).flat().filter(Boolean))

  // Relevé sur le site : GET /rest/api/3/project/SOC/statuses.
  const workflow = ['To Refine', 'Inbox', 'Ready for dev', 'In Progress', 'Ready for prod', 'Code review', 'Done']

  assert.deepEqual(
    workflow.filter((status) => !covered.has(status)),
    [],
  )
})

test('the manager map covers the statuses of the SO workflow', async () => {
  const { projects } = await loadProjects()
  const manager = projects.find((project) => project.id === 'manager')
  const covered = new Set(Object.values(manager.map.states).flat())

  // Relevé sur le site : GET /rest/api/3/project/SO/statuses.
  const workflow = [
    'Rejected',
    'Ready for prod',
    'To Qualify',
    'To Dev',
    'Staging Test',
    'Released',
    'Inbox',
    'To Refine',
    'Ready to Dev',
    'In Progress',
    'Local Testing',
    'Code review',
    'Analysis done',
  ]

  assert.deepEqual(
    workflow.filter((status) => !covered.has(status)),
    ['Rejected'],
  )
})

test('a project with an incomplete mapping is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [
      'canonical:',
      '  states: [to-refine, ready]',
      '  types: [bug]',
      'projects:',
      '  - id: incomplete',
      '    reference: X',
      '    tracker: github',
      '    github: { owner: a, repo: b }',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => loadProjects(new URL(`file://${file}`)), /ready/)
})

test('an unknown tracker is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [
      'canonical:',
      '  states: [to-refine]',
      '  types: [bug]',
      'projects:',
      '  - id: x',
      '    reference: X',
      '    tracker: gitlab',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => loadProjects(new URL(`file://${file}`)), /unknown tracker/)
})

test('a state may name several tracker values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [
      'canonical:',
      '  states: [to-refine, done]',
      '  types: [bug]',
      'projects:',
      '  - id: jira',
      '    reference: X',
      '    tracker: jira',
      '    map:',
      '      states: { to-refine: [Inbox, To Refine], done: [Released, Ready for prod] }',
      '      types: { bug: Bug }',
      '',
    ].join('\n'),
  )

  const { projects } = await loadProjects(new URL(`file://${file}`))
  assert.deepEqual(projects[0].map.states.done, ['Released', 'Ready for prod'])
})

test('a tracker value mapped to two states is rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'projects-'))
  const file = join(directory, 'projects.yml')
  await writeFile(
    file,
    [
      'canonical:',
      '  states: [to-refine, done]',
      '  types: [bug]',
      'projects:',
      '  - id: jira',
      '    reference: X',
      '    tracker: jira',
      '    map:',
      '      states: { to-refine: [Inbox, Released], done: [Released] }',
      '      types: { bug: Bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => loadProjects(new URL(`file://${file}`)), /maps "Released" to both/)
})

test('a project without a reference is rejected', async () => {
  const url = await writeProjects([
    '  - id: x',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    map:',
    '      states: { to-refine: to-refine }',
    '      types: { bug: bug }',
  ])

  await assert.rejects(() => loadProjects(url), /x has no reference/)
})

test('a reference must be an uppercase token', async () => {
  const url = await writeProjects([
    '  - id: x',
    '    reference: mis',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    map:',
    '      states: { to-refine: to-refine }',
    '      types: { bug: bug }',
  ])

  await assert.rejects(() => loadProjects(url), /invalid reference \("mis"\)/)
})

test('two projects cannot share a reference', async () => {
  const project = (id) => [
    `  - id: ${id}`,
    '    reference: MIS',
    '    tracker: github',
    '    github: { owner: a, repo: b }',
    '    map:',
    '      states: { to-refine: to-refine }',
    '      types: { bug: bug }',
  ]
  const url = await writeProjects([...project('one'), ...project('two')])

  await assert.rejects(() => loadProjects(url), /reference "MIS" is used by both one and two/)
})
