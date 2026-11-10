import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { attachBranches, loadBranches } from './branches.js'
import { loadProjects } from './projects.js'
import { findWorkspaceId } from './workspaces.js'
import { listAll } from './trackers/index.js'

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
  // Where a session started from the panel lands: the code workspace, never the
  // method repository.
  const workspaceRoot = String(config?.workspaceRoot || join(homedir(), 'projects'))

  const handler = async (req, res) => {
    if (!isLocalRequest(req)) return send(res, 403, { error: 'origin not allowed' })

    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return send(res, 400, { error: 'invalid request' })
    }

    if (url.pathname !== '/missions/api/list') {
      return send(res, 404, { error: 'unknown route' })
    }
    if ((req.method ?? 'GET') !== 'GET') {
      return send(res, 405, { error: 'method not allowed' })
    }

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

function send(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
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
