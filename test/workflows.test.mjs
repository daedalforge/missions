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
  descriptionError,
  documentStub,
  fileModel,
  isWorkflowKey,
  retitleDocument,
  slugify,
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

test('slugify déduit une clé lisible d’un titre libre', () => {
  // La clé est le titre, replié : accents retirés, casse basse, liaisons par
  // tirets — c'est la même fonction pour l'API et pour le panneau.
  assert.equal(slugify('Incidents ouverts'), 'incidents-ouverts')
  assert.equal(slugify('Crème brûlée'), 'creme-brulee')
  assert.equal(slugify('Œufs & Æstérisque'), 'oeufs-aesterisque')
  assert.equal(slugify('  Déjà   vu !  '), 'deja-vu', 'les bords et les doublons se replient')
  assert.equal(slugify('!!! ???'), '', 'un titre sans lettre ne produit aucune clé')
  assert.equal(slugify('A'.repeat(120)).length, 80, 'la clé tient en 80 caractères')
  assert.equal(slugify('A'.repeat(120)).endsWith('-'), false, 'la coupe ne laisse pas de tiret')
})

test('la description tient sur une ligne, en 280 caractères', () => {
  assert.equal(descriptionError('Les incidents du workspace.'), null)
  assert.equal(descriptionError(''), null, 'une description vide est permise')
  assert.equal(descriptionError('deux\nlignes'), '`description` tient sur une ligne')
  assert.ok(descriptionError('x'.repeat(281)))
  assert.equal(descriptionError('x'.repeat(280)), null)
})

test('le squelette du document ouvre la section d’un parcours d’étapes', () => {
  assert.equal(documentStub('Incidents', 'etape'), '# Incidents\n\n## Ce qu’on fait\n')
  assert.equal(documentStub('Statuts', 'statuts'), '# Statuts\n', 'un vocabulaire de statuts ne cite aucune section')
  assert.equal(retitleDocument('# Ancien\n\n## Ce qu’on fait\n', 'Nouveau'), '# Nouveau\n\n## Ce qu’on fait\n')
  assert.equal(retitleDocument('## Sans titre\n', 'Nouveau'), '# Nouveau\n\n## Sans titre\n', 'le titre manquant s’ajoute, rien ne se perd')
})

test('saveWorkflow renomme le titre du document quand le modèle change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-retitle-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })
  await writeFile(join(dir, 'workflows', 'cadrage.md'), '# Cadrage\n\n## Ce qu\'on fait\n', 'utf8')

  const saved = await saveWorkflow(join(dir, 'workflows', 'model'), 'cadrage', modele({ title: 'Cadrage renommé' }), { states: STATES })
  assert.deepEqual(saved.errors, [])

  assert.equal(
    await readFile(join(dir, 'workflows', 'cadrage.md'), 'utf8'),
    '# Cadrage renommé\n\n## Ce qu\'on fait\n',
    'le titre vit dans le modèle, le document suit',
  )
})

test('saveWorkflow n’invente pas le document d’un modèle qui n’en a pas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-nodoc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })

  const saved = await saveWorkflow(join(dir, 'workflows', 'model'), 'cadrage', modele(), { states: STATES })
  assert.deepEqual(saved.errors, [])
  assert.equal(await readFile(join(dir, 'workflows', 'cadrage.md'), 'utf8').catch(() => null), null, 'aucun document créé')
})

test('createWorkflow ne prend que le titre, la description et le type', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-create-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const created = await createWorkflow(models, {
    title: 'Incidents ouverts',
    description: 'Les incidents qui restent à traiter.',
    kind: 'etape',
  }, { states: STATES })

  assert.deepEqual(created.errors, [])
  assert.equal(created.entry.workflow, 'incidents-ouverts', 'la clé est le slug du titre')
  assert.equal(created.entry.title, 'Incidents ouverts')
  assert.equal(created.entry.description, 'Les incidents qui restent à traiter.')
  assert.equal(created.entry.document, 'workflows/incidents-ouverts.md', 'le document suit la clé')
  assert.equal(created.entry.entry, 'to-refine', 'l’entrée part de l’état canonique')
  assert.deepEqual(created.entry.exit, ['done'], 'la sortie part de l’état final')
  assert.deepEqual(created.entry.nodes, [])

  const written = parse(await readFile(join(models, 'incidents-ouverts.yml'), 'utf8'))
  assert.equal(written.description, 'Les incidents qui restent à traiter.')
  assert.deepEqual(written.nodes, [])
  assert.deepEqual(written.edges, [])
  assert.equal(
    await readFile(join(dir, 'workflows', 'incidents-ouverts.md'), 'utf8'),
    '# Incidents ouverts\n\n## Ce qu’on fait\n',
    'le squelette ouvre la section que le premier geste citera',
  )

  const again = await createWorkflow(models, { title: 'Incidents ouverts', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(again), ['cle-double'])
  assert.equal(parse(await readFile(join(models, 'incidents-ouverts.yml'), 'utf8')).title, 'Incidents ouverts')
})

test('createWorkflow refuse un titre vide, un titre sans clé et un type inconnu', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-create-refus-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const sansTitre = await createWorkflow(models, { title: '   ', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(sansTitre), ['titre-manquant'])

  const sansCle = await createWorkflow(models, { title: '!!! ???', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(sansCle), ['cle-invalide'], 'un titre sans lettre ne produit aucune clé')

  const type = await createWorkflow(models, { title: 'Incidents', kind: 'autre' }, { states: STATES })
  assert.deepEqual(codes(type), ['genre-inconnu'])
})

test('createWorkflow garde le mot de l’appelant quand il nomme sa clé ou son document', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-create-api-'))
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

  const created = await createWorkflow(models, { title: 'Statuts bis', kind: 'statuts' }, { states: STATES })

  assert.deepEqual(created.errors, [])
  assert.equal(created.entry.workflow, 'statuts-bis')
  assert.deepEqual(created.entry.nodes.map((node) => node.id), STATES)
  assert.deepEqual(created.entry.edges, [])
  assert.ok(created.entry.nodes.every((node) => node.label && node.tracker))
  assert.equal(
    await readFile(join(dir, 'workflows', 'statuts-bis.md'), 'utf8'),
    '# Statuts bis\n',
    'un workflow de statuts est son propre vocabulaire : pas de section à ouvrir',
  )
})

test('la clé dérive du titre, accents compris, et refuse un titre vide de sens', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-slug-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const revision = await createWorkflow(models, { title: 'Révision des demandes', kind: 'etape' }, { states: STATES })
  assert.deepEqual(revision.errors, [])
  assert.equal(revision.entry.workflow, 'revision-des-demandes')
  assert.equal(revision.entry.document, 'workflows/revision-des-demandes.md')

  const vide = await createWorkflow(models, { title: '---', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(vide), ['cle-invalide'])
  assert.equal(await readFile(join(models, '---.yml'), 'utf8').catch(() => null), null, 'aucun modèle écrit')
  assert.equal(await readFile(join(dir, 'workflows', '---.md'), 'utf8').catch(() => null), null, 'aucun document écrit')

  const multiligne = await createWorkflow(models, { title: 'Deux\nlignes', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(multiligne), ['titre-invalide'])
})

test('une collision de clé ou de document refuse la création, sans rien écrire', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-collision-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await mkdir(join(dir, 'workflows'), { recursive: true })

  // Le modèle existe, le document non : le refus nomme la clé.
  await mkdir(models, { recursive: true })
  await writeFile(join(models, 'incidents.yml'), 'workflow: incidents\n', 'utf8')
  const parModele = await createWorkflow(models, { title: 'Incidents', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(parModele), ['cle-double'])
  assert.equal(await readFile(join(dir, 'workflows', 'incidents.md'), 'utf8').catch(() => null), null)

  // Le document existe seul : le refus nomme le document, le modèle reste absent.
  await writeFile(join(dir, 'workflows', 'revues.md'), '# Revues\n', 'utf8')
  const parDocument = await createWorkflow(models, { title: 'Revues', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(parDocument), ['document-double'])
  assert.equal(await readFile(join(dir, 'workflows', 'revues.md'), 'utf8'), '# Revues\n', 'le document existant reste intact')
  assert.equal(await readFile(join(models, 'revues.yml'), 'utf8').catch(() => null), null, 'aucun modèle partiel')
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
