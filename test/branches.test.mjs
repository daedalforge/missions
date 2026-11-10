import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { attachBranches, loadBranches, MISSION_FILE } from '../lib/branches.js'

/**
 * Le store des branches : un dossier par mission, un `mission.yml` par dossier.
 *
 * Ces tests écrivent de vrais fichiers dans un dossier temporaire : le format
 * du fichier et les erreurs remontées font partie du contrat.
 */
async function fixtures(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-branches-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return dir
}

const DECLARATION = 'key: daedalforge/missions#41\nbranch: gh-41\nbase: main\n'

test('un dossier par mission : la branche et la base sont lues', async (t) => {
  const dir = await fixtures(t, {
    [`GH-41/${MISSION_FILE}`]: DECLARATION,
    [`SO-1184/${MISSION_FILE}`]: 'key: SO-1184\nbranch: feat/so-1184\n',
  })

  const { index, errors } = await loadBranches(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual(index.get('daedalforge/missions#41'), { branch: 'gh-41', base: 'main' })
  assert.deepEqual(index.get('SO-1184'), { branch: 'feat/so-1184', base: null })
})

test('un dossier sans mission.yml et un fichier à la racine sont ignorés', async (t) => {
  const dir = await fixtures(t, {
    'GH-41/notes.md': 'pas une déclaration',
    'projets.yml': 'key: nope\n',
  })

  const { index, errors } = await loadBranches(dir)
  assert.equal(index.size, 0)
  assert.deepEqual(errors, [])
})

test('un dossier absent n’est pas une erreur, juste un index vide', async (t) => {
  const dir = await fixtures(t, {})
  const { index, errors } = await loadBranches(join(dir, 'absent'))
  assert.equal(index.size, 0)
  assert.deepEqual(errors, [])
})

test('un dossier passé en URL est accepté', async (t) => {
  const dir = await fixtures(t, { [`GH-41/${MISSION_FILE}`]: DECLARATION })
  const { index, errors } = await loadBranches(pathToFileURL(`${dir}/`))
  assert.deepEqual(errors, [])
  assert.equal(index.get('daedalforge/missions#41').base, 'main')
})

test('la déclaration de ce dépôt est lue par défaut', async () => {
  // `missions/GH-41/mission.yml` : la mission #41 se déclare elle-même, et le
  // chemin par défaut passe par une URL (le piège que ce test couvre).
  const { index, errors } = await loadBranches()
  assert.deepEqual(errors, [])
  assert.deepEqual(index.get('daedalforge/missions#41'), { branch: 'gh-41', base: 'main' })
})

test('la clé est obligatoire, branch et base sont optionnels', async (t) => {
  const dir = await fixtures(t, {
    'sans-cle/mission.yml': 'branch: gh-1\n',
    'sans-branche/mission.yml': 'key: daedalforge/missions#1\n',
    'vide/mission.yml': '',
    'liste/mission.yml': '- key: a\n',
  })

  const { index, errors } = await loadBranches(dir)
  assert.deepEqual([...index.keys()], ['daedalforge/missions#1'])
  assert.deepEqual(index.get('daedalforge/missions#1'), { branch: null, base: null })
  assert.equal(errors.length, 3, errors.map((error) => error.message).join(' | '))
  assert.ok(errors.every((error) => error.project === 'branches'))
  assert.match(errors.map((error) => error.message).join('\n'), /sans-cle\/mission\.yml: key is missing/)
  assert.match(errors.map((error) => error.message).join('\n'), /liste\/mission\.yml: must be a mapping/)
})

test('un champ inconnu est signalé, pas deviné', async (t) => {
  const dir = await fixtures(t, {
    'GH-41/mission.yml': 'key: daedalforge/missions#41\nbranch: gh-41\nbase: main\nbranche: gh-41\n',
    'GH-42/mission.yml': 'key: 41\nbranch: gh-42\n',
    'GH-43/mission.yml': 'key: daedalforge/missions#43\nbranch: ""\n',
    'GH-44/mission.yml': 'key: daedalforge/missions#44\nbranch: 42\n',
    'GH-45/mission.yml': 'key: daedalforge/missions#45\nbase: [main]\n',
  })

  const { index, errors } = await loadBranches(dir)
  assert.equal(index.size, 0)
  const message = errors.map((error) => error.message).join('\n')
  assert.match(message, /unknown field\(s\): branche/)
  assert.match(message, /key must be a non-empty string/)
  assert.match(message, /branch must be a non-empty string/)
  assert.match(message, /GH-44\/mission\.yml: branch must be a non-empty string/)
  assert.match(message, /GH-45\/mission\.yml: base must be a non-empty string/)
})

test('un dossier illisible est signalé sans masquer les missions', async (t) => {
  const dir = await fixtures(t, { fichier: 'x' })

  const { index, errors } = await loadBranches(join(dir, 'fichier'))
  assert.equal(index.size, 0)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].project, 'branches')
  assert.match(errors[0].message, /missions folder: ENOTDIR/)
})

test('une clé déclarée deux fois signale les deux dossiers', async (t) => {
  const dir = await fixtures(t, {
    'A/mission.yml': DECLARATION,
    'B/mission.yml': DECLARATION,
  })

  const { index, errors } = await loadBranches(dir)
  assert.equal(index.size, 1)
  assert.equal(index.get('daedalforge/missions#41').branch, 'gh-41')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /B\/mission\.yml: key "daedalforge\/missions#41" is already declared in A\/mission\.yml/)
})

test('un YAML invalide ne masque pas les autres déclarations', async (t) => {
  const dir = await fixtures(t, {
    'casse/mission.yml': 'key: [\n',
    [`GH-41/${MISSION_FILE}`]: DECLARATION,
  })

  const { index, errors } = await loadBranches(dir)
  assert.equal(index.size, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /^casse\/mission\.yml: /)
})

test('attachBranches pose les valeurs déclarées et null pour les autres', () => {
  const missions = [
    { key: 'daedalforge/missions#41', title: 'Props' },
    { key: 'SO-1184', title: 'Autre' },
  ]
  const index = new Map([['daedalforge/missions#41', { branch: 'gh-41', base: 'main' }]])

  const attached = attachBranches(missions, index)
  assert.deepEqual(attached, [
    { key: 'daedalforge/missions#41', title: 'Props', branch: 'gh-41', base: 'main' },
    { key: 'SO-1184', title: 'Autre', branch: null, base: null },
  ])
  // La liste du tracker n'est pas modifiée en place.
  assert.equal(missions[0].branch, undefined)
  assert.deepEqual(attachBranches(missions), [
    { key: 'daedalforge/missions#41', title: 'Props', branch: null, base: null },
    { key: 'SO-1184', title: 'Autre', branch: null, base: null },
  ])
  assert.deepEqual(attachBranches(), [])
})
