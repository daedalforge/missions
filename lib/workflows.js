import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import YAML from 'yaml'

/**
 * The models of the Workspace tab: the four steps of the parcours, plus the
 * workflow of the canonical states.
 *
 * A model is the editable view of `workflows/<clé>.md`: gestures or states
 * (nodes) and transitions (edges) between canonical states. The document stays
 * the reference — a gesture cites the heading it comes from, and the
 * concordance between the two is reported, never repaired here.
 *
 * Two kinds share the format. `etape` models are the method steps, whose nodes
 * are gestures. `statuts` models describe the canonical states themselves: the
 * nodes are the states of `missions/projects.yml`, and the edges are events.
 * An absent `kind` means `etape`, so the four historical models stay valid
 * without being rewritten.
 */
export const WORKFLOWS = ['cadrage', 'execution', 'review', 'cloture']

/** The kinds of model the panel can read and edit. */
export const KINDS = ['etape', 'statuts']

/** Who performs a gesture or an event. */
export const WRITERS = ['demandeur', 'session', 'outil']

/** Where the models live, relative to the repository root. */
export const MODEL_DIR = 'workflows/model'

/** Default models directory: the repository this package lives in. */
export const MODELS_DIR = new URL('../workflows/model/', import.meta.url)

/**
 * Where the workflows kept out of git live. Same shape as the versioned
 * directory: the model under `local/model/`, its document one level up. The
 * directory, not a field of the model, says whether a workflow is versioned.
 */
export const LOCAL_MODEL_DIR = 'workflows/local/model'

/** Default local models directory: beside the versioned one, git-ignored. */
export const LOCAL_MODELS_DIR = new URL('../workflows/local/model/', import.meta.url)

export const MODEL_FILE_SUFFIX = '.yml'

/** The directory every document must stay in. */
const DOCUMENT_PREFIX = 'workflows/'

/**
 * The canonical states of the workspace, with the label, the description and
 * the tracker projection the mockup fixed for each one.
 */
export const STATUS_STATES = [
  {
    id: 'to-refine',
    label: 'À cadrer',
    description: 'Le ticket est ouvert ; rien n\'est encore décidé.',
    tracker: 'label to-refine',
  },
  {
    id: 'ready',
    label: 'Prête',
    description: 'Le cadrage est validé : périmètre, critères et plan.',
    tracker: 'label ready',
  },
  {
    id: 'in-progress',
    label: 'En cours',
    description: 'La branche est poussée ; l\'exécution travaille.',
    tracker: 'label in-progress',
  },
  {
    id: 'in-review',
    label: 'En revue',
    description: 'La PR est ouverte ; une relecture tranche.',
    tracker: 'label in-review',
  },
  {
    id: 'ready-for-prod',
    label: 'Prête à partir',
    description: 'La PR est approuvée ; le demandeur livre.',
    tracker: 'label ready-for-prod',
  },
  {
    id: 'done',
    label: 'Terminée',
    description: 'Merge fait, ticket fermé, branche supprimée.',
    tracker: 'issue fermée (map: null)',
  },
]

const MODEL_KEYS = ['workflow', 'kind', 'title', 'description', 'document', 'entry', 'exit', 'nodes', 'edges']
const DESCRIPTION_MAX = 280
const TITLE_MAX = 120
const DEFAULT_ENTRY = 'to-refine'
const DEFAULT_EXIT = ['done']
const DEFAULT_SECTION = "Ce qu'on fait"
const NODE_KEYS = ['id', 'label', 'section', 'writer', 'condition', 'artifact', 'gate', 'description', 'tracker']
const STATUS_NODE_KEYS = ['id', 'label', 'description', 'tracker']
const EDGE_KEYS = ['from', 'to', 'when', 'writer', 'artifact', 'gate']
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether a value can name a model file: a slug, never a path. */
export function isWorkflowKey(value) {
  return typeof value === 'string' && SLUG.test(value)
}

/**
 * The key a title gives: accents are folded, `œ`/`æ` open, everything that is
 * not a letter or a digit becomes a dash, and the dashes on the edges go. A
 * title that leaves nothing is a title without a key — the creation refuses it.
 */
export function slugify(title) {
  const folded = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'ae')
    .toLowerCase()
  return folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

/**
 * The document a new workflow starts with. A steps workflow keeps one section
 * open, so the first gesture has a heading to cite; a states workflow is its
 * own vocabulary and needs none.
 */
export function documentStub(title, kind) {
  return kind === 'statuts' ? `# ${title}\n` : `# ${title}\n\n## ${DEFAULT_SECTION}\n`
}

/** Why a description is refused, or null when it is acceptable. */
export function descriptionError(value) {
  if (typeof value !== 'string') return '`description` est du texte'
  if (value.trim().length > DESCRIPTION_MAX) return `\`description\` fait ${DESCRIPTION_MAX} caractères au plus`
  return null
}

/**
 * Rewrite the first level-one heading of a document. The title lives in the
 * model; the document's own heading follows it, and nothing else is touched.
 */
export function retitleDocument(text, title) {
  const source = String(text ?? '')
  const heading = /^#[ \t]+[^\r\n]*/m
  if (heading.test(source)) return source.replace(heading, `# ${title}`)
  return `# ${title}\n\n${source}`
}

/**
 * The headings of a markdown document, with the path leading to each one.
 *
 * Fenced code is skipped: a `#` inside a shell block is not a heading, and a
 * model that cited it would be citing a comment.
 */
export function readHeadings(markdown) {
  const headings = []
  const stack = []
  let fenced = false
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const level = match[1].length
    const text = match[2].trim()
    stack.length = level
    stack[level - 1] = text
    headings.push({ level, text, path: stack.slice(0, level).join(' › ') })
  }
  return headings
}

/**
 * The one-line summary of a workflow: its first prose paragraph, with the
 * markdown headings and lists skipped. No summary is invented, and no field is
 * added to the model for it.
 */
export function summaryOf(markdown = '') {
  const paragraph = []
  let started = false
  let fenced = false
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (started) break
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const text = line.trim()
    if (!started) {
      if (!text || /^#/.test(text) || /^([-*+]|\d+\.)\s/.test(text) || /^[|>]/.test(text)) continue
      started = true
      paragraph.push(text)
      continue
    }
    if (!text || /^#/.test(text) || /^([-*+]|\d+\.)\s/.test(text)) break
    paragraph.push(text)
  }
  return paragraph.join(' ')
}

/**
 * Which directory a workflow belongs to, read from the directory itself:
 * `local` under `workflows/local/`, `model` anywhere else. The model carries no
 * such field — a cloned repository must not inherit a lie about where the file
 * sits.
 */
export function scopeOf(dir = MODELS_DIR) {
  const path = fileURLToPath(asUrl(dir)).replace(/\\/g, '/').replace(/\/+$/, '')
  return /(?:^|\/)workflows\/local(?:\/|$)/.test(path) ? 'local' : 'model'
}

/** The document a workflow keeps in its scope: `workflows/local/<clé>.md` or not. */
export function expectedDocument(scope, workflow) {
  return `${scope === 'local' ? 'workflows/local' : 'workflows'}/${workflow}.md`
}

/** A file named after its workflow, in the models directory. */
export function modelUrl(dir, workflow) {
  return new URL(`./${workflow}${MODEL_FILE_SUFFIX}`, asUrl(dir))
}

/** The default document of a workflow, one directory above the models. */
export function documentUrl(dir, workflow) {
  return new URL(`../${workflow}.md`, asUrl(dir))
}

/**
 * The document declared by a model, or null when the value would leave the
 * `workflows/` directory. The confinement is checked here, once, for reading
 * and for writing.
 */
export function documentTarget(dir, document) {
  const value = typeof document === 'string' ? document.trim() : ''
  if (!value.startsWith(DOCUMENT_PREFIX) || value.includes('..') || value.includes('\\')) return null
  return new URL(value, repositoryRoot(dir))
}

/**
 * The repository root, from a models directory: one level above `workflows/`
 * whether the models are versioned or local. Resolving documents from there
 * keeps `workflows/local/<clé>.md` inside the repository instead of stacking
 * `workflows/` twice.
 */
function repositoryRoot(dir) {
  const base = asUrl(dir)
  return scopeOf(base) === 'local' ? new URL('../../../', base) : new URL('../../', base)
}

/**
 * Validate one model against the vocabulary of the workspace and the headings
 * of its document. Errors are returned, never thrown: the panel shows them.
 */
export function validateModel(doc, { headings = [], states = [], workflow = null, scope = 'model' } = {}) {
  const errors = []
  const fail = (field, code, message) => errors.push({ field, code, message })
  const orphanSections = []

  if (!isObject(doc)) {
    fail('', 'modele-invalide', 'un modèle est un objet YAML')
    return { errors, orphanSections }
  }

  const kind = doc.kind === undefined ? 'etape' : doc.kind
  if (!KINDS.includes(kind)) fail('kind', 'genre-inconnu', `\`kind\` vaut ${KINDS.join(' ou ')}`)
  const statuses = kind === 'statuts'

  checkKeys(doc, MODEL_KEYS, '', fail)

  if (!states.length) {
    fail('entry', 'etats-inconnus', 'aucun vocabulaire d\'états fourni : le modèle ne peut pas être validé')
  }

  if (workflow !== null && String(doc.workflow ?? '').trim() !== workflow) {
    fail('workflow', 'etape-inconnue', `le fichier doit déclarer \`workflow: ${workflow}\``)
  }
  if (!nonEmpty(doc.title)) fail('title', 'titre-manquant', '`title` est requis')

  if (doc.description !== undefined && doc.description !== null) {
    const error = descriptionError(doc.description)
    if (error) fail('description', 'description-invalide', error)
  }

  const document = typeof doc.document === 'string' ? doc.document.trim() : ''
  if (!document) fail('document', 'document-manquant', '`document` est requis')
  else if (!document.endsWith('.md') || !document.startsWith(DOCUMENT_PREFIX) || document.includes('..') || document.includes('\\')) {
    fail('document', 'document-invalide', '`document` désigne un fichier `.md` sous `workflows/`')
  } else if (scope === 'local' && !document.startsWith(`${DOCUMENT_PREFIX}local/`)) {
    fail('document', 'document-hors-dossier', 'Un workflow local garde son document sous `workflows/local/`.')
  } else if (scope !== 'local' && document.startsWith(`${DOCUMENT_PREFIX}local/`)) {
    fail('document', 'document-hors-dossier', 'Un document sous `workflows/local/` n\'appartient qu\'à un workflow local.')
  }

  const stateSet = new Set(states)
  if (typeof doc.entry !== 'string' || !stateSet.has(doc.entry)) {
    fail('entry', 'etat-inconnu', `\`entry\` doit être un état connu : ${states.join(', ') || '(aucun)'}`)
  }

  const exits = Array.isArray(doc.exit) ? doc.exit : null
  if (!exits || exits.length === 0) {
    fail('exit', 'sortie-manquante', '`exit` liste au moins un état')
  } else {
    const seen = new Set()
    for (const state of exits) {
      if (typeof state !== 'string' || !stateSet.has(state)) {
        fail('exit', 'etat-inconnu', `\`exit\` cite un état inconnu : ${String(state)}`)
      } else if (seen.has(state)) {
        fail('exit', 'etat-double', `\`exit\` cite deux fois ${state}`)
      } else {
        seen.add(state)
      }
    }
    if (typeof doc.entry === 'string' && seen.has(doc.entry)) {
      fail('exit', 'sortie-confondue', 'un état ne peut pas être à la fois l\'entrée et la sortie')
    }
  }

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : []
  if (!Array.isArray(doc.nodes)) fail('nodes', 'noeuds-manquants', '`nodes` liste les points du workflow')

  const headingTexts = new Map(headings.map((heading) => [normalize(heading.text), heading]))
  const cited = new Set()
  const nodeIds = new Set()

  nodes.forEach((node, index) => {
    const field = `nodes[${index}]`
    if (!isObject(node)) {
      fail(field, 'noeud-invalide', 'un point du workflow est un objet')
      return
    }
    checkKeys(node, statuses ? STATUS_NODE_KEYS : NODE_KEYS, field, fail)

    const id = typeof node.id === 'string' ? node.id.trim() : ''
    if (statuses) {
      if (!stateSet.has(id)) {
        fail(`${field}.id`, 'etat-inconnu', `un nœud de statuts est un état canonique : ${JSON.stringify(node.id ?? null)}`)
      } else if (nodeIds.has(id)) {
        fail(`${field}.id`, 'id-double', `deux états portent l'id ${id}`)
      } else {
        nodeIds.add(id)
      }
      if (!nonEmpty(node.label)) fail(`${field}.label`, 'libelle-manquant', '`label` nomme l\'état')
      for (const key of ['description', 'tracker']) {
        if (node[key] !== undefined && node[key] !== null && typeof node[key] !== 'string') {
          fail(`${field}.${key}`, 'champ-invalide', `\`${key}\` est du texte`)
        }
      }
      return
    }

    if (!SLUG.test(id)) fail(`${field}.id`, 'id-invalide', `\`id\` est un slug (a-z, 0-9, tirets) : ${JSON.stringify(node.id ?? null)}`)
    else if (stateSet.has(id)) fail(`${field}.id`, 'id-conflictuel', `un geste ne peut pas s'appeler comme l'état ${id}`)
    else if (nodeIds.has(id)) fail(`${field}.id`, 'id-double', `deux gestes portent l'id ${id}`)
    else nodeIds.add(id)

    if (!nonEmpty(node.label)) fail(`${field}.label`, 'libelle-manquant', '`label` décrit le geste en une phrase')
    if (!WRITERS.includes(node.writer)) {
      fail(`${field}.writer`, 'ecrivain-inconnu', `\`writer\` vaut ${WRITERS.join(', ')}`)
    }

    const section = typeof node.section === 'string' ? node.section.trim() : ''
    if (!section) {
      fail(`${field}.section`, 'section-manquante', '`section` cite un titre du document')
    } else if (headings.length && !headingTexts.has(normalize(section))) {
      fail(`${field}.section`, 'section-absente', `le document n'a pas de titre « ${section} »`)
    } else if (headings.length) {
      cited.add(normalize(section))
    }

    for (const key of ['condition', 'artifact', 'gate', 'description', 'tracker']) {
      if (node[key] !== undefined && node[key] !== null && typeof node[key] !== 'string') {
        fail(`${field}.${key}`, 'champ-invalide', `\`${key}\` est du texte`)
      }
    }
  })

  // A status workflow is the vocabulary itself: every canonical state appears
  // once, in the order the workspace lists them.
  if (statuses) {
    for (const state of states) {
      if (!nodeIds.has(state)) fail('nodes', 'etat-manquant', `le workflow de statuts décrit l'état ${state}`)
    }
    const order = nodes.map((node) => (isObject(node) ? String(node.id ?? '') : ''))
    if (nodeIds.size === states.length && order.some((id, index) => id !== states[index])) {
      fail('nodes', 'etats-desordonnes', `les états se lisent dans l'ordre ${states.join(', ')}`)
    }
  }

  const edges = Array.isArray(doc.edges) ? doc.edges : []
  if (!Array.isArray(doc.edges)) fail('edges', 'arcs-manquants', '`edges` liste les arcs')
  const resolvable = (value) => nodeIds.has(value) || stateSet.has(value)
  const arcs = new Set()
  const graph = new Map()

  edges.forEach((edge, index) => {
    const field = `edges[${index}]`
    if (!isObject(edge)) {
      fail(field, 'arc-invalide', 'un arc est un objet')
      return
    }
    checkKeys(edge, EDGE_KEYS, field, fail)
    const from = typeof edge.from === 'string' ? edge.from.trim() : ''
    const to = typeof edge.to === 'string' ? edge.to.trim() : ''
    if (!from) fail(`${field}.from`, 'arc-manquant', '`from` désigne un point du workflow')
    if (!to) fail(`${field}.to`, 'arc-manquant', '`to` désigne un point du workflow')
    if (from && to && from === to) fail(field, 'arc-boucle', 'un arc ne revient pas sur lui-même')
    if (from && !resolvable(from)) fail(`${field}.from`, 'arc-orphelin', `\`from\` ne désigne aucun point connu : ${from}`)
    if (to && !resolvable(to)) fail(`${field}.to`, 'arc-orphelin', `\`to\` ne désigne aucun point connu : ${to}`)
    if (edge.when !== undefined && edge.when !== null && typeof edge.when !== 'string') {
      fail(`${field}.when`, 'champ-invalide', '`when` est du texte')
    }
    if (edge.writer !== undefined && edge.writer !== null && !WRITERS.includes(edge.writer)) {
      fail(`${field}.writer`, 'ecrivain-inconnu', `\`writer\` vaut ${WRITERS.join(', ')}`)
    }
    for (const key of ['artifact', 'gate']) {
      if (edge[key] !== undefined && edge[key] !== null && typeof edge[key] !== 'string') {
        fail(`${field}.${key}`, 'champ-invalide', `\`${key}\` est du texte`)
      }
    }
    if (from && to) {
      const pair = `${from}\u0000${to}`
      if (arcs.has(pair)) fail(field, 'arc-double', `deux arcs vont de ${from} à ${to}`)
      else {
        arcs.add(pair)
        if (!graph.has(from)) graph.set(from, [])
        graph.get(from).push(to)
      }
    }
  })

  // Everything must hang together: a gesture nobody reaches is dead weight, and
  // an exit nobody reaches can never be entered. An empty graph is a scaffold
  // waiting for its first arc, not a broken model.
  if (edges.length && typeof doc.entry === 'string' && stateSet.has(doc.entry)) {
    const seen = new Set([doc.entry])
    const queue = [doc.entry]
    while (queue.length) {
      for (const next of graph.get(queue.shift()) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    for (const id of nodeIds) {
      if (!seen.has(id)) {
        fail(statuses ? 'nodes' : `nodes[${nodes.findIndex((node) => node?.id === id)}]`, statuses ? 'etat-injoignable' : 'geste-injoignable', `aucun arc ne mène à ${id} depuis ${doc.entry}`)
      }
    }
    if (exits) {
      for (const state of exits) {
        if (typeof state === 'string' && stateSet.has(state) && !seen.has(state)) {
          fail('exit', 'sortie-injoignable', `aucun arc ne mène à ${state} depuis ${doc.entry}`)
        }
      }
    }
  }

  if (!statuses) {
    for (const heading of headings) {
      if (heading.level < 2) continue
      if (!cited.has(normalize(heading.text))) orphanSections.push(heading.text)
    }
  }

  return { errors, orphanSections }
}

/** Canonical key order, so an edit of one field does not rewrite the file. */
export function fileModel(model) {
  const statuses = model.kind === 'statuts'
  const value = {
    workflow: model.workflow,
    ...(statuses ? { kind: 'statuts' } : {}),
    title: model.title,
    ...(typeof model.description === 'string' && model.description.trim() ? { description: model.description.trim() } : {}),
    document: model.document,
    entry: model.entry,
    exit: Array.isArray(model.exit) ? [...model.exit] : [],
    nodes: (Array.isArray(model.nodes) ? model.nodes : []).map((node) => compact(statuses
      ? {
          id: node.id,
          label: node.label,
          description: node.description,
          tracker: node.tracker,
        }
      : {
          id: node.id,
          label: node.label,
          section: node.section,
          writer: node.writer,
          condition: node.condition,
          artifact: node.artifact,
          gate: node.gate,
          description: node.description,
          tracker: node.tracker,
        })),
    edges: (Array.isArray(model.edges) ? model.edges : []).map((edge) => compact({
      from: edge.from,
      to: edge.to,
      when: edge.when,
      writer: edge.writer,
      artifact: edge.artifact,
      gate: edge.gate,
    })),
  }
  return value
}

/** Load every model of the directory, in the order the panel lists them. */
export async function loadWorkflows(dir = MODELS_DIR, { states = [], scope = scopeOf(dir) } = {}) {
  const base = asUrl(dir)
  let names = []
  try {
    names = await readdir(fileURLToPath(base))
  } catch (error) {
    if (error?.code === 'ENOENT') return { workflows: [] }
    throw error
  }

  const workflows = []
  for (const name of names.filter((item) => item.endsWith(MODEL_FILE_SUFFIX)).sort()) {
    const workflow = name.slice(0, -MODEL_FILE_SUFFIX.length)
    if (!isWorkflowKey(workflow)) continue
    workflows.push(await readWorkflow(base, workflow, { states, scope }))
  }
  workflows.sort(compareWorkflows)
  return { workflows }
}

/**
 * The order the panel lists the workflows in: the four method steps, then the
 * other step workflows by title, then the status workflows by title.
 */
export function compareWorkflows(a, b) {
  const group = (entry) => (entry.kind === 'statuts' ? 2 : WORKFLOWS.includes(entry.workflow) ? 0 : 1)
  const left = group(a)
  const right = group(b)
  if (left !== right) return left - right
  if (left === 0) return WORKFLOWS.indexOf(a.workflow) - WORKFLOWS.indexOf(b.workflow)
  return String(a.title).localeCompare(String(b.title), 'fr') || String(a.workflow).localeCompare(String(b.workflow))
}

/** One model and its concordance with its document. */
export async function readWorkflow(dir = MODELS_DIR, workflow, { states = [], scope = scopeOf(dir) } = {}) {
  const base = asUrl(dir)
  const file = `${scope === 'local' ? LOCAL_MODEL_DIR : MODEL_DIR}/${workflow}${MODEL_FILE_SUFFIX}`

  let source = null
  try {
    source = await readFile(fileURLToPath(modelUrl(base, workflow)), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  let doc = null
  let parseError = null
  if (source !== null) {
    try {
      doc = YAML.parse(source)
    } catch (error) {
      parseError = error
    }
  }

  const document = isObject(doc) && typeof doc.document === 'string' ? doc.document : expectedDocument(scope, workflow)
  const { headings, text: markdown, missing } = await readDocument(base, workflow, document)
  const errors = []
  if (missing) errors.push({ field: 'document', code: 'document-absent', message: `le document ${document} est absent` })
  if (source === null) errors.push({ field: 'fichier', code: 'fichier-absent', message: `${file} est absent` })
  if (parseError) errors.push({ field: 'fichier', code: 'yaml-invalide', message: parseError?.message ?? 'YAML invalide' })

  const nodes = isObject(doc) && Array.isArray(doc.nodes) ? doc.nodes.filter(isObject) : []
  const edges = isObject(doc) && Array.isArray(doc.edges) ? doc.edges.filter(isObject) : []
  const entry = {
    workflow: isObject(doc) && typeof doc.workflow === 'string' ? doc.workflow : workflow,
    kind: isObject(doc) && doc.kind === 'statuts' ? 'statuts' : 'etape',
    title: isObject(doc) && typeof doc.title === 'string' && doc.title.trim() ? doc.title : workflow,
    description: isObject(doc) && typeof doc.description === 'string' ? doc.description.trim() : '',
    document: isObject(doc) && typeof doc.document === 'string' ? doc.document : expectedDocument(scope, workflow),
    summary: summaryOf(markdown),
    entry: isObject(doc) && typeof doc.entry === 'string' ? doc.entry : null,
    exit: isObject(doc) && Array.isArray(doc.exit) ? doc.exit.filter((state) => typeof state === 'string') : [],
    nodes,
    edges,
    counts: { nodes: nodes.length, edges: edges.length },
    headings: headings.map((heading) => heading.text),
    orphanSections: [],
    local: scope === 'local',
    file,
    text: source,
    errors,
  }

  if (source === null || parseError) return entry

  const { errors: modelErrors, orphanSections } = validateModel(doc, { headings, states, workflow, scope })
  return { ...entry, orphanSections, errors: [...errors, ...modelErrors] }
}

/**
 * Write one model after validation. Nothing is written when the model has an
 * error: the file on disk and the panel cannot disagree.
 */
export async function saveWorkflow(dir, workflow, doc, { states = [], local } = {}) {
  const base = asUrl(dir)
  if (!isWorkflowKey(workflow)) {
    return { errors: [{ field: 'workflow', code: 'workflow-inconnu', message: `workflow inconnu : ${workflow}` }], model: null }
  }

  const sourceScope = scopeOf(base)
  const targetScope = local === undefined ? sourceScope : (local ? 'local' : 'model')
  const sourceDocument = isObject(doc) && typeof doc.document === 'string'
    ? doc.document
    : expectedDocument(sourceScope, workflow)

  // A move is one gesture: read the source, write the target, then delete the
  // source. Every refusal happens before the first byte is written.
  if (targetScope !== sourceScope) {
    return moveWorkflow(base, workflow, doc, { states, sourceScope, sourceDocument, targetScope })
  }

  const { headings, text } = await readDocument(base, workflow, sourceDocument)
  const model = { ...(isObject(doc) ? doc : {}), workflow }
  const { errors, orphanSections } = validateModel(model, { headings, states, workflow, scope: targetScope })
  if (errors.length) return { errors, orphanSections, model: null }

  const value = fileModel(model)
  const target = modelUrl(base, workflow)
  await mkdir(fileURLToPath(new URL('./', target)), { recursive: true })
  await writeFile(target, YAML.stringify(value, { lineWidth: 0 }), 'utf8')

  // The model is the source of the title: a renamed workflow renames the first
  // heading of its document, and only that line. An absent document stays
  // absent — saving a model never invents one.
  if (text) {
    const retitled = retitleDocument(text, value.title)
    if (retitled !== text) {
      const documentPath = documentTarget(base, sourceDocument) ?? documentUrl(base, workflow)
      await writeFile(fileURLToPath(documentPath), retitled, 'utf8')
    }
  }

  return {
    errors: [],
    orphanSections,
    model: value,
    headings: headings.map((heading) => heading.text),
    local: targetScope === 'local',
  }
}

/**
 * Move one workflow, model and document together, to the other scope. The
 * target's `document` is the directory's convention — the move is also the
 * repair of a hand-written value. An existing target, model or document, is
 * refused before anything is written.
 */
async function moveWorkflow(dir, workflow, doc, { states, sourceScope, sourceDocument, targetScope }) {
  const targetBase = scopedDir(dir, targetScope)
  const targetDocument = expectedDocument(targetScope, workflow)
  const sourceModel = modelUrl(dir, workflow)
  const targetModel = modelUrl(targetBase, workflow)
  const sourceDocumentPath = documentTarget(dir, sourceDocument)
  const targetDocumentPath = documentTarget(targetBase, targetDocument)

  // The source must already obey its directory: a hand-written `document`
  // outside `workflows/local/` (or inside it for a versioned model) is refused
  // rather than moved and deleted out of the wrong folder.
  const sourceInLocal = sourceDocument.startsWith(`${DOCUMENT_PREFIX}local/`)
  if ((sourceScope === 'local') !== sourceInLocal) {
    return {
      errors: [{ field: 'document', code: 'document-hors-dossier', message: `Le document ${sourceDocument} n'appartient pas à ${scopeDirName(sourceScope)}.` }],
      model: null,
    }
  }

  if (await exists(targetModel)) {
    return {
      errors: [{ field: 'key', code: 'cle-double', message: `La clé « ${workflow} » est déjà utilisée dans ${scopeDirName(targetScope)}.` }],
      model: null,
      conflict: true,
    }
  }
  if (targetDocumentPath && await exists(targetDocumentPath)) {
    return {
      errors: [{ field: 'document', code: 'document-double', message: `Le document ${targetDocument} existe déjà.` }],
      model: null,
      conflict: true,
    }
  }

  const { headings, text } = await readDocument(dir, workflow, sourceDocument)
  const model = { ...(isObject(doc) ? doc : {}), workflow, document: targetDocument }
  const { errors, orphanSections } = validateModel(model, { headings, states, workflow, scope: targetScope })
  if (errors.length) return { errors, orphanSections, model: null }

  const value = fileModel(model)
  await mkdir(fileURLToPath(new URL('./', targetModel)), { recursive: true })
  await writeFile(targetModel, YAML.stringify(value, { lineWidth: 0 }), 'utf8')
  if (text && targetDocumentPath) {
    const retitled = retitleDocument(text, value.title)
    await writeFile(targetDocumentPath, retitled, 'utf8')
  }

  await rm(sourceModel, { force: true })
  if (sourceDocumentPath) await rm(sourceDocumentPath, { force: true })

  return {
    errors: [],
    orphanSections,
    model: value,
    headings: headings.map((heading) => heading.text),
    local: targetScope === 'local',
    moved: true,
  }
}

/**
 * Create one workflow, both files at once: the model and the document stub.
 *
 * The panel asks for three things: the title, the description and the kind.
 * The key is the title's slug, the document is `workflows/<clé>.md`, and the
 * entry and the exits start at the canonical `to-refine`/`done` pair — the
 * panel edits them afterwards. A caller that names its own key, document,
 * entry or exits keeps its say: the API stays usable without the panel.
 *
 * An existing file is never overwritten: the creation is refused as soon as
 * one of the two targets is already there.
 */
export async function createWorkflow(dir, draft = {}, { states = [] } = {}) {
  const errors = []
  const fail = (field, code, message) => errors.push({ field, code, message })

  const scope = draft.local === true ? 'local' : 'model'
  const base = scopedDir(dir, scope)
  const otherScope = scope === 'local' ? 'model' : 'local'
  const otherBase = scopedDir(dir, otherScope)

  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  if (!title) fail('title', 'titre-manquant', 'Le titre est obligatoire.')
  else if (/[\r\n]/.test(title)) fail('title', 'titre-invalide', 'Le titre tient sur une ligne.')
  else if (title.length > TITLE_MAX) fail('title', 'titre-invalide', `Le titre fait ${TITLE_MAX} caractères au plus.`)

  const description = typeof draft.description === 'string' ? draft.description.trim() : ''
  if (description) {
    const error = descriptionError(description)
    if (error) fail('description', 'description-invalide', error)
  }

  const kind = draft.kind === undefined ? 'etape' : draft.kind
  if (!KINDS.includes(kind)) fail('kind', 'genre-inconnu', `Le type vaut ${KINDS.join(' ou ')}.`)

  const given = typeof draft.workflow === 'string' && draft.workflow.trim()
    ? draft.workflow.trim()
    : (typeof draft.key === 'string' ? draft.key.trim() : '')
  const workflow = given || slugify(title)
  // Un titre vide n'ajoute pas une seconde erreur à celle qui le dit déjà ;
  // un titre qui ne produit rien, si.
  if (given) {
    if (!isWorkflowKey(workflow)) fail('key', 'cle-invalide', 'Clé invalide : minuscules, chiffres et tirets (ex. mon-workflow).')
  } else if (!workflow) {
    if (title) fail('key', 'cle-invalide', 'Ce titre ne produit aucune clé : ajoute une lettre ou un chiffre.')
  } else if (!isWorkflowKey(workflow)) {
    fail('key', 'cle-invalide', 'Clé invalide : minuscules, chiffres et tirets (ex. mon-workflow).')
  }

  const document = typeof draft.document === 'string' && draft.document.trim()
    ? draft.document.trim()
    : expectedDocument(scope, workflow)
  if (!document.endsWith('.md') || !document.startsWith(DOCUMENT_PREFIX) || document.includes('..') || document.includes('\\')) {
    fail('document', 'document-invalide', 'Le document est un fichier `.md` sous `workflows/`.')
  }

  const stateSet = new Set(states)
  const entry = typeof draft.entry === 'string' && draft.entry.trim() ? draft.entry.trim() : DEFAULT_ENTRY
  if (!stateSet.has(entry)) {
    fail('entry', 'etat-inconnu', `État inconnu : « ${entry} ». États : ${states.join(', ')}.`)
  }

  const exits = draft.exit === undefined || draft.exit === null
    ? [...DEFAULT_EXIT]
    : (Array.isArray(draft.exit) ? draft.exit : String(draft.exit).split(',').map((value) => value.trim()).filter(Boolean))
  if (!exits.length) fail('exit', 'sortie-manquante', 'Au moins une sortie est obligatoire.')
  else {
    const seen = new Set()
    for (const state of exits) {
      if (!stateSet.has(state)) fail('exit', 'etat-inconnu', `Sortie inconnue : « ${state} ». États : ${states.join(', ')}.`)
      else if (seen.has(state)) fail('exit', 'etat-double', `La sortie ${state} est citée deux fois.`)
      else seen.add(state)
    }
    if (seen.has(entry)) fail('exit', 'sortie-confondue', 'Un état ne peut pas être à la fois l\'entrée et la sortie.')
  }

  if (errors.length) return { errors, entry: null }

  // One key, one workflow: the two directories share a namespace, so a key or a
  // document already taken in the other directory refuses the creation too.
  for (const [where, whereScope] of [[base, scope], [otherBase, otherScope]]) {
    if (await exists(modelUrl(where, workflow))) {
      return {
        errors: [{
          field: 'key',
          code: 'cle-double',
          message: whereScope === scope
            ? `La clé « ${workflow} » est déjà utilisée.`
            : `La clé « ${workflow} » est déjà utilisée dans ${scopeDirName(whereScope)}.`,
        }],
        entry: null,
      }
    }
  }
  for (const name of new Set([document, expectedDocument('model', workflow), expectedDocument('local', workflow)])) {
    const target = documentTarget(base, name)
    if (target && await exists(target)) {
      return {
        errors: [{ field: 'document', code: 'document-double', message: `Le document ${name} existe déjà.` }],
        entry: null,
      }
    }
  }

  const known = new Map(STATUS_STATES.map((state) => [state.id, state]))
  const model = {
    workflow,
    kind,
    title,
    ...(description ? { description } : {}),
    document,
    entry,
    exit: [...exits],
    nodes: kind === 'statuts'
      ? states.map((id) => ({
          id,
          label: known.get(id)?.label ?? id,
          description: known.get(id)?.description ?? '',
          tracker: known.get(id)?.tracker ?? '',
        }))
      : [],
    edges: [],
  }
  const { errors: modelErrors } = validateModel(model, { headings: [], states, workflow, scope })
  if (modelErrors.length) return { errors: modelErrors, entry: null }

  const value = fileModel(model)
  const target = modelUrl(base, workflow)
  const documentPath = documentTarget(base, document)
  await mkdir(fileURLToPath(new URL('./', target)), { recursive: true })
  await writeFile(target, YAML.stringify(value, { lineWidth: 0 }), 'utf8')
  if (documentPath) {
    await mkdir(fileURLToPath(new URL('./', documentPath)), { recursive: true })
    await writeFile(documentPath, documentStub(title, kind), 'utf8')
  }

  return { errors: [], entry: await readWorkflow(base, workflow, { states }) }
}

/**
 * The two models directories are twins: `workflows/model/` and
 * `workflows/local/model/`. Give one from the other, whether the caller passes
 * a versioned or a local directory.
 */
function scopedDir(dir, scope) {
  const base = fileURLToPath(asUrl(dir)).replace(/\\/g, '/').replace(/\/+$/, '')
  if (scope === scopeOf(dir)) return pathToFileURL(`${base}/`)
  if (scopeOf(dir) === 'local') return pathToFileURL(`${base.replace(/\/local\/model$/, '/model')}/`)
  return pathToFileURL(`${join(base, '..', 'local', 'model')}/`)
}

/** The relative directory named in a collision message. */
function scopeDirName(scope) {
  return scope === 'local' ? LOCAL_MODEL_DIR : MODEL_DIR
}

/** The document of a workflow, and its headings when it can be read. */
async function readDocument(dir, workflow, document = `workflows/${workflow}.md`) {
  const target = documentTarget(dir, document) ?? documentUrl(dir, workflow)
  try {
    const text = await readFile(fileURLToPath(target), 'utf8')
    return { headings: readHeadings(text).filter((heading) => heading.level >= 2), text, missing: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { headings: [], text: '', missing: true }
    throw error
  }
}

async function exists(url) {
  try {
    await stat(fileURLToPath(url))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function asUrl(dir) {
  if (dir instanceof URL) return dir
  return pathToFileURL(String(dir).endsWith('/') ? String(dir) : `${dir}/`)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function checkKeys(value, allowed, field, fail) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(field ? `${field}.${key}` : key, 'cle-inconnue', `la clé « ${key} » n'est pas reconnue`)
    }
  }
}

function compact(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    if (typeof item === 'string' && item.trim() === '') continue
    out[key] = item
  }
  return out
}
