import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/
const ABANDONED = new Set(['done', 'archived', 'abandoned'])
const PRIORITIES = ['urgent', 'important', 'un_jour']
const PRIORITY_ALIASES = {
  urgent: 'urgent',
  p0: 'urgent',
  important: 'important',
  p1: 'important',
  un_jour: 'un_jour',
  unjour: 'un_jour',
  normal: '',
  none: '',
  a_faire_un_jour: 'un_jour',
  someday: 'un_jour',
  later: 'un_jour',
  p2: 'un_jour',
}

/** Lit le bloc `--- ... ---` en tête d'un fichier mission.md / epic.md. */
export function parseFrontmatter(source) {
  const fields = {}
  const match = FRONTMATTER_PATTERN.exec(source)
  if (!match) return fields
  for (const line of match[1].split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!KEY_PATTERN.test(key)) continue
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    fields[key] = value
  }
  return fields
}

/** Titre = premier `# ...` du document. */
export function parseTitle(source) {
  const match = /^#\s+(.+)$/m.exec(source)
  return match ? match[1].trim() : ''
}

/** Texte comparable : bas de casse, accents retirés. */
export function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

/** Texte cherchable d'une fiche : identifiant, titre, valeurs du frontmatter et corps. */
export function buildSearchText({ id, title, fields, source }) {
  const values = [id, title]
  for (const value of Object.values(fields ?? {})) if (value) values.push(value)
  const text = String(source ?? '')
  const match = FRONTMATTER_PATTERN.exec(text)
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const item = /^\s*-\s+(.+)$/.exec(line)
      if (item) values.push(item[1].trim())
    }
  }
  values.push(match ? text.slice(match[0].length) : text)
  return normalizeSearchText(values.join('\n')).trim()
}

export function normalizeStatus(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/** `Urgent`, `un jour`, `someday`… -> `urgent|important|un_jour`, sinon `''`. */
export function normalizePriority(value) {
  const raw = String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (!raw) return ''
  return PRIORITY_ALIASES[raw] ?? ''
}

/** 0 pour urgent, 1 important, 2 un jour, 3 si non défini. */
export function priorityRank(value) {
  const index = PRIORITIES.indexOf(value)
  return index === -1 ? PRIORITIES.length : index
}

export function isAbandoned(status) {
  return ABANDONED.has(status)
}

/** Rang de file : entier positif, 0 hors file. */
export function normalizeQueue(value) {
  const number = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(number) && number > 0 ? number : 0
}

function naturalKey(value) {
  return String(value).replace(/\d+/g, (digits) => digits.padStart(6, '0'))
}

export function compareIds(left, right) {
  return naturalKey(left).localeCompare(naturalKey(right))
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function listDirectories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort(compareIds)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

export async function scanEpics(epicsRoot) {
  const epics = []
  for (const name of await listDirectories(epicsRoot)) {
    const source = await readOptional(join(epicsRoot, name, 'epic.md'))
    if (source === null) continue
    const fields = parseFrontmatter(source)
    epics.push({
      key: (fields.key || name).trim(),
      title: parseTitle(source),
      status: normalizeStatus(fields.status),
      jira: (fields.jira || '').trim(),
    })
  }
  epics.sort((left, right) => compareIds(left.key, right.key))
  return epics
}

/**
 * Scanne `missions/` (hors `missions/archives/`) et renvoie les missions non
 * terminées, les epics connues et le nombre de missions archivées.
 */
export async function scanMissions(root) {
  const missions = []
  let archived = 0

  for (const name of await listDirectories(root)) {
    if (name === 'archives') continue
    const source = await readOptional(join(root, name, 'mission.md'))
    if (source === null) continue
    const fields = parseFrontmatter(source)
    const status = normalizeStatus(fields.status) || 'draft'
    if (isAbandoned(status)) continue
    const id = (fields.id || name).trim()
    const title = (fields.title || parseTitle(source)).trim()
    missions.push({
      id,
      title,
      status,
      epic: (fields.epic || '').trim(),
      repo: (fields.repo || '').trim(),
      type: (fields.type || '').trim(),
      priority: normalizePriority(fields.priority),
      queue: normalizeQueue(fields.queue),
      suite: (fields.suite || '').trim(),
      dir: name,
      file: join(root, name, 'mission.md'),
      search: buildSearchText({ id, title, fields, source }),
    })
  }

  missions.sort((left, right) => compareIds(left.id, right.id))
  archived = (await listDirectories(join(root, 'archives'))).length

  return {
    root,
    generatedAt: new Date().toISOString(),
    archived,
    epics: await scanEpics(join(dirname(root), 'epics')),
    missions,
  }
}

const FILE_STATUSES = new Set(['ready'])
const REVIEWED = new Set(['awaiting_validation', 'in_review', 'in_peer_review'])

export const DEFAULT_RUNNING_LIMIT = 5
export const MIN_RUNNING_LIMIT = 1
export const MAX_RUNNING_LIMIT = 50

export function normalizeRunningLimit(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_RUNNING_LIMIT
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_RUNNING_LIMIT
  }
  return Math.min(MAX_RUNNING_LIMIT, Math.max(MIN_RUNNING_LIMIT, Math.trunc(parsed)))
}

export function acceptsQueue(status) {
  return FILE_STATUSES.has(status)
}

export function inFile(mission) {
  return mission.queue > 0 && acceptsQueue(mission.status)
}

export function queuedMissions(missions) {
  return missions.filter(inFile).sort((left, right) => left.queue - right.queue)
}

/**
 * Ordonnance la file : bloqueur de chaîne, vagues et missions exécutables.
 * Projection pure : aucun statut n'est changé.
 */
export function computePlan(missions) {
  const open = missions.filter((mission) => !isAbandoned(mission.status))
  const byId = new Map(open.map((mission) => [mission.id, mission]))
  const queued = queuedMissions(open)
  const running = open.filter((mission) => mission.status === 'active')
  const blockedBy = new Map()

  const addBlocker = (mission, blocker, cause) => {
    if (!blocker || blocker.id === mission.id) return
    const list = blockedBy.get(mission.id) ?? []
    if (!list.some((entry) => entry.id === blocker.id)) list.push({ id: blocker.id, cause })
    blockedBy.set(mission.id, list)
  }

  for (const mission of queued) {
    const suite = mission.suite ? byId.get(mission.suite) : null
    if (suite && !REVIEWED.has(suite.status)) addBlocker(mission, suite, 'suite')
  }

  const waveCache = new Map()
  const waveOf = (mission, seen) => {
    if (waveCache.has(mission.id)) return waveCache.get(mission.id)
    if (seen.has(mission.id)) return 1
    seen.add(mission.id)
    let wave = 1
    for (const entry of blockedBy.get(mission.id) ?? []) {
      const blocker = byId.get(entry.id)
      if (!blocker) continue
      if (blocker.queue > 0) wave = Math.max(wave, 1 + waveOf(blocker, seen))
      else wave = Math.max(wave, 2)
    }
    waveCache.set(mission.id, wave)
    return wave
  }

  const nodes = [
    ...running.map((mission) => ({ id: mission.id, state: 'running', wave: null })),
    ...queued.map((mission) => {
      const blocked = (blockedBy.get(mission.id) ?? []).length > 0
      return { id: mission.id, state: blocked ? 'blocked' : 'runnable', wave: waveOf(mission, new Set()) }
    }),
  ]

  const blocks = {}
  for (const [id, entries] of blockedBy) {
    for (const entry of entries) {
      blocks[entry.id] = blocks[entry.id] ?? []
      blocks[entry.id].push(id)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    blockedBy: Object.fromEntries(blockedBy),
    blocks,
    executable: nodes.filter((node) => node.state === 'runnable').map((node) => node.id),
    waiting: nodes.filter((node) => node.state === 'running').map((node) => node.id),
  }
}

const JOURNAL_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—-]\s+(.+?)\s*$/gm

export function parseJournal(source) {
  const events = []
  for (const match of source.matchAll(JOURNAL_HEADING)) events.push({ date: match[1], title: match[2].trim() })
  const find = (pattern) => events.find((event) => pattern.test(event.title))
  const reprises = events.filter((event) => /re-?cadrage|rollback|reprise|abandon|retour/i.test(event.title))
  return {
    events,
    cadrage: find(/cadrage/i)?.date ?? '',
    go: find(/^go\b/i)?.date ?? '',
    review: find(/review|revue/i)?.date ?? '',
    close: find(/cl[oô]ture|cloture|fin/i)?.date ?? '',
    reprises: reprises.map((event) => ({ date: event.date, title: event.title })),
  }
}

export function parseReview(source, fields = parseFrontmatter(source)) {
  const title = source.match(/^#\s+Revue\s+\S+\s+[—-]\s+(\d{4}-\d{2}-\d{2})/m)
  const block = source.match(/##\s+Verdict\s*\n+([\s\S]*?)(?=\n##\s|$)/)
  const verdict = (fields.verdict || block?.[1]?.match(/\*\*(.+?)\*\*/)?.[1] || '').trim()
  const section = source.match(/##\s+Crit[eè]res d'acceptation\s*\n([\s\S]*?)(?=\n##\s|$)/)?.[1] ?? ''
  const criteria = []
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4) continue
    const criterion = cells[1] ?? ''
    const status = cells[2] ?? ''
    if (!criterion || /^:?-+:?$/.test(criterion) || /^crit[eè]re/i.test(criterion)) continue
    criteria.push({ criterion, status })
  }
  const unmet = criteria.filter((row) => !/^(couvert|ok|oui|conforme|v[eé]rifi[eé]|✓|pass)/i.test(row.status))
  const constats = source.match(/##\s+Constats\s*\n([\s\S]*?)(?=\n##\s|$)/)?.[1] ?? ''
  const findings = (constats.match(/^\*\*(?:BLO|MAJ|MIN)-\d+/gm) ?? []).length
  return { date: title?.[1] ?? '', verdict, criteria, unmet, findings }
}

export async function readMissionJournal(root, dir) {
  const source = await readOptional(join(root, dir, 'journal.md'))
  return { exists: source !== null, source: source === null ? '' : source.slice(0, 200_000) }
}

export async function readMissionReview(reviewsRoot, id) {
  const source = await readOptional(join(reviewsRoot, id, 'review.md'))
  return { exists: source !== null, source: source === null ? '' : source.slice(0, 200_000) }
}

export async function readMissionJira(root, dir) {
  const source = await readOptional(join(root, dir, 'jira.json'))
  if (source === null) return null
  try {
    const data = JSON.parse(source)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    return null
  }
}

export async function scanAllMissions(root) {
  const missions = []
  for (const [base, archived] of [[root, false], [join(root, 'archives'), true]]) {
    for (const name of await listDirectories(base)) {
      if (name === 'archives') continue
      const source = await readOptional(join(base, name, 'mission.md'))
      if (source === null) continue
      const fields = parseFrontmatter(source)
      const status = normalizeStatus(fields.status) || 'draft'
      missions.push({
        id: (fields.id || name).trim(),
        title: (fields.title || parseTitle(source)).trim(),
        status,
        epic: (fields.epic || '').trim(),
        repo: (fields.repo || '').trim(),
        type: (fields.type || '').trim(),
        priority: normalizePriority(fields.priority),
        queue: normalizeQueue(fields.queue),
        suite: (fields.suite || '').trim(),
        created: (fields.created || '').trim(),
        updated: (fields.updated || '').trim(),
        points: Number(fields.points ?? fields.story_points ?? 0) || 0,
        dir: archived ? join('archives', name) : name,
        file: join(base, name, 'mission.md'),
        archived: archived || isAbandoned(status),
      })
    }
  }
  missions.sort((left, right) => compareIds(left.id, right.id))
  return missions
}
