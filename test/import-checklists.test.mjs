import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { importChecklists } from '../tools/import-checklists.mjs'

/**
 * La migration des checklists de l'ancien système : `checklist-manuelle.md` →
 * `checklist.md`, contenu recopié tel quel, `mission.yml` réduit à la clé créé
 * quand le dossier n'en a pas.
 *
 * L'outil tourne une fois par workspace, mais son contrat se lit ici : jamais
 * d'écrasement, découverte des seuls dossiers qui portent une checklist.
 */
async function fixtures(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'missions-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }
  return root
}

test("importe une checklist dans le dossier de mission, sans toucher au contenu", async (t) => {
  const source = await fixtures(t, {
    'SO-1184/checklist-manuelle.md': '# SO-1184 — Checklist manuelle\n\n- [x] Fait. — *test* : `npm test`\n',
    'SO-1184/mission.md': '# Une fiche\n',
    'SO-999/notes.md': 'pas de checklist\n',
  })
  const dest = await fixtures(t, {})

  const report = await importChecklists({ from: source, to: dest })

  assert.deepEqual(report.map((line) => [line.key, line.status]), [['SO-1184', 'imported']])
  assert.equal(
    await readFile(join(dest, 'SO-1184', 'checklist.md'), 'utf8'),
    '# SO-1184 — Checklist manuelle\n\n- [x] Fait. — *test* : `npm test`\n',
  )
  assert.equal(await readFile(join(dest, 'SO-1184', 'mission.yml'), 'utf8'), [
    '# Déclaration de la mission SO-1184',
    '# Fichier local du panneau Missions, jamais versionné.',
    '',
    'key: SO-1184',
    '',
  ].join('\n'))
  // La fiche de l'ancien système n'est pas du périmètre : elle ne migre pas.
  await assert.rejects(readFile(join(dest, 'SO-1184', 'mission.md'), 'utf8'), { code: 'ENOENT' })
})

test('ne réécrit pas une checklist déjà migrée', async (t) => {
  const source = await fixtures(t, { 'SO-539/checklist-manuelle.md': 'ancienne version\n' })
  const dest = await fixtures(t, { 'SO-539/checklist.md': 'version retravaillée\n', 'SO-539/mission.yml': 'key: SO-539\nbranch: feat/so-539\nbase: main\n' })

  const report = await importChecklists({ from: source, to: dest })

  assert.deepEqual(report.map((line) => [line.key, line.status, line.declared]), [['SO-539', 'kept', false]])
  assert.equal(await readFile(join(dest, 'SO-539', 'checklist.md'), 'utf8'), 'version retravaillée\n')
  assert.equal(await readFile(join(dest, 'SO-539', 'mission.yml'), 'utf8'), 'key: SO-539\nbranch: feat/so-539\nbase: main\n')
})

test('une clé demandée mais absente est signalée, pas inventée', async (t) => {
  const source = await fixtures(t, { 'SO-1185/checklist-manuelle.md': 'x\n' })
  const dest = await fixtures(t, {})

  const report = await importChecklists({ from: source, to: dest, keys: ['SO-1185', 'SO-404'] })

  assert.deepEqual(report.map((line) => [line.key, line.status]), [['SO-1185', 'imported'], ['SO-404', 'absent']])
  await assert.rejects(readFile(join(dest, 'SO-404', 'checklist.md'), 'utf8'), { code: 'ENOENT' })
})
