import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updateMissionPriority } from '../lib/index.js'
import { normalizePriority } from '../lib/missions.js'

const base = ['---', 'id: ABC-50', 'status: active', 'epic: XYZ-1309', 'repo: konoha', '---', '', '# Titre', '', 'Corps.'].join('\n')

test('updateMissionPriority insère après status quand absente', () => {
  const { content, changed } = updateMissionPriority(base, 'urgent')
  assert.equal(changed, true)
  assert.match(content, /status: active\npriority: urgent\nepic: XYZ-1309/)
  assert.match(content, /\n# Titre\n\nCorps\.$/)
})

test('updateMissionPriority remplace la valeur existante', () => {
  const withPriority = base.replace('status: active', 'status: active\npriority: un_jour')
  const { content } = updateMissionPriority(withPriority, 'important')
  assert.match(content, /priority: important/)
  assert.doesNotMatch(content, /un_jour/)
})

test('updateMissionPriority retire la ligne quand la valeur est vide', () => {
  const withPriority = base.replace('status: active', 'status: active\npriority: urgent')
  const { content } = updateMissionPriority(withPriority, '')
  assert.doesNotMatch(content, /priority:/)
  assert.match(content, /status: active\nepic: XYZ-1309/)
})

test('updateMissionPriority refuse une valeur inconnue', () => {
  assert.throws(() => updateMissionPriority(base, 'p0'), /priorité inconnue/)
})

test('updateMissionPriority exige un frontmatter', () => {
  assert.throws(() => updateMissionPriority('# sans frontmatter', 'urgent'), /frontmatter absent/)
})

test('normal et none comptent comme sans priorité', () => {
  assert.equal(normalizePriority('normal'), '')
  assert.equal(normalizePriority('none'), '')
  assert.equal(normalizePriority('Urgent'), 'urgent')
  assert.equal(normalizePriority('à faire un jour'), 'un_jour')
})
