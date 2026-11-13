import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  expectedDocument,
  LOCAL_MODEL_DIR,
  LOCAL_MODELS_DIR,
  MODELS_DIR,
  loadWorkflows,
  readHeadings,
  scopeOf,
  readWorkflow,
  saveWorkflow,
  validateModel,
  workflowDirs,
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

test('saveWorkflow refuse chaque édition illisible, sans toucher au modèle ni au document', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-refus-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await mkdir(models, { recursive: true })
  const document = join(dir, 'workflows', 'cadrage.md')
  await writeFile(document, '# Cadrage\n\n## Ce qu\'on fait\n', 'utf8')

  // Given : un modèle valide écrit une première fois, et son document en place.
  assert.deepEqual((await saveWorkflow(models, 'cadrage', modele(), { states: STATES })).errors, [])
  const fichier = join(models, 'cadrage.yml')
  const yamlEcrit = await readFile(fichier, 'utf8')
  const documentEcrit = await readFile(document, 'utf8')

  // When : chaque édition illisible est enregistrée, une par une.
  const refus = [
    ['un titre vide', modele({ title: '   ' }), 'title', 'titre-manquant'],
    ['une entrée inconnue', modele({ entry: 'shipped' }), 'entry', 'etat-inconnu'],
    ['une sortie inconnue', modele({ exit: ['shipped'] }), 'exit', 'etat-inconnu'],
    ['une sortie en double', modele({ exit: ['ready', 'ready'] }), 'exit', 'etat-double'],
    ['une entrée aussi sortie', modele({ exit: ['to-refine'] }), 'exit', 'sortie-confondue'],
    ['une description de 281 caractères', modele({ description: 'x'.repeat(281) }), 'description', 'description-invalide'],
  ]

  // Then : chaque refus nomme son champ et son motif, et rien n’a bougé sur disque.
  for (const [cas, doc, field, code] of refus) {
    const result = await saveWorkflow(models, 'cadrage', doc, { states: STATES })
    assert.deepEqual(codes(result), [code], cas)
    assert.equal(result.errors[0].field, field, cas)
  }
  assert.equal(await readFile(fichier, 'utf8'), yamlEcrit, 'le modèle refusé reste intact')
  assert.equal(await readFile(document, 'utf8'), documentEcrit, 'le document refusé reste intact')
})

test('saveWorkflow ne réécrit pas le document quand le titre ne change pas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-conserve-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await mkdir(models, { recursive: true })
  const document = join(dir, 'workflows', 'cadrage.md')
  await writeFile(document, '# Cadrage\n\n## Ce qu\'on fait\n', 'utf8')

  // Given : un document daté d’hier, que seule une écriture ferait bouger.
  const date = new Date('2026-11-12T08:00:00Z')
  await utimes(document, date, date)
  const avant = await stat(document)

  // When : le modèle est enregistré sans changer de titre.
  assert.deepEqual((await saveWorkflow(models, 'cadrage', modele(), { states: STATES })).errors, [])

  // Then : le document garde son contenu et sa date de modification.
  const apres = await stat(document)
  assert.equal(await readFile(document, 'utf8'), '# Cadrage\n\n## Ce qu\'on fait\n')
  assert.equal(apres.mtimeMs, avant.mtimeMs, 'le document n’est pas réécrit quand le titre ne change pas')
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

test('la description tient sur plusieurs lignes, en 280 caractères', () => {
  assert.equal(descriptionError('Les incidents du workspace.'), null)
  assert.equal(descriptionError(''), null, 'une description vide est permise')
  assert.equal(descriptionError('deux\nlignes'), null, 'un retour à la ligne est une description, pas un défaut')
  assert.equal(descriptionError('deux\r\nlignes'), null)
  assert.equal(descriptionError('\n'), null, 'des blancs seuls ne comptent pas')
  assert.ok(descriptionError('x'.repeat(281)))
  assert.equal(descriptionError('x'.repeat(280)), null)
})

test('le squelette du document ouvre la section d’un parcours d’étapes', () => {
  assert.equal(documentStub('Incidents', 'etape'), '# Incidents\n\n## Ce qu\'on fait\n')
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
    '# Incidents ouverts\n\n## Ce qu\'on fait\n',
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
  // Une date figée : une écriture, même identique, la ferait bouger.
  const date = new Date('2026-11-12T08:00:00Z')
  await utimes(join(models, 'incidents.yml'), date, date)
  const modeleAvant = await stat(join(models, 'incidents.yml'))
  const parModele = await createWorkflow(models, { title: 'Incidents', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(parModele), ['cle-double'])
  assert.equal(await readFile(join(dir, 'workflows', 'incidents.md'), 'utf8').catch(() => null), null)
  assert.equal((await stat(join(models, 'incidents.yml'))).mtimeMs, modeleAvant.mtimeMs, 'le modèle existant n’est pas réécrit')

  // Le document existe seul : le refus nomme le document, le modèle reste absent.
  await writeFile(join(dir, 'workflows', 'revues.md'), '# Revues\n', 'utf8')
  await utimes(join(dir, 'workflows', 'revues.md'), date, date)
  const documentAvant = await stat(join(dir, 'workflows', 'revues.md'))
  const parDocument = await createWorkflow(models, { title: 'Revues', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(parDocument), ['document-double'])
  assert.equal(await readFile(join(dir, 'workflows', 'revues.md'), 'utf8'), '# Revues\n', 'le document existant reste intact')
  assert.equal((await stat(join(dir, 'workflows', 'revues.md'))).mtimeMs, documentAvant.mtimeMs, 'le document existant n’est pas réécrit')
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

test('le dossier dit le rangement, et chaque rangement a son document', () => {
  assert.equal(scopeOf(MODELS), 'model')
  assert.equal(scopeOf(join(ROOT, 'workflows', 'local', 'model')), 'local')
  assert.equal(scopeOf(LOCAL_MODELS_DIR), 'local', 'le dossier par défaut est local')
  assert.equal(expectedDocument('model', 'cadrage'), 'workflows/cadrage.md')
  assert.equal(expectedDocument('local', 'cadrage'), 'workflows/local/cadrage.md')
  assert.equal(LOCAL_MODEL_DIR, 'workflows/local/model')
})

test('workflowDirs rend les dossiers du paquet sans projetsFile, et les dérive du fichier sinon', async (t) => {
  // Given : un fichier de projets dans un dépôt temporaire.
  const dir = await mkdtemp(join(tmpdir(), 'workflows-dirs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const projectsFile = pathToFileURL(join(dir, 'missions', 'projects.yml'))

  // When
  const defaults = workflowDirs(undefined)
  const derived = workflowDirs(projectsFile)

  // Then : sans fichier de projets, les dossiers sont ceux que le paquet lit déjà.
  assert.equal(defaults.modelsDir.href, MODELS_DIR.href)
  assert.equal(defaults.localModelsDir.href, LOCAL_MODELS_DIR.href)
  // Avec, les deux dossiers restent à côté de `projects.yml`.
  assert.equal(derived.modelsDir.href, pathToFileURL(join(dir, 'workflows', 'model') + '/').href)
  assert.equal(derived.localModelsDir.href, pathToFileURL(join(dir, 'workflows', 'local', 'model') + '/').href)
})

test('createWorkflow écrit la création locale dans le dossier local rendu par workflowDirs', async (t) => {
  // Given : les dossiers dérivés d'un fichier de projets temporaire.
  const dir = await mkdtemp(join(tmpdir(), 'workflows-dirs-create-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { modelsDir } = workflowDirs(pathToFileURL(join(dir, 'missions', 'projects.yml')))

  // When
  const created = await createWorkflow(modelsDir, { title: 'Brouillon local', kind: 'etape', local: true }, { states: STATES })

  // Then : le modèle et son document sont sous `workflows/local/`, pas sous un `undefined/`.
  assert.deepEqual(created.errors, [])
  assert.equal(created.entry.local, true)
  assert.equal(created.entry.file, 'workflows/local/model/brouillon-local.yml')
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'model', 'brouillon-local.yml'), 'utf8').then(() => true), true)
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'brouillon-local.md'), 'utf8'), '# Brouillon local\n\n## Ce qu\'on fait\n')
  assert.equal(await readFile(join(dir, 'undefined', 'local', 'model', 'brouillon-local.yml'), 'utf8').catch(() => null), null, 'aucun dossier undefined/')
})

test('validateModel refuse un document hors du dossier de son workflow', () => {
  const localHorsDossier = valide(modele({ document: 'workflows/cadrage.md' }), { scope: 'local' })
  assert.deepEqual(codes(localHorsDossier), ['document-hors-dossier'])

  const versionneHorsDossier = valide(modele({ document: 'workflows/local/cadrage.md' }), { scope: 'model' })
  assert.deepEqual(codes(versionneHorsDossier), ['document-hors-dossier'])

  assert.deepEqual(valide(modele({ document: 'workflows/local/cadrage.md' }), { scope: 'local' }).errors, [])
})

test('fileModel écrit une description multi-lignes en bloc YAML relisible', () => {
  const description = 'Une première ligne.\nUne deuxième ligne.'
  const ecrit = YAML.stringify(fileModel(modele({ description })), { lineWidth: 0 })
  assert.match(ecrit, /description: \|-/)
  assert.equal(YAML.parse(ecrit).description, description)
})

test('createWorkflow range un workflow local sous workflows/local/', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-local-create-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const created = await createWorkflow(models, {
    title: 'Brouillon local',
    description: 'deux\nlignes',
    kind: 'etape',
    local: true,
  }, { states: STATES })

  assert.deepEqual(created.errors, [])
  assert.equal(created.entry.local, true)
  assert.equal(created.entry.file, 'workflows/local/model/brouillon-local.yml')
  assert.equal(created.entry.document, 'workflows/local/brouillon-local.md')

  const modeleLocal = join(dir, 'workflows', 'local', 'model', 'brouillon-local.yml')
  const documentLocal = join(dir, 'workflows', 'local', 'brouillon-local.md')
  const model = parse(await readFile(modeleLocal, 'utf8'))
  assert.equal(model.document, 'workflows/local/brouillon-local.md')
  assert.equal(model.description, 'deux\nlignes')
  assert.match(await readFile(modeleLocal, 'utf8'), /description: \|-/)
  assert.equal(await readFile(documentLocal, 'utf8'), '# Brouillon local\n\n## Ce qu\'on fait\n')
  assert.equal(await readFile(join(models, 'brouillon-local.yml'), 'utf8').catch(() => null), null, 'rien dans le dossier versionné')
  assert.equal(await readFile(join(dir, 'workflows', 'brouillon-local.md'), 'utf8').catch(() => null), null, 'le document ne reste pas au niveau versionné')
})

test('createWorkflow refuse une clé ou un document déjà pris par l’autre dossier', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-local-collision-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  assert.deepEqual((await createWorkflow(models, { title: 'Incidents', kind: 'etape' }, { states: STATES })).errors, [])
  const localSurVersionne = await createWorkflow(models, { title: 'Incidents', kind: 'etape', local: true }, { states: STATES })
  assert.deepEqual(codes(localSurVersionne), ['cle-double'])
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'model', 'incidents.yml'), 'utf8').catch(() => null), null, 'aucune écriture locale')

  const autre = await mkdtemp(join(tmpdir(), 'workflows-local-collision-2-'))
  t.after(() => rm(autre, { recursive: true, force: true }))
  const autreModels = join(autre, 'workflows', 'model')
  assert.deepEqual((await createWorkflow(autreModels, { title: 'Incidents', kind: 'etape', local: true }, { states: STATES })).errors, [])
  const versionneSurLocal = await createWorkflow(autreModels, { title: 'Incidents', kind: 'etape' }, { states: STATES })
  assert.deepEqual(codes(versionneSurLocal), ['cle-double'])
  assert.equal(await readFile(join(autreModels, 'incidents.yml'), 'utf8').catch(() => null), null, 'aucune écriture versionnée')

  const troisieme = await mkdtemp(join(tmpdir(), 'workflows-local-doc-collision-'))
  t.after(() => rm(troisieme, { recursive: true, force: true }))
  await mkdir(join(troisieme, 'workflows'), { recursive: true })
  await writeFile(join(troisieme, 'workflows', 'incidents.md'), '# Incidents\n', 'utf8')
  const document = await createWorkflow(join(troisieme, 'workflows', 'model'), {
    title: 'Incidents', kind: 'etape', local: true,
  }, { states: STATES })
  assert.deepEqual(codes(document), ['document-double'])
})

test('createWorkflow refuse un document local qui cite le dossier versionné', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-local-document-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')

  const created = await createWorkflow(models, {
    workflow: 'incidents',
    title: 'Incidents',
    kind: 'etape',
    local: true,
    document: 'workflows/incidents.md',
  }, { states: STATES })

  assert.deepEqual(codes(created), ['document-hors-dossier'])
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'model', 'incidents.yml'), 'utf8').catch(() => null), null)
})

test('readWorkflow et loadWorkflows rendent le dossier local dans file et local', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-local-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await createWorkflow(models, { title: 'Local', kind: 'etape', local: true }, { states: STATES })
  await createWorkflow(models, { title: 'Versionne', kind: 'etape' }, { states: STATES })

  const local = join(dir, 'workflows', 'local', 'model')
  const entry = await readWorkflow(local, 'local', { states: STATES })
  assert.deepEqual(entry.errors, [])
  assert.equal(entry.local, true)
  assert.equal(entry.file, 'workflows/local/model/local.yml')
  assert.equal(entry.document, 'workflows/local/local.md')

  const { workflows } = await loadWorkflows(local, { states: STATES })
  assert.deepEqual(workflows.map((item) => item.workflow), ['local'])
  assert.equal(workflows[0].local, true)

  const versionne = await readWorkflow(models, 'versionne', { states: STATES })
  assert.equal(versionne.local, false)
  assert.equal(versionne.file, 'workflows/model/versionne.yml')
})

test('saveWorkflow déplace modèle et document entre les deux dossiers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-move-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await mkdir(models, { recursive: true })
  await writeFile(join(dir, 'workflows', 'cadrage.md'), '# Cadrage\n\n## Ce qu\'on fait\n', 'utf8')
  assert.deepEqual((await saveWorkflow(models, 'cadrage', modele(), { states: STATES })).errors, [])

  // Vers le local : le modèle et son document partent ensemble, le champ
  // `document` suit la convention du dossier cible.
  const moved = await saveWorkflow(models, 'cadrage', modele({ title: 'Cadrage local', description: 'deux\nlignes' }), { states: STATES, local: true })
  assert.deepEqual(moved.errors, [])
  assert.equal(moved.moved, true)
  assert.equal(moved.local, true)
  assert.equal(moved.model.document, 'workflows/local/cadrage.md')
  assert.equal(await readFile(join(models, 'cadrage.yml'), 'utf8').catch(() => null), null, 'le modèle source a disparu')
  assert.equal(await readFile(join(dir, 'workflows', 'cadrage.md'), 'utf8').catch(() => null), null, 'le document source a disparu')
  const modeleLocal = await readFile(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'), 'utf8')
  assert.match(modeleLocal, /document: workflows\/local\/cadrage\.md/)
  assert.match(modeleLocal, /title: Cadrage local/)
  assert.equal(
    await readFile(join(dir, 'workflows', 'local', 'cadrage.md'), 'utf8'),
    '# Cadrage local\n\n## Ce qu\'on fait\n',
    'le titre a suivi le document dans le déplacement',
  )

  // Et le retour : recocher « Versionné » ramène les deux fichiers.
  const back = await saveWorkflow(join(dir, 'workflows', 'local', 'model'), 'cadrage', moved.model, { states: STATES, local: false })
  assert.deepEqual(back.errors, [])
  assert.equal(back.local, false)
  assert.equal(back.model.document, 'workflows/cadrage.md')
  assert.ok(await readFile(join(models, 'cadrage.yml'), 'utf8'))
  assert.ok(await readFile(join(dir, 'workflows', 'cadrage.md'), 'utf8'))
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'), 'utf8').catch(() => null), null)
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'cadrage.md'), 'utf8').catch(() => null), null)
})

test('le déplacement d’un workflow sans document n’en crée pas et ne laisse rien derrière', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-move-nodoc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await mkdir(models, { recursive: true })
  assert.deepEqual((await saveWorkflow(models, 'cadrage', modele(), { states: STATES })).errors, [])

  const moved = await saveWorkflow(models, 'cadrage', modele(), { states: STATES, local: true })
  assert.deepEqual(moved.errors, [])
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'cadrage.md'), 'utf8').catch(() => null), null, 'aucun document inventé')
  assert.equal(await readFile(join(dir, 'workflows', 'cadrage.md'), 'utf8').catch(() => null), null, 'aucun document source')
})

test('un déplacement qui collisionne est refusé avant toute écriture', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-move-collision-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const models = join(dir, 'workflows', 'model')
  await mkdir(join(dir, 'workflows', 'local', 'model'), { recursive: true })
  await writeFile(join(dir, 'workflows', 'cadrage.md'), '# Cadrage\n\n## Ce qu\'on fait\n', 'utf8')
  assert.deepEqual((await saveWorkflow(models, 'cadrage', modele(), { states: STATES })).errors, [])

  // La clé cible existe déjà : rien ne bouge.
  await writeFile(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'), 'workflow: cadrage\n', 'utf8')
  const cle = await saveWorkflow(models, 'cadrage', modele(), { states: STATES, local: true })
  assert.equal(cle.conflict, true)
  assert.deepEqual(codes(cle), ['cle-double'])
  assert.ok(await readFile(join(models, 'cadrage.yml'), 'utf8'), 'la source reste')
  assert.ok(await readFile(join(dir, 'workflows', 'cadrage.md'), 'utf8'), 'le document source reste')

  // Le document cible existe déjà : la source reste aussi.
  await rm(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'))
  await writeFile(join(dir, 'workflows', 'local', 'cadrage.md'), '# Autre\n', 'utf8')
  const document = await saveWorkflow(models, 'cadrage', modele(), { states: STATES, local: true })
  assert.equal(document.conflict, true)
  assert.deepEqual(codes(document), ['document-double'])
  assert.ok(await readFile(join(models, 'cadrage.yml'), 'utf8'))
})

test('saveWorkflow local refuse un document hors de workflows/local/', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-local-save-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const local = join(dir, 'workflows', 'local', 'model')
  await mkdir(local, { recursive: true })

  const refused = await saveWorkflow(local, 'cadrage', modele({ document: 'workflows/cadrage.md' }), { states: STATES })
  assert.deepEqual(codes(refused), ['document-hors-dossier'])
  assert.equal(await readFile(join(local, 'cadrage.yml'), 'utf8').catch(() => null), null, 'rien n’est écrit')
})
