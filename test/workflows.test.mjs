import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML, { parse } from 'yaml'

import { loadProjects } from '../lib/projects.js'
import {
  WORKFLOWS,
  fileModel,
  loadWorkflows,
  readHeadings,
  readWorkflow,
  saveWorkflow,
  validateModel,
} from '../lib/workflows.js'

/**
 * Le modèle d'une étape, contre son document et le vocabulaire du workspace.
 *
 * Un modèle cite les titres du document : c'est la seule chose qui empêche les
 * deux de diverger en silence. Tout ce qui ne peut pas être vérifié ici est une
 * erreur — une clé inconnue, un état inventé, un geste que personne n'atteint.
 */
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MODELS = join(ROOT, 'workflows', 'model')
const { canonical } = await loadProjects(join(ROOT, 'missions', 'projects.yml'))
const STATES = canonical.states

const HEADINGS = [
  { level: 1, text: 'Cadrage' },
  { level: 2, text: "Ce qu'on fait" },
  { level: 2, text: 'Sur le tracker' },
]

/** Un modèle minimal et valide, que chaque test casse d'une seule façon. */
function modele(over = {}) {
  return {
    workflow: 'cadrage',
    title: 'Cadrage',
    document: 'workflows/cadrage.md',
    entry: 'to-refine',
    exit: ['ready'],
    nodes: [
      { id: 'lire', label: 'Lire le ticket', section: "Ce qu'on fait", writer: 'session' },
    ],
    edges: [
      { from: 'to-refine', to: 'lire' },
      { from: 'lire', to: 'ready' },
    ],
    ...over,
  }
}

function valide(doc, over = {}) {
  return validateModel(doc, { headings: HEADINGS, states: STATES, workflow: 'cadrage', ...over })
}

function codes(result) {
  return result.errors.map((error) => error.code)
}

test('les quatre modèles du dépôt sont valides et concordent avec leurs documents', async () => {
  const { workflows } = await loadWorkflows(MODELS, { states: STATES })

  assert.equal(workflows.length, 4)
  assert.deepEqual(workflows.map((entry) => entry.workflow), WORKFLOWS)
  for (const entry of workflows) {
    assert.deepEqual(entry.errors, [], `${entry.workflow} : ${JSON.stringify(entry.errors)}`)
    assert.deepEqual(entry.orphanSections, [])
    assert.ok(entry.nodes.length >= 10, `${entry.workflow} porte ses gestes`)
    assert.ok(entry.edges.length >= entry.nodes.length, `${entry.workflow} porte ses arcs`)
    // Chaque geste vient d'un titre du document : c'est la concordance.
    for (const node of entry.nodes) {
      assert.ok(entry.headings.includes(node.section), `${entry.workflow}/${node.id} cite « ${node.section} »`)
    }
  }
})

test('la clôture laisse le merge au demandeur, jamais à la session', async () => {
  const { workflows } = await loadWorkflows(MODELS, { states: STATES })
  const cloture = workflows.find((entry) => entry.workflow === 'cloture')
  assert.ok(cloture, 'le modèle de clôture est chargé')

  const merger = cloture.nodes.find((node) => node.id === 'merger')
  assert.ok(merger, 'le geste de merge existe')
  assert.equal(merger.writer, 'demandeur', 'le merge est le geste du demandeur')

  // Aucun geste de merge, même futur, ne peut revenir à la session.
  for (const node of cloture.nodes) {
    if (/merge/i.test(`${node.id} ${node.label}`)) {
      assert.equal(node.writer, 'demandeur', `${node.id} ne peut pas être écrit par la session`)
    }
  }

  assert.equal(cloture.nodes.find((node) => node.id === 'fermer-ticket')?.writer, 'demandeur')
  assert.equal(cloture.nodes.find((node) => node.id === 'supprimer-branche')?.writer, 'demandeur')
  assert.equal(cloture.nodes.find((node) => node.id === 'constater')?.writer, 'session')
})

test('un titre du document sans geste est une section orpheline, pas une erreur', () => {
  const result = valide(modele())

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.orphanSections, ['Sur le tracker'])
})

test('une section absente du document est refusée', () => {
  const doc = modele()
  doc.nodes[0].section = 'Ce qu’on ne fait pas'
  const result = valide(doc)

  assert.deepEqual(codes(result), ['section-absente'])
  assert.equal(result.errors[0].field, 'nodes[0].section')
})

test('un état inventé, en entrée comme en sortie, est refusé', () => {
  const entree = valide(modele({ entry: 'refined' }))
  assert.ok(codes(entree).includes('etat-inconnu'))

  const sortie = valide(modele({ exit: ['shipped'] }))
  assert.ok(codes(sortie).includes('etat-inconnu'))
})

test('une clé inconnue est refusée, à la racine comme dans un geste', () => {
  const racine = valide(modele({ steps: [] }))
  assert.deepEqual(codes(racine), ['cle-inconnue'])
  assert.equal(racine.errors[0].field, 'steps')

  const doc = modele()
  doc.nodes[0].owner = 'moi'
  const geste = valide(doc)
  assert.deepEqual(codes(geste), ['cle-inconnue'])
  assert.equal(geste.errors[0].field, 'nodes[0].owner')
})

test('un id double, ou le nom d’un état, est refusé', () => {
  const doc = modele()
  doc.nodes.push({ ...doc.nodes[0] })
  assert.ok(codes(valide(doc)).includes('id-double'))

  const conflit = modele()
  conflit.nodes[0].id = 'ready'
  assert.ok(codes(valide(conflit)).includes('id-conflictuel'))
})

test('un écrivain inconnu est refusé', () => {
  const doc = modele()
  doc.nodes[0].writer = 'robot'
  const result = valide(doc)

  assert.deepEqual(codes(result), ['ecrivain-inconnu'])
  assert.equal(result.errors[0].field, 'nodes[0].writer')
})

test('un arc orphelin, une boucle et un double arc sont refusés', () => {
  const orphelin = valide(modele({ edges: [{ from: 'to-refine', to: 'lire' }, { from: 'lire', to: 'shipped' }] }))
  assert.ok(codes(orphelin).includes('arc-orphelin'))

  const boucle = valide(modele({ edges: [{ from: 'lire', to: 'lire' }] }))
  assert.ok(codes(boucle).includes('arc-boucle'))

  const double = valide(modele({
    edges: [
      { from: 'to-refine', to: 'lire' },
      { from: 'to-refine', to: 'lire' },
      { from: 'lire', to: 'ready' },
    ],
  }))
  assert.ok(codes(double).includes('arc-double'))
})

test('un geste injoignable et une sortie injoignable sont refusés', () => {
  const doc = modele()
  doc.nodes.push({ id: 'oublie', label: 'Geste oublié', section: "Ce qu'on fait", writer: 'session' })
  const result = valide(doc)
  assert.ok(codes(result).includes('geste-injoignable'))

  const sansSortie = valide(modele({ edges: [{ from: 'to-refine', to: 'lire' }] }))
  assert.ok(codes(sansSortie).includes('sortie-injoignable'))
})

test('saveWorkflow écrit un YAML relisible et n’écrit rien quand le modèle est invalide', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-save-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })
  await writeFile(join(dir, 'workflows', 'cadrage.md'), '# Cadrage\n\n## Ce qu\'on fait\n', 'utf8')

  const saved = await saveWorkflow(join(dir, 'workflows', 'model'), 'cadrage', modele(), { states: STATES })
  assert.deepEqual(saved.errors, [])
  const file = join(dir, 'workflows', 'model', 'cadrage.yml')
  const written = await readFile(file, 'utf8')

  assert.deepEqual(parse(written), {
    workflow: 'cadrage',
    title: 'Cadrage',
    document: 'workflows/cadrage.md',
    entry: 'to-refine',
    exit: ['ready'],
    nodes: [{ id: 'lire', label: 'Lire le ticket', section: "Ce qu'on fait", writer: 'session' }],
    edges: [{ from: 'to-refine', to: 'lire' }, { from: 'lire', to: 'ready' }],
  })

  const refused = await saveWorkflow(join(dir, 'workflows', 'model'), 'cadrage', modele({ exit: ['shipped'] }), { states: STATES })
  assert.ok(codes(refused).includes('etat-inconnu'))
  assert.equal(await readFile(file, 'utf8'), written, 'le fichier refusé reste intact')
})

test('un fichier absent et un document absent sont signalés, sans lever', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const entry = await readWorkflow(join(dir, 'workflows', 'model'), 'cadrage', { states: STATES })
  assert.equal(entry.text, null)
  assert.deepEqual(codes(entry), ['document-absent', 'fichier-absent'])
})

test('un YAML cassé est un défaut du fichier, pas du panneau', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-broken-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })
  await writeFile(join(dir, 'workflows', 'cadrage.md'), '# Cadrage\n', 'utf8')
  await writeFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'nodes: [\n', 'utf8')

  const entry = await readWorkflow(join(dir, 'workflows', 'model'), 'cadrage', { states: STATES })
  assert.ok(codes(entry).includes('yaml-invalide'), JSON.stringify(entry.errors))
  assert.equal(entry.nodes.length, 0)
})

test('les titres d’un bloc de code ne sont pas des titres', () => {
  const headings = readHeadings('# Étude\n\n```sh\n# pas un titre\n```\n\n## Vraie section\n')
  assert.deepEqual(headings.map((heading) => heading.text), ['Étude', 'Vraie section'])
  assert.equal(headings[1].path, 'Étude › Vraie section')
})

test('fileModel ordonne les clés et retire les champs vides', () => {
  const doc = modele()
  doc.nodes[0].gate = ''
  const model = fileModel(doc)
  assert.deepEqual(Object.keys(model), ['workflow', 'title', 'document', 'entry', 'exit', 'nodes', 'edges'])
  assert.deepEqual(Object.keys(model.edges[0]), ['from', 'to'], 'un arc sans condition ne porte pas `when`')
  const ordered = YAML.stringify(model, { lineWidth: 0 })
  const positions = ['workflow:', 'title:', 'document:', 'entry:', 'exit:', 'nodes:', 'edges:'].map((key) => ordered.indexOf(key))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'les clés sortent dans l’ordre du schéma')
  assert.ok(!ordered.includes('gate:'), 'un champ vide ne s’écrit pas')
})
