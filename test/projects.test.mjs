import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadProjects } from '../lib/projects.js'

test('the workspace file declares the missions project, complete', async () => {
  const { canonical, projects } = await loadProjects()

  assert.deepEqual(canonical.states, ['to-refine', 'ready', 'in-progress', 'in-review', 'done'])
  assert.deepEqual(canonical.types, ['bug', 'story'])
  assert.deepEqual(canonical.priorities, ['urgent', 'high', 'normal', 'low'])
  assert.equal(projects.length, 1)
  const [missions] = projects
  assert.equal(missions.id, 'missions')
  assert.equal(missions.tracker, 'github')
  assert.equal(missions.github.owner, 'daedalforge')
  assert.equal(missions.github.repo, 'missions')
  assert.equal(missions.map.states.done, null)
  assert.equal(missions.map.states.ready, 'ready')
  assert.equal(missions.map.types.story, 'Feature')
  assert.equal(missions.map.priorities.urgent, 'priority:urgent')
  assert.equal(missions.map.points, 'sp:')
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
