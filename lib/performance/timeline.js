import { statSync } from 'node:fs'
import { join } from 'node:path'
import { collectGit } from './sources.js'
import { linksFor, readLinks } from './links.js'
import { canonicalSessionId } from '../sessions.js'
import { scanSessions } from './stats.js'
import { parseJournal, readMissionJournal, readMissionJira, readMissionReview, scanAllMissions } from '../missions.js'
import { isDelivered, jiraDate, jiraLifecycle } from './jira.js'
import { resolveRoots } from './metrics.js'

export const STEPS = [
  { key: 'cadrage', label: 'Cadrage', hint: "import et fiche, jusqu'à la validation" },
  { key: 'go', label: 'Go', hint: "validation jusqu'à la première ligne de code" },
  { key: 'exec', label: 'Exécution', hint: 'premier au dernier commit' },
  { key: 'review', label: 'Review', hint: 'dernier commit au verdict' },
  { key: 'val', label: 'Validation', hint: 'verdict à la validation du principal' },
  { key: 'close', label: 'Clôture', hint: 'validation au rangement' },
]

const REPRISE = /re-?cadrage|rollback|reprise|retour|abandon|re-?ouvre/i
const REVIEWED = new Set(['in_review', 'in_peer_review', 'awaiting_validation', 'done'])
const WAITING = new Set(['in_review', 'in_peer_review', 'awaiting_validation'])
const DAY = 86_400_000
const WINDOW_DAYS = { week: 7, month: 30, day: 1 }
const WINDOW_LABEL = { week: '7 jours glissants', month: '30 jours glissants', day: 'missions actives aujourd’hui' }
const cache = new Map()

function dayStart(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function windowOf(period, anchor, now) {
  const days = WINDOW_DAYS[period] ?? 7
  const end = anchor ? Math.min(now, dayStart(Date.parse(`${anchor}T00:00:00`)) + DAY - 1) : now
  const date = new Date(end)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (days - 1))
  return { kind: period, from: date.getTime(), to: end, days, label: WINDOW_LABEL[period] ?? WINDOW_LABEL.week }
}

function atNoon(date) {
  const ms = Date.parse(`${date || ''}T12:00:00`)
  return Number.isFinite(ms) ? ms : 0
}

function localIso(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function atMidnight(date) {
  const ms = Date.parse(`${date || ''}T00:00:00`)
  return Number.isFinite(ms) ? ms : 0
}

function statAt(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function sessionsOf(links, sessionById, missionId) {
  const found = new Map()
  for (const id of linksFor(links, missionId)) {
    const session = sessionById.get(canonicalSessionId(id))
    if (session) found.set(session.id, session)
  }
  for (const session of sessionById.values()) {
    if (found.has(session.id) || session.delegationDepth > 0 || !session.title) continue
    if (session.title.includes(missionId)) found.set(session.id, session)
  }
  return [...found.values()].sort((left, right) => left.firstAt - right.firstAt)
}

function stagesOf({ mission, journal, sessions, commits, reviewMtime, missionMtime, now, from, jira }) {
  const archived = String(mission.dir ?? '').startsWith('archives/')
  const closeAt = atNoon(journal.close)
  const delivered = !archived && isDelivered(jira)
  const lifecycle = archived || delivered ? jiraLifecycle(jira, { closedAt: delivered ? closeAt || now : 0 }) : null
  if (lifecycle) {
    const repriseEvents = journal.events.filter((event) => REPRISE.test(event.title) && atMidnight(event.date) >= from - DAY)
    return {
      id: mission.id,
      status: mission.status,
      start: lifecycle.created,
      source: 'jira',
      steps: lifecycle.steps,
      cycle: STEPS.reduce((total, step) => total + lifecycle.steps[step.key], 0),
      reprises: repriseEvents.length,
      repriseEvents: repriseEvents.map((event) => ({ id: mission.id, date: event.date, title: event.title })),
      sessions: sessions.length,
      commits: commits.length,
      inReview: WAITING.has(mission.status),
      waitingSince: lifecycle.end,
    }
  }
  const firstSession = sessions[0] ?? null
  const lastSession = sessions.at(-1) ?? null
  const jiraStart = jira?.state === 'retenu' ? jiraDate(jira.created) : 0
  const jiraReady = jira?.state === 'retenu' ? jiraDate(jira.readyToDev) : 0
  const dated = jiraStart > 0 && jiraReady >= jiraStart
  const start = dated ? jiraStart : atMidnight(mission.created) || atMidnight(journal.events[0]?.date) || firstSession?.firstAt || missionMtime || now
  const cadrageEnd = Math.max(start, dated ? jiraReady : (firstSession?.lastAt ?? (atNoon(journal.cadrage) || start + 3_600_000)))
  const ordered = commits.filter((commit) => commit.at >= start).sort((left, right) => left.at - right.at)
  const execStart = Math.max(start, lastSession?.firstAt ?? ordered[0]?.at ?? cadrageEnd)
  const execEnd = Math.max(execStart, ordered.at(-1)?.at ?? lastSession?.lastAt ?? execStart)
  const reviewEnd = Math.max(execEnd, reviewMtime || 0, REVIEWED.has(mission.status) ? missionMtime || 0 : 0)
  const valEnd = WAITING.has(mission.status) ? now : closeAt > reviewEnd ? closeAt : reviewEnd
  const steps = {
    cadrage: Math.max(0, Math.min(cadrageEnd, execStart) - start),
    go: Math.max(0, execStart - cadrageEnd),
    exec: Math.max(0, execEnd - execStart),
    review: Math.max(0, reviewEnd - execEnd),
    val: Math.max(0, valEnd - reviewEnd),
    close: 0,
  }
  const repriseEvents = journal.events.filter((event) => REPRISE.test(event.title) && atMidnight(event.date) >= from - DAY)
  const reprises = repriseEvents.length
  return {
    id: mission.id,
    status: mission.status,
    start,
    source: dated ? 'jira' : 'repli',
    steps,
    cycle: STEPS.reduce((total, step) => total + steps[step.key], 0),
    reprises,
    repriseEvents: repriseEvents.map((event) => ({ id: mission.id, date: event.date, title: event.title })),
    sessions: sessions.length,
    commits: ordered.length,
    inReview: WAITING.has(mission.status),
    waitingSince: reviewEnd,
  }
}

function mean(values) {
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function summarize(rows, now) {
  const cycle = mean(rows.map((row) => row.cycle))
  const steps = {}
  for (const step of STEPS) {
    const values = rows.map((row) => row.steps[step.key])
    steps[step.key] = {
      key: step.key,
      label: step.label,
      hint: step.hint,
      mean: mean(values),
      median: median(values.filter((value) => value > 0)),
      max: Math.max(0, ...values),
      reached: values.filter((value) => value > 0).length,
      count: rows.length,
      share: cycle > 0 ? mean(values) / cycle : 0,
      total: values.reduce((sum, value) => sum + value, 0),
    }
  }
  const wait = steps.cadrage.mean + steps.go.mean + steps.val.mean
  const work = steps.exec.mean + steps.review.mean
  const waiting = rows.filter((row) => row.inReview)
  return {
    count: rows.length,
    cycle,
    cycleMedian: median(rows.map((row) => row.cycle)),
    steps,
    wait,
    work,
    waitShare: cycle > 0 ? wait / cycle : 0,
    workShare: cycle > 0 ? work / cycle : 0,
    waiting: waiting.length,
    waitingTotal: waiting.reduce((sum, row) => sum + Math.max(0, now - row.waitingSince), 0),
    reprises: rows.reduce((sum, row) => sum + row.reprises, 0),
    repriseList: rows
      .flatMap((row) => row.repriseEvents)
      .sort((left, right) => (right.date > left.date ? 1 : right.date < left.date ? -1 : 0))
      .slice(0, 6),
    waitingReprises: waiting.reduce((sum, row) => sum + row.reprises, 0),
    rows,
  }
}

async function fastestClosed(roots, missions, from, to) {
  let best = null
  for (const mission of missions) {
    if (!['done', 'archived'].includes(mission.status)) continue
    const journal = parseJournal((await readMissionJournal(roots.missionsRoot, mission.dir)).source)
    const close = atNoon(journal.close)
    if (!close || close < from || dayStart(close) > dayStart(to)) continue
    const jira = await readMissionJira(roots.missionsRoot, mission.dir)
    const jiraStart = jira?.state === 'retenu' ? jiraDate(jira.created) : 0
    const start = jiraStart || atMidnight(mission.created) || atMidnight(journal.events[0]?.date) || close
    const cycle = Math.max(0, close - start)
    if (cycle > 0 && (!best || cycle < best.cycle)) best = { id: mission.id, cycle }
  }
  return best
}

export async function buildTimeline({ roots = resolveRoots(), period = 'week', anchor } = {}) {
  const to = Date.now()
  const range = windowOf(period, anchor, to)
  const from = range.from
  const missions = await scanAllMissions(roots.missionsRoot)
  const product = missions.filter((mission) => String(mission.type).toLowerCase() === 'produit')
  const open = product.filter((mission) => !mission.archived)
  const journals = new Map()
  for (const mission of product) {
    journals.set(mission.id, parseJournal((await readMissionJournal(roots.missionsRoot, mission.dir)).source))
  }
  const closed = product.filter((mission) => {
    const close = atNoon(journals.get(mission.id)?.close)
    return mission.archived && close >= from && dayStart(close) <= dayStart(range.to)
  })
  const links = readLinks(roots.linksFile)
  const sessionList = scanSessions(roots.sessionsRoot, { includeSubagents: false })
  const sessionById = new Map(sessionList.map((session) => [canonicalSessionId(session.id), session]))
  const git = await collectGit({ konohaRoot: roots.konohaRoot, projectsRoot: roots.projectsRoot, from: localIso(from), to: localIso(to) })
  const byMission = new Map()
  for (const commit of git.commits) {
    const at = Date.parse(commit.date)
    if (!Number.isFinite(at)) continue
    for (const id of commit.missions) {
      const list = byMission.get(id) ?? []
      list.push({ at, hash: commit.hash, subject: commit.subject })
      byMission.set(id, list)
    }
  }
  const rows = []
  const candidates = [...open, ...closed]
  for (const mission of candidates) {
    const journal = journals.get(mission.id) ?? parseJournal('')
    const review = await readMissionReview(roots.reviewsRoot, mission.id)
    const jira = await readMissionJira(roots.missionsRoot, mission.dir)
    const sessions = sessionsOf(links, sessionById, mission.id)
    const commits = byMission.get(mission.id) ?? []
    const row = stagesOf({
      mission,
      journal,
      jira,
      sessions,
      commits,
      reviewMtime: review.exists ? statAt(join(roots.reviewsRoot, mission.id, 'review.md')) : 0,
      missionMtime: statAt(join(roots.missionsRoot, mission.dir, 'mission.md')),
      now: to,
      from,
    })
    const worked = sessions.some((session) => session.lastAt >= from) || commits.some((commit) => commit.at >= from)
    const isClosed = mission.archived
    if (!isClosed && !worked && !WAITING.has(mission.status)) continue
    if (row.start > range.to || row.cycle <= 60_000) continue
    rows.push(row)
  }
  return {
    window: range,
    generatedAt: to,
    ...summarize(rows, range.to),
    reference: await fastestClosed(roots, missions, from, range.to),
    coverage: {
      from,
      to: range.to,
      sessions: sessionList.length,
      commits: git.commits.length,
      git: git.repos.filter((repo) => repo.status !== 'ok').length,
      jira: {
        retenus: rows.filter((row) => row.source === 'jira').length,
        replis: rows.filter((row) => row.source === 'repli').length,
      },
    },
  }
}

export function clearTimelineCache() {
  cache.clear()
}

export async function timelineData(settings, { period, anchor }) {
  const key = JSON.stringify({ root: resolveRoots(settings).missionsRoot, period, anchor })
  const hit = cache.get(key)
  const ttl = Math.max(60_000, (Number(settings.refreshSeconds) || 300) * 1000)
  if (hit && Date.now() - hit.at < ttl) return hit.data
  const data = await buildTimeline({ roots: resolveRoots(settings), period, anchor })
  cache.set(key, { at: Date.now(), data })
  return data
}
