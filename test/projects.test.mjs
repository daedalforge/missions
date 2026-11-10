import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { chargerProjets } from '../lib/projects.js'

test('le fichier du workspace déclare le projet missions, complet', async () => {
  const { canonique, projets } = await chargerProjets()

  assert.deepEqual(canonique.states, ['to-refine', 'ready', 'in-progress', 'in-review', 'done'])
  assert.deepEqual(canonique.types, ['bug', 'story'])
  assert.equal(projets.length, 1)
  const [missions] = projets
  assert.equal(missions.id, 'missions')
  assert.equal(missions.tracker, 'github')
  assert.equal(missions.github.owner, 'daedalforge')
  assert.equal(missions.github.repo, 'missions')
  assert.equal(missions.map.states.done, null)
  assert.equal(missions.map.states.ready, 'ready')
})

test('un projet à la correspondance incomplète est refusé', async () => {
  const dossier = await mkdtemp(join(tmpdir(), 'projects-'))
  const fichier = join(dossier, 'projects.yml')
  await writeFile(
    fichier,
    [
      'canonical:',
      '  states: [to-refine, ready]',
      '  types: [bug]',
      'projects:',
      '  - id: incomplet',
      '    tracker: github',
      '    github: { owner: a, repo: b }',
      '    map:',
      '      states: { to-refine: to-refine }',
      '      types: { bug: bug }',
      '',
    ].join('\n'),
  )

  await assert.rejects(() => chargerProjets(new URL(`file://${fichier}`)), /ready/)
})

test('un tracker inconnu est refusé', async () => {
  const dossier = await mkdtemp(join(tmpdir(), 'projects-'))
  const fichier = join(dossier, 'projects.yml')
  await writeFile(
    fichier,
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

  await assert.rejects(() => chargerProjets(new URL(`file://${fichier}`)), /tracker inconnu/)
})
