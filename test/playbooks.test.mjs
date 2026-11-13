import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { checkPage } from '../lib/playbook-rules.js'
import {
  PLAYBOOK_PAGES,
  PlaybookError,
  listPlaybooks,
  readPlaybook,
  savePlaybook,
} from '../lib/playbooks.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHECKER = join(ROOT, 'tools', 'check-playbook.mjs')
const exec = promisify(execFile)

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'playbooks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(join(ROOT, 'playbook'), join(root, 'playbook'), { recursive: true })
  return { root, dir: join(root, 'playbook') }
}

async function pageText(dir, name) {
  return readFile(join(dir, name), 'utf8')
}

/** The bytes and the version of a file, to prove a refusal wrote nothing. */
async function fingerprint(dir, name) {
  const path = join(dir, name)
  return { source: await readFile(path, 'utf8'), mtimeMs: (await stat(path)).mtimeMs }
}

async function refusal(root, dir, name, transform) {
  const text = await pageText(dir, name)
  const changed = transform(text)
  const before = await fingerprint(dir, name)
  const expected = []
  checkPage(`playbook/${name}`, changed, expected)
  return { changed, before, expected }
}

test('la liste décrit les cinq pages dans l’ordre du parcours', async (t) => {
  // Given
  const { dir } = await fixture(t)

  // When
  const pages = await listPlaybooks(dir)

  // Then
  assert.deepEqual(pages.map((page) => page.page), ['cadrage', 'execution', 'revue', 'cloture', 'workspace'])
  assert.deepEqual(pages.map((page) => page.step), ['cadrage', 'exécution', 'revue', 'clôture', null])
  assert.deepEqual(pages.map((page) => page.file), [
    'playbook/cadrage.md',
    'playbook/execution.md',
    'playbook/revue.md',
    'playbook/cloture.md',
    'playbook/workspace.md',
  ])
  for (const page of pages) {
    assert.equal(page.exists, true)
    assert.equal('text' in page, false, `${page.page} ne porte pas son texte`)
    assert.match(page.title, /^[A-ZÀ-Ý]/)
    assert.ok(page.lines > 0)
  }
})

test('une page absente du disque garde sa place avec exists: false', async (t) => {
  // Given
  const { dir } = await fixture(t)
  await rm(join(dir, 'revue.md'))

  // When
  const pages = await listPlaybooks(dir)

  // Then
  const revue = pages.find((page) => page.page === 'revue')
  assert.equal(revue.exists, false)
  assert.equal(revue.title, null)
  assert.equal(revue.lines, 0)
})

test('la lecture rend le texte du fichier et sa version', async (t) => {
  // Given
  const { dir } = await fixture(t)
  const expected = await pageText(dir, 'execution.md')

  // When
  const page = await readPlaybook(dir, 'execution')

  // Then
  assert.equal(page.text, expected)
  assert.equal(page.file, 'playbook/execution.md')
  assert.equal(page.step, 'exécution')
  assert.match(page.title, /^Exécution/)
  assert.equal(page.mtimeMs, (await stat(join(dir, 'execution.md'))).mtimeMs)
})

test('une page inconnue, l’index et une traversée sont refusés en 400', async (t) => {
  // Given
  const { dir } = await fixture(t)

  // When / Then
  for (const page of ['inconnue', 'README', 'index', '../projects', '../../etc/passwd']) {
    await assert.rejects(readPlaybook(dir, page), (error) => {
      assert.ok(error instanceof PlaybookError)
      assert.equal(error.status, 400)
      assert.match(error.message, /unknown playbook page/)
      return true
    })
  }
})

test('une page absente du disque est refusée en 404', async (t) => {
  // Given
  const { dir } = await fixture(t)
  await rm(join(dir, 'cloture.md'))

  // When / Then
  await assert.rejects(readPlaybook(dir, 'cloture'), (error) => {
    assert.equal(error.status, 404)
    assert.match(error.message, /playbook\/cloture\.md/)
    return true
  })
})

test('une page valide est écrite puis relue avec sa nouvelle version', async (t) => {
  // Given
  const { dir } = await fixture(t)
  const page = await readPlaybook(dir, 'execution')
  const changed = `${page.text}\nUne ligne de plus.\n`

  // When
  const saved = await savePlaybook(dir, { page: 'execution', text: changed, mtimeMs: page.mtimeMs })

  // Then
  assert.equal(await pageText(dir, 'execution.md'), changed)
  assert.notEqual(saved.mtimeMs, page.mtimeMs)
  assert.equal(saved.mtimeMs, (await stat(join(dir, 'execution.md'))).mtimeMs)
  assert.equal('text' in saved, false)
  const reread = await readPlaybook(dir, 'execution')
  assert.equal(reread.text, changed)
  assert.equal(reread.mtimeMs, saved.mtimeMs)

  // And a second save of the same version passes: the response carried it.
  const savedAgain = await savePlaybook(dir, { page: 'execution', text: changed, mtimeMs: saved.mtimeMs })
  const after = await readPlaybook(dir, 'execution')
  assert.equal(savedAgain.mtimeMs, after.mtimeMs)
  assert.equal(after.text, changed)
})

const FAUTES = [
  {
    page: 'execution',
    name: 'execution.md',
    label: 'section manquante',
    transform: (text) => text.replace("## Pièges observés", '## Pièges'),
  },
  {
    page: 'execution',
    name: 'execution.md',
    label: 'plus de 200 lignes',
    transform: (text) => `${text}${'ligne ajoutée\n'.repeat(120)}`,
  },
  {
    page: 'execution',
    name: 'execution.md',
    label: 'mauvaise ligne Entrée → Sortie',
    transform: (text) => text.replace('Entrée : ready → Sortie : in-review', 'Entrée : done → Sortie : ready'),
  },
  {
    page: 'execution',
    name: 'execution.md',
    label: 'document de workflow absent',
    transform: (text) => text.replaceAll('workflows/execution.md', 'workflows/autre.md'),
  },
  {
    page: 'execution',
    name: 'execution.md',
    label: 'dépôt absent de la fiche',
    transform: (text) => text.replaceAll('`ticketing-service`', '`autre-service`'),
  },
  {
    page: 'workspace',
    name: 'workspace.md',
    label: 'interdits mal numérotés',
    transform: (text) => text.replace(/^13\. /m, '14. '),
  },
]

for (const faute of FAUTES) {
  test(`la sauvegarde refuse une page avec ${faute.label} et n’écrit rien`, async (t) => {
    // Given
    const { dir } = await fixture(t)
    const { changed, before, expected } = await refusal(null, dir, faute.name, faute.transform)
    assert.ok(expected.length > 0, 'la règle détecte la faute')

    // When
    await assert.rejects(
      savePlaybook(dir, { page: faute.page, text: changed, mtimeMs: before.mtimeMs }),
      (error) => {
        assert.ok(error instanceof PlaybookError)
        assert.equal(error.status, 400)
        assert.match(error.message, /page invalid/)
        assert.deepEqual(error.errors, expected)
        return true
      },
    )

    // Then
    assert.deepEqual(await fingerprint(dir, faute.name), before)
  })
}

test('l’hôte refuse exactement ce que le CLI refuse sur la même page', async (t) => {
  // Given
  const { root, dir } = await fixture(t)
  const text = await pageText(dir, 'execution.md')
  const changed = text.replace('Entrée : ready → Sortie : in-review', 'Entrée : ready → Sortie : done')
  await writeFile(join(dir, 'execution.md'), changed)
  const page = await readPlaybook(dir, 'execution')
  const expected = []
  checkPage('playbook/execution.md', changed, expected)

  // When
  const cli = await exec(process.execPath, [CHECKER, '--root', root]).catch((error) => error)

  // Then
  assert.notEqual(cli.code, 0)
  const printed = String(cli.stderr).trim().split('\n').map((line) => line.replace(/^✖ /, ''))
  assert.deepEqual(printed, expected)
  await assert.rejects(
    savePlaybook(dir, { page: 'execution', text: changed, mtimeMs: page.mtimeMs }),
    (error) => {
      assert.deepEqual(error.errors, expected)
      return true
    },
  )
})

test('une version périmée répond 409 sans écrire', async (t) => {
  // Given
  const { dir } = await fixture(t)
  const page = await readPlaybook(dir, 'revue')
  const before = await fingerprint(dir, 'revue.md')

  // When
  await assert.rejects(
    savePlaybook(dir, { page: 'revue', text: `${page.text}\nAutre version.\n`, mtimeMs: page.mtimeMs - 1000 }),
    (error) => {
      assert.ok(error instanceof PlaybookError)
      assert.equal(error.status, 409)
      return true
    },
  )

  // Then
  assert.deepEqual(await fingerprint(dir, 'revue.md'), before)
})

test('un page hors liste ou un corps incomplet est refusé en 400', async (t) => {
  // Given
  const { dir } = await fixture(t)
  const page = await readPlaybook(dir, 'cadrage')

  // When / Then
  for (const body of [
    { page: '../../etc/passwd', text: 'x', mtimeMs: page.mtimeMs },
    { page: 'README', text: 'x', mtimeMs: page.mtimeMs },
    { page: 'cadrage', text: 42, mtimeMs: page.mtimeMs },
    { page: 'cadrage', text: page.text },
  ]) {
    await assert.rejects(savePlaybook(dir, body), (error) => {
      assert.ok(error instanceof PlaybookError)
      assert.equal(error.status, 400)
      return true
    })
  }
})

test('une page supprimée n’est jamais recréée par une sauvegarde', async (t) => {
  // Given
  const { dir } = await fixture(t)
  const before = await readPlaybook(dir, 'cadrage')
  await rm(join(dir, 'cadrage.md'))

  // When
  await assert.rejects(savePlaybook(dir, { page: 'cadrage', text: before.text, mtimeMs: before.mtimeMs }), (error) => {
    assert.equal(error.status, 404)
    return true
  })

  // Then
  await assert.rejects(stat(join(dir, 'cadrage.md')), { code: 'ENOENT' })
})

test('un dossier en lecture seule échoue sans laisser de .tmp ni d’autre page', async (t) => {
  // Given
  const { dir } = await fixture(t)
  const page = await readPlaybook(dir, 'workspace')
  const before = await fingerprint(dir, 'workspace.md')
  await chmod(dir, 0o555)

  try {
    // When
    await assert.rejects(
      savePlaybook(dir, { page: 'workspace', text: `${page.text}\nRefus du disque.\n`, mtimeMs: page.mtimeMs }),
      (error) => {
        assert.equal(error.code, 'EACCES')
        return true
      },
    )

    // Then
    assert.deepEqual(await fingerprint(dir, 'workspace.md'), before)
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [])
  } finally {
    await chmod(dir, 0o755)
  }
})

test('le périmètre est la constante dérivée du contrat des pages', async () => {
  // Given
  const expected = ['cadrage', 'execution', 'revue', 'cloture', 'workspace']

  // When
  const pages = PLAYBOOK_PAGES.map((entry) => entry.page)

  // Then
  assert.deepEqual(pages, expected)
})
