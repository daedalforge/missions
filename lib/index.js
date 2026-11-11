import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { attachBranches, loadBranches, saveDeclaration } from './branches.js'
import { CHECKLIST_FILE, readChecklist } from './checklist.js'
import { JOURNAL_FILE, readJournal } from './journal.js'
import { loadProjects } from './projects.js'
import { MODEL_DIR, WRITERS, WORKFLOWS, loadWorkflows, readWorkflow, saveWorkflow } from './workflows.js'
import { findWorkspaceId } from './workspaces.js'
import { listAll, setBlocked } from './trackers/index.js'

/**
 * Host half of the Missions panel.
 *
 * It alone talks to the trackers: it holds the tokens, reads the projects
 * declared in `missions/projects.yml`, and exposes a normalized list to the
 * client, which never sees a secret.
 */
export const name = '@daedalforge/dsh-missions'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const projectsFile = config?.projectsFile ? new URL(config.projectsFile, 'file:///') : undefined
  // Mission folders sit next to `projects.yml`; a custom projects file brings
  // its own declarations along.
  const branchesDir = projectsFile ? new URL('./', projectsFile) : undefined
  // The workflow models live next to `projects.yml`, in the method repository:
  // a custom projects file brings its own models along.
  // `projects.yml` vit dans `missions/` ; les modèles du parcours dans
  // `workflows/model/`, à côté des documents qu'ils décrivent.
  const modelsDir = projectsFile ? new URL('../workflows/model/', projectsFile) : undefined
  // Where a session started from the panel lands: the code workspace, never the
  // method repository.
  const workspaceRoot = String(config?.workspaceRoot || join(homedir(), 'projects'))
  // Tests pass a fake `fetch`: no test writes to a real tracker.
  const fetchImpl = config?.fetchImpl ?? fetch

  const list = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const { projects } = await loadProjects(projectsFile)
      const refresh = url.searchParams.get('refresh') === '1'
      const { missions, errors } = await listAll(projects, { refresh })
      // Branch and base are declared per mission, in the mission folders: the
      // trackers do not carry them, and nothing derives them from the repo.
      const { index, errors: branchErrors } = await loadBranches(branchesDir)
      return send(res, 200, {
        missions: attachBranches(missions, index),
        errors: [...errors, ...branchErrors],
        workspaceRoot,
        workspaceId: await resolveWorkspaceId(ctx, workspaceRoot),
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // Declarations are local to this checkout: `missions/*/` is ignored by git,
  // so this route writes files and never touches git.
  const declare = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let declaration
    try {
      declaration = await readJson(req)
    } catch (error) {
      // A body we refused to read is still in flight: close the connection so
      // the client stops uploading after receiving the 400.
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }
    try {
      return send(res, 200, await saveDeclaration(branchesDir, declaration))
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error instanceof Error ? error.message : 'write failed' })
    }
  }

  // The panel's one write towards a tracker: the blocked label, and the reason
  // as a comment. Nothing is stored locally — clearing the label writes nothing
  // else, and the next read shows the tracker's own answer.
  const blocked = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    const isBlocked = payload?.blocked === true
    const message = String(payload?.message ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    // A block without its reason is a label nobody can explain: refuse it.
    if (isBlocked && !message) return send(res, 400, { error: 'a reason is required to block a mission' })

    try {
      const { projects } = await loadProjects(projectsFile)
      const project = projects.find((entry) => key.startsWith(`${entry.reference}-`))
      if (!project) return send(res, 404, { error: `no project declares ${key}` })
      const result = await setBlocked(project, key, { blocked: isBlocked, message, fetchImpl })
      return send(res, 200, { ...result, project: project.id })
    } catch (error) {
      // The tracker refused: that is upstream, not a bad request from the panel.
      return send(res, 502, { error: error instanceof Error ? error.message : 'tracker write failed' })
    }
  }

  // The journal sits next to `mission.yml`, in the folder the declaration
  // already names. The route reads it; writing it is the session's job.
  const journal = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const key = (url.searchParams.get('key') ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    try {
      const { index } = await loadBranches(branchesDir)
      const folder = index.get(key)?.folder ?? null
      const { exists, source, mtimeMs } = await readJournal(branchesDir, folder)
      return send(res, 200, {
        key,
        folder,
        path: folder ? `${folder}/${JOURNAL_FILE}` : null,
        exists,
        source,
        mtimeMs,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The checklist also sits next to `mission.yml`, in the folder the
  // declaration names. The route reads it; the session ticks it in the file.
  const checklist = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const key = (url.searchParams.get('key') ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    try {
      const { index } = await loadBranches(branchesDir)
      const folder = index.get(key)?.folder ?? null
      const { exists, source, mtimeMs } = await readChecklist(branchesDir, folder)
      return send(res, 200, {
        key,
        folder,
        path: folder ? `${folder}/${CHECKLIST_FILE}` : null,
        exists,
        source,
        mtimeMs,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The parcours itself: the four steps, each one a graph of gestures. The
  // panel reads them, edits them, and writes a model back only if it validates.
  const workflowList = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const { canonical } = await loadProjects(projectsFile)
      const { workflows } = await loadWorkflows(modelsDir, { states: canonical.states })
      return send(res, 200, {
        workflows: workflows.map(({ text, ...entry }) => entry),
        writers: WRITERS,
        states: canonical.states,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // One model: read as text (the source of truth on disk), or written back
  // after a full validation. A refused model is never written: the file and the
  // panel cannot disagree.
  const workflowModel = async (req, res, url) => {
    const method = req.method ?? 'GET'
    if (method === 'GET') {
      const workflow = (url.searchParams.get('workflow') ?? '').trim()
      if (!workflow) return send(res, 400, { error: 'workflow is missing' })
      if (!WORKFLOWS.includes(workflow)) return send(res, 400, { error: `unknown workflow: ${workflow}` })
      try {
        const { canonical } = await loadProjects(projectsFile)
        const entry = await readWorkflow(modelsDir, workflow, { states: canonical.states })
        if (entry.text === null) return send(res, 404, { error: `${entry.file} is missing` })
        return send(res, 200, {
          workflow,
          file: entry.file,
          text: entry.text,
          headings: entry.headings,
          errors: entry.errors,
          orphanSections: entry.orphanSections,
        })
      } catch (error) {
        return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
      }
    }

    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : 'invalid request body' })
    }
    const workflow = String(body.workflow ?? '').trim()
    if (!WORKFLOWS.includes(workflow)) return send(res, 400, { error: `unknown workflow: ${workflow || '(missing)'}` })
    if (!body.model || typeof body.model !== 'object' || Array.isArray(body.model)) {
      return send(res, 400, { error: 'model is missing' })
    }

    try {
      const { canonical } = await loadProjects(projectsFile)
      const saved = await saveWorkflow(modelsDir, workflow, body.model, { states: canonical.states })
      if (saved.errors?.length) {
        return send(res, 400, {
          error: 'model invalid',
          workflow,
          errors: saved.errors,
          orphanSections: saved.orphanSections ?? [],
        })
      }
      return send(res, 200, {
        workflow,
        file: `${MODEL_DIR}/${workflow}.yml`,
        model: saved.model,
        errors: [],
        orphanSections: saved.orphanSections ?? [],
        headings: saved.headings ?? [],
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  const handler = async (req, res) => {
    if (!isLocalRequest(req)) return send(res, 403, { error: 'origin not allowed' })

    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return send(res, 400, { error: 'invalid request' })
    }

    if (url.pathname === '/missions/api/list') return list(req, res, url)
    if (url.pathname === '/missions/api/branches') return declare(req, res)
    if (url.pathname === '/missions/api/blocked') return blocked(req, res)
    if (url.pathname === '/missions/api/journal') return journal(req, res, url)
    if (url.pathname === '/missions/api/checklist') return checklist(req, res, url)
    if (url.pathname === '/missions/api/workflows') return workflowList(req, res)
    if (url.pathname === '/missions/api/workflows/model') return workflowModel(req, res, url)
    return send(res, 404, { error: 'unknown route' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/missions/api', handler }))
}

/**
 * Workspace record for the code root, when the registry is reachable.
 *
 * The registry is a host service: panels cannot see it, so the id is resolved
 * here and handed to the client with the list.
 */
async function resolveWorkspaceId(ctx, root) {
  // Preferred: the host registry, when this plugin is allowed to see it.
  try {
    const registry = ctx.workspaceRegistry
    if (registry && typeof registry.resolveByPath === 'function') {
      const record = await registry.resolveByPath(root)
      if (record?.id) return record.id
    }
  } catch {
    // fall through to the on-disk registry
  }

  // Fallback: the registry file the app keeps on disk, read-only.
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    const store = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    return findWorkspaceId(store, root, homedir())
  } catch {
    return null
  }
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(value))
}

/** Read a small JSON request body; a huge or malformed body is a 400. */
async function readJson(req) {
  const limit = 16 * 1024
  const refuse = () => Object.assign(new Error('request body too large'), { status: 400, tooLarge: true })
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    // Drain instead of destroying: the 400 has to reach the client first.
    req.resume?.()
    throw refuse()
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      req.resume?.()
      throw refuse()
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw Object.assign(new Error('empty request body'), { status: 400 })
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

/** Only local requests are served: the panel runs on the same machine. */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!local) return false
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}
