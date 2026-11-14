import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { attachPins, loadPins, PINS_FILE, savePin } from '../lib/pins.js'

/**
 * L'étagère des épingles : un seul `pins.yml`, une liste `pinned:` de clés.
 *
 * Ces tests écrivent de vrais fichiers dans un dossier temporaire : le format
 * du fichier, l'en-tête et les erreurs remontées font partie du contrat.
 */
async function fixtures(t, files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-pins-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

const PINS = 'pinned:\n  - MIS-14\n  - MIS-7\n'

test('la liste des clés épinglées est lue, dans l’ordre du fichier', async (t) => {
  const dir = await fixtures(t, { [PINS_FILE]: PINS })

  const { pinned, errors } = await loadPins(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual([...pinned], ['MIS-14', 'MIS-7'])
})

test('un dossier sans fichier n’est pas une erreur, juste une liste vide', async (t) => {
  const dir = await fixtures(t)
  const { pinned, errors } = await loadPins(join(dir, 'absent'))
  assert.equal(pinned.size, 0)
  assert.deepEqual(errors, [])
})

test('un dossier passé en URL est accepté', async (t) => {
  const dir = await fixtures(t, { [PINS_FILE]: PINS })
  const { pinned, errors } = await loadPins(pathToFileURL(`${dir}/`))
  assert.deepEqual(errors, [])
  assert.equal(pinned.has('MIS-7'), true)
})

test('les entrées vides ou non textuelles sont signalées, les bonnes restent', async (t) => {
  const dir = await fixtures(t, {
    [PINS_FILE]: 'pinned:\n  - MIS-14\n  - ""\n  - 42\n  - "  MIS-7  "\n',
  })

  const { pinned, errors } = await loadPins(dir)
  assert.deepEqual([...pinned], ['MIS-14', 'MIS-7'])
  assert.equal(errors.length, 2)
  assert.ok(errors.every((error) => error.project === 'pins'))
  assert.match(errors[0].message, /pinned entries must be non-empty strings/)
})

test('un fichier casse est signalé et lu comme vide', async (t) => {
  const dir = await fixtures(t, {
    [PINS_FILE]: 'pinned: [MIS-14\n',
  })

  const { pinned, errors } = await loadPins(dir)
  assert.equal(pinned.size, 0)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].project, 'pins')
  assert.match(errors[0].message, /pins\.yml:/)
})

test('un fichier qui n’est pas une table, ou une liste mal typée, est signalé', async (t) => {
  const dir = await fixtures(t, {
    [`liste/${PINS_FILE}`]: '- MIS-14\n',
    [`type/${PINS_FILE}`]: 'pinned: MIS-14\n',
  })

  const table = await loadPins(join(dir, 'liste'))
  assert.equal(table.pinned.size, 0)
  assert.match(table.errors[0].message, /must be a mapping/)

  const type = await loadPins(join(dir, 'type'))
  assert.equal(type.pinned.size, 0)
  assert.match(type.errors[0].message, /pinned must be a list/)
})

test('épingler crée le fichier avec son en-tête et sa liste', async (t) => {
  const dir = await fixtures(t)

  const result = await savePin(dir, { key: 'MIS-14', pinned: true })
  assert.deepEqual(result, { key: 'MIS-14', pinned: true })

  const text = await readFile(join(dir, PINS_FILE), 'utf8')
  assert.match(text, /^# Épingles du poste — jamais versionné\.\n/)
  assert.match(text, /\npinned:\n  - MIS-14\n$/)

  const { pinned } = await loadPins(dir)
  assert.deepEqual([...pinned], ['MIS-14'])
})

test('épingler puis dépinger garde l’ordre et les autres clés', async (t) => {
  const dir = await fixtures(t, {
    [PINS_FILE]: '# Épingles du poste — jamais versionné.\n# ma note\npinned:\n  - MIS-14\n  - MIS-7\n',
  })

  await savePin(dir, { key: 'MIS-14', pinned: false })
  await savePin(dir, { key: 'MIS-20', pinned: true })

  const text = await readFile(join(dir, PINS_FILE), 'utf8')
  assert.match(text, /# ma note/)
  const { pinned } = await loadPins(dir)
  assert.deepEqual([...pinned], ['MIS-7', 'MIS-20'])
})

test('une clé vide ou un drapeau non booléen est refusé, rien n’est écrit', async (t) => {
  const dir = await fixtures(t)

  await assert.rejects(savePin(dir, { key: '  ', pinned: true }), (error) => error.status === 400 && /key is missing/.test(error.message))
  await assert.rejects(savePin(dir, { key: 'MIS-14', pinned: 'yes' }), (error) => error.status === 400 && /pinned must be a boolean/.test(error.message))
  await assert.rejects(savePin(dir, { key: 'MIS-14' }), (error) => error.status === 400)

  const { pinned } = await loadPins(dir)
  assert.equal(pinned.size, 0)
  await assert.rejects(readFile(join(dir, PINS_FILE), 'utf8'), { code: 'ENOENT' })
})

test('un fichier cassé est refusé au lieu d’être écrasé', async (t) => {
  const dir = await fixtures(t, { [PINS_FILE]: 'pinned: [MIS-14\n' })

  await assert.rejects(savePin(dir, { key: 'MIS-14', pinned: true }), (error) => error.status === 400)
  const text = await readFile(join(dir, PINS_FILE), 'utf8')
  assert.equal(text, 'pinned: [MIS-14\n')
})

test('deux épingles simultanées ne se perdent pas', async (t) => {
  const dir = await fixtures(t)

  await Promise.all([
    savePin(dir, { key: 'MIS-14', pinned: true }),
    savePin(dir, { key: 'MIS-7', pinned: true }),
    savePin(dir, { key: 'MIS-14', pinned: false }),
    savePin(dir, { key: 'MIS-20', pinned: true }),
  ])

  const { pinned, errors } = await loadPins(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual([...pinned], ['MIS-7', 'MIS-20'])
})

test('chaque mission porte son drapeau, épinglée ou non', () => {
  const missions = [{ key: 'MIS-14' }, { key: 'MIS-7' }, { key: 'MIS-20' }]
  const attached = attachPins(missions, new Set(['MIS-7']))
  assert.deepEqual(attached.map((mission) => [mission.key, mission.pinned]), [
    ['MIS-14', false],
    ['MIS-7', true],
    ['MIS-20', false],
  ])
  // L'entrée n'est pas mutée : le même objet peut être relu par un autre onglet.
  assert.equal(missions[0].pinned, undefined)
})
