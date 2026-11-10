import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSION_REF = /missions\/([A-Za-z0-9][A-Za-z0-9._-]{0,39})\//g

/** Retire le préfixe `session-` pour comparer les deux formes d'identifiant. */
export function canonicalSessionId(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  return raw.startsWith('session-') ? raw : `session-${raw}`
}

/** Taille d'une trame zstd à `offset` (0 si le format n'est pas reconnu). */
function zstdFrameLength(buf, offset) {
  if (buf.length - offset < 9) return 0
  if (buf.readUInt32LE(offset) !== 0xfd2fb528) return 0
  let pos = offset + 4
  const descriptor = buf[pos]
  pos += 1
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictFlag = descriptor & 3
  if (dictFlag === 3) return 0
  if (!singleSegment) pos += 1
  pos += [0, 1, 2, 4][dictFlag]
  pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  if (pos > buf.length) return 0
  for (;;) {
    if (pos + 3 > buf.length) return 0
    const header = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16)
    pos += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 3) return 0
    pos += type === 1 ? 1 : size
    if (pos > buf.length) return 0
    if (last) break
  }
  if (checksum) pos += 4
  return pos > offset && pos <= buf.length ? pos : 0
}

/**
 * Décompresse un fichier zstd multi-trames (une trame par ajout).
 * zlib d'Electron (Node 24) s'arrête à la première trame, Node 26 concatène :
 * on découpe explicitement pour un résultat identique partout.
 */
export function decompressZstdFrames(buf) {
  const parts = []
  let offset = 0
  while (offset < buf.length) {
    const end = zstdFrameLength(buf, offset)
    if (end === 0) break
    parts.push(zstdDecompressSync(buf.subarray(offset, end)).toString('utf8'))
    offset = end
  }
  return parts.join('')
}

/** Texte d'une session, sans borne : l'appelant décide de ce qu'il en garde. */
export function readSessionText(file) {
  return decompressZstdFrames(readFileSync(file))
}

/** Titre d'une session, lu dans la première occurrence `"title":"…"`. */
export function sessionTitle(text) {
  const match = text.match(/"title":"((?:[^"\\]|\\.)*)"/)
  if (!match) return ''
  try {
    return JSON.parse(`"${match[1]}"`)
  } catch {
    return match[1]
  }
}

/** Références `missions/<ID>/` trouvées dans le journal d'une session. */
export function missionsInSnippet(text, known) {
  const found = []
  for (const match of text.matchAll(SESSION_REF)) {
    const id = match[1]
    if (known.has(id) && !found.includes(id)) found.push(id)
  }
  return found
}

/** Missions dont l'identifiant apparaît comme un jeton dans le titre. */
export function titleMentions(title, known) {
  const found = []
  if (!title) return found
  for (const id of known) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^A-Za-z0-9-])${escaped}([^A-Za-z0-9-]|$)`).test(title)) found.push(id)
  }
  return found
}

/**
 * Identifiants des sessions archivées, lus dans le store du workspace
 * (`global.archivedSessionIds`). Une session archivée ne doit jamais être
 * proposée : elle n'est plus une session de travail.
 */
export function readArchivedSessions(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const ids = parsed?.global?.archivedSessionIds
    if (!Array.isArray(ids)) return new Set()
    return new Set(ids.map((id) => canonicalSessionId(String(id))).filter(Boolean))
  } catch {
    return new Set()
  }
}

function readJournal(file) {
  const text = readSessionText(file)
  let delegationDepth = 0
  try {
    delegationDepth = JSON.parse(text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')))?.delegationDepth ?? 0
  } catch {
  }
  const mentions = new Map()
  for (const match of text.matchAll(SESSION_REF)) mentions.set(match[1], (mentions.get(match[1]) ?? 0) + 1)
  return { blank: !/"(?:user|assistant)\/message"/.test(text), delegationDepth, mentions, title: sessionTitle(text) }
}

function journalEntry(file, cache) {
  const stats = statSync(file)
  const cached = cache?.get(file)
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached
  const entry = { ...readJournal(file), mtimeMs: stats.mtimeMs, size: stats.size }
  cache?.set(file, entry)
  return entry
}

export function scanSessionCandidates(sessionsRoot, known, journalCache) {
  const byMission = {}
  const sessions = {}
  let scanned = 0
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot)
  } catch {
    return { byMission, sessions, scanned }
  }
  for (const workspace of workspaces) {
    const workspacePath = join(sessionsRoot, workspace)
    let entries = []
    try {
      if (!statSync(workspacePath).isDirectory()) continue
      entries = readdirSync(workspacePath)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('session-')) continue
      let journal
      try {
        journal = journalEntry(join(workspacePath, entry, 'session.v4.jsonl.zstd'), journalCache)
      } catch {
        continue
      }
      if (journal.delegationDepth > 0) continue
      scanned += 1
      const sessionId = canonicalSessionId(entry)
      sessions[sessionId] = { blank: journal.blank, title: journal.title, updatedAt: journal.mtimeMs }
      const inTitle = new Set(titleMentions(journal.title, known))
      for (const [missionId, count] of journal.mentions) {
        if (!known.has(missionId)) continue
        if (!byMission[missionId]) byMission[missionId] = []
        byMission[missionId].push({
          sessionId,
          title: journal.title,
          mentions: count,
          titleMatch: inTitle.has(missionId),
          updatedAt: journal.mtimeMs,
          blank: journal.blank,
        })
      }
    }
  }
  return { byMission, sessions, scanned }
}
