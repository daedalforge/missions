import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMissionJournal } from '../lib/index.js'

async function missionDir(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-missions-journal-'))
  await mkdir(join(root, 'ABC-61'), { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, 'ABC-61', name), content)
  return root
}

test('sans journal.md, la mission déclare un journal absent', async () => {
  const root = await missionDir({ 'mission.md': '# Fiche\n' })
  const journal = readMissionJournal(root, 'ABC-61')

  assert.deepEqual(journal, { exists: false, source: '', mtimeMs: 0 })
})

test('journal.md est lu tel quel, avec sa date de modification', async () => {
  const content = '# Journal — ABC-61\n\n## 2026-10-29 — Ouverture\n\nTexte.\n'
  const root = await missionDir({ 'journal.md': content })
  const journal = readMissionJournal(root, 'ABC-61')

  assert.equal(journal.exists, true)
  assert.equal(journal.source, content)
  assert.ok(journal.mtimeMs > 0)
})

test('le journal est borné à 200 000 caractères', async () => {
  const exactly = 'a'.repeat(200_000)
  const root = await missionDir({ 'journal.md': `${exactly}de trop` })
  const journal = readMissionJournal(root, 'ABC-61')

  assert.equal(journal.source.length, 200_000)
  assert.equal(journal.source, exactly)
})

test('une mission inconnue sur le disque ne casse pas la lecture', async () => {
  const root = await missionDir({})
  const journal = readMissionJournal(root, 'MAI-99')

  assert.deepEqual(journal, { exists: false, source: '', mtimeMs: 0 })
})
