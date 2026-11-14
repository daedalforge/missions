import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadProjects } from '../lib/projects.js'

const FIXTURE = new URL('./fixtures/projects.yml', import.meta.url)

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
  const { canonical, products, projects } = await loadProjects(FIXTURE)

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
    projects.map((project) => project.id),
    ['missions', 'alpha', 'beta'],
  )
  const [missions, alpha, beta] = projects
  assert.equal(missions.id, 'missions')
  assert.equal(missions.reference, 'MIS')
  assert.equal(missions.tracker, 'github')
  assert.equal(missions.github.owner, 'example')
  assert.equal(missions.github.repo, 'missions')
  assert.equal(missions.map.states.done, null)
  assert.equal(missions.map.states.ready, 'ready')
  assert.equal(missions.map.states['ready-for-prod'], 'ready-for-prod')
  assert.equal(missions.map.types.story, 'Feature')
  assert.equal(missions.map.priorities.urgent, 'priority:urgent')
  assert.equal(missions.map.points, 'sp:')

  assert.equal(alpha.tracker, 'jira')
  assert.equal(alpha.reference, 'ALP')
  assert.equal(alpha.jira.site, 'https://example.atlassian.net')
  assert.equal(alpha.jira.story_points_field, 'customfield_10032')
  assert.deepEqual(alpha.map.states['in-progress'], ['In Progress'])
  assert.deepEqual(alpha.map.states['ready-for-prod'], ['Local Testing', 'Staging Test', 'Ready for prod'])
  assert.deepEqual(alpha.map.states.done, ['Released'])
  assert.deepEqual(alpha.map.labels, products)
  // Jira nomme `Story` et `Task` : les deux se lisent `story` en local.
  assert.deepEqual(alpha.map.types.story, ['Story', 'Task'])

  assert.equal(beta.name, 'Beta')
  assert.equal(beta.reference, 'BET')
  assert.equal(beta.tracker, 'jira')
  assert.equal(beta.jira.site, 'https://example.atlassian.net')
  assert.equal(beta.jira.story_points_field, 'customfield_10032')
  assert.deepEqual(beta.map.states['to-refine'], ['To Refine', 'Inbox'])
  assert.equal(beta.map.states.ready, 'Ready for dev')
  assert.deepEqual(beta.map.states['in-progress'], ['In Progress'])
  assert.equal(beta.map.states['in-review'], 'Code review')
  assert.equal(beta.map.states['ready-for-prod'], 'Ready for prod')
  assert.equal(beta.map.states.done, 'Done')
  assert.deepEqual(beta.map.types.story, ['Story', 'Task'])
})

test('le bloc translations est rendu pour alpha, absent ailleurs', async () => {
  const { projects } = await loadProjects(FIXTURE)
  const [missions, alpha, beta] = projects

  assert.equal(missions.translations, null)
  assert.equal(beta.translations, null)
  assert.deepEqual(alpha.translations, {
    locales: ['ar', 'de', 'en', 'es', 'fil', 'fr', 'hi', 'pt', 'ru', 'zh'],
    languageFile: 'src/locales/{locale}/translations.json',
    reference: 'fr',
  })
})

test('un bloc translations incomplet est refusé', async () => {
  const project = (translations) => [
    '  - id: so',
    '    reference: ALP',
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

test('the beta map covers the statuses of the BET workflow', async () => {
  const { projects } = await loadProjects(FIXTURE)
  const beta = projects.find((project) => project.id === 'beta')
  const covered = new Set(Object.values(beta.map.states).flat().filter(Boolean))

  // Relevé sur le site : GET /rest/api/3/project/BET/statuses.
  const workflow = ['To Refine', 'Inbox', 'Ready for dev', 'In Progress', 'Ready for prod', 'Code review', 'Done']

  assert.deepEqual(
    workflow.filter((status) => !covered.has(status)),
    [],
  )
})

test('the alpha map covers the statuses of the ALP workflow', async () => {
  const { projects } = await loadProjects(FIXTURE)
  const alpha = projects.find((project) => project.id === 'alpha')
  const covered = new Set(Object.values(alpha.map.states).flat())

  // Relevé sur le site : GET /rest/api/3/project/ALP/statuses.
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

test("le gabarit d'exemple reste valide", async () => {
  const example = new URL('../missions/projects.example.yml', import.meta.url)
  const { projects } = await loadProjects(example)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].id, 'example')
})

test('un fichier projects.yml absent explique où copier le gabarit', async () => {
  const missing = new URL('./fixtures/projects-absent.yml', import.meta.url)
  await assert.rejects(() => loadProjects(missing), /copy missions\/projects\.example\.yml there/)
})
