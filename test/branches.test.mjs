import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

import { attachBranches, loadBranches, MISSION_FILE, saveDeclaration } from '../lib/branches.js'

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
  assert.deepEqual(index.get('daedalforge/missions#41'), { folder: 'GH-41', branch: 'gh-41', base: 'main' })
  assert.deepEqual(index.get('SO-1184'), { folder: 'SO-1184', branch: 'feat/so-1184', base: null })
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

test('la clé est obligatoire, branch et base sont optionnels', async (t) => {
  const dir = await fixtures(t, {
    'sans-cle/mission.yml': 'branch: gh-1\n',
    'sans-branche/mission.yml': 'key: daedalforge/missions#1\n',
    'vide/mission.yml': '',
    'liste/mission.yml': '- key: a\n',
  })

  const { index, errors } = await loadBranches(dir)
  assert.deepEqual([...index.keys()], ['daedalforge/missions#1'])
  assert.deepEqual(index.get('daedalforge/missions#1'), { folder: 'sans-branche', branch: null, base: null })
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
  const index = new Map([['daedalforge/missions#41', { folder: 'MIS-41', branch: 'gh-41', base: 'main' }]])

  const attached = attachBranches(missions, index)
  assert.deepEqual(attached, [
    { key: 'daedalforge/missions#41', title: 'Props', folder: 'MIS-41', branch: 'gh-41', base: 'main' },
    { key: 'SO-1184', title: 'Autre', folder: null, branch: null, base: null },
  ])
  // La liste du tracker n'est pas modifiée en place.
  assert.equal(missions[0].branch, undefined)
  assert.deepEqual(attachBranches(missions), [
    { key: 'daedalforge/missions#41', title: 'Props', folder: null, branch: null, base: null },
    { key: 'SO-1184', title: 'Autre', folder: null, branch: null, base: null },
  ])
  assert.deepEqual(attachBranches(), [])
})

test('saveDeclaration crée le dossier d’une mission sans déclaration', async (t) => {
  const dir = await fixtures(t, {})

  const saved = await saveDeclaration(dir, { key: 'daedalforge/missions#49', branch: 'gh-49', base: 'main' })
  assert.deepEqual(saved, {
    key: 'daedalforge/missions#49',
    folder: 'daedalforge-missions-49',
    branch: 'gh-49',
    base: 'main',
  })

  const { index, errors } = await loadBranches(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual(index.get(saved.key), { folder: saved.folder, branch: 'gh-49', base: 'main' })
  const text = await readFile(join(dir, saved.folder, MISSION_FILE), 'utf8')
  assert.match(text, /^key: daedalforge\/missions#49$/m)
  // Le fichier créé se présente : il vit hors de git.
  assert.match(text, /^# Fichier local du panneau Missions, jamais versionné\.$/m)
})

test('saveDeclaration réutilise le dossier existant et garde les commentaires', async (t) => {
  const dir = await fixtures(t, {
    [`GH-41/${MISSION_FILE}`]: '# déclaration de la mission 41\nkey: daedalforge/missions#41\nbranch: gh-41\n# la base suit la convention du dépôt\nbase: main\n',
  })

  const saved = await saveDeclaration(dir, { key: 'daedalforge/missions#41', branch: 'gh-41-v2', base: 'release/1' })
  assert.equal(saved.folder, 'GH-41')
  assert.equal(saved.branch, 'gh-41-v2')

  const text = await readFile(join(dir, 'GH-41', MISSION_FILE), 'utf8')
  assert.match(text, /# déclaration de la mission 41/)
  assert.match(text, /# la base suit la convention du dépôt/)
  assert.match(text, /branch: gh-41-v2/)
  assert.match(text, /base: release\/1/)

  const { index } = await loadBranches(dir)
  assert.deepEqual([...index.keys()], ['daedalforge/missions#41'])
})

test('saveDeclaration retire un champ vidé et suit la clé Jira', async (t) => {
  const dir = await fixtures(t, {})
  // Une URL aussi : le chemin par défaut du module en est une.
  const saved = await saveDeclaration(pathToFileURL(`${dir}/`), { key: 'SO-1184', branch: ' feat/so-1184 ', base: '' })
  assert.equal(saved.folder, 'SO-1184')
  assert.equal(saved.branch, 'feat/so-1184')
  assert.equal(saved.base, null)

  await saveDeclaration(dir, { key: 'SO-1184', branch: '' })
  const { index } = await loadBranches(dir)
  assert.deepEqual(index.get('SO-1184'), { folder: 'SO-1184', branch: null, base: null })
})

test('saveDeclaration refuse une déclaration invalide sans rien écrire', async (t) => {
  const dir = await fixtures(t, {})

  await assert.rejects(
    saveDeclaration(dir, {}),
    (error) => error.status === 400 && /key is missing/.test(error.message),
  )
  await assert.rejects(saveDeclaration(dir, { key: 'a#1', branch: 42 }), /branch must be a string/)
  await assert.rejects(saveDeclaration(dir, { key: 'a#1', base: ['main'] }), /base must be a string/)

  const { index, errors } = await loadBranches(dir)
  assert.equal(index.size, 0)
  assert.deepEqual(errors, [])
})

test('saveDeclaration refuse un dossier déjà pris par une autre clé', async (t) => {
  // Les clés `a#1` et `a-1` donnent le même dossier : la seconde écraserait la
  // première, donc elle est refusée.
  const dir = await fixtures(t, { 'a-1/mission.yml': 'key: a-1\nbranch: b\n' })

  await assert.rejects(saveDeclaration(dir, { key: 'a#1', branch: 'x' }), /a-1\/mission\.yml already declares "a-1"/)
  const { index } = await loadBranches(dir)
  assert.deepEqual(index.get('a-1'), { folder: 'a-1', branch: 'b', base: null })
})

test('saveDeclaration répare une déclaration au champ vide', async (t) => {
  const dir = await fixtures(t, {
    [`GH-42/${MISSION_FILE}`]: 'key: daedalforge/missions#42\nbranch: ""\nbase: ""\n',
  })

  const saved = await saveDeclaration(dir, { key: 'daedalforge/missions#42', branch: 'gh-42', base: 'main' })
  assert.equal(saved.folder, 'GH-42')

  const text = await readFile(join(dir, 'GH-42', MISSION_FILE), 'utf8')
  // Le style de citation du fichier existant peut rester ; la valeur, elle, est réparée.
  assert.equal(parse(text).branch, 'gh-42')
  assert.equal(parse(text).base, 'main')
  assert.doesNotMatch(text, /""/)

  const { index, errors } = await loadBranches(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual(index.get(saved.key), { folder: 'GH-42', branch: 'gh-42', base: 'main' })
})

test('saveDeclaration ne duplique pas une déclaration existante invalide', async (t) => {
  const dir = await fixtures(t, {
    [`GH-41/${MISSION_FILE}`]: 'key: daedalforge/missions#41\nnotes: à garder\n',
  })

  await assert.rejects(
    saveDeclaration(dir, { key: 'daedalforge/missions#41', branch: 'gh-41', base: 'main' }),
    /GH-41\/mission\.yml: unknown field\(s\): notes/,
  )
  assert.deepEqual(await readdir(dir), ['GH-41'])
})

test('saveDeclaration sérialise deux écritures concurrentes', async (t) => {
  const dir = await fixtures(t, {})

  // Les deux clés donnent le dossier `a-1` : une seule doit gagner.
  const results = await Promise.allSettled([
    saveDeclaration(dir, { key: 'a#1', branch: 'one', base: 'main' }),
    saveDeclaration(dir, { key: 'a-1', branch: 'two', base: 'main' }),
  ])

  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected'])
  assert.match(String(results.find((result) => result.status === 'rejected').reason), /already declares/)
  const { index, errors } = await loadBranches(dir)
  assert.deepEqual(errors, [])
  assert.deepEqual([...index.keys()].sort(), [results.find((result) => result.status === 'fulfilled').value.key])
})

test('saveDeclaration refuse un fichier de déclaration illisible', async (t) => {
  const dir = await fixtures(t, {})
  // `mission.yml` est un dossier : le fichier ne peut pas être lu.
  await mkdir(join(dir, 'a-1', MISSION_FILE), { recursive: true })

  await assert.rejects(
    saveDeclaration(dir, { key: 'a#1', branch: 'x', base: 'main' }),
    (error) => error.status === 400 && /a-1\/mission\.yml/.test(error.message),
  )
})

test('saveDeclaration dérive toujours le dossier de la clé', async (t) => {
  const dir = await fixtures(t, {})

  const saved = await saveDeclaration(dir, { key: '../../escape', branch: 'x', base: 'main' })
  assert.equal(saved.folder, 'escape')
  assert.deepEqual(await readdir(dir), ['escape'])
})
