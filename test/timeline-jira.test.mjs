import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveRoots } from '../lib/performance/metrics.js'
import { buildTimeline } from '../lib/performance/timeline.js'

const FICHE = `---
id: UV-1185
type: produit
status: in_review
priority:
epic: UV-483
story_points: 1
repo: ~/projects/registre
base_branch: epic/UV-483
category:
branch_name: feat/UV-1185
pr: 42
suite:
queue:
bruno: []
---

# Sujet de démonstration

## Objectif

Test.
`

const JOURNAL = `# Journal

## 2026-10-26 — Cadrage

Fiche ouverte.

## 2026-10-29 — Cadrage Jira

Ticket passé Ready to Dev.

## 2026-11-03 — Exécution

Travail ouvert.
`

const JIRA = {
  key: 'UV-1185',
  summary: 'Sujet de démonstration',
  created: '2026-10-26T10:53:53.557+0100',
  status: 'Ready to Dev',
  readyToDev: '2026-10-29T14:34:45.167+0100',
  readyFrom: 'Inbox',
  transitions: [{ at: '2026-10-29T14:34:45.167+0100', from: 'Inbox', to: 'Ready to Dev' }],
  state: 'retenu',
  reason: '',
  syncedAt: '2026-11-03T17:07:00.000+0100',
}

async function rootsWith(jira) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-timeline-'))
  await mkdir(join(root, 'missions', 'UV-1185'), { recursive: true })
  await mkdir(join(root, 'projects'), { recursive: true })
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(join(root, 'missions', 'UV-1185', 'mission.md'), FICHE)
  await writeFile(join(root, 'missions', 'UV-1185', 'journal.md'), JOURNAL)
  if (jira) await writeFile(join(root, 'missions', 'UV-1185', 'jira.json'), JSON.stringify(jira))
  return {
    root,
    roots: resolveRoots({
      roots: {
        konohaRoot: root,
        projectsRoot: join(root, 'projects'),
        sessionsRoot: join(root, 'sessions'),
        linksFile: join(root, 'links.json'),
      },
    }),
  }
}

test('la Timeline prend les bornes Jira quand jira.json est retenu', async () => {
  const { root, roots } = await rootsWith(JIRA)
  try {
    const timeline = await buildTimeline({ roots, period: 'week' })
    const row = timeline.rows.find((candidate) => candidate.id === 'UV-1185')
    assert.ok(row)
    assert.equal(row.source, 'jira')
    assert.ok(Math.abs(row.steps.cadrage / 3_600_000 - 75.68) < 0.02)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sans jira.json, la Timeline garde le repli journal', async () => {
  const { root, roots } = await rootsWith(null)
  try {
    const timeline = await buildTimeline({ roots, period: 'week' })
    const row = timeline.rows.find((candidate) => candidate.id === 'UV-1185')
    assert.ok(row)
    assert.equal(row.source, 'repli')
    assert.ok(Math.abs(row.steps.cadrage / 3_600_000 - 12) < 0.02)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const LIVREE_FICHE = `---
id: UV-9000
type: produit
status: done
priority:
epic: UV-483
story_points:
repo: ~/projects/registre
base_branch: epic/UV-483
category: feat
branch_name: feat/UV-9000
pr: 1
suite:
queue:
bruno: []
---

# Mission livrée

## Objectif

Test.
`

function dayOffset(offset) {
  const date = new Date()
  date.setHours(10, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return date
}

function stamp(offset) {
  return dayOffset(offset).toISOString()
}

test('une mission livrée se lit sur son cycle Jira et valide jusqu’à sa clôture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-livree-'))
  try {
    const dir = join(root, 'missions', 'UV-9000')
    await mkdir(dir, { recursive: true })
    await mkdir(join(root, 'projects'), { recursive: true })
    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(join(dir, 'mission.md'), LIVREE_FICHE)
    await writeFile(
      join(dir, 'journal.md'),
      `# Journal\n\n## ${stamp(-40).slice(0, 10)} — Création Jira et cadrage\n\nOuverture.\n\n## ${stamp(0).slice(0, 10)} — Clôture\n\nFermée.\n`,
    )
    await writeFile(
      join(dir, 'jira.json'),
      JSON.stringify({
        key: 'UV-9000',
        created: stamp(-40),
        transitions: [
          { at: stamp(-38), from: 'Inbox', to: 'Ready to Dev' },
          { at: stamp(-37), from: 'Ready to Dev', to: 'To Dev' },
          { at: stamp(-20), from: 'To Dev', to: 'Code review' },
          { at: stamp(-10), from: 'Code review', to: 'Local Testing' },
        ],
      }),
    )
    const roots = resolveRoots({
      roots: {
        konohaRoot: root,
        projectsRoot: join(root, 'projects'),
        sessionsRoot: join(root, 'sessions'),
        linksFile: join(root, 'links.json'),
      },
    })
    const timeline = await buildTimeline({ roots, period: 'week' })
    const row = timeline.rows.find((candidate) => candidate.id === 'UV-9000')
    assert.ok(row)
    assert.equal(row.source, 'jira')
    assert.equal(Math.round(row.steps.cadrage / 86_400_000), 2)
    assert.equal(Math.round(row.steps.exec / 86_400_000), 17)
    assert.equal(Math.round(row.steps.val / 86_400_000), 10)
    assert.equal(row.steps.close, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
