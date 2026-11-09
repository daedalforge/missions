import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const WORKFLOWS = ['cadrage', 'cloture', 'enchainement', 'execution', 'missions', 'queue', 'review']
export const WRITERS = ['principal', 'orchestrateur', 'implementer', 'reviewer', 'outil']
export const STATUSES = ['draft', 'ready', 'active', 'in_review', 'in_peer_review', 'awaiting_validation', 'done', 'abandoned']
export const MODEL_KEYS = ['workflow', 'title', 'document', 'nodes', 'edges']
export const NODE_KEYS = ['id', 'section', 'writer', 'condition', 'artifact', 'gate', 'status']
export const EDGE_KEYS = ['from', 'to', 'when']
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const MODEL_DIR = join('workflows', 'model')

export function modelPath(root, workflow) {
  return join(root, MODEL_DIR, `${workflow}.json`)
}

export function documentPath(root, workflow) {
  return join(root, 'workflows', `${workflow}.md`)
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

export function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

export function compactText(value, max = 160) {
  const text = normalizeText(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function readHeadings(markdown) {
  const headings = []
  let parent = ''
  for (const match of markdown.matchAll(/^(#{2,3}) (.+)$/gm)) {
    const level = match[1].length
    const text = normalizeText(match[2])
    if (level === 2) parent = text
    const path = level === 2 ? text : `${parent} › ${text}`
    if (level === 2) parent = text
    headings.push({ level, text, path })
  }
  return headings
}

export function validateModel(doc, options = {}) {
  const errors = []
  if (!isPlainObject(doc)) return { errors: ['racine : un objet est attendu'] }
  for (const key of unknownKeys(doc, MODEL_KEYS)) errors.push(`racine : champ inconnu « ${key} »`)
  const workflow = normalizeText(doc.workflow)
  if (!WORKFLOWS.includes(workflow)) {
    errors.push(`workflow : « ${doc.workflow ?? ''} » n'est pas un document de workflows/ (${WORKFLOWS.join(', ')})`)
  } else if (typeof doc.document !== 'string' || doc.document !== `workflows/${workflow}.md`) {
    errors.push(`document : « ${doc.document ?? ''} » ; attendu « workflows/${workflow}.md »`)
  }
  if (typeof doc.title !== 'string' || !doc.title.trim()) errors.push('title : texte non vide attendu')

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : null
  if (!nodes) errors.push('nodes : tableau attendu')
  else if (nodes.length === 0) errors.push('nodes : au moins un geste')
  const ids = new Set()
  const sections = new Map()
  for (const [index, node] of (nodes ?? []).entries()) {
    const at = `nœud ${index + 1}${isPlainObject(node) && normalizeText(node.id) ? ` (${normalizeText(node.id)})` : ''} : `
    if (!isPlainObject(node)) {
      errors.push(`${at}objet attendu`)
      continue
    }
    for (const key of unknownKeys(node, NODE_KEYS)) errors.push(`${at}champ inconnu « ${key} »`)
    const id = normalizeText(node.id)
    if (!id) errors.push(`${at}id attendu`)
    else if (!SLUG.test(id)) errors.push(`${at}id « ${id} » : minuscules, chiffres et tirets`)
    else if (ids.has(id)) errors.push(`${at}id « ${id} » en double`)
    ids.add(id)
    const section = normalizeText(node.section)
    if (!section) errors.push(`${at}section attendue`)
    else if (sections.has(section)) errors.push(`${at}section « ${section} » déjà portée par « ${sections.get(section)} »`)
    else sections.set(section, id)
    if (!WRITERS.includes(normalizeText(node.writer))) {
      errors.push(`${at}writer « ${node.writer ?? ''} » inconnu (${WRITERS.join(', ')})`)
    }
    for (const key of ['condition', 'artifact', 'gate']) {
      if (node[key] !== undefined && (typeof node[key] !== 'string' || !node[key].trim())) {
        errors.push(`${at}${key} : texte non vide attendu`)
      }
    }
    if (node.status !== undefined && !STATUSES.includes(normalizeText(node.status))) {
      errors.push(`${at}status « ${node.status} » inconnu (${STATUSES.join(', ')})`)
    }
  }

  const edges = Array.isArray(doc.edges) ? doc.edges : null
  if (!edges) errors.push('edges : tableau attendu')
  const pairs = new Set()
  for (const [index, edge] of (edges ?? []).entries()) {
    const at = `arc ${index + 1} : `
    if (!isPlainObject(edge)) {
      errors.push(`${at}objet attendu`)
      continue
    }
    for (const key of unknownKeys(edge, EDGE_KEYS)) errors.push(`${at}champ inconnu « ${key} »`)
    const from = normalizeText(edge.from)
    const to = normalizeText(edge.to)
    if (!from) errors.push(`${at}from attendu`)
    else if (!ids.has(from)) errors.push(`${at}from « ${from} » ne nomme aucun geste`)
    if (!to) errors.push(`${at}to attendu`)
    else if (!ids.has(to)) errors.push(`${at}to « ${to} » ne nomme aucun geste`)
    if (from && from === to) errors.push(`${at}un geste ne se suit pas lui-même`)
    const pair = `${from}→${to}`
    if (from && to && from !== to) {
      if (pairs.has(pair)) errors.push(`${at}arc ${pair} en double`)
      pairs.add(pair)
    }
    if (edge.when !== undefined && (typeof edge.when !== 'string' || !edge.when.trim())) {
      errors.push(`${at}when : texte non vide attendu`)
    }
  }

  if (Array.isArray(options.headings)) {
    for (const [index, node] of (nodes ?? []).entries()) {
      if (!isPlainObject(node)) continue
      const section = normalizeText(node.section)
      if (section && !options.headings.some((heading) => heading.path === section)) {
        errors.push(`nœud ${index + 1} (${normalizeText(node.id)}) : section « ${section} » absente du document`)
      }
    }
  }

  return { errors }
}

export function formatModel(doc) {
  const order = (value, keys) => {
    const out = {}
    for (const key of keys) if (value?.[key] !== undefined) out[key] = value[key]
    return out
  }
  const nodes = (doc.nodes ?? []).map((node) => order(node, NODE_KEYS))
  const edges = (doc.edges ?? []).map((edge) => order(edge, EDGE_KEYS))
  return `${JSON.stringify(order({ ...doc, nodes, edges }, MODEL_KEYS), null, 2)}\n`
}

export function parseModel(text) {
  return JSON.parse(text)
}

export function loadModel(root, workflow) {
  return parseModel(readFileSync(modelPath(root, workflow), 'utf8'))
}

export function saveModel(root, doc) {
  const { errors } = validateModel(doc)
  if (errors.length) {
    const error = new Error(errors.join('\n'))
    error.code = 'model-invalid'
    error.errors = errors
    throw error
  }
  writeFileSync(modelPath(root, doc.workflow), formatModel(doc))
  return doc
}

export function resolveWorkspaceRoot(candidates = [process.cwd(), join(homedir(), 'konoha')]) {
  for (const candidate of candidates) {
    const dir = join(candidate, MODEL_DIR)
    if (existsSync(dir) && statSync(dir).isDirectory()) return candidate
  }
  return candidates[0]
}

export function listModels(root) {
  const dir = join(root, MODEL_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'schema.json')
    .map((name) => name.slice(0, -'.json'.length))
    .filter((name) => WORKFLOWS.includes(name))
}

export function readDocument(root, workflow) {
  return readFileSync(documentPath(root, workflow), 'utf8')
}
