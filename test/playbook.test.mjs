import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PLAYBOOK_STEP_FILES, playbookFile } from '../lib/view.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHECKER = join(ROOT, 'tools', 'check-playbook.mjs')
const exec = promisify(execFile)

async function run(root) {
  try {
    const { stdout } = await exec(process.execPath, [CHECKER, '--root', root])
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'playbook-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(join(ROOT, 'playbook'), join(root, 'playbook'), { recursive: true })
  return root
}

test('le playbook du dépôt passe le contrôle', async () => {
  // Given
  const root = ROOT

  // When
  const result = await run(root)

  // Then
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^OK — /)
})

test('le contrat de lecture cite les pages de PLAYBOOK_STEP_FILES', async () => {
  // Given
  const source = await readFile(join(ROOT, 'playbook', 'README.md'), 'utf8')
  const contract = new Map()
  for (const line of source.split('\n')) {
    const match = /^\|\s*([^|`]+?)\s*\|\s*`(playbook\/[^`]+\.md)`\s*\|/.exec(line)
    if (match) {
      contract.set(match[1].trim(), match[2])
    }
  }

  // When
  const steps = [...contract.keys()].sort()

  // Then
  assert.deepEqual(steps, Object.keys(PLAYBOOK_STEP_FILES).sort())
  for (const [step, page] of Object.entries(PLAYBOOK_STEP_FILES)) {
    assert.equal(contract.get(step), playbookFile(step), step)
  }
})

test('une page indexée mais absente du disque échoue en la nommant', async (t) => {
  // Given
  const root = await fixture(t)
  await rm(join(root, 'playbook', 'revue.md'))

  // When
  const result = await run(root)

  // Then
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /playbook\/revue\.md/)
})

test('une page présente mais non indexée échoue en la nommant', async (t) => {
  // Given
  const root = await fixture(t)
  await cp(join(root, 'playbook', 'cadrage.md'), join(root, 'playbook', 'bonus.md'))

  // When
  const result = await run(root)

  // Then
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /playbook\/bonus\.md/)
  assert.match(result.stderr, /absente de l'index/)
})

test('une section manquante échoue en nommant la page et la section', async (t) => {
  // Given
  const root = await fixture(t)
  const path = join(root, 'playbook', 'execution.md')
  const source = await readFile(path, 'utf8')
  await writeFile(path, source.replace('## Pièges observés', '## Pièges constatés'))

  // When
  const result = await run(root)

  // Then
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /playbook\/execution\.md/)
  assert.match(result.stderr, /Pièges observés/)
})

test('une page qui ne nomme pas son document workflows/ échoue en la nommant', async (t) => {
  // Given
  const root = await fixture(t)
  const path = join(root, 'playbook', 'cadrage.md')
  const source = await readFile(path, 'utf8')
  await writeFile(path, source.split('workflows/cadrage.md').join('workflows/autre.md'))

  // When
  const result = await run(root)

  // Then
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /playbook\/cadrage\.md/)
  assert.match(result.stderr, /workflows\/cadrage\.md/)
})

test('un dépôt retiré de la fiche échoue en nommant la page et le dépôt', async (t) => {
  // Given
  const root = await fixture(t)
  const path = join(root, 'playbook', 'execution.md')
  const source = await readFile(path, 'utf8')
  const stripped = source
    .split('\n')
    .filter((line) => !line.startsWith('| `missions`'))
    .join('\n')
  await writeFile(path, stripped)

  // When
  const result = await run(root)

  // Then
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /playbook\/execution\.md/)
  assert.match(result.stderr, /missions/)
})

test('un interdit retiré de workspace.md échoue en le nommant', async (t) => {
  // Given
  const root = await fixture(t)
  const path = join(root, 'playbook', 'workspace.md')
  const source = await readFile(path, 'utf8')
  const stripped = source
    .split('\n')
    .filter((line) => !line.startsWith('13. '))
    .join('\n')
  await writeFile(path, stripped)

  // When
  const result = await run(root)

  // Then
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /playbook\/workspace\.md/)
  assert.match(result.stderr, /13 interdits/)
})
