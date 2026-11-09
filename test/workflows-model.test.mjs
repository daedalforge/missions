import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkModel, checkWorkspace, parseTransitions } from '../lib/workflows/check.js'
import { formatModel, readHeadings, validateModel } from '../lib/workflows/model.js'

const root = process.env.DSH_WORKSPACE ?? join(homedir(), 'konoha')

const base = () => ({
  workflow: 'cadrage',
  title: 'Cadrage',
  document: 'workflows/cadrage.md',
  nodes: [
    { id: 'entree', section: 'Séquence', writer: 'principal', condition: 'une phrase', artifact: 'l\'intention' },
    { id: 'validation', section: 'Validation', writer: 'principal' },
  ],
  edges: [{ from: 'entree', to: 'validation' }],
})

test('un modèle complet ne produit aucun écart', () => {
  assert.deepEqual(validateModel(base()).errors, [])
})

test('un champ inconnu est refusé à tous les niveaux', () => {
  const doc = base()
  doc.extra = true
  doc.nodes[0].priority = 'urgent'
  doc.edges[0].label = 'x'
  const { errors } = validateModel(doc)
  assert.equal(errors.length, 3)
  assert.match(errors.join('\n'), /champ inconnu « extra »/)
  assert.match(errors.join('\n'), /champ inconnu « priority »/)
  assert.match(errors.join('\n'), /champ inconnu « label »/)
})

test('un id hors slug, une section en double ou un arc orphelin sont refusés', () => {
  const doc = base()
  doc.nodes[1].id = 'Validation'
  doc.nodes[1].section = 'Séquence'
  doc.edges[0].to = 'inconnu'
  const errors = validateModel(doc).errors.join('\n')
  assert.match(errors, /minuscules, chiffres et tirets/)
  assert.match(errors, /section « Séquence » déjà portée/)
  assert.match(errors, /ne nomme aucun geste/)
})

test('un statut hors standard est refusé', () => {
  const doc = base()
  doc.nodes[0].status = 'en_cours'
  assert.match(validateModel(doc).errors.join('\n'), /status « en_cours » inconnu/)
})

test('une section absente du document est nommée', () => {
  const headings = readHeadings('# T\n\n## Séquence\n\n### Entrée\n')
  assert.deepEqual(headings.map((heading) => heading.path), ['Séquence', 'Séquence › Entrée'])
  const doc = base()
  const { errors } = validateModel(doc, { headings })
  assert.match(errors.join('\n'), /section « Validation » absente du document/)
})

test('formatModel ordonne les clés et pose une fin de ligne', () => {
  const text = formatModel(base())
  assert.ok(text.endsWith('}\n'))
  assert.deepEqual(Object.keys(JSON.parse(text)), ['workflow', 'title', 'document', 'nodes', 'edges'])
  assert.deepEqual(Object.keys(JSON.parse(text).nodes[0]), ['id', 'section', 'writer', 'condition', 'artifact'])
  assert.equal(formatModel(JSON.parse(text)), text)
})

test('les transitions du standard se lisent par chaîne', () => {
  const markdown = '| conteneur, poc | `draft → ready → active` ; `active` ou `ready` → `abandoned` |\n'
  const transitions = parseTransitions(markdown)
  assert.deepEqual([...transitions.get('draft→ready')], ['conteneur', 'poc'])
  assert.deepEqual([...transitions.get('active→abandoned')], ['conteneur', 'poc'])
  assert.ok(transitions.has('ready→abandoned'))
})

test('le check d\'un modèle ne signale que des sections absentes avant réduction', () => {
  const entry = checkModel(root, 'cadrage')
  assert.ok(entry.errors.every((error) => /section .* absente du document/.test(error)))
  assert.ok(entry.orphanSections.includes('Exemple'))
})

test('le check de l\'atelier nomme les statuts hors standard', () => {
  const report = checkWorkspace(root)
  assert.equal(report.models.length, 7)
  assert.deepEqual(report.statuses.unknown, [])
})

test('le schéma JSON et le validateur portent les mêmes énumérations', () => {
  const schema = JSON.parse(readFileSync(join(root, 'workflows', 'model', 'schema.json'), 'utf8'))
  const nodes = schema.properties.nodes.items.properties
  assert.deepEqual(nodes.writer.enum, ['principal', 'orchestrateur', 'implementer', 'reviewer', 'outil'])
  assert.deepEqual(schema.properties.workflow.enum, ['cadrage', 'cloture', 'enchainement', 'execution', 'missions', 'queue', 'review'])
  assert.equal(nodes.status.enum.length, 8)
})
