import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { ArchiveError, archiveMission, ARCHIVES_FOLDER } from '../lib/archive.js'

/**
 * L'archivage d'une mission done : le dossier quitte le chemin de lecture.
 *
 * Ces tests écrivent de vrais fichiers dans un dossier temporaire : le
 * déplacement, le contenu conservé et les refus font partie du contrat.
 */
async function fixtures(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

const DONE = { key: 'MIS-42', state: 'done' }

test('une mission done passe sous archives/, son contenu est intact', async (t) => {
  const dir = await fixtures(t, {
    'MIS-42/mission.yml': 'key: MIS-42\nbranch: feat/mis-42\nbase: main\n',
    'MIS-42/journal.md': '# Journal — MIS-42\n',
    'MIS-42/checklist.md': '# Checklist — MIS-42\n',
  })

  const result = await archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: DONE })

  assert.deepEqual(result, { key: 'MIS-42', folder: 'MIS-42', archived: 'missions/archives/MIS-42' })
  await assert.rejects(stat(join(dir, 'MIS-42')), { code: 'ENOENT' })
  assert.equal(
    await readFile(join(dir, ARCHIVES_FOLDER, 'MIS-42', 'journal.md'), 'utf8'),
    '# Journal — MIS-42\n',
  )
  assert.equal(
    await readFile(join(dir, ARCHIVES_FOLDER, 'MIS-42', 'checklist.md'), 'utf8'),
    '# Checklist — MIS-42\n',
  )
  assert.equal(
    await readFile(join(dir, ARCHIVES_FOLDER, 'MIS-42', 'mission.yml'), 'utf8'),
    'key: MIS-42\nbranch: feat/mis-42\nbase: main\n',
  )
})

test('le premier archivage crée archives/ à côté des dossiers déclarés', async (t) => {
  const dir = await fixtures(t, { 'MIS-42/mission.yml': 'key: MIS-42\n' })

  await archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: DONE })

  assert.deepEqual(await readdir(dir), [ARCHIVES_FOLDER])
  assert.deepEqual(await readdir(join(dir, ARCHIVES_FOLDER)), ['MIS-42'])
})

test('refuse une mission qui n’est pas done, sans rien déplacer', async (t) => {
  const dir = await fixtures(t, { 'MIS-42/mission.yml': 'key: MIS-42\n' })

  await assert.rejects(
    archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: { key: 'MIS-42', state: 'in-review' } }),
    (error) => {
      assert.ok(error instanceof ArchiveError)
      assert.equal(error.status, 409)
      assert.match(error.message, /MIS-42 is not done/)
      return true
    },
  )
  assert.deepEqual(await readdir(dir), ['MIS-42'])
})

test('refuse un dossier source absent', async (t) => {
  const dir = await fixtures(t)

  await assert.rejects(
    archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: DONE }),
    (error) => {
      assert.equal(error.status, 409)
      assert.match(error.message, /mission folder MIS-42 is missing/)
      return true
    },
  )
  await assert.rejects(stat(join(dir, ARCHIVES_FOLDER)), { code: 'ENOENT' })
})

test('refuse une destination déjà occupée, sans l’écraser', async (t) => {
  const dir = await fixtures(t, {
    'MIS-42/journal.md': 'nouveau\n',
    [join(ARCHIVES_FOLDER, 'MIS-42', 'journal.md')]: 'ancien\n',
  })

  await assert.rejects(
    archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: DONE }),
    (error) => {
      assert.equal(error.status, 409)
      assert.match(error.message, /missions\/archives\/MIS-42 already exists/)
      return true
    },
  )
  assert.equal(await readFile(join(dir, 'MIS-42', 'journal.md'), 'utf8'), 'nouveau\n')
  assert.equal(await readFile(join(dir, ARCHIVES_FOLDER, 'MIS-42', 'journal.md'), 'utf8'), 'ancien\n')
})

test('la clé est obligatoire et le dossier ne sort pas de missions/', async (t) => {
  const dir = await fixtures(t, { 'MIS-42/mission.yml': 'key: MIS-42\n' })

  await assert.rejects(
    archiveMission({ root: dir, key: '  ', folder: 'MIS-42', mission: DONE }),
    (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /key is missing/)
      return true
    },
  )

  for (const folder of ['../MIS-42', 'a/b', 'archives']) {
    await assert.rejects(
      archiveMission({ root: dir, key: 'MIS-42', folder, mission: DONE }),
      (error) => {
        assert.equal(error.status, 409)
        assert.match(error.message, /invalid mission folder|archives folder cannot be archived/)
        return true
      },
    )
  }
  assert.deepEqual(await readdir(dir), ['MIS-42'])
})

test('deux archivages concurrents : un seul déplace la mission', async (t) => {
  const dir = await fixtures(t, { 'MIS-42/mission.yml': 'key: MIS-42\n' })

  const results = await Promise.allSettled([
    archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: DONE }),
    archiveMission({ root: dir, key: 'MIS-42', folder: 'MIS-42', mission: DONE }),
  ])

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const refused = results.find((result) => result.status === 'rejected')
  assert.equal(refused.reason.status, 409)
  assert.deepEqual(await readdir(join(dir, ARCHIVES_FOLDER)), ['MIS-42'])
})
