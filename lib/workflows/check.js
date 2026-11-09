import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { WORKFLOWS, loadModel, modelPath, readDocument, readHeadings, validateModel } from './model.js'

export const TYPES_DOCUMENT = join('standards', 'types.md')

const WORKFLOW_TYPES = {
  cadrage: ['produit', 'conteneur', 'poc', 'review de ticket'],
  cloture: ['produit', 'conteneur', 'poc', 'review de ticket'],
  enchainement: ['produit', 'conteneur'],
  execution: ['produit', 'conteneur', 'poc'],
  missions: ['produit', 'conteneur', 'poc', 'review de ticket'],
  queue: ['produit', 'conteneur'],
  review: ['produit', 'review de ticket'],
}

const ARROW = /`?([a-z][a-z_]*)`?\s*(?:→|->)\s*`?([a-z][a-z_]*)`?/g

function statusesOf(markdown) {
  return new Set([...markdown.matchAll(/\b(draft|ready|active|awaiting_validation|in_review|in_peer_review|done|abandoned)\b/g)].map((match) => match[1]))
}

const STATUS_WORD = /\b(draft|ready|active|awaiting_validation|in_review|in_peer_review|done|abandoned)\b/g

function tokens(part) {
  return [...part.replace(/`/g, '').matchAll(STATUS_WORD)].map((match) => match[1])
}

export function parseTransitions(typesMarkdown) {
  const transitions = new Map()
  const add = (key, types) => {
    if (!transitions.has(key)) transitions.set(key, new Set())
    for (const type of types) transitions.get(key).add(type)
  }
  for (const match of typesMarkdown.matchAll(/^\|\s*([a-z ,]+?)\s*\|(.+)\|\s*$/gm)) {
    const types = match[1].split(',').map((name) => name.trim()).filter(Boolean)
    if (!types.length || types[0] === 'Type') continue
    for (const clause of match[2].replace(/`/g, '').split(';')) {
      const parts = clause.split(/→|->/).map((part) => part.trim())
      for (let index = 0; index < parts.length - 1; index += 1) {
        for (const source of tokens(parts[index])) {
          for (const target of tokens(parts[index + 1])) add(`${source}→${target}`, types)
        }
      }
    }
  }
  return transitions
}

export function checkTransitions(root) {
  const file = join(root, TYPES_DOCUMENT)
  if (!existsSync(file)) return [{ source: TYPES_DOCUMENT, errors: ['standard absent'] }]
  const typesMarkdown = readFileSync(file, 'utf8')
  const transitions = parseTransitions(typesMarkdown)
  const statuses = statusesOf(typesMarkdown)
  const results = []
  for (const workflow of WORKFLOWS) {
    const document = join(root, 'workflows', `${workflow}.md`)
    if (!existsSync(document)) continue
    const text = readFileSync(document, 'utf8')
    const errors = []
    for (const arrow of text.matchAll(ARROW)) {
      const from = arrow[1]
      const to = arrow[2]
      if (!statuses.has(from) || !statuses.has(to)) continue
      const key = `${from}→${to}`
      const allowed = transitions.get(key)
      const types = WORKFLOW_TYPES[workflow] ?? []
      if (!allowed) {
        errors.push(`transition \`${key}\` absente de ${TYPES_DOCUMENT}`)
        continue
      }
      if (types.length && !types.some((type) => allowed.has(type))) {
        errors.push(`transition \`${key}\` interdite pour ${types.join(', ')}`)
      }
    }
    results.push({ source: `workflows/${workflow}.md`, errors: [...new Set(errors)] })
  }
  return results
}

export function checkModel(root, workflow) {
  const errors = []
  const doc = loadModel(root, workflow)
  const headings = readHeadings(readDocument(root, workflow))
  for (const error of validateModel(doc, { headings }).errors) errors.push(error)

  const incoming = new Set(doc.edges.map((edge) => edge.to))
  const outgoing = new Set(doc.edges.map((edge) => edge.from))
  if (doc.edges.length > 0) {
    for (const node of doc.nodes) {
      if (!incoming.has(node.id) && !outgoing.has(node.id)) {
        errors.push(`nœud ${node.id} : ni entrant ni sortant, il ne prend part à aucun enchaînement`)
      }
    }
  }

  const cited = new Set(doc.nodes.map((node) => node.section))
  const sections = headings.filter((heading) => heading.level >= 2).map((heading) => heading.path)
  const orphanSections = sections.filter((section) => !cited.has(section))
  return { workflow, errors, orphanSections }
}

export function checkWorkspace(root) {
  const models = []
  for (const workflow of WORKFLOWS) {
    if (!existsSync(modelPath(root, workflow))) {
      models.push({ workflow, errors: ['modèle absent'], orphanSections: [] })
      continue
    }
    try {
      models.push(checkModel(root, workflow))
    } catch (error) {
      models.push({ workflow, errors: [error instanceof Error ? error.message : String(error)], orphanSections: [] })
    }
  }
  const documentChecks = checkTransitions(root)
  const statuses = statusesOf(readFileSync(join(root, TYPES_DOCUMENT), 'utf8'))
  const unknown = []
  for (const entry of models) {
    if (entry.errors.length || !existsSync(modelPath(root, entry.workflow))) continue
    for (const node of loadModel(root, entry.workflow).nodes) {
      if (node.status && !statuses.has(node.status)) {
        unknown.push(`${entry.workflow} : nœud ${node.id}, statut « ${node.status} » absent de ${TYPES_DOCUMENT}`)
      }
    }
  }
  return {
    models,
    documents: documentChecks,
    statuses: { known: [...statuses].sort(), unknown },
  }
}
