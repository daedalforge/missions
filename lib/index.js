import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_RUNNING_LIMIT,
  MAX_RUNNING_LIMIT,
  MIN_RUNNING_LIMIT,
  acceptsQueue,
  computePlan,
  normalizeRunningLimit,
  queuedMissions,
  scanMissions,
} from './missions.js'
import { apply as applyPerformance } from './performance/index.js'
import { createWorkflows, workspaceRoot as resolveWorkflowsRoot } from './workflows/server.js'
import { isTrustedRequest } from './trusted.js'

import {
  canonicalSessionId,
  readArchivedSessions,
  scanSessionCandidates,
} from './sessions.js'

export {
  canonicalSessionId,
  decompressZstdFrames,
  missionsInSnippet,
  readArchivedSessions,
  scanSessionCandidates,
  sessionTitle,
  titleMentions,
} from './sessions.js'

export const name = '@daedalforge/dsh-missions'
export const inject = ['webServer']

const API_PATH = '/missions/api'
const SESSION_REF = /missions\/([A-Za-z0-9][A-Za-z0-9._-]{0,39})\//g
const MAX_CANDIDATES = 4
const DIRECT_OPEN_MENTIONS = 15
const CONTENT_CACHE_MS = 5 * 60_000

export const Config = Schema.object({
  missionsRoot: Schema.string()
    .default(join(homedir(), 'konoha', 'missions'))
    .description('Dossier des missions konoha'),
  sessionsRoot: Schema.string()
    .default(join(homedir(), '.dsh', 'sessions'))
    .description('Dossier des sessions DSH'),
  linksFile: Schema.string()
    .default(join(homedir(), '.dsh', 'missions', 'links.json'))
    .description('Fichier des liens mission ↔ session'),
  workspaceStore: Schema.string()
    .default(join(homedir(), '.dsh', 'storages', 'workspace.json'))
    .description('Registre des workspaces DSH'),
  workspaceRoot: Schema.string()
    .description('Dépôt dont les modèles de workflows sont édités'),
  productWorkspaceRoot: Schema.string()
    .default(join(homedir(), 'projects'))
    .description('Racine des dépôts produit, workspace des sessions de mission produit'),
  maxRunningSessions: Schema.number()
    .default(DEFAULT_RUNNING_LIMIT)
    .min(MIN_RUNNING_LIMIT)
    .max(MAX_RUNNING_LIMIT)
    .description('Sessions en cours autorisées à la validation de la file')
    .volatile(),
}).description('Réglages du panneau Missions')

let runtimeConfig = {}

function configValue(key) {
  const value = runtimeConfig?.[key]
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

function runningLimit() {
  return normalizeRunningLimit(configValue('maxRunningSessions'))
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function canonicalDir(value) {
  const resolved = resolve(expandHome(value))
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** Même garde que dsh-mindmap : refuse les appels cross-site. */
function listDirectoryNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function countDirectories(dir) {
  return listDirectoryNames(dir).length
}

export function missionsSignature(root) {
  const parts = []
  const stamp = (label, file) => {
    try {
      const stats = statSync(file)
      parts.push(`${label}:${stats.mtimeMs}:${stats.size}`)
    } catch {
      parts.push(`${label}:-`)
    }
  }
  for (const name of listDirectoryNames(root)) {
    if (name === 'archives') continue
    stamp(`${name}/mission`, join(root, name, 'mission.md'))
    stamp(`${name}/journal`, join(root, name, 'journal.md'))
  }
  parts.push(`archives:${countDirectories(join(root, 'archives'))}`)
  const epicsRoot = join(dirname(root), 'epics')
  for (const name of listDirectoryNames(epicsRoot)) stamp(`epic/${name}`, join(epicsRoot, name, 'epic.md'))
  stamp('queue', join(dirname(root), 'workflows', 'queue.md'))
  return parts.join('|')
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/** Poids d'une candidate : lien explicite > titre > mentions. */
function candidateScore(entry) {
  return (entry.explicit ? 1000 : 0) + (entry.titleMatch ? 400 : 0) + Math.min(entry.mentions ?? 0, 300)
}

/**
 * Fusionne liens explicites et candidates de contenu. Une session ne peut
 * appartenir qu'à une seule mission : un lien explicite la réserve, sinon le
 * titre, sinon le plus grand nombre de mentions. Une session déjà attribuée est
 * ignorée pour les autres missions.
 */
export function mergeMissionSessions(links, content, missions, archived = new Set(), sessions = {}) {
  const byMission = {}
  const claimed = new Set()

  const add = (missionId, entry) => {
    if (!byMission[missionId]) byMission[missionId] = []
    byMission[missionId].push(entry)
  }

  for (const mission of missions) {
    for (const id of links[mission.id] ?? []) {
      const sessionId = canonicalSessionId(id)
      if (!sessionId || archived.has(sessionId) || claimed.has(sessionId)) continue
      claimed.add(sessionId)
      const meta = sessions[sessionId]
      add(mission.id, {
        sessionId,
        title: meta?.title ?? '',
        mentions: 0,
        titleMatch: false,
        explicit: true,
        updatedAt: meta?.updatedAt ?? 0,
        blank: meta?.blank === true,
      })
    }
  }

  const best = new Map()
  for (const mission of missions) {
    for (const entry of content[mission.id] ?? []) {
      const sessionId = canonicalSessionId(entry?.sessionId ?? entry)
      if (!sessionId || archived.has(sessionId) || claimed.has(sessionId)) continue
      const score = candidateScore({ ...entry, explicit: false })
      const current = best.get(sessionId)
      if (!current || score > current.score) best.set(sessionId, { missionId: mission.id, entry, score })
    }
  }

  for (const [sessionId, { missionId, entry }] of best) {
    if (claimed.has(sessionId)) continue
    claimed.add(sessionId)
    add(missionId, { ...entry, sessionId, explicit: false })
  }

  for (const [missionId, rows] of Object.entries(byMission)) {
    byMission[missionId] = rows
      .sort((left, right) => candidateScore(right) - candidateScore(left) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, MAX_CANDIDATES)
  }
  return byMission
}

function readLinks(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessions = parsed?.sessions ?? {}
    const clean = {}
    for (const [missionId, ids] of Object.entries(sessions)) {
      if (Array.isArray(ids)) clean[missionId] = ids.map(canonicalSessionId).filter(Boolean)
    }
    return clean
  } catch {
    return {}
  }
}

function writeLinks(file, links) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ version: 1, sessions: links }, null, 2)}\n`, 'utf8')
}

const PRIORITIES = new Set(['urgent', 'important', 'un_jour'])

/** Réécrit la ligne `priority:` du frontmatter (ajout, remplacement ou retrait). */
export function updateMissionPriority(text, priority) {
  const value = typeof priority === 'string' ? priority.trim() : ''
  if (value !== '' && !PRIORITIES.has(value)) throw new Error(`priorité inconnue : ${value}`)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('frontmatter absent')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('frontmatter non fermé')
  const header = lines.slice(1, end)
  const index = header.findIndex((line) => /^priority\s*:/.test(line))
  if (value === '') {
    if (index !== -1) header.splice(index, 1)
  } else if (index !== -1) {
    header[index] = `priority: ${value}`
  } else {
    const status = header.findIndex((line) => /^status\s*:/.test(line))
    header.splice(status === -1 ? header.length : status + 1, 0, `priority: ${value}`)
  }
  const content = [lines[0], ...header, '---', ...lines.slice(end + 1)].join(newline)
  return { content, changed: content !== text }
}

const STATUSES = new Set(['active', 'in_review', 'in_peer_review', 'awaiting_validation', 'ready', 'draft'])

export function updateMissionStatus(text, status) {
  const value = typeof status === 'string' ? status.trim() : ''
  if (!STATUSES.has(value)) throw new Error(`statut inconnu : ${value}`)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('frontmatter absent')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('frontmatter non fermé')
  const header = lines.slice(1, end)
  const index = header.findIndex((line) => /^status\s*:/.test(line))
  if (index === -1) throw new Error('statut absent du frontmatter')
  const current = header[index].replace(/^status\s*:\s*/, '').trim()
  header[index] = `status: ${value}`
  const updated = [lines[0], ...header, '---', ...lines.slice(end + 1)].join(newline)
  return { content: updated, changed: current !== value }
}

/** Rang de file : entier >= 0, 0 pour sortir de la file. */
export function updateMissionQueue(text, rank) {
  const value = Number.isInteger(rank) ? rank : 0
  if (value < 0) throw new Error(`rang invalide : ${rank}`)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') throw new Error('frontmatter absent')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('frontmatter non fermé')
  const header = lines.slice(1, end)
  const index = header.findIndex((line) => /^queue\s*:/.test(line))
  if (value === 0) {
    if (index !== -1) header.splice(index, 1)
  } else if (index !== -1) {
    header[index] = `queue: ${value}`
  } else {
    const suite = header.findIndex((line) => /^suite\s*:/.test(line))
    if (suite !== -1) {
      header.splice(suite + 1, 0, `queue: ${value}`)
    } else {
      const bruno = header.findIndex((line) => /^bruno\s*:/.test(line))
      header.splice(bruno === -1 ? header.length : bruno, 0, `queue: ${value}`)
    }
  }
  const content = [lines[0], ...header, '---', ...lines.slice(end + 1)].join(newline)
  return { content, changed: content !== text }
}

/**
 * Diff d'un geste de file : valide les identifiants et rend la file visée, les
 * fiches ajoutées et les fiches retirées, sans rien écrire.
 */
export function planQueue(missions, ids) {
  if (!Array.isArray(ids)) throw new Error('ids attendus')
  const seen = new Set()
  const ordered = []
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id) throw new Error('identifiant vide')
    if (seen.has(id)) throw new Error(`identifiant en double : ${id}`)
    seen.add(id)
    const mission = missions.find((entry) => entry.id === id)
    if (!mission) throw new Error(`mission inconnue : ${id}`)
    if (!acceptsQueue(mission.status)) throw new Error(`mission hors de la file : ${id}`)
    ordered.push(mission)
  }
  const current = missions.filter((entry) => entry.queue > 0).sort((left, right) => left.queue - right.queue)
  const currentIds = new Set(queuedMissions(missions).map((entry) => entry.id))
  const added = ordered.filter((mission) => !currentIds.has(mission.id))
  const kept = new Set(ordered.map((mission) => mission.id))
  const removed = current.filter((mission) => !kept.has(mission.id))
  return { ordered, added, removed }
}

/** Date locale AAAA-MM-JJ, la même que celle des journaux. */
export function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Ajoute un bloc daté en fin de journal (le crée s'il manque). */
function appendJournalBlock(root, dir, title, body, date = localDate()) {
  const file = join(root, dir, 'journal.md')
  const block = `## ${date} — ${title}\n\n${body}\n`
  if (!existsSync(file)) {
    writeFileSync(file, `# Journal — ${dir}\n\n${block}`)
    return
  }
  const text = readFileSync(file, 'utf8')
  const separator = text.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(file, `${text}${separator}${block}`)
}

function readMissionPart(root, dir, name) {
  const file = join(root, dir, name)
  if (!existsSync(file)) return { exists: false, source: '', mtimeMs: 0 }
  return { exists: true, source: readFileSync(file, 'utf8').slice(0, 200_000), mtimeMs: statSync(file).mtimeMs }
}

export function readMissionJournal(root, dir) {
  return readMissionPart(root, dir, 'journal.md')
}

export function readMissionChecklist(root, dir) {
  return readMissionPart(root, dir, 'checklist-manuelle.md')
}

function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload trop volumineux'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

export function apply(ctx, config = {}) {
  runtimeConfig = config && typeof config === 'object' ? config : {}
  const configured = typeof config.missionsRoot === 'string' ? config.missionsRoot.trim() : ''
  const root = expandHome(configured || join(homedir(), 'konoha', 'missions'))
  const sessionsRoot = expandHome(
    typeof config.sessionsRoot === 'string' && config.sessionsRoot.trim()
      ? config.sessionsRoot.trim()
      : join(homedir(), '.dsh', 'sessions'),
  )
  const linksFile = expandHome(
    typeof config.linksFile === 'string' && config.linksFile.trim()
      ? config.linksFile.trim()
      : join(homedir(), '.dsh', 'missions', 'links.json'),
  )
  const workspaceStore = expandHome(
    typeof config.workspaceStore === 'string' && config.workspaceStore.trim()
      ? config.workspaceStore.trim()
      : join(homedir(), '.dsh', 'storages', 'workspace.json'),
  )
  const workspacePath = dirname(root)
  const workspacePaths = [...new Set([resolve(workspacePath), canonicalDir(workspacePath)])]
  const workspaceLabel = workspacePath.startsWith(homedir())
    ? `~${workspacePath.slice(homedir().length)}`
    : workspacePath
  const productWorkspaceForm = expandHome(
    typeof config.productWorkspaceRoot === 'string' && config.productWorkspaceRoot.trim()
      ? config.productWorkspaceRoot.trim()
      : join(homedir(), 'projects'),
  )
  const productWorkspacePath = canonicalDir(productWorkspaceForm)
  const productWorkspacePaths = [...new Set([resolve(productWorkspaceForm), productWorkspacePath])]
  const productWorkspaceLabel = productWorkspacePath.startsWith(homedir())
    ? `~${productWorkspacePath.slice(homedir().length)}`
    : productWorkspacePath
  const workflows = createWorkflows({ root: resolveWorkflowsRoot(config), readJson, sendJson, fail })

  let contentCache = { at: 0, value: null }
  let listCache = { signature: '', value: null }
  const journalCache = new Map()

  function invalidateCaches() {
    contentCache = { at: 0, value: null }
    listCache = { signature: '', value: null }
  }

  async function buildSessionIndex(refresh) {
    const now = Date.now()
    if (!refresh && contentCache.value && now - contentCache.at < CONTENT_CACHE_MS) {
      return { ...contentCache.value, cached: true }
    }
    const scan = await scanMissions(root)
    const known = new Set(scan.missions.map((mission) => mission.id))
    const { byMission: content, sessions, scanned } = scanSessionCandidates(sessionsRoot, known, journalCache)
    const archived = readArchivedSessions(workspaceStore)
    const value = {
      at: now,
      scanned,
      workspacePath,
      archived: archived.size,
      byMission: mergeMissionSessions(readLinks(linksFile), content, scan.missions, archived, sessions),
    }
    contentCache = { at: now, value }
    return { ...value, cached: false }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PATH,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname
          if (!isTrustedRequest(req)) return fail(res, 403, 'forbidden', 'Requête refusée')
          if (pathname.startsWith(`${API_PATH}/workflows/`)) return workflows(req, res)

          if (pathname.endsWith('/sessions')) {
            if (req.method !== 'GET') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const value = await buildSessionIndex(url.searchParams.get('refresh') === '1')
              return sendJson(res, 200, { ok: true, value })
            } catch (error) {
              return fail(res, 500, 'sessions-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (pathname.endsWith('/priority')) {
            if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const body = await readJson(req)
              const missionId = typeof body?.missionId === 'string' ? body.missionId.trim() : ''
              const priority = typeof body?.priority === 'string' ? body.priority.trim() : ''
              if (!missionId) return fail(res, 400, 'invalid-body', 'missionId requis')
              const scan = await scanMissions(root)
              const mission = scan.missions.find((entry) => entry.id === missionId)
              if (!mission) return fail(res, 404, 'mission-not-found', `mission inconnue : ${missionId}`)
              const file = join(root, mission.dir, 'mission.md')
              const text = readFileSync(file, 'utf8')
              const { content, changed } = updateMissionPriority(text, priority)
              if (changed) writeFileSync(file, content)
              invalidateCaches()
              return sendJson(res, 200, { ok: true, value: { missionId, priority, changed } })
            } catch (error) {
              return fail(res, 400, 'priority-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (pathname.endsWith('/status')) {
            if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const body = await readJson(req)
              const missionId = typeof body?.missionId === 'string' ? body.missionId.trim() : ''
              const status = typeof body?.status === 'string' ? body.status.trim() : ''
              if (!missionId) return fail(res, 400, 'invalid-body', 'missionId requis')
              const scan = await scanMissions(root)
              const mission = scan.missions.find((entry) => entry.id === missionId)
              if (!mission) return fail(res, 404, 'mission-not-found', `mission inconnue : ${missionId}`)
              const file = join(root, mission.dir, 'mission.md')
              const text = readFileSync(file, 'utf8')
              const { content, changed } = updateMissionStatus(text, status)
              if (changed) writeFileSync(file, content)
              invalidateCaches()
              return sendJson(res, 200, { ok: true, value: { missionId, status, changed } })
            } catch (error) {
              return fail(res, 400, 'status-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (pathname.endsWith('/plan')) {
            if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const body = await readJson(req)
              const ids = Array.isArray(body?.ids) ? body.ids : []
              if (!ids.length) return fail(res, 400, 'plan-failed', 'ids attendus')
              const scan = await scanMissions(root)
              const plan = computePlan(scan.missions)
              const wanted = []
              for (const raw of ids) {
                const id = typeof raw === 'string' ? raw.trim() : ''
                const mission = scan.missions.find((entry) => entry.id === id)
                if (!mission) return fail(res, 400, 'plan-failed', `mission inconnue : ${id}`)
                if (!plan.executable.includes(id)) return fail(res, 400, 'plan-failed', `mission hors de la vague 1 : ${id}`)
                wanted.push(mission)
              }
              const date = localDate()
              const wave = wanted.map((mission) => `${mission.id} (${mission.repo})`).join(', ')
              for (const mission of wanted) {
                const file = join(root, mission.dir, 'mission.md')
                const opened = updateMissionStatus(readFileSync(file, 'utf8'), 'active')
                const { content } = updateMissionQueue(opened.content, 0)
                writeFileSync(file, content)
                appendJournalBlock(
                  root,
                  mission.dir,
                  'Plan validé',
                  `Vague 1 du plan validée le ${date} · missions de la vague : ${wave} · l'ouverture vaut go d'exécution (\`workflows/queue.md\`).`,
                  date,
                )
              }
              invalidateCaches()
              return sendJson(res, 200, { ok: true, value: { opened: wanted.map((mission) => mission.id), plan } })
            } catch (error) {
              return fail(res, 400, 'plan-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (pathname.endsWith('/queue')) {
            if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const body = await readJson(req)
              const scan = await scanMissions(root)
              const plan = planQueue(scan.missions, body?.ids)
              plan.ordered.forEach((mission, index) => {
                const rank = index + 1
                if (mission.queue === rank) return
                const file = join(root, mission.dir, 'mission.md')
                const { content } = updateMissionQueue(readFileSync(file, 'utf8'), rank)
                writeFileSync(file, content)
              })
              for (const mission of plan.removed) {
                const file = join(root, mission.dir, 'mission.md')
                const { content } = updateMissionQueue(readFileSync(file, 'utf8'), 0)
                writeFileSync(file, content)
              }
              invalidateCaches()
              return sendJson(res, 200, {
                ok: true,
                value: {
                  ids: plan.ordered.map((entry) => entry.id),
                  added: plan.added.map((entry) => entry.id),
                  removed: plan.removed.map((entry) => entry.id),
                },
              })
            } catch (error) {
              return fail(res, 400, 'queue-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (pathname.endsWith('/link')) {
            if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const body = await readJson(req)
              const missionId = typeof body?.missionId === 'string' ? body.missionId.trim() : ''
              const sessionId = canonicalSessionId(body?.sessionId)
              if (!missionId || !sessionId) return fail(res, 400, 'invalid-body', 'missionId et sessionId requis')
              const links = readLinks(linksFile)
              const ids = new Set(links[missionId] ?? [])
              ids.add(sessionId)
              links[missionId] = [...ids]
              writeLinks(linksFile, links)
              invalidateCaches()
              return sendJson(res, 200, { ok: true, value: { missionId, sessionId } })
            } catch (error) {
              return fail(res, 400, 'link-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (pathname.endsWith('/mission')) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
            try {
              const missionId = (url.searchParams.get('id') ?? '').trim()
              const part = (url.searchParams.get('part') ?? '').trim()
              if (!missionId) return fail(res, 400, 'invalid-query', 'id requis')
              if (part && part !== 'journal' && part !== 'checklist') return fail(res, 400, 'invalid-query', `part inconnu : ${part}`)
              const scan = await scanMissions(root)
              const mission = scan.missions.find((entry) => entry.id === missionId)
              if (!mission) return fail(res, 404, 'mission-not-found', `mission inconnue : ${missionId}`)
              const journal = readMissionJournal(root, mission.dir)
              const checklist = readMissionChecklist(root, mission.dir)
              if (part === 'journal') return sendJson(res, 200, { ok: true, value: { id: mission.id, journal } })
              if (part === 'checklist') return sendJson(res, 200, { ok: true, value: { id: mission.id, checklist } })
              const source = readFileSync(mission.file, 'utf8')
              return sendJson(res, 200, {
                ok: true,
                value: { id: mission.id, title: mission.title, file: mission.file, source: source.slice(0, 200_000), journal, checklist },
              })
            } catch (error) {
              return fail(res, 500, 'mission-failed', error instanceof Error ? error.message : String(error))
            }
          }

          if (req.method !== 'GET' && req.method !== 'HEAD') {
            return fail(res, 405, 'method-not-allowed', 'Méthode non autorisée')
          }
          try {
            const signature = missionsSignature(root)
            const cached =
              url.searchParams.get('refresh') !== '1' && listCache.value && listCache.signature === signature
                ? listCache.value
                : null
            let value = cached
            if (!value) {
              value = await scanMissions(root)
              value.displayRoot = root.startsWith(homedir()) ? `~${root.slice(homedir().length)}` : root
              value.sessions = {
                workspacePath,
                workspacePaths,
                workspaceLabel,
                productWorkspacePath,
                productWorkspacePaths,
                productWorkspaceLabel,
              }
              value.plan = computePlan(value.missions)
              value.limits = { maxRunningSessions: runningLimit() }
            }
            if (!cached) listCache = { signature, value }
            return sendJson(res, 200, { ok: true, value })
          } catch (error) {
            return fail(res, 500, 'scan-failed', error instanceof Error ? error.message : String(error))
          }
        },
      }),
    'dsh-missions : routes GET /missions/api/list, GET /missions/api/sessions, GET /missions/api/mission, POST /missions/api/link, POST /missions/api/priority, POST /missions/api/status, POST /missions/api/queue, POST /missions/api/plan, GET /missions/api/workflows/list, GET|POST /missions/api/workflows/model, POST /missions/api/workflows/check',
  )

  applyPerformance(ctx, config.performance ?? {})
}
