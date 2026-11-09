import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updateMissionStatus } from '../lib/index.js'
import { normalizeStatus } from '../lib/missions.js'

const base = ['---', 'id: ABC-65', 'status: draft', 'priority: important', 'epic: ABC-64', '---', '', '# Titre', '', 'Corps.'].join('\n')

test('updateMissionStatus remplace la valeur existante', () => {
  const { content, changed } = updateMissionStatus(base, 'in_peer_review')
  assert.equal(changed, true)
  assert.match(content, /status: in_peer_review\npriority: important/)
  assert.match(content, /epic: ABC-64\n---\n\n# Titre\n\nCorps\.$/)
})

test('updateMissionStatus accepte les six états du parcours', () => {
  for (const status of ['active', 'in_review', 'in_peer_review', 'awaiting_validation', 'ready', 'draft']) {
    assert.match(updateMissionStatus(base, status).content, new RegExp(`status: ${status}\n`))
  }
})

test('updateMissionStatus ne touche à rien quand la valeur est déjà là', () => {
  const { content, changed } = updateMissionStatus(base, 'draft')
  assert.equal(changed, false)
  assert.equal(content, base)
})

test('updateMissionStatus refuse un état hors parcours', () => {
  assert.throws(() => updateMissionStatus(base, 'archive'), /statut inconnu/)
  assert.throws(() => updateMissionStatus(base, 'En attente de validation'), /statut inconnu/)
})

test('updateMissionStatus exige une ligne de statut', () => {
  const withoutStatus = ['---', 'id: ABC-65', 'priority: ', '---', '', 'Corps.'].join('\n')
  assert.throws(() => updateMissionStatus(withoutStatus, 'active'), /statut absent/)
})

test('updateMissionStatus exige un frontmatter fermé', () => {
  assert.throws(() => updateMissionStatus('# sans frontmatter', 'active'), /frontmatter absent/)
  assert.throws(() => updateMissionStatus(['---', 'status: draft', 'Corps.'].join('\n'), 'active'), /frontmatter non fermé/)
})

test('les états ajoutés se lisent et se normalisent comme les autres', () => {
  assert.equal(normalizeStatus('in_peer_review'), 'in_peer_review')
  assert.equal(normalizeStatus('In Peer Review'), 'in_peer_review')
  assert.equal(normalizeStatus(' Ready '), 'ready')
  assert.equal(normalizeStatus('in-peer-review'), 'in_peer_review')
  assert.equal(normalizeStatus('awaiting_validation'), 'awaiting_validation')
  assert.equal(normalizeStatus('Awaiting Validation'), 'awaiting_validation')
  assert.equal(normalizeStatus('awaiting-validation'), 'awaiting_validation')
})
