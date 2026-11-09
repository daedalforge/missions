import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.dsh', 'storages', 'dsh-performance')
const FILE = join(DIR, 'snapshot.json')
const LIMIT = 8

export function snapshotKey(period, from) {
  return `${period}:${from}`
}

function keyOf(entry) {
  const range = entry.week?.period ?? {}
  return snapshotKey(entry.period ?? range.kind ?? 'week', range.from ?? entry.anchor ?? '')
}

function readStore() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    if (raw?.entries && typeof raw.entries === 'object') return raw.entries
    if (raw?.week && typeof raw.generatedAt === 'number') return { [keyOf(raw)]: raw }
    return {}
  } catch {
    return {}
  }
}

function isEntry(entry) {
  return Boolean(entry) && typeof entry.generatedAt === 'number' && Boolean(entry.week)
}

export function readSnapshot(key) {
  const entry = readStore()[key]
  return isEntry(entry) ? entry : null
}

export function hasSnapshot(key) {
  return Boolean(readSnapshot(key))
}

export function readLatestSnapshot() {
  const entries = Object.values(readStore()).filter(isEntry)
  entries.sort((a, b) => b.generatedAt - a.generatedAt)
  return entries[0] ?? null
}

export function writeSnapshot(key, { period, anchor, filters, week }) {
  const entries = readStore()
  const entry = { version: 2, generatedAt: Date.now(), period, anchor, filters: filters ?? {}, week }
  entries[key] = entry
  const kept = Object.entries(entries)
    .filter(([, value]) => isEntry(value))
    .sort((a, b) => b[1].generatedAt - a[1].generatedAt)
    .slice(0, LIMIT)
  mkdirSync(DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: 2, entries: Object.fromEntries(kept) }))
  renameSync(tmp, FILE)
  return entry
}
