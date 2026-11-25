import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TOOL = fileURLToPath(new URL('../tools/field.mjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/projects-fields.yml', import.meta.url))

async function run(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [TOOL, ...args], { cwd: ROOT })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('field.mjs refuse un usage incomplet et explique la commande', async () => {
  const result = await run()
  assert.equal(result.code, 2)
  assert.match(result.stderr, /Usage : node tools\/field\.mjs/)
})

test('field.mjs nomme une clé et une valeur inconnues avant tout appel réseau', async () => {
  const unknownKey = await run('state', 'ZZZ-1', 'ready', '--projects', FIXTURE)
  assert.equal(unknownKey.code, 1)
  assert.match(unknownKey.stderr, /aucune board ne déclare ZZZ-1/)

  const unknownState = await run('state', 'CFG-1', 'shipped', '--projects', FIXTURE)
  assert.equal(unknownState.code, 1)
  assert.match(unknownState.stderr, /n'est pas un state du workspace/)

  const unknownPriority = await run('priority', 'CFG-1', 'blocker', '--projects', FIXTURE)
  assert.equal(unknownPriority.code, 1)
  assert.match(unknownPriority.stderr, /n'est pas un priority du workspace/)

  const wrongPoints = await run('points', 'CFG-1', '4', '--projects', FIXTURE)
  assert.equal(wrongPoints.code, 1)
  assert.match(wrongPoints.stderr, /n'est pas une taille de l'échelle/)
})

test('field.mjs refuse une board sans statut natif ni champ d’organisation', async () => {
  const state = await run('state', 'LAB-1', 'ready', '--projects', FIXTURE)
  assert.equal(state.code, 1)
  assert.match(state.stderr, /ne déclare pas de statuts natifs \(statuses\)/)

  const priority = await run('priority', 'LAB-1', 'high', '--projects', FIXTURE)
  assert.equal(priority.code, 1)
  assert.match(priority.stderr, /ne déclare pas fields\.priority/)
})

test('field.mjs affiche l’aide sans rien lire', async () => {
  const result = await run('--help')
  assert.equal(result.code, 0)
  assert.match(result.stdout, /blocked/)
})
