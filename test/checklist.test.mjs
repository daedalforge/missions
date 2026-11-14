import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { CHECKLIST_LIMIT, emptyChecklist, readChecklist } from '../lib/checklist.js'

/**
 * La checklist d'une mission : un markdown local, à côté de `mission.yml`.
 *
 * Ces tests lisent de vrais fichiers dans un dossier temporaire. Le contrat est
 * celui de l'ancien système — forme vide sans fichier, source exacte avec sa
 * date, source bornée — et le dossier vient toujours des déclarations, jamais
 * d'une clé de requête.
 */
async function fixtures(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-checklist-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

test('un dossier sans checklist rend la forme vide', async (t) => {
  const dir = await fixtures(t, { 'MIS-70/mission.yml': 'key: MIS-70\nbranch: feat/mis-70\nbase: main\n' })

  assert.deepEqual(await readChecklist(dir, 'MIS-70'), { exists: false, source: '', mtimeMs: 0 })
  assert.deepEqual(await readChecklist(dir, null), { exists: false, source: '', mtimeMs: 0 })
  assert.deepEqual(emptyChecklist(), { exists: false, source: '', mtimeMs: 0 })
})

test('la checklist est lue telle quelle, avec sa date', async (t) => {
  const source = '# Checklist — MIS-70\n\n## Exécution\n\n- [x] Les tests passent. — *test* : `npm test`\n- [ ] La PR est ouverte.\n'
  const dir = await fixtures(t, { 'MIS-70/checklist.md': source })

  const checklist = await readChecklist(dir, 'MIS-70')
  assert.equal(checklist.exists, true)
  assert.equal(checklist.source, source)
  assert.ok(checklist.mtimeMs > 0)
})

test('la source est bornée à 200 000 caractères', async (t) => {
  const dir = await fixtures(t, { 'MIS-70/checklist.md': 'a'.repeat(CHECKLIST_LIMIT) + 'trop' })

  const checklist = await readChecklist(dir, 'MIS-70')
  assert.equal(checklist.exists, true)
  assert.equal(checklist.source.length, CHECKLIST_LIMIT)
  assert.equal(checklist.source, 'a'.repeat(CHECKLIST_LIMIT))
})
