import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import YAML from 'yaml'

/**
 * The four steps of the workspace parcours, each one a small graph of gestures.
 *
 * A model is the editable view of `workflows/<step>.md`: gestures (nodes) and
 * transitions (edges) between canonical states. The document stays the
 * reference — a gesture cites the heading it comes from, and the concordance
 * between the two is reported, never repaired here.
 */
export const WORKFLOWS = ['cadrage', 'execution', 'review', 'cloture']

/** Who performs a gesture. */
export const WRITERS = ['demandeur', 'session', 'outil']

/** Where the models live, relative to the repository root. */
export const MODEL_DIR = 'workflows/model'

/** Default models directory: the repository this package lives in. */
export const MODELS_DIR = new URL('../workflows/model/', import.meta.url)

export const MODEL_FILE_SUFFIX = '.yml'

const MODEL_KEYS = ['workflow', 'title', 'document', 'entry', 'exit', 'nodes', 'edges']
const NODE_KEYS = ['id', 'label', 'section', 'writer', 'condition', 'artifact', 'gate']
const EDGE_KEYS = ['from', 'to', 'when']
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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

/** A file named after its step, in the models directory. */
export function modelUrl(dir, workflow) {
  return new URL(`./${workflow}${MODEL_FILE_SUFFIX}`, asUrl(dir))
}

/** The document a step is described by, one directory above the models. */
export function documentUrl(dir, workflow) {
  return new URL(`../${workflow}.md`, asUrl(dir))
}

/**
 * Validate one model against the vocabulary of the workspace and the headings
 * of its document. Errors are returned, never thrown: the panel shows them.
 */
export function validateModel(doc, { headings = [], states = [], workflow = null } = {}) {
  const errors = []
  const fail = (field, code, message) => errors.push({ field, code, message })
  const orphanSections = []

  if (!isObject(doc)) {
    fail('', 'modele-invalide', 'un modèle est un objet YAML')
    return { errors, orphanSections }
  }

  checkKeys(doc, MODEL_KEYS, '', fail)

  if (!states.length) {
    fail('entry', 'etats-inconnus', 'aucun vocabulaire d\'états fourni : le modèle ne peut pas être validé')
  }

  if (workflow !== null && String(doc.workflow ?? '').trim() !== workflow) {
    fail('workflow', 'etape-inconnue', `le fichier doit déclarer \`workflow: ${workflow}\``)
  }
  if (!nonEmpty(doc.title)) fail('title', 'titre-manquant', '`title` est requis')

  const document = typeof doc.document === 'string' ? doc.document.trim() : ''
  if (!document) fail('document', 'document-manquant', '`document` est requis')
  else if (!document.endsWith('.md')) fail('document', 'document-invalide', '`document` désigne un fichier `.md`')

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
  if (!Array.isArray(doc.nodes)) fail('nodes', 'gestes-manquants', '`nodes` liste les gestes')
  else if (nodes.length === 0) fail('nodes', 'geste-manquant', 'un modèle porte au moins un geste')

  const headingTexts = new Map(headings.map((heading) => [normalize(heading.text), heading]))
  const cited = new Set()
  const nodeIds = new Set()
  const nodeFields = new Map()

  nodes.forEach((node, index) => {
    const field = `nodes[${index}]`
    if (!isObject(node)) {
      fail(field, 'geste-invalide', 'un geste est un objet')
      return
    }
    checkKeys(node, NODE_KEYS, field, fail)

    const id = typeof node.id === 'string' ? node.id.trim() : ''
    if (!SLUG.test(id)) fail(`${field}.id`, 'id-invalide', `\`id\` est un slug (a-z, 0-9, tirets) : ${JSON.stringify(node.id ?? null)}`)
    else if (stateSet.has(id)) fail(`${field}.id`, 'id-conflictuel', `un geste ne peut pas s'appeler comme l'état ${id}`)
    else if (nodeIds.has(id)) fail(`${field}.id`, 'id-double', `deux gestes portent l'id ${id}`)
    else {
      nodeIds.add(id)
      nodeFields.set(id, field)
    }

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

    for (const key of ['condition', 'artifact', 'gate']) {
      if (node[key] !== undefined && node[key] !== null && typeof node[key] !== 'string') {
        fail(`${field}.${key}`, 'champ-invalide', `\`${key}\` est du texte`)
      }
    }
  })

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
    if (!from) fail(`${field}.from`, 'arc-manquant', '`from` désigne un geste ou un état')
    if (!to) fail(`${field}.to`, 'arc-manquant', '`to` désigne un geste ou un état')
    if (from && to && from === to) fail(field, 'arc-boucle', 'un arc ne revient pas sur lui-même')
    if (from && !resolvable(from)) fail(`${field}.from`, 'arc-orphelin', `\`from\` ne désigne aucun geste ni état : ${from}`)
    if (to && !resolvable(to)) fail(`${field}.to`, 'arc-orphelin', `\`to\` ne désigne aucun geste ni état : ${to}`)
    if (edge.when !== undefined && edge.when !== null && typeof edge.when !== 'string') {
      fail(`${field}.when`, 'champ-invalide', '`when` est du texte')
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
  // an exit nobody reaches can never be entered.
  if (typeof doc.entry === 'string' && stateSet.has(doc.entry)) {
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
      if (!seen.has(id)) fail(nodeFields.get(id), 'geste-injoignable', `aucun arc ne mène à ${id} depuis ${doc.entry}`)
    }
    if (exits) {
      for (const state of exits) {
        if (typeof state === 'string' && stateSet.has(state) && !seen.has(state)) {
          fail('exit', 'sortie-injoignable', `aucun arc ne mène à ${state} depuis ${doc.entry}`)
        }
      }
    }
  }

  for (const heading of headings) {
    if (heading.level < 2) continue
    if (!cited.has(normalize(heading.text))) orphanSections.push(heading.text)
  }

  return { errors, orphanSections }
}

/** Canonical key order, so an edit of one field does not rewrite the file. */
export function fileModel(model) {
  const value = {
    workflow: model.workflow,
    title: model.title,
    document: model.document,
    entry: model.entry,
    exit: Array.isArray(model.exit) ? [...model.exit] : [],
    nodes: (Array.isArray(model.nodes) ? model.nodes : []).map((node) => compact({
      id: node.id,
      label: node.label,
      section: node.section,
      writer: node.writer,
      condition: node.condition,
      artifact: node.artifact,
      gate: node.gate,
    })),
    edges: (Array.isArray(model.edges) ? model.edges : []).map((edge) => compact({
      from: edge.from,
      to: edge.to,
      when: edge.when,
    })),
  }
  return value
}

/** Load the four models; a broken file becomes an entry with its errors. */
export async function loadWorkflows(dir = MODELS_DIR, { states = [] } = {}) {
  const base = asUrl(dir)
  const workflows = []
  for (const workflow of WORKFLOWS) {
    workflows.push(await readWorkflow(base, workflow, { states }))
  }
  return { workflows }
}

/** One model and its concordance with its document. */
export async function readWorkflow(dir = MODELS_DIR, workflow, { states = [] } = {}) {
  const base = asUrl(dir)
  const errors = []
  const file = `${MODEL_DIR}/${workflow}${MODEL_FILE_SUFFIX}`
  const { headings, text: markdown, missing } = await readDocument(base, workflow)
  if (missing) {
    errors.push({ field: 'document', code: 'document-absent', message: `le document workflows/${workflow}.md est absent` })
  }

  let source = null
  try {
    source = await readFile(fileURLToPath(modelUrl(base, workflow)), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  if (source === null) {
    return {
      workflow,
      title: workflow,
      document: `workflows/${workflow}.md`,
      entry: null,
      exit: [],
      nodes: [],
      edges: [],
      headings: headings.map((heading) => heading.text),
      orphanSections: [],
      file,
      text: null,
      errors: [...errors, { field: 'fichier', code: 'fichier-absent', message: `${file} est absent` }],
    }
  }

  let doc
  try {
    doc = YAML.parse(source)
  } catch (error) {
    return {
      workflow,
      title: workflow,
      document: `workflows/${workflow}.md`,
      entry: null,
      exit: [],
      nodes: [],
      edges: [],
      headings: headings.map((heading) => heading.text),
      orphanSections: [],
      file,
      text: source,
      errors: [...errors, { field: 'fichier', code: 'yaml-invalide', message: error?.message ?? 'YAML invalide' }],
    }
  }

  const { errors: modelErrors, orphanSections } = validateModel(doc, { headings, states, workflow })
  return {
    workflow: isObject(doc) && typeof doc.workflow === 'string' ? doc.workflow : workflow,
    title: isObject(doc) && typeof doc.title === 'string' && doc.title.trim() ? doc.title : workflow,
    document: isObject(doc) && typeof doc.document === 'string' ? doc.document : `workflows/${workflow}.md`,
    entry: isObject(doc) && typeof doc.entry === 'string' ? doc.entry : null,
    exit: isObject(doc) && Array.isArray(doc.exit) ? doc.exit.filter((state) => typeof state === 'string') : [],
    nodes: isObject(doc) && Array.isArray(doc.nodes) ? doc.nodes.filter(isObject) : [],
    edges: isObject(doc) && Array.isArray(doc.edges) ? doc.edges.filter(isObject) : [],
    headings: headings.map((heading) => heading.text),
    orphanSections,
    file,
    text: source,
    errors: [...errors, ...modelErrors],
  }
}

/**
 * Write one model after validation. Nothing is written when the model has an
 * error: the file on disk and the panel cannot disagree.
 */
export async function saveWorkflow(dir, workflow, doc, { states = [] } = {}) {
  const base = asUrl(dir)
  if (!WORKFLOWS.includes(workflow)) {
    return { errors: [{ field: 'workflow', code: 'etape-inconnue', message: `étape inconnue : ${workflow}` }], model: null }
  }
  const { headings } = await readDocument(base, workflow)
  const model = { ...(isObject(doc) ? doc : {}), workflow }
  const { errors, orphanSections } = validateModel(model, { headings, states, workflow })
  if (errors.length) return { errors, orphanSections, model: null }

  const value = fileModel(model)
  const target = modelUrl(base, workflow)
  await mkdir(fileURLToPath(new URL('./', target)), { recursive: true })
  await writeFile(target, YAML.stringify(value, { lineWidth: 0 }), 'utf8')
  return { errors: [], orphanSections, model: value, headings: headings.map((heading) => heading.text) }
}

/** The document of a step, and its headings when it can be read. */
async function readDocument(dir, workflow) {
  try {
    const text = await readFile(fileURLToPath(documentUrl(dir, workflow)), 'utf8')
    return { headings: readHeadings(text).filter((heading) => heading.level >= 2), text, missing: false }
  } catch (error) {
    if (error?.code === 'ENOENT') return { headings: [], text: '', missing: true }
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
