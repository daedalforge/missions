import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML, { parse } from 'yaml'

import { loadProjects } from '../lib/projects.js'
import {
  STATUS_STATES,
  WORKFLOWS,
  createWorkflow,
  fileModel,
  isWorkflowKey,
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

test('les cinq modèles du dépôt sont valides et concordent avec leurs documents', async () => {
  const { workflows } = await loadWorkflows(MODELS, { states: STATES })

  assert.equal(workflows.length, 5)
  assert.deepEqual(workflows.map((entry) => entry.workflow), [...WORKFLOWS, 'statuts'])
  for (const entry of workflows) {
    assert.deepEqual(entry.errors, [], `${entry.workflow} : ${JSON.stringify(entry.errors)}`)
    assert.deepEqual(entry.orphanSections, [])
    assert.ok(entry.kind === 'statuts' || entry.kind === 'etape')
    if (entry.kind === 'statuts') {
      // Le workflow des statuts est le vocabulaire lui-même, dans son ordre.
      assert.deepEqual(entry.nodes.map((node) => node.id), STATES)
      assert.ok(entry.nodes.every((node) => node.label && node.description && node.tracker))
      continue
    }
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

/** Le workflow des statuts : six états canoniques, une chaîne d'événements. */
function statuts(over = {}) {
  return {
    workflow: 'statuts',
    kind: 'statuts',
    title: 'Statuts des missions',
    document: 'workflows/statuts.md',
    entry: 'to-refine',
    exit: ['done'],
    nodes: STATES.map((id) => ({ id, label: id, description: `L'état ${id}.`, tracker: `label ${id}` })),
    edges: [
      { from: 'to-refine', to: 'ready' },
      { from: 'ready', to: 'in-progress' },
      { from: 'in-progress', to: 'in-review' },
      { from: 'in-review', to: 'ready-for-prod' },
      { from: 'ready-for-prod', to: 'done' },
    ],
    ...over,
  }
}

function valideStatuts(doc) {
  return validateModel(doc, { headings: [], states: STATES, workflow: 'statuts' })
}

test('un workflow de statuts valide suit le vocabulaire et son ordre', () => {
  const result = valideStatuts(statuts())

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.orphanSections, [])
})

test('un état inconnu, un doublon ou un ordre faux sont refusés dans les statuts', () => {
  const inconnu = statuts()
  inconnu.nodes[0] = { ...inconnu.nodes[0], id: 'refined' }
  assert.ok(codes(valideStatuts(inconnu)).includes('etat-inconnu'))

  const double = statuts()
  double.nodes[1] = { ...double.nodes[1], id: 'to-refine' }
  assert.ok(codes(valideStatuts(double)).includes('id-double'))

  const desordre = statuts()
  desordre.nodes = [desordre.nodes[1], desordre.nodes[0], ...desordre.nodes.slice(2)]
  assert.ok(codes(valideStatuts(desordre)).includes('etats-desordonnes'))
})

test('un arc de statuts inconnu, une boucle ou un double arc sont refusés', () => {
  const orphelin = statuts({ edges: [...statuts().edges, { from: 'done', to: 'shipped' }] })
  assert.ok(codes(valideStatuts(orphelin)).includes('arc-orphelin'))

  const boucle = statuts({ edges: [...statuts().edges, { from: 'ready', to: 'ready' }] })
  assert.ok(codes(valideStatuts(boucle)).includes('arc-boucle'))

  const double = statuts({ edges: [...statuts().edges, { from: 'to-refine', to: 'ready' }] })
  assert.ok(codes(valideStatuts(double)).includes('arc-double'))
})

test('un genre inconnu ou une clé de geste dans les statuts sont refusés', () => {
  const genre = statuts({ kind: 'autre' })
  assert.ok(codes(valideStatuts(genre)).includes('genre-inconnu'))

  const doc = statuts()
  doc.nodes[0] = { ...doc.nodes[0], section: "Ce qu'on fait" }
  const cle = valideStatuts(doc)
  assert.ok(codes(cle).includes('cle-inconnue'))
  assert.equal(cle.errors[0].field, 'nodes[0].section')
})

test('un arc de statuts porte condition, écrivain, artefact et porte', () => {
  const doc = statuts()
  doc.edges[0] = { ...doc.edges[0], when: 'cadrage validé', writer: 'session', artifact: 'label ready', gate: 'accord du demandeur' }
  assert.deepEqual(valideStatuts(doc).errors, [])

  const boucle = statuts()
  boucle.edges[0] = { ...boucle.edges[0], writer: 'robot' }
  assert.ok(codes(valideStatuts(boucle)).includes('ecrivain-inconnu'))
})

test('les six états du modèle de statuts viennent du vocabulaire du workspace', () => {
  assert.deepEqual(STATUS_STATES.map((state) => state.id), STATES)
  for (const state of STATUS_STATES) {
    assert.ok(state.label && state.description && state.tracker, state.id)
  }
})

test('isWorkflowKey accepte les clés du dossier et refuse le reste', () => {
  assert.ok(isWorkflowKey('statuts'))
  assert.ok(isWorkflowKey('mon-workflow'))
  assert.ok(!isWorkflowKey('../main'))
  assert.ok(!isWorkflowKey('Mon-Workflow'))
  assert.ok(!isWorkflowKey('workflows/statuts'))
})

test('createWorkflow écrit le modèle et le document, jamais par-dessus l’existant', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-create-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const created = await createWorkflow(models, {
    workflow: 'incidents',
    title: 'Incidents',
    kind: 'etape',
    document: 'workflows/incidents.md',
    entry: 'to-refine',
    exit: ['ready'],
  }, { states: STATES })

  assert.deepEqual(created.errors, [])
  assert.equal(created.entry.workflow, 'incidents')
  assert.equal(created.entry.kind, 'etape')
  assert.deepEqual(created.entry.nodes, [])
  const written = parse(await readFile(join(models, 'incidents.yml'), 'utf8'))
  assert.equal(written.document, 'workflows/incidents.md')
  assert.deepEqual(written.nodes, [])
  assert.deepEqual(written.edges, [])
  assert.equal(await readFile(join(dir, 'workflows', 'incidents.md'), 'utf8'), '# Incidents\n')

  const again = await createWorkflow(models, {
    workflow: 'incidents',
    title: 'Autre titre',
    kind: 'etape',
    document: 'workflows/incidents.md',
    entry: 'to-refine',
    exit: ['ready'],
  }, { states: STATES })
  assert.deepEqual(codes(again), ['cle-double'])
  assert.equal(parse(await readFile(join(models, 'incidents.yml'), 'utf8')).title, 'Incidents')
})

test('createWorkflow refuse une clé invalide et un document hors de workflows/', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-create-refus-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const cle = await createWorkflow(models, {
    workflow: '../main', title: 'Fuite', kind: 'etape', document: 'workflows/main.md', entry: 'to-refine', exit: ['ready'],
  }, { states: STATES })
  assert.deepEqual(codes(cle), ['cle-invalide'])

  const document = await createWorkflow(models, {
    workflow: 'incidents', title: 'Incidents', kind: 'etape', document: '../incidents.md', entry: 'to-refine', exit: ['ready'],
  }, { states: STATES })
  assert.deepEqual(codes(document), ['document-invalide'])

  const sortie = await createWorkflow(models, {
    workflow: 'incidents', title: 'Incidents', kind: 'etape', document: 'workflows/incidents.md', entry: 'to-refine', exit: ['shipped'],
  }, { states: STATES })
  assert.deepEqual(codes(sortie), ['etat-inconnu'])
})

test('createWorkflow pré-remplit les six états d’un workflow de statuts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-create-statuts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const created = await createWorkflow(models, {
    workflow: 'statuts-bis',
    title: 'Statuts bis',
    kind: 'statuts',
    document: 'workflows/statuts-bis.md',
    entry: 'to-refine',
    exit: ['done'],
  }, { states: STATES })

  assert.deepEqual(created.errors, [])
  assert.deepEqual(created.entry.nodes.map((node) => node.id), STATES)
  assert.deepEqual(created.entry.edges, [])
  assert.ok(created.entry.nodes.every((node) => node.label && node.tracker))
})

test('un fichier ajouté au dossier apparaît dans la liste, même cassé', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-list-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })
  const created = await createWorkflow(join(dir, 'workflows', 'model'), {
    workflow: 'statuts', title: 'Statuts', kind: 'statuts', document: 'workflows/statuts.md', entry: 'to-refine', exit: ['done'],
  }, { states: STATES })
  assert.deepEqual(created.errors, [])
  await writeFile(join(dir, 'workflows', 'model', 'essai.yml'), 'nodes: [\n', 'utf8')

  const { workflows } = await loadWorkflows(join(dir, 'workflows', 'model'), { states: STATES })
  assert.deepEqual(workflows.map((entry) => entry.workflow), ['essai', 'statuts'])
  assert.ok(codes(workflows[0]).includes('yaml-invalide'))
  assert.equal(workflows[0].kind, 'etape')
  assert.equal(workflows[1].kind, 'statuts')
})
