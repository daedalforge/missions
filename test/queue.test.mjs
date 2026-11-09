import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { planQueue, updateMissionQueue, localDate } from '../lib/index.js'
import { normalizeQueue, scanMissions } from '../lib/missions.js'

const base = ['---', 'id: UV-1184', 'status: ready', 'repo: ~/projects/registre', 'suite:', 'bruno: []', '---', '', '# Titre', '', 'Corps.'].join('\n')

const mission = (id, status, queue = 0) => ({ id, status, queue })

test('normalizeQueue lit un rang positif et rend 0 sinon', () => {
  assert.equal(normalizeQueue('3'), 3)
  assert.equal(normalizeQueue(' 12 '), 12)
  assert.equal(normalizeQueue(2), 2)
  assert.equal(normalizeQueue(''), 0)
  assert.equal(normalizeQueue('0'), 0)
  assert.equal(normalizeQueue('-2'), 0)
  assert.equal(normalizeQueue('abc'), 0)
  assert.equal(normalizeQueue(undefined), 0)
})

test('updateMissionQueue insère le rang après suite', () => {
  const { content, changed } = updateMissionQueue(base, 2)
  assert.equal(changed, true)
  assert.match(content, /suite:\nqueue: 2\nbruno: \[\]/)
})

test('updateMissionQueue remplace le rang existant', () => {
  const withQueue = base.replace('suite:', 'suite:\nqueue: 2')
  const { content, changed } = updateMissionQueue(withQueue, 1)
  assert.equal(changed, true)
  assert.match(content, /suite:\nqueue: 1\nbruno: \[\]/)
})

test('updateMissionQueue retire la clé quand le rang est 0', () => {
  const withQueue = base.replace('suite:', 'suite:\nqueue: 2')
  const { content, changed } = updateMissionQueue(withQueue, 0)
  assert.equal(changed, true)
  assert.equal(content.includes('queue'), false)
  assert.match(content, /suite:\nbruno: \[\]/)
})

test('updateMissionQueue ne touche à rien quand le rang est déjà là', () => {
  const withQueue = base.replace('suite:', 'suite:\nqueue: 2')
  const { changed } = updateMissionQueue(withQueue, 2)
  assert.equal(changed, false)
})

test('updateMissionQueue exige un frontmatter', () => {
  assert.throws(() => updateMissionQueue('# sans frontmatter', 1), /frontmatter absent/)
  assert.throws(() => updateMissionQueue(['---', 'id: X', 'Corps.'].join('\n'), 1), /frontmatter non fermé/)
})

test('planQueue rend la file visée, les ajouts et les retraits', () => {
  const missions = [mission('UV-1184', 'ready', 1), mission('UV-1185', 'ready', 2), mission('XYZ-1491', 'ready')]
  const plan = planQueue(missions, ['XYZ-1491', 'UV-1184'])
  assert.deepEqual(plan.ordered.map((entry) => entry.id), ['XYZ-1491', 'UV-1184'])
  assert.deepEqual(plan.added.map((entry) => entry.id), ['XYZ-1491'])
  assert.deepEqual(plan.removed.map((entry) => entry.id), ['UV-1185'])
})

test('planQueue vide la file quand la liste est vide', () => {
  const plan = planQueue([mission('UV-1184', 'ready', 1)], [])
  assert.deepEqual(plan.ordered, [])
  assert.deepEqual(plan.removed.map((entry) => entry.id), ['UV-1184'])
})

test('planQueue refuse un identifiant inconnu, vide ou en double', () => {
  const missions = [mission('UV-1184', 'ready')]
  assert.throws(() => planQueue(missions, ['UV-9999']), /mission inconnue/)
  assert.throws(() => planQueue(missions, ['']), /identifiant vide/)
  assert.throws(() => planQueue(missions, ['UV-1184', 'UV-1184']), /identifiant en double/)
  assert.throws(() => planQueue(missions, 'UV-1184'), /ids attendus/)
})

test('planQueue ne prend que des fiches en attente d’exécution', () => {
  const missions = [
    mission('UV-1185', 'draft'),
    mission('UV-760', 'in_review'),
    mission('UV-1186', 'awaiting_validation'),
    mission('XYZ-1380', 'active'),
  ]
  for (const id of ['UV-1185', 'UV-760', 'UV-1186', 'XYZ-1380']) {
    assert.throws(() => planQueue(missions, [id]), /mission hors de la file/)
  }
  assert.deepEqual(
    planQueue([mission('UV-1184', 'ready')], ['UV-1184']).ordered.map((entry) => entry.id),
    ['UV-1184'],
  )
})

test('planQueue retire le rang d’une fiche sortie de l’attente', () => {
  const missions = [mission('UV-760', 'in_review', 1), mission('UV-1186', 'awaiting_validation', 2)]
  assert.deepEqual(planQueue(missions, []).removed.map((entry) => entry.id), ['UV-760', 'UV-1186'])
})

test('planQueue sort la fiche retirée de la liste', () => {
  const missions = [mission('UV-760', 'in_review', 1), mission('UV-1184', 'ready', 2)]
  const plan = planQueue(missions, ['UV-1184'])
  assert.deepEqual(plan.ordered.map((entry) => entry.id), ['UV-1184'])
  assert.deepEqual(plan.removed.map((entry) => entry.id), ['UV-760'])
})

test('scanMissions lit le rang de file des fiches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-queue-'))
  await mkdir(join(root, 'missions', 'UV-1184'), { recursive: true })
  await mkdir(join(root, 'missions', 'UV-1185'), { recursive: true })
  await writeFile(join(root, 'missions', 'UV-1184', 'mission.md'), base.replace('UV-1184', 'UV-1184').replace('suite:', 'suite:\nqueue: 1'))
  await writeFile(join(root, 'missions', 'UV-1185', 'mission.md'), base.replaceAll('UV-1184', 'UV-1185'))
  const scan = await scanMissions(join(root, 'missions'))
  assert.equal(scan.missions.find((entry) => entry.id === 'UV-1184').queue, 1)
  assert.equal(scan.missions.find((entry) => entry.id === 'UV-1185').queue, 0)
})

test('localDate écrit la date locale AAAA-MM-JJ', () => {
  assert.equal(localDate(new Date(2026, 9, 30)), '2026-10-30')
})
