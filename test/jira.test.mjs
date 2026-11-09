import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstReadyToDev, importFiche, importJournal, isDelivered, jiraLifecycle, parseJqlKeys, stateOf } from '../lib/performance/jira.js'
import { parseJournal } from '../lib/missions.js'

test('parseJqlKeys lit les lignes de jql.sh', () => {
  const output = [
    'UV-1185  [Ready to Dev]  Camille  Story  Sujet de démonstration',
    'XYZ-1546  [Inbox]  Camille  Task  Test',
    '',
    '2 tickets',
  ].join('\n')
  assert.deepEqual(parseJqlKeys(output), ['UV-1185', 'XYZ-1546'])
})

test('firstReadyToDev retient la première transition, Ready for dev inclus', () => {
  const transitions = [
    { at: '2026-10-29T14:34:45.167+0100', from: 'Inbox', to: 'Ready to Dev' },
    { at: '2026-10-05T15:49:50.829+0200', from: 'To Refine', to: 'Ready for dev' },
    { at: '2026-10-30T11:10:02.641+0100', from: 'Code review', to: 'Ready for prod' },
  ]
  assert.equal(firstReadyToDev(transitions).to, 'Ready for dev')
  assert.equal(firstReadyToDev([]), null)
})

test('stateOf retient, rejette ou constate l’absence de transition', () => {
  assert.deepEqual(stateOf({ ready: null, journalFirstDate: '2026-10-26' }).state, 'sans-transition')
  assert.equal(
    stateOf({
      ready: { at: '2026-10-29T14:34:45.167+0100' },
      created: '2026-10-26T10:53:53.557+0100',
      journalFirstDate: '2026-10-26',
    }).state,
    'retenu',
  )
  assert.equal(
    stateOf({
      ready: { at: '2026-10-31T10:00:00.000+0100' },
      created: '2026-07-17T10:00:00.000+0200',
      journalFirstDate: '2026-10-30',
    }).state,
    'rejete',
  )
  assert.equal(
    stateOf({ ready: { at: '2026-08-14T14:41:01.432+0200' }, journalFirstDate: '2026-10-30' }).state,
    'rejete',
  )
  assert.equal(stateOf({ ready: { at: '2026-10-29T14:34:45.167+0100' }, journalFirstDate: null }).state, 'rejete')
})

test('jiraLifecycle dérive le cycle d’un ticket de ses transitions', () => {
  const lifecycle = jiraLifecycle({
    created: '2026-09-01T10:00:00.000+0200',
    transitions: [
      { at: '2026-09-02T10:00:00.000+0200', from: 'Inbox', to: 'Ready to Dev' },
      { at: '2026-09-03T10:00:00.000+0200', from: 'Ready to Dev', to: 'To Dev' },
      { at: '2026-09-03T11:00:00.000+0200', from: 'To Dev', to: 'In Progress' },
      { at: '2026-09-05T10:00:00.000+0200', from: 'In Progress', to: 'Code review' },
      { at: '2026-09-06T10:00:00.000+0200', from: 'Code review', to: 'Ready for prod' },
    ],
  })
  assert.equal(lifecycle.steps.cadrage, 24 * 3_600_000)
  assert.equal(lifecycle.steps.go, 24 * 3_600_000)
  assert.equal(lifecycle.steps.exec, 2 * 24 * 3_600_000)
  assert.equal(lifecycle.steps.review, 24 * 3_600_000)
  assert.equal(lifecycle.steps.val, 0)
  assert.equal(lifecycle.end, Date.parse('2026-09-06T10:00:00.000+0200'))
  assert.equal(jiraLifecycle({ created: '2026-09-01T10:00:00+0200', transitions: [] }), null)
})

test('une mission livrée porte sa validation jusqu’à sa clôture', () => {
  const jira = {
    created: '2026-09-01T10:00:00.000+0200',
    transitions: [
      { at: '2026-09-02T10:00:00.000+0200', from: 'Inbox', to: 'Ready to Dev' },
      { at: '2026-09-03T10:00:00.000+0200', from: 'Ready to Dev', to: 'In Progress' },
      { at: '2026-09-05T10:00:00.000+0200', from: 'In Progress', to: 'Code review' },
      { at: '2026-09-06T10:00:00.000+0200', from: 'Code review', to: 'Local Testing' },
    ],
  }
  assert.equal(isDelivered(jira), true)
  assert.equal(isDelivered({ ...jira, transitions: jira.transitions.slice(0, 3) }), false)
  assert.equal(isDelivered({ transitions: [] }), false)
  const lifecycle = jiraLifecycle(jira, { closedAt: Date.parse('2026-10-06T10:00:00.000+0200') })
  assert.equal(lifecycle.steps.val, 30 * 24 * 3_600_000)
  assert.equal(lifecycle.end, Date.parse('2026-10-06T10:00:00.000+0200'))
  assert.equal(jiraLifecycle(jira).steps.val, 0)
})

test('importFiche respecte le template produit', () => {
  const fiche = importFiche({
    key: 'XYZ-1546',
    summary: 'Test',
    created: '2026-11-02T10:00:00.000+0100',
    status: 'Inbox',
    epic: 'XYZ-1494',
    today: '2026-11-03',
  })
  assert.match(fiche, /^---\nid: XYZ-1546\ntype: produit\nstatus: draft\n/m)
  assert.match(fiche, /\nepic: XYZ-1494\n/)
  assert.match(fiche, /\n# Test\n/)
  assert.match(fiche, /\n## Objectif\n/)
  assert.match(fiche, /\n## Scope\n/)
})

test('importJournal produit un événement que parseJournal relit', () => {
  const journal = importJournal({
    key: 'XYZ-1546',
    summary: 'Test',
    created: '2026-11-02T10:00:00.000+0100',
    status: 'Inbox',
    epic: 'XYZ-1494',
    today: '2026-11-03',
  })
  const parsed = parseJournal(journal)
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].date, '2026-11-03')
  assert.equal(parsed.events[0].title, 'Import depuis Jira')
})
