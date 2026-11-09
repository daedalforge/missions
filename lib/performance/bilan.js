import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { localDate } from './metrics.js'

const STORAGE = join(homedir(), '.dsh', 'storages', 'dsh-performance', 'bilan')
const INFLIGHT = new Set(['active', 'awaiting_validation', 'in_review', 'in_peer_review'])
const REVIEW = new Set(['in_review', 'in_peer_review'])
const STARTABLE = new Set(['ready'])
const CAUSES = ['moi', 'tiers', 'dépendance', 'spec']
const DAYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam']

function dayPath(date) {
  return join(STORAGE, `${date}.json`)
}

export function readDay(date = localDate()) {
  try {
    const file = dayPath(date)
    if (!existsSync(file)) return { date, decision: '', blockers: {}, night: null, tomorrow: null }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      date,
      decision: typeof parsed.decision === 'string' ? parsed.decision : '',
      blockers: parsed.blockers && typeof parsed.blockers === 'object' ? parsed.blockers : {},
      night: Array.isArray(parsed.night) ? parsed.night : null,
      tomorrow: Array.isArray(parsed.tomorrow) ? parsed.tomorrow : null,
      updatedAt: parsed.updatedAt ?? null,
    }
  } catch {
    return { date, decision: '', blockers: {}, night: null, tomorrow: null }
  }
}

export function saveDay(date, patch = {}) {
  const current = readDay(date)
  const next = {
    date,
    decision: typeof patch.decision === 'string' ? patch.decision : current.decision,
    blockers: patch.blockers && typeof patch.blockers === 'object' ? patch.blockers : current.blockers,
    night: Array.isArray(patch.night) ? patch.night : current.night,
    tomorrow: Array.isArray(patch.tomorrow) ? patch.tomorrow : current.tomorrow,
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(STORAGE, { recursive: true })
  writeFileSync(dayPath(date), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

const CAUSE_ORDER = { 'dépendance': 0, tiers: 1, moi: 2, spec: 3 }

function detectBlockers(week) {
  const dependOf = new Map((week.waiting ?? []).map((row) => [row.id, row.depend ?? []]))
  const found = []
  for (const row of week.table ?? []) {
    const depend = dependOf.get(row.id) ?? []
    const dormant = Number(row.dormantDays ?? 0)
    let cause = null
    let action = ''
    if (REVIEW.has(row.status)) {
      cause = 'tiers'
      action = 'relire et fusionner'
    } else if (row.status === 'awaiting_validation') {
      cause = 'tiers'
      action = 'valider'
    } else if (depend.length > 0 && (row.status === 'ready' || row.status === 'active')) {
      cause = 'dépendance'
      action = `débloquer via ${depend.join(', ')}`
    } else if (row.status === 'active' && dormant >= 3) {
      cause = 'moi'
      action = 'débloquer ou sortir du WIP'
    }
    if (!cause) continue
    found.push({
      id: row.id,
      title: row.title,
      status: row.status,
      days: row.dormantDays,
      depend,
      cause,
      action,
      due: '',
      owner: depend.length > 0 ? depend.join(', ') : 'moi',
      detected: true,
    })
  }
  found.sort((left, right) => (CAUSE_ORDER[left.cause] - CAUSE_ORDER[right.cause]) || (Number(right.days ?? 0) - Number(left.days ?? 0)))
  return found
}

function mergeBlockers(detected, saved) {
  return detected.map((blocker) => {
    const edit = saved?.[blocker.id] ?? {}
    return {
      ...blocker,
      cause: CAUSES.includes(edit.cause) ? edit.cause : blocker.cause,
      action: typeof edit.action === 'string' && edit.action ? edit.action : blocker.action,
      due: typeof edit.due === 'string' ? edit.due : blocker.due,
      owner: typeof edit.owner === 'string' && edit.owner ? edit.owner : blocker.owner,
    }
  })
}

function repoName(repo) {
  return repo ? String(repo).split('/').filter(Boolean).pop() : 'dépôt ?'
}

function proposals(week) {
  const table = week.table ?? []
  const night = []
  for (const row of table) {
    if (row.status === 'active') night.push(`${row.id} — poursuivre l'exécution (${row.points || '?'} pts)`)
  }
  if (night.length === 0) night.push('aucune mission exécutable sans go : préparer la matière du prochain cadrage')
  const tomorrow = []
  for (const row of table) {
    if (REVIEW.has(row.status)) tomorrow.push(`relire et fusionner ${row.id} (${row.status})`)
    else if (row.status === 'awaiting_validation') tomorrow.push(`valider ${row.id}`)
  }
  for (const row of table) {
    if (STARTABLE.has(row.status)) tomorrow.push(`démarrer ${row.id} (${row.points || '?'} pts, ${repoName(row.repo)})`)
  }
  for (const row of week.waiting ?? []) {
    const depend = row.depend ?? []
    if (depend.length > 0) tomorrow.push(`débloquer ${row.id} : dépend de ${depend.join(', ')}`)
  }
  if (tomorrow.length === 0) tomorrow.push('aucun acte immédiat : consolider ou cadrer')
  return { night: [...new Set(night)], tomorrow: [...new Set(tomorrow)] }
}

export function buildDay(week, date = localDate()) {
  const saved = readDay(date)
  const detected = detectBlockers(week)
  const proposal = proposals(week)
  const inflight = (week.table ?? []).filter((row) => INFLIGHT.has(row.status)).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    days: row.dormantDays,
    repo: row.repo,
    points: row.points,
    depend: (week.waiting ?? []).find((entry) => entry.id === row.id)?.depend ?? [],
    href: row.href,
  }))
  return {
    date,
    figures: {
      merged: week.production?.prs ?? 0,
      delivered: week.counters?.done ?? 0,
      inflight: week.counters?.active ?? 0,
      waiting: week.counters?.waiting ?? 0,
      cost: week.effort?.costEur ?? 0,
    },
    inflight,
    epics: (week.epicProgress?.epics ?? []).map((epic) => ({
      key: epic.key,
      title: epic.title,
      rate: epic.rate,
      rateDev: epic.rateDev ?? epic.rate,
      rateMissions: epic.rateMissions ?? 0,
      rateMissionsDev: epic.rateMissionsDev ?? epic.rateMissions ?? 0,
      points: { done: epic.points.done, dev: epic.points.dev ?? epic.points.done, total: epic.points.total },
      missions: { done: epic.missions.done, dev: epic.missions.dev ?? epic.missions.done, total: epic.missions.total },
    })),
    blockers: mergeBlockers(detected, saved.blockers),
    decision: saved.decision,
    night: saved.night ?? proposal.night,
    tomorrow: saved.tomorrow ?? proposal.tomorrow,
    detected: detected.map((blocker) => blocker.id),
    updatedAt: saved.updatedAt,
  }
}

export function registryLine(day) {
  const merged = day.figures.merged ?? 0
  const delivered = day.figures.delivered ?? 0
  const date = new Date(`${day.date}T12:00:00`)
  const stamp = `${day.date} (${DAYS[date.getDay()]})`
  const decision = day.decision ? day.decision.replace(/\|/g, '/').replace(/\n/g, ' ') : 'à faire'
  return `| ${stamp} | ${merged} | ${delivered > 0 ? delivered : '—'} | ${day.figures.inflight} | ${day.figures.waiting} | ${Number(day.figures.cost).toFixed(2).replace('.', ',')} $ | ${decision} |`
}

export function registryBlock(day) {
  const night = day.night?.length ? day.night.join(' ; ') : 'rien'
  const tomorrow = day.tomorrow?.length ? day.tomorrow.join(' ; ') : 'rien'
  return `**Nuit** — ${night}\n\n**Lendemain** — ${tomorrow}`
}

export function registryMarkdown(day) {
  return `${registryLine(day)}\n\n${registryBlock(day)}`
}
