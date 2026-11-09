import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalSessionId, readSessionText, sessionTitle } from '../sessions.js'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const CACHE_PATH = join(homedir(), '.dsh', 'storages', 'dsh-performance', 'cache', 'sessions.json')
let statCache = null
let statCacheDirty = false

function loadStatCache() {
  if (statCache) return statCache
  statCache = new Map()
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    for (const [file, entry] of Object.entries(raw.entries ?? {})) statCache.set(file, entry)
  } catch {
  }
  return statCache
}

export function saveSessionCache() {
  if (!statCacheDirty || !statCache) return
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify({ version: 1, entries: Object.fromEntries(statCache) }))
    statCacheDirty = false
  } catch {
  }
}

function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
    }
  }
  return events
}

export function sessionStats(workspacePath, entry) {
  const file = join(workspacePath, entry, SESSION_FILE)
  const stat = statSync(file)
  const cached = loadStatCache().get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.stats
  const text = readSessionText(file)
  const events = parseEvents(text)
  const session = events.find((event) => event.type === 'session') ?? {}
  let firstAt = Infinity
  let lastAt = 0
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let turns = 0
  let turnMs = 0
  const openTurns = new Map()
  for (const event of events) {
    const time = Number(event.time)
    if (Number.isFinite(time) && time > 0) {
      if (time < firstAt) firstAt = time
      if (time > lastAt) lastAt = time
    }
    if (event.type === 'user/message') {
      if (event.data?.source?.kind === 'user') userMessages += 1
    } else if (event.type === 'assistant/message') {
      assistantMessages += 1
    } else if (event.type === 'tool/call') {
      toolCalls += 1
    } else if (event.type === 'turn/start') {
      turns += 1
      if (Number.isFinite(time)) openTurns.set(event.data?.turn, time)
    } else if (event.type === 'turn/end') {
      const started = openTurns.get(event.data?.turn)
      if (Number.isFinite(started) && Number.isFinite(time) && time > started) {
        turnMs += time - started
        openTurns.delete(event.data?.turn)
      }
    }
  }
  const stats = {
    id: typeof session.id === 'string' ? session.id : canonicalSessionId(entry),
    dir: entry,
    title: sessionTitle(text),
    createdAt: Number(session.createdAt) || (firstAt === Infinity ? 0 : firstAt),
    firstAt: firstAt === Infinity ? 0 : firstAt,
    lastAt,
    activeMs: lastAt > firstAt ? lastAt - firstAt : 0,
    turnMs,
    delegationDepth: Number(session.delegationDepth) || 0,
    agentPreset: typeof session.agentPreset === 'string' ? session.agentPreset : '',
    userMessages,
    assistantMessages,
    toolCalls,
    turns,
    bytes: stat.size,
  }
  statCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, stats })
  statCacheDirty = true
  return stats
}

export function scanSessions(sessionsRoot, options = {}) {
  const includeSubagents = options.includeSubagents !== false
  const sessions = []
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot)
  } catch {
    return sessions
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
      try {
        if (!statSync(join(workspacePath, entry, SESSION_FILE)).isFile()) continue
      } catch {
        continue
      }
      try {
        const stats = sessionStats(workspacePath, entry)
        if (!includeSubagents && stats.delegationDepth > 0) continue
        sessions.push({ ...stats, workspace })
      } catch {
      }
    }
  }
  sessions.sort((left, right) => left.firstAt - right.firstAt)
  saveSessionCache()
  return sessions
}
