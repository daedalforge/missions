import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { checkWorkspace } from './check.js'
import {
  WORKFLOWS,
  formatModel,
  isPlainObject,
  loadModel,
  modelPath,
  readDocument,
  readHeadings,
  resolveWorkspaceRoot,
  saveModel,
  validateModel,
} from './model.js'

export function workspaceRoot(config = {}) {
  const candidates = [config.workspaceRoot, process.cwd(), `${homedir()}/konoha`].filter(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  )
  return resolveWorkspaceRoot(candidates)
}

export function describeModel(root, workflow) {
  const doc = loadModel(root, workflow)
  const headings = readHeadings(readDocument(root, workflow))
  const { errors } = validateModel(doc, { headings })
  return { ...doc, errors }
}

export function listWorkspace(root) {
  const report = checkWorkspace(root)
  const errors = new Map(report.models.map((entry) => [entry.workflow, entry.errors]))
  const orphans = new Map(report.models.map((entry) => [entry.workflow, entry.orphanSections]))
  return {
    workflows: WORKFLOWS.map((workflow) => {
      const doc = describeModel(root, workflow)
      return {
        workflow,
        title: doc.title,
        document: doc.document,
        fingerprint: JSON.stringify(doc),
        models: doc,
        errors: errors.get(workflow) ?? [],
        orphanSections: orphans.get(workflow) ?? [],
        gestures: doc.nodes.length,
        arcs: doc.edges.length,
      }
    }),
    statuses: report.statuses,
    documents: report.documents,
  }
}

export function saveWorkspaceModel(root, workflow, model) {
  if (!WORKFLOWS.includes(workflow)) throw new Error(`workflow inconnu : ${workflow}`)
  if (!isPlainObject(model)) throw new Error('modèle attendu')
  const headings = readHeadings(readDocument(root, workflow))
  const { errors } = validateModel({ ...model, workflow, document: model.document ?? `workflows/${workflow}.md` }, { headings })
  if (errors.length) {
    const error = new Error('modèle refusé')
    error.code = 'model-invalid'
    error.errors = errors
    throw error
  }
  saveModel(root, { ...model, workflow, document: model.document ?? `workflows/${workflow}.md` })
  return formatModel(loadModel(root, workflow))
}

export function createWorkflows({ root, readJson, sendJson, fail }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (pathname.endsWith('/list')) {
      if (req.method !== 'GET') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
      try {
        return sendJson(res, 200, { ok: true, value: listWorkspace(root) })
      } catch (error) {
        return fail(res, 500, 'list-failed', error instanceof Error ? error.message : String(error))
      }
    }

    if (pathname.endsWith('/model')) {
      if (req.method === 'GET') {
        const workflow = url.searchParams.get('workflow') ?? ''
        if (!WORKFLOWS.includes(workflow)) return fail(res, 400, 'invalid-workflow', `workflow inconnu : ${workflow}`)
        const file = modelPath(root, workflow)
        if (!existsSync(file)) return fail(res, 404, 'model-missing', `modèle absent : ${file}`)
        return sendJson(res, 200, { ok: true, value: { workflow, text: readFileSync(file, 'utf8') } })
      }
      if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
      try {
        const body = await readJson(req, 262144)
        const workflow = String(body?.workflow ?? '')
        const text = saveWorkspaceModel(root, workflow, body?.model)
        return sendJson(res, 200, { ok: true, value: { workflow, text } })
      } catch (error) {
        if (error && error.code === 'model-invalid') {
          return sendJson(res, 400, { ok: false, error: { code: error.code, message: error.message, errors: error.errors } })
        }
        return fail(res, 400, 'save-failed', error instanceof Error ? error.message : String(error))
      }
    }

    if (pathname.endsWith('/check')) {
      if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
      try {
        return sendJson(res, 200, { ok: true, value: checkWorkspace(root) })
      } catch (error) {
        return fail(res, 500, 'check-failed', error instanceof Error ? error.message : String(error))
      }
    }

    return fail(res, 404, 'not-found', `route inconnue : ${pathname}`)
  }
}
