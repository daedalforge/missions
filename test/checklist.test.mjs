import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMissionChecklist } from '../lib/index.js'

async function missionDir(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-missions-checklist-'))
  await mkdir(join(root, 'XYZ-1437'), { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, 'XYZ-1437', name), content)
  return root
}

test('sans checklist-manuelle.md, la mission déclare une checklist absente', async () => {
  const root = await missionDir({ 'mission.md': '# Fiche\n' })
  const checklist = readMissionChecklist(root, 'XYZ-1437')

  assert.deepEqual(checklist, { exists: false, source: '', mtimeMs: 0 })
})

test('checklist-manuelle.md est lu tel quel, avec sa date de modification', async () => {
  const content = '# XYZ-1437 — Checklist front\n\n- [ ] OK\n'
  const root = await missionDir({ 'checklist-manuelle.md': content })
  const checklist = readMissionChecklist(root, 'XYZ-1437')

  assert.equal(checklist.exists, true)
  assert.equal(checklist.source, content)
  assert.ok(checklist.mtimeMs > 0)
})

test('la checklist est bornée à 200 000 caractères', async () => {
  const exactly = 'a'.repeat(200_000)
  const root = await missionDir({ 'checklist-manuelle.md': `${exactly}de trop` })
  const checklist = readMissionChecklist(root, 'XYZ-1437')

  assert.equal(checklist.source.length, 200_000)
  assert.equal(checklist.source, exactly)
})

test('une mission inconnue sur le disque ne casse pas la lecture', async () => {
  const root = await missionDir({})
  const checklist = readMissionChecklist(root, 'ABC-99')

  assert.deepEqual(checklist, { exists: false, source: '', mtimeMs: 0 })
})
