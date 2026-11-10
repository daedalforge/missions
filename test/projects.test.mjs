import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadProjects } from '../lib/projects.js'

test('the workspace file declares its projects, complete', async () => {
  const { canonical, projects } = await loadProjects()

  assert.deepEqual(canonical.states, ['to-refine', 'ready', 'in-progress', 'in-review', 'done'])
  assert.deepEqual(canonical.types, ['bug', 'story'])
  assert.deepEqual(canonical.priorities, ['urgent', 'high', 'normal', 'low'])
  assert.deepEqual(
    projects.map((project) => project.id),
    ['missions', 'manager'],
  )
  const [missions, manager] = projects
  assert.equal(missions.id, 'missions')
  assert.equal(missions.tracker, 'github')
  assert.equal(missions.github.owner, 'daedalforge')
  assert.equal(missions.github.repo, 'missions')
  assert.equal(missions.map.states.done, null)
  assert.equal(missions.map.states.ready, 'ready')
  assert.equal(missions.map.types.story, 'Feature')
  assert.equal(missions.map.priorities.urgent, 'priority:urgent')
  assert.equal(missions.map.points, 'sp:')

  assert.equal(manager.tracker, 'jira')
  assert.equal(manager.jira.site, 'https://saas-office.atlassian.net')
  assert.equal(manager.jira.key_prefix, 'SO')
  assert.equal(manager.jira.story_points_field, 'customfield_10032')
  assert.deepEqual(manager.map.states['in-progress'], ['In Progress', 'Local Testing', 'Staging Test'])
  assert.deepEqual(manager.map.states.done, ['Released', 'Ready for prod'])
  assert.equal(manager.map.types.story, 'Story')
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
      '    tracker: jira',
      '    map:',
      '      states: { to-refine: [Inbox, Released], done: [Released] }',
      '      types: { bug: Bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => loadProjects(new URL(`file://${file}`)), /maps "Released" to both/)
})
