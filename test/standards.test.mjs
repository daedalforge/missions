import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { STANDARDS_DIR, STANDARDS_STEP_FILES, standardsFiles } from '../lib/view.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHECKER = join(ROOT, 'tools', 'check-standards.mjs')
const STEPS = Object.keys(STANDARDS_STEP_FILES)
const PROJECTS = ['missions', 'manager', 'connect']

function runChecker(root) {
  return new Promise((done) => {
    execFile(process.execPath, [CHECKER, '--root', root], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      done({ code, stdout, stderr })
    })
  })
}

/** A copy of the standards and the project declarations, in a temporary root. */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'standards-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(join(ROOT, STANDARDS_DIR), join(dir, STANDARDS_DIR), { recursive: true })
  await mkdir(join(dir, 'missions'), { recursive: true })
  await cp(join(ROOT, 'missions', 'projects.yml'), join(dir, 'missions', 'projects.yml'))
  return dir
}

/** The reading contract of the README, step by step. */
function contractRows(readme) {
  const rows = new Map()
  for (const line of readme.split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|(.*)\|\s*$/.exec(line)
    if (!match) {
      continue
    }
    const step = match[1].trim()
    if (!STEPS.includes(step)) {
      continue
    }
    rows.set(step, [...match[2].matchAll(/`([^`]+)`/g)].map((cell) => cell[1]))
  }
  return rows
}

test('le dépôt laisse le contrôle des standards au vert', async () => {
  const result = await runChecker(ROOT)

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^OK — /)
})

test('l’index et le prompt de chaque étape nomment les mêmes fichiers', async () => {
  const readme = await readFile(join(ROOT, STANDARDS_DIR, 'README.md'), 'utf8')
  const indexed = new Set(
    [...readme.matchAll(/^\|\s*`(standards\/[^`]+\.md)`\s*\|/gm)].map((match) => match[1]),
  )
  const rows = contractRows(readme)

  for (const step of STEPS) {
    const row = rows.get(step)
    assert.ok(row, `l'index porte la ligne de l'étape ${step}`)
    for (const project of PROJECTS) {
      const declared = row.map((file) => file.replace('<projet>', project))
      assert.deepEqual(declared, standardsFiles(step, project), `${step} / ${project}`)
      for (const file of declared) {
        assert.ok(indexed.has(file), `${file} figure dans l'index`)
      }
    }
  }
})

test('les 13 interdits ont chacun une décision écrite dans la reprise', async () => {
  const readme = await readFile(join(ROOT, STANDARDS_DIR, 'README.md'), 'utf8')
  const rows = readme
    .split('\n')
    .filter((line) => /^\|\s*(?:[1-9]|1[0-3])\s*\|/.test(line))

  assert.equal(rows.length, 13)
  for (const row of rows) {
    assert.match(row, /\|\s*(?:conservé|adapté|retiré)\s*\|/, row)
  }
})

test('aucun fichier de règle ne renvoie à l’ancien système', async () => {
  const repoSheets = (await readdir(join(ROOT, STANDARDS_DIR, 'repos')))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(ROOT, STANDARDS_DIR, 'repos', name))
  const files = [
    join(ROOT, STANDARDS_DIR, 'code.md'),
    join(ROOT, STANDARDS_DIR, 'revue.md'),
    join(ROOT, STANDARDS_DIR, 'interdits.md'),
    ...repoSheets,
  ]
  const forbidden = /~\/projects\/konoha|orchestrator|branch_name/

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    assert.doesNotMatch(text, forbidden, file)
  }
})

test('un fichier indexé absent fait échouer le contrôle en le nommant', async (t) => {
  const root = await fixture(t)
  await rm(join(root, STANDARDS_DIR, 'code.md'))

  const result = await runChecker(root)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /standards\/code\.md/)
})

test('un fichier du dossier absent de l’index fait échouer le contrôle en le nommant', async (t) => {
  const root = await fixture(t)
  await writeFile(
    join(root, STANDARDS_DIR, 'repos', 'sans-projet.md'),
    '# sans-projet\n',
    'utf8',
  )

  const result = await runChecker(root)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /standards\/repos\/sans-projet\.md/)
})

test('un projet déclaré sans fiche fait échouer le contrôle en la nommant', async (t) => {
  const root = await fixture(t)
  await rm(join(root, STANDARDS_DIR, 'repos', 'manager.md'))

  const result = await runChecker(root)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /standards\/repos\/manager\.md/)
})

test('un contrat de lecture divergent fait échouer le contrôle', async (t) => {
  const root = await fixture(t)
  const path = join(root, STANDARDS_DIR, 'README.md')
  const readme = await readFile(path, 'utf8')
  const modifie = readme.replace(
    /^\| revue \|.*$/m,
    '| revue | `standards/revue.md`, `standards/interdits.md`, `standards/repos/<projet>.md` |',
  )
  assert.notEqual(modifie, readme)
  await writeFile(path, modifie, 'utf8')

  const result = await runChecker(root)

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /étape revue/)
})

test('sans projet, le prompt efface la fiche du dépôt et nomme le reste', async () => {
  const readme = await readFile(join(ROOT, STANDARDS_DIR, 'README.md'), 'utf8')
  const rows = contractRows(readme)

  for (const step of STEPS) {
    const expected = standardsFiles(step, null)
    const declared = rows.get(step).filter((file) => !file.includes('<projet>'))
    assert.deepEqual(declared, expected, step)
  }
})
