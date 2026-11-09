import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RUNNING_LIMIT, computePlan, normalizeRunningLimit } from '../lib/missions.js'

const mission = (id, status, repo, queue = 0, suite = '') => ({ id, status, repo, queue, suite })

test('computePlan : sans bloqueur, la vague 1 est exécutable', () => {
  const plan = computePlan([mission('UV-1184', 'ready', 'registre', 1)])
  assert.deepEqual(plan.executable, ['UV-1184'])
  assert.deepEqual(plan.nodes, [{ id: 'UV-1184', state: 'runnable', wave: 1 }])
  assert.deepEqual(plan.blockedBy, {})
})

test('computePlan : deux missions du même dépôt partent ensemble', () => {
  const plan = computePlan([
    mission('UV-1184', 'ready', 'registre', 1),
    mission('UV-1185', 'ready', 'registre', 2),
  ])
  assert.deepEqual(plan.executable, ['UV-1184', 'UV-1185'])
  assert.deepEqual(plan.blockedBy, {})
  assert.deepEqual(
    plan.nodes.map((node) => node.wave),
    [1, 1],
  )
})

test('computePlan : une mission en vol ne bloque pas un nouveau départ', () => {
  const plan = computePlan([
    mission('XYZ-1380', 'active', 'atelier'),
    mission('XYZ-1491', 'ready', 'atelier', 1),
  ])
  assert.deepEqual(plan.executable, ['XYZ-1491'])
  assert.deepEqual(plan.blockedBy, {})
  assert.equal(plan.nodes.find((node) => node.id === 'XYZ-1491').wave, 1)
})

test('computePlan : une devancière en revue ou en validation ne bloque plus', () => {
  const plan = computePlan([
    mission('ABC-74', 'awaiting_validation', 'konoha', 1),
    mission('ABC-77', 'ready', 'konoha', 2, 'ABC-74'),
  ])
  assert.deepEqual(plan.executable, ['ABC-77'])
  assert.deepEqual(plan.blockedBy, {})
})

test('computePlan : une devancière encore en cours bloque sa suivante', () => {
  const plan = computePlan([
    mission('ABC-74', 'active', 'konoha', 1),
    mission('ABC-77', 'ready', 'konoha', 2, 'ABC-74'),
  ])
  assert.deepEqual(plan.executable, [])
  assert.deepEqual(plan.blockedBy['ABC-77'].map((entry) => entry.id), ['ABC-74'])
})

test('computePlan : une fiche en revue sort de la file et du plan', () => {
  const plan = computePlan([
    mission('UV-760', 'in_review', 'marche', 1),
    mission('XYZ-1439', 'draft', 'registre', 2),
    mission('UV-1184', 'ready', 'registre', 1),
  ])
  assert.deepEqual(plan.nodes, [{ id: 'UV-1184', state: 'runnable', wave: 1 }])
  assert.deepEqual(plan.executable, ['UV-1184'])
  assert.deepEqual(plan.waiting, [])
  assert.deepEqual(plan.blockedBy, {})
})

test('computePlan : une fiche en cours reste au plan sans rang', () => {
  const plan = computePlan([mission('XYZ-1380', 'active', 'atelier', 1)])
  assert.deepEqual(plan.nodes, [{ id: 'XYZ-1380', state: 'running', wave: null }])
  assert.deepEqual(plan.waiting, ['XYZ-1380'])
})

test('computePlan : les vagues s’enchaînent par suite: et les bloqueurs sont nommés', () => {
  const plan = computePlan([
    mission('ABC-74', 'active', 'konoha', 1),
    mission('ABC-77', 'ready', 'konoha', 2, 'ABC-74'),
    mission('ABC-78', 'ready', 'konoha', 3, 'ABC-77'),
  ])
  assert.equal(plan.nodes.find((node) => node.id === 'ABC-77').wave, 2)
  assert.equal(plan.nodes.find((node) => node.id === 'ABC-78').wave, 3)
  assert.deepEqual(plan.blocks['ABC-77'], ['ABC-78'])
})

test('computePlan : une mission close hors file ne bloque plus', () => {
  const plan = computePlan([
    { id: 'ABC-74', status: 'done', repo: 'konoha', queue: 0, suite: '' },
    mission('ABC-77', 'ready', 'konoha', 1, 'ABC-74'),
  ])
  assert.deepEqual(plan.executable, ['ABC-77'])
})

test('normalizeRunningLimit : cinq par défaut, entier entre un et cinquante', () => {
  assert.equal(DEFAULT_RUNNING_LIMIT, 5)
  assert.equal(normalizeRunningLimit(undefined), 5)
  assert.equal(normalizeRunningLimit(null), 5)
  assert.equal(normalizeRunningLimit(''), 5)
  assert.equal(normalizeRunningLimit('abc'), 5)
  assert.equal(normalizeRunningLimit(1), 1)
  assert.equal(normalizeRunningLimit(5), 5)
  assert.equal(normalizeRunningLimit('7'), 7)
  assert.equal(normalizeRunningLimit(2.4), 2)
  assert.equal(normalizeRunningLimit(0), 1)
  assert.equal(normalizeRunningLimit(-3), 1)
  assert.equal(normalizeRunningLimit(51), 50)
})
