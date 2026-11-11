import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { JOURNAL_LIMIT, emptyJournal, readJournal } from '../lib/journal.js'

/**
 * Le journal d'une mission : un markdown local, à côté de `mission.yml`.
 *
 * Ces tests lisent de vrais fichiers dans un dossier temporaire. Le contrat est
 * celui de l'ancien système — forme vide sans fichier, source exacte avec sa
 * date, source bornée — et le dossier vient toujours des déclarations, jamais
 * d'une clé de requête.
 */
async function fixtures(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-journal-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

test('un dossier sans journal rend la forme vide', async (t) => {
  const dir = await fixtures(t, { 'MIS-69/mission.yml': 'key: MIS-69\nbranch: feat/mis-69\nbase: main\n' })

  assert.deepEqual(await readJournal(dir, 'MIS-69'), { exists: false, source: '', mtimeMs: 0 })
  assert.deepEqual(await readJournal(dir, null), { exists: false, source: '', mtimeMs: 0 })
  assert.deepEqual(emptyJournal(), { exists: false, source: '', mtimeMs: 0 })
})

test('le journal est lu tel quel, avec sa date', async (t) => {
  const source = '# Journal — MIS-69\n\n## 2026-11-11 — Cadrage\n\nDemande et lectures.\n'
  const dir = await fixtures(t, { 'MIS-69/journal.md': source })

  const journal = await readJournal(dir, 'MIS-69')
  assert.equal(journal.exists, true)
  assert.equal(journal.source, source)
  assert.ok(journal.mtimeMs > 0)
})

test('la source est bornée à 200 000 caractères', async (t) => {
  const dir = await fixtures(t, { 'MIS-69/journal.md': 'a'.repeat(JOURNAL_LIMIT) + 'trop' })

  const journal = await readJournal(dir, 'MIS-69')
  assert.equal(journal.exists, true)
  assert.equal(journal.source.length, JOURNAL_LIMIT)
  assert.equal(journal.source, 'a'.repeat(JOURNAL_LIMIT))
})
