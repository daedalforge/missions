import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readMissionJournal, scanAllMissions } from '../lib/missions.js'
import { resolveRoots } from '../lib/performance/metrics.js'
import { buildTimeline } from '../lib/performance/timeline.js'

function isoDay(offset) {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}

const STAMP_BASE = Date.now()

function isoStamp(offset) {
  return new Date(STAMP_BASE + offset * 86_400_000).toISOString()
}

const OPEN_FICHE = `---
id: OPS-1
type: produit
status: active
priority:
epic:
story_points:
repo: ~/projects/Test
base_branch: main
category:
branch_name: feat/ops-1
pr:
suite:
queue:
bruno: []
---

# Mission ouverte de test
`

const ARCHIVED_FICHE = `---
id: OPS-9
type: produit
status: done
priority:
epic:
story_points:
repo: ~/projects/Test
base_branch: main
category:
branch_name: feat/ops-9
pr:
suite:
queue:
bruno: []
---

# Mission archivée de test
`

const ARCHIVED_JIRA_FICHE = `---
id: OPS-10
type: produit
status: done
priority:
epic:
story_points:
repo: ~/projects/Test
base_branch: main
category:
branch_name: feat/ops-10
pr:
suite:
queue:
bruno: []
---

# Mission archivée datée par Jira
`

async function rootsWithArchive() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archives-'))
  await mkdir(join(root, 'missions', 'OPS-1'), { recursive: true })
  await mkdir(join(root, 'missions', 'archives', 'OPS-9'), { recursive: true })
  await mkdir(join(root, 'projects'), { recursive: true })
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(join(root, 'missions', 'OPS-1', 'mission.md'), OPEN_FICHE)
  await writeFile(join(root, 'missions', 'OPS-1', 'journal.md'), `# Journal\n\n## ${isoDay(-5)} — Cadrage\n\nOuverture.\n`)
  await writeFile(join(root, 'missions', 'archives', 'OPS-9', 'mission.md'), ARCHIVED_FICHE)
  await writeFile(
    join(root, 'missions', 'archives', 'OPS-9', 'journal.md'),
    `# Journal\n\n## ${isoDay(-6)} — Cadrage\n\nOuverture.\n\n## ${isoDay(-1)} — Clôture\n\nFermée.\n`,
  )
  await mkdir(join(root, 'missions', 'archives', 'OPS-10'), { recursive: true })
  await writeFile(join(root, 'missions', 'archives', 'OPS-10', 'mission.md'), ARCHIVED_JIRA_FICHE)
  await writeFile(
    join(root, 'missions', 'archives', 'OPS-10', 'journal.md'),
    `# Journal\n\n## ${isoDay(-6)} — Cadrage\n\nOuverture.\n\n## ${isoDay(-1)} — Clôture\n\nFermée.\n`,
  )
  await writeFile(
    join(root, 'missions', 'archives', 'OPS-10', 'jira.json'),
    JSON.stringify({
      key: 'OPS-10',
      created: isoStamp(-6),
      transitions: [
        { at: isoStamp(-5), to: 'Ready to Dev' },
        { at: isoStamp(-4), to: 'To Dev' },
        { at: isoStamp(-2), to: 'Code review' },
        { at: isoStamp(-1), to: 'Ready for prod' },
      ],
    }),
  )
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

test('scanAllMissions donne le chemin archives aux missions archivées', async () => {
  const { root } = await rootsWithArchive()
  try {
    const missions = await scanAllMissions(join(root, 'missions'))
    const open = missions.find((mission) => mission.id === 'OPS-1')
    const archived = missions.find((mission) => mission.id === 'OPS-9')
    assert.equal(open.dir, 'OPS-1')
    assert.equal(archived.dir, join('archives', 'OPS-9'))
    assert.equal(archived.archived, true)
    const journal = await readMissionJournal(join(root, 'missions'), archived.dir)
    assert.equal(journal.exists, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('la Timeline compte une mission archivée fermée dans la fenêtre', async () => {
  const { root, roots } = await rootsWithArchive()
  try {
    const timeline = await buildTimeline({ roots, period: 'week' })
    const row = timeline.rows.find((candidate) => candidate.id === 'OPS-9')
    assert.ok(row)
    assert.equal(row.status, 'done')
    assert.ok(row.cycle > 0)
    assert.equal(row.steps.close, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('une archive datée par Jira prend son cycle dans le changelog', async () => {
  const { root, roots } = await rootsWithArchive()
  try {
    const timeline = await buildTimeline({ roots, period: 'week' })
    const row = timeline.rows.find((candidate) => candidate.id === 'OPS-10')
    assert.ok(row)
    assert.equal(row.source, 'jira')
    assert.equal(row.steps.cadrage, 86_400_000)
    assert.equal(row.steps.go, 86_400_000)
    assert.equal(row.steps.exec, 2 * 86_400_000)
    assert.equal(row.steps.review, 86_400_000)
    assert.equal(row.steps.val, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
