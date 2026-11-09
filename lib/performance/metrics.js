import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { cacheRate, ledgerRange, readLedger, sessionsOf, sumDays } from './ledger.js'
import { inverseLinks, linksFor, readLinks } from './links.js'
import { computePlan, parseJournal, parseReview, readMissionJournal, readMissionReview, scanAllMissions, scanEpics } from '../missions.js'
import { canonicalSessionId } from '../sessions.js'
import { scanSessions } from './stats.js'

const TZ = 'Europe/Paris'
const DAY = 86_400_000
const IN_FLIGHT = new Set(['active', 'in_review', 'in_peer_review', 'awaiting_validation'])
const WAITING = new Set(['draft', 'ready', 'in_review', 'in_peer_review', 'awaiting_validation'])
const DEV_DONE = new Set(['done', 'in_review', 'in_peer_review', 'awaiting_validation'])
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
const numFormat = new Intl.NumberFormat('fr-FR')
const oneDecimal = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const twoDecimals = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const DEFAULT_CONFIG = {
  refreshSeconds: 300,
  alerts: { dormantDays: 7, sessionCostEur: 4, dayCostEur: 40, cycleFactor: 2 },
  sources: { git: true, gh: true, jira: true, subagents: true },
  roots: {
    konohaRoot: join(homedir(), 'konoha'),
    projectsRoot: join(homedir(), 'projects'),
    sessionsRoot: join(homedir(), '.dsh', 'sessions'),
    ledgerFile: join(homedir(), '.dsh', 'storages', 'cost-meter', 'ledger.json'),
    linksFile: join(homedir(), '.dsh', 'missions', 'links.json'),
    configFile: join(homedir(), '.dsh', 'storages', 'dsh-performance', 'config.json'),
    jiraScript: join(homedir(), 'konoha', 'config', 'tools', 'atlassian', 'jira.sh'),
  },
}

export function localDate(date = new Date()) {
  return dayFormat.format(date)
}

export function resolveRoots(config = {}) {
  const roots = { ...DEFAULT_CONFIG.roots, ...(config.roots ?? {}) }
  return {
    ...roots,
    missionsRoot: join(roots.konohaRoot, 'missions'),
    reviewsRoot: join(roots.konohaRoot, 'reviews', 'missions'),
  }
}

function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function datesBetween(from, to) {
  const dates = []
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date)
  return dates
}

function weekStart(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return addDays(iso, -((day + 6) % 7))
}

function weekNumber(iso) {
  const date = new Date(`${iso}T00:00:00Z`)
  const thursday = new Date(date)
  thursday.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  return Math.ceil(((thursday - yearStart) / DAY + 1) / 7)
}

function monthLabel(iso) {
  const [year, month] = iso.split('-').map(Number)
  return `${MONTHS[month - 1]} ${year}`
}

function shortDate(iso) {
  const [, month, day] = iso.split('-').map(Number)
  return `${day} ${MONTHS[month - 1]}`
}

export function periodRange(kind = 'week', anchor = localDate()) {
  let from
  let to
  if (kind === 'day') {
    from = anchor
    to = anchor
  } else if (kind === 'month') {
    from = `${anchor.slice(0, 7)}-01`
    const [year, month] = anchor.split('-').map(Number)
    to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  } else {
    from = weekStart(anchor)
    to = addDays(from, 6)
  }
  const length = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1
  const prevFrom = addDays(from, -length)
  const prevTo = addDays(to, -length)
  let label
  if (kind === 'day') label = `${DAYS[new Date(`${from}T00:00:00Z`).getUTCDay()]} ${shortDate(from)} ${from.slice(0, 4)}`
  else if (kind === 'month') label = monthLabel(from)
  else label = `Semaine ${weekNumber(from)} · ${shortDate(from)} → ${shortDate(to)} ${to.slice(0, 4)}`
  return {
    kind,
    from,
    to,
    label,
    prevFrom,
    prevTo,
    prevLabel: kind === 'day' ? shortDate(prevFrom) : kind === 'month' ? monthLabel(prevFrom) : `Semaine ${weekNumber(prevFrom)}`,
    dates: datesBetween(from, to),
    prevDates: datesBetween(prevFrom, prevTo),
  }
}

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (list.length === 0) return 0
  const middle = Math.floor(list.length / 2)
  return list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle]
}

function p90(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (list.length === 0) return 0
  return list[Math.min(list.length - 1, Math.ceil(list.length * 0.9) - 1)]
}

function daysBetween(from, to) {
  if (!from || !to) return 0
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / DAY))
}

function daysSince(date, today = localDate()) {
  if (!date) return null
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / DAY))
}

function fmtInt(value) {
  return numFormat.format(Number(value) || 0)
}

function fmtEur(value) {
  return `${twoDecimals.format(Number(value) || 0)} €`
}

function fmtDays(value) {
  return `${oneDecimal.format(Number(value) || 0)} j`
}

function fmtTokens(value) {
  const count = Number(value) || 0
  if (count >= 1_000_000) return `${oneDecimal.format(count / 1_000_000)} M`
  if (count >= 1_000) return `${Math.round(count / 1_000)} k`
  return fmtInt(count)
}

function fmtPct(value) {
  return `${numFormat.format(Math.round((Number(value) || 0) * 100))} %`
}

function pctChange(current, previous) {
  const before = Number(previous) || 0
  const now = Number(current) || 0
  if (before === 0) return null
  return (now - before) / before
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0)
}

function missionSessions(links, sessionById, missionId) {
  const sessions = []
  const seen = new Set()
  for (const id of linksFor(links, missionId)) {
    const session = sessionById.get(canonicalSessionId(id))
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
  }
  const pattern = new RegExp(`(?:^|\\b)${missionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`)
  for (const session of sessionById.values()) {
    if (!session.title || seen.has(session.id)) continue
    if (pattern.test(session.title)) {
      seen.add(session.id)
      sessions.push(session)
    }
  }
  return sessions
}

function spanDaysOf(sessions) {
  const first = Math.min(...sessions.map((session) => session.firstAt).filter((time) => time > 0))
  const last = Math.max(...sessions.map((session) => session.lastAt).filter((time) => time > 0))
  return Number.isFinite(first) && Number.isFinite(last) && last > first ? (last - first) / DAY : null
}

function sessionCost(ledgerSessions, sessions) {
  let cost = 0
  let tokens = 0
  for (const session of sessions) {
    const entry = ledgerSessions.get(canonicalSessionId(session.id))
    if (!entry) continue
    cost += entry.costEur
    tokens += entry.input + entry.output + entry.cacheRead
  }
  return { cost, tokens }
}

function closeOf(mission, journal) {
  if (journal.close) return journal.close
  if (mission.status === 'done' && mission.updated) return mission.updated
  return ''
}

function lastActivityOf(mission, journal, sessions, today) {
  const candidates = [mission.updated, journal.events.at(-1)?.date ?? '']
  for (const session of sessions) {
    if (session.lastAt) candidates.push(localDate(new Date(session.lastAt)))
  }
  const latest = candidates.filter(Boolean).sort().at(-1) ?? ''
  return { date: latest, days: daysSince(latest, today) }
}

function coverageItem(key, label, status, detail) {
  return { key, label, status, detail }
}

export async function buildWeek({ roots = resolveRoots(), config = {}, period = 'week', anchor, filters = {}, sources = {} } = {}) {
  const settings = { ...DEFAULT_CONFIG, ...config, alerts: { ...DEFAULT_CONFIG.alerts, ...(config.alerts ?? {}) } }
  const today = localDate()
  const range = periodRange(period, anchor ?? today)
  const dates = new Set(range.dates)

  const missions = await scanAllMissions(roots.missionsRoot)
  const journalById = new Map()
  const reviewById = new Map()
  for (const mission of missions) {
    const journal = await readMissionJournal(roots.missionsRoot, mission.dir)
    journalById.set(mission.id, parseJournal(journal.source))
    const review = await readMissionReview(roots.reviewsRoot, mission.id)
    if (review.exists) reviewById.set(mission.id, parseReview(review.source))
  }

  const ledger = readLedger(roots.ledgerFile)
  const links = readLinks(roots.linksFile)
  const sessionList = scanSessions(roots.sessionsRoot, { includeSubagents: settings.sources.subagents })
  const sessionById = new Map(sessionList.map((session) => [canonicalSessionId(session.id), session]))
  const ledgerSessions = ledger ? sessionsOf(ledger, range.dates) : new Map()

  const done = []
  const created = []
  const active = []
  const waiting = []
  for (const mission of missions) {
    const journal = journalById.get(mission.id) ?? parseJournal('')
    const close = closeOf(mission, journal)
    if (close && dates.has(close)) done.push({ ...mission, close })
    if (mission.created && dates.has(mission.created)) created.push(mission)
    if (IN_FLIGHT.has(mission.status)) active.push(mission)
    if (WAITING.has(mission.status)) waiting.push(mission)
  }

  const plan = computePlan(missions)
  const blockedBy = plan.blockedBy ?? {}

  const table = []
  const seen = new Set()
  const candidates = [...done, ...created, ...active, ...waiting]
  for (const mission of candidates) {
    if (seen.has(mission.id)) continue
    seen.add(mission.id)
    const journal = journalById.get(mission.id) ?? parseJournal('')
    const sessions = missionSessions(links, sessionById, mission.id)
    const { cost, tokens } = sessionCost(ledgerSessions, sessions)
    const activity = lastActivityOf(mission, journal, sessions, today)
    const close = closeOf(mission, journal)
    const cycle = spanDaysOf(sessions) ?? daysBetween(mission.created, close || today)
    const review = reviewById.get(mission.id) ?? null
    table.push({
      id: mission.id,
      title: mission.title,
      type: mission.type,
      status: mission.status,
      repo: mission.repo,
      epic: mission.epic,
      points: mission.points,
      created: mission.created,
      cycle,
      cost,
      tokens,
      sessions: sessions.length,
      verdict: review?.verdict ?? '',
      findings: review?.findings ?? 0,
      activity: activity.date,
      dormantDays: activity.days,
      href: `/performance/mission/${mission.id}`,
    })
  }
  table.sort((left, right) => {
    const order = { active: 0, awaiting_validation: 0, in_review: 1, in_peer_review: 1, ready: 2, draft: 3, done: 4 }
    const delta = (order[left.status] ?? 5) - (order[right.status] ?? 5)
    if (delta !== 0) return delta
    return String(right.activity).localeCompare(String(left.activity))
  })

  const filtered = table.filter((row) => {
    if (filters.type && row.type !== filters.type) return false
    if (filters.epic && row.epic !== filters.epic) return false
    if (filters.repo && row.repo !== filters.repo) return false
    if (filters.status && row.status !== filters.status) return false
    return true
  })

  const epicMeta = await scanEpics(join(dirname(roots.missionsRoot), 'epics'))
  const scopedMissions = missions.filter((mission) => mission.status !== 'abandoned')
  const epicProgress = epicMeta.map((epic) => {
    const scoped = scopedMissions.filter((mission) => mission.epic === epic.key)
    const delivered = scoped.filter((mission) => mission.status === 'done')
    const devDelivered = scoped.filter((mission) => DEV_DONE.has(mission.status))
    const pointsTotal = sum(scoped.map((mission) => Number(mission.points) || 0))
    const pointsDone = sum(delivered.map((mission) => Number(mission.points) || 0))
    const pointsDev = sum(devDelivered.map((mission) => Number(mission.points) || 0))
    const rate = pointsTotal > 0 ? pointsDone / pointsTotal : scoped.length > 0 ? delivered.length / scoped.length : 0
    const rateDev = pointsTotal > 0 ? pointsDev / pointsTotal : scoped.length > 0 ? devDelivered.length / scoped.length : 0
    const rateMissions = scoped.length > 0 ? delivered.length / scoped.length : 0
    const rateMissionsDev = scoped.length > 0 ? devDelivered.length / scoped.length : 0
    return {
      key: epic.key,
      title: epic.title || epic.key,
      status: epic.status,
      rate,
      rateDev,
      rateMissions,
      rateMissionsDev,
      missions: { done: delivered.length, dev: devDelivered.length, total: scoped.length },
      points: { done: pointsDone, dev: pointsDev, total: pointsTotal, remaining: Math.max(0, pointsTotal - pointsDone), remainingDev: Math.max(0, pointsTotal - pointsDev) },
      active: scoped.filter((mission) => IN_FLIGHT.has(mission.status)).length,
    }
  })
  const orphans = scopedMissions.filter((mission) => !mission.epic)

  const filterOptions = {
    types: [...new Set(missions.map((mission) => mission.type).filter(Boolean))].sort(),
    epics: [...new Set(missions.map((mission) => mission.epic).filter(Boolean))].sort(),
    repos: [...new Set(missions.map((mission) => mission.repo).filter(Boolean))].sort(),
    statuses: [...new Set(missions.map((mission) => mission.status).filter(Boolean))].sort(),
  }

  const open = missions.filter((mission) => !mission.archived)
  const dormant = filtered.filter((row) => WAITING.has(row.status) && row.dormantDays !== null && row.dormantDays >= settings.alerts.dormantDays)

  const effort = ledger
    ? sumDays(ledger, range.dates)
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costEur: 0 }
  const effortPrev = ledger
    ? sumDays(ledger, range.prevDates)
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costEur: 0 }
  const byDay = range.dates.map((date) => {
    const day = ledger?.days?.[date]
    return {
      date,
      label: shortDate(date),
      tokens: day ? Number(day.input) + Number(day.output) + Number(day.cacheRead) : 0,
      cost: Number(day?.costEur) || 0,
      calls: Number(day?.calls) || 0,
    }
  })

  const commits = sources.git?.commits ?? []
  const prs = sources.gh?.prs ?? []
  const prsMerged = prs.filter((pr) => pr.mergedAt && localDate(new Date(pr.mergedAt)) >= range.from && localDate(new Date(pr.mergedAt)) <= range.to)
  const byRepo = [...new Set(commits.map((commit) => commit.repo))]
    .map((repo) => ({ repo, commits: commits.filter((commit) => commit.repo === repo).length }))
    .sort((left, right) => right.commits - left.commits)

  const reviews = [...reviewById.entries()]
    .map(([missionId, review]) => ({ missionId, ...review }))
    .filter((review) => review.date && dates.has(review.date))
  const reviewUnmet = sum(reviews.map((review) => review.unmet.length))
  const reviewFindings = sum(reviews.map((review) => review.findings))
  const reprises = []
  for (const [missionId, journal] of journalById) {
    for (const event of journal.reprises) if (dates.has(event.date)) reprises.push({ missionId, ...event })
  }
  const abandoned = missions.filter((mission) => ['abandoned', 'archived'].includes(mission.status) && mission.updated && dates.has(mission.updated))

  const cycleValues = done.map((mission) => {
    const journal = journalById.get(mission.id) ?? parseJournal('')
    return spanDaysOf(missionSessions(links, sessionById, mission.id)) ?? daysBetween(mission.created, closeOf(mission, journal) || today)
  })
  const cycleMedian = median(cycleValues)
  const cycleP90 = p90(cycleValues)
  const cyclePrevValues = []
  for (const mission of missions) {
    const journal = journalById.get(mission.id) ?? parseJournal('')
    const close = closeOf(mission, journal)
    if (close && dates.has(range.prevFrom) === false && close >= range.prevFrom && close <= range.prevTo) {
      cyclePrevValues.push(spanDaysOf(missionSessions(links, sessionById, mission.id)) ?? daysBetween(mission.created, close))
    }
  }
  const cyclePrevMedian = median(cyclePrevValues)
  const segments = done.map((mission) => {
    const journal = journalById.get(mission.id) ?? parseJournal('')
    return {
      id: mission.id,
      cadrage: journal.cadrage ? daysBetween(mission.created, journal.cadrage) : null,
      go: journal.go ? daysBetween(mission.created, journal.go) : null,
      review: journal.review ? daysBetween(journal.go || mission.created, journal.review) : null,
      close: daysBetween(journal.go || mission.created, closeOf(mission, journal) || today),
    }
  })

  const series = []
  for (let index = 7; index >= 0; index -= 1) {
    const weekTo = addDays(range.to, -7 * index)
    const weekFrom = weekStart(weekTo)
    const weekDates = new Set(datesBetween(weekFrom, addDays(weekFrom, 6)))
    const weekDone = missions.filter((mission) => {
      const journal = journalById.get(mission.id) ?? parseJournal('')
      const close = closeOf(mission, journal)
      return close && weekDates.has(close)
    })
    const weekCreated = missions.filter((mission) => mission.created && weekDates.has(mission.created))
    const values = weekDone.map((mission) => spanDaysOf(missionSessions(links, sessionById, mission.id)) ?? daysBetween(mission.created, closeOf(mission, journalById.get(mission.id) ?? parseJournal(''))))
    series.push({
      label: `S${weekNumber(weekFrom)}`,
      from: weekFrom,
      done: weekDone.length,
      created: weekCreated.length,
      cycle: median(values),
    })
  }

  const periodSessions = sessionList.filter((session) => {
    const date = session.lastAt ? localDate(new Date(session.lastAt)) : ''
    return date && dates.has(date)
  })
  const periodMain = periodSessions.filter((session) => session.delegationDepth === 0)
  const human = {
    userMessages: sum(periodMain.map((session) => session.userMessages)),
    go: [...journalById.values()].filter((journal) => journal.go && dates.has(journal.go)).length,
    reviews: reviews.length,
    activeMs: sum(periodMain.map((session) => session.turnMs)),
  }
  const agent = {
    sessions: periodSessions.length,
    turns: sum(periodSessions.map((session) => session.turns)),
    tools: sum(periodSessions.map((session) => session.toolCalls)),
    assistantMessages: sum(periodSessions.map((session) => session.assistantMessages)),
    activeMs: sum(periodSessions.map((session) => session.turnMs)),
    tokens: effort.input + effort.output + effort.cacheRead,
    cost: effort.costEur,
    commits: commits.length,
  }
  const humanActiveHours = human.activeMs / 3_600_000
  const humanTotal = human.userMessages + agent.assistantMessages
  const humanAgent = {
    human,
    agent,
    humanActiveHours,
    humanShare: humanTotal > 0 ? human.userMessages / humanTotal : 0,
    agentShare: humanTotal > 0 ? agent.assistantMessages / humanTotal : 0,
    tokens: effort,
    cacheRate: cacheRate(effort),
  }

  const alerts = []
  for (const row of dormant) {
    alerts.push({ level: 'warn', title: `${row.id} sans activité depuis ${row.dormantDays} j`, detail: `${row.title} · ${row.status}` })
  }
  for (const session of ledgerSessions.values()) {
    if (session.costEur > settings.alerts.sessionCostEur) {
      alerts.push({ level: 'warn', title: `Session ${session.id.slice(-4)} à ${fmtEur(session.costEur)}`, detail: `Seuil ${fmtEur(settings.alerts.sessionCostEur)}` })
    }
  }
  for (const mission of done) {
    const journal = journalById.get(mission.id) ?? parseJournal('')
    const cycle = spanDaysOf(missionSessions(links, sessionById, mission.id)) ?? daysBetween(mission.created, closeOf(mission, journal))
    if (cycleMedian > 0 && cycle > cycleMedian * settings.alerts.cycleFactor) {
      alerts.push({ level: 'warn', title: `${mission.id} bouclée en ${fmtDays(cycle)}`, detail: `Médiane ${fmtDays(cycleMedian)} × ${settings.alerts.cycleFactor}` })
    }
  }
  if (dormant.length === 0 && alerts.length === 0) alerts.push({ level: 'ok', title: 'Aucune alerte', detail: 'Aucune mission dormante, aucun coût anormal, aucun cycle hors seuil.' })

  const ledgerInfo = ledger ? ledgerRange(ledger) : null
  const coverage = {
    sources: [
      coverageItem('missions', 'Fiches et journaux', 'ok', `${missions.length} missions`),
      coverageItem('sessions', 'Sessions DSH', sessionList.length ? 'ok' : 'partial', `${sessionList.length} sessions · ${links.size} missions liées`),
      coverageItem('ledger', 'Ledger cost-meter', ledgerInfo ? 'ok' : 'absent', ledgerInfo ? `${ledgerInfo.from} → ${ledgerInfo.to} · ${ledgerInfo.days} jours` : 'fichier introuvable'),
      coverageItem('git', 'Git konoha et dépôts', sources.git ? (sources.git.coverage ? 'ok' : 'partial') : 'absent', sources.git ? `${sources.git.repos.length} dépôts · ${commits.length} commits` : 'non collecté'),
      coverageItem('gh', 'Pull requests via gh', sources.gh ? (sources.gh.errors.length ? 'partial' : 'ok') : 'absent', sources.gh ? `${prsMerged.length} PR fusionnées` : 'non collecté'),
      coverageItem('reviews', 'Reviews', reviewById.size ? 'ok' : 'partial', `${reviews.length} reviews sur la période`),
      coverageItem('jira', 'Jira via jira.sh', sources.jira ? (sources.jira.errors.length ? 'partial' : 'ok') : 'partial', sources.jira ? `${sources.jira.issues.size} tickets` : 'lecture non activée'),
    ],
    gaps: [
      ledgerInfo ? `Effort et coût : depuis le ${shortDate(ledgerInfo.from)}.` : 'Effort et coût : ledger absent.',
      missions.length ? `Missions : depuis le ${shortDate(missions.map((mission) => mission.created).filter(Boolean).sort()[0] ?? range.from)}.` : 'Missions : aucune fiche.',
      sources.jira?.errors?.length ? `Jira : ${sources.jira.errors.length} ticket(s) illisible(s).` : '',
      sources.gh?.errors?.length ? `gh : ${sources.gh.errors.length} dépôt(s) en erreur.` : '',
    ].filter(Boolean),
  }

  const donePoints = sum(done.map((mission) => mission.points))
  const bilanLines = []
  bilanLines.push(
    `${range.label} : ${done.length} mission${done.length > 1 ? 's' : ''} terminée${done.length > 1 ? 's' : ''}, ${created.length} créée${created.length > 1 ? 's' : ''}, ${active.length} en cours, ${waiting.length} en attente. Cycle médian ${fmtDays(cycleMedian)} (p90 ${fmtDays(cycleP90)}).`,
  )
  bilanLines.push(
    `Effort : ${fmtTokens(humanAgent.tokens.input)} tokens en entrée, ${fmtTokens(humanAgent.tokens.output)} en sortie, ${fmtTokens(humanAgent.tokens.cacheRead)} lus en cache (${fmtPct(humanAgent.cacheRate)}) ; ${fmtEur(effort.costEur)} (${pctChange(effort.costEur, effortPrev.costEur) === null ? 'pas de comparaison' : `${pctChange(effort.costEur, effortPrev.costEur) > 0 ? '+' : ''}${fmtPct(pctChange(effort.costEur, effortPrev.costEur))} vs période précédente`}).`,
  )
  bilanLines.push(
    `Production : ${commits.length} commits, ${prsMerged.length} PR fusionnée${prsMerged.length > 1 ? 's' : ''}, ${donePoints} points livrés, ${reviews.length} review${reviews.length > 1 ? 's' : ''}. Qualité : ${reviewUnmet} critère${reviewUnmet > 1 ? 's' : ''} non tenu${reviewUnmet > 1 ? 's' : ''}, ${reviewFindings} constat${reviewFindings > 1 ? 's' : ''}, ${reprises.length} reprise${reprises.length > 1 ? 's' : ''}, ${abandoned.length} abandon${abandoned.length > 1 ? 's' : ''}.`,
  )
  if (alerts.length > 0) bilanLines.push(`Alertes : ${alerts.map((alert) => alert.title).join(' ; ')}.`)
  const bilan = { lines: bilanLines, text: bilanLines.join('\n\n') }

  return {
    generatedAt: new Date().toISOString(),
    period: range,
    counters: {
      done: done.length,
      created: created.length,
      active: active.length,
      waiting: waiting.length,
      dormant: dormant.length,
      queue: open.filter((mission) => mission.queue > 0).length,
      review: open.filter((mission) => ['in_review', 'in_peer_review'].includes(mission.status)).length,
      validation: open.filter((mission) => mission.status === 'awaiting_validation').length,
      abandoned: abandoned.length,
    },
    throughput: { done: done.map((mission) => mission.id), created: created.map((mission) => mission.id), wip: active.length, byType: {}, series },
    cycle: { median: cycleMedian, p90: cycleP90, count: done.length, prevMedian: cyclePrevMedian, segments, series },
    effort: {
      ...effort,
      cacheRate: cacheRate(effort),
      prevCostEur: effortPrev.costEur,
      sessions: ledgerSessions.size,
      byDay,
    },
    production: { commits: commits.length, prs: prsMerged.length, points: donePoints, reviews: reviews.length, byRepo },
    quality: { reviews, unmet: reviewUnmet, findings: reviewFindings, reprises, abandoned: abandoned.map((mission) => mission.id) },
    waiting: filtered.filter((row) => WAITING.has(row.status)).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      days: row.dormantDays,
      depend: (blockedBy[row.id] ?? []).map((entry) => entry.id),
      href: row.href,
    })),
    humanAgent,
    alerts,
    coverage,
    table: filtered,
    filters,
    filterOptions,
    epicProgress: {
      epics: epicProgress,
      orphans: { missions: orphans.length, points: sum(orphans.map((mission) => Number(mission.points) || 0)) },
    },
    bilan,
    missions: open.map((mission) => ({ id: mission.id, title: mission.title, status: mission.status, href: `/performance/mission/${mission.id}` })),
  }
}

export async function buildMission({ roots = resolveRoots(), config = {}, id, sources = {} } = {}) {
  const missions = await scanAllMissions(roots.missionsRoot)
  const mission = missions.find((entry) => entry.id === id)
  if (!mission) return null
  const journal = await readMissionJournal(roots.missionsRoot, mission.dir)
  const parsedJournal = parseJournal(journal.source)
  const review = await readMissionReview(roots.reviewsRoot, mission.id)
  const ledger = readLedger(roots.ledgerFile)
  const links = readLinks(roots.linksFile)
  const sessionList = scanSessions(roots.sessionsRoot, { includeSubagents: true })
  const sessionById = new Map(sessionList.map((session) => [canonicalSessionId(session.id), session]))
  const sessions = missionSessions(links, sessionById, mission.id)
  const dates = datesBetween(mission.created || localDate(), localDate())
  const ledgerSessions = ledger ? sessionsOf(ledger, dates) : new Map()
  const { cost, tokens } = sessionCost(ledgerSessions, sessions)
  const commits = (sources.git?.commits ?? []).filter((commit) => commit.missions.includes(mission.id))
  const close = closeOf(mission, parsedJournal)
  const cycle = { created: mission.created, cadrage: parsedJournal.cadrage, go: parsedJournal.go, review: parsedJournal.review, close, days: spanDaysOf(sessions) ?? daysBetween(mission.created, close || localDate()), age: daysSince(mission.created) }
  const userMessages = sum(sessions.filter((session) => session.delegationDepth === 0).map((session) => session.userMessages))
  const assistantMessages = sum(sessions.map((session) => session.assistantMessages))
  const toolCalls = sum(sessions.map((session) => session.toolCalls))
  return {
    mission,
    journal: parsedJournal,
    journalSource: journal.source,
    review: review.exists ? parseReview(review.source) : null,
    reviewSource: review.source,
    sessions,
    commits,
    cost,
    tokens,
    cycle,
    split: {
      userMessages,
      go: parsedJournal.go ? 1 : 0,
      reviews: review.exists ? 1 : 0,
      assistantMessages,
      toolCalls,
      sessions: sessions.length,
      turns: sum(sessions.map((session) => session.turns)),
      tokens,
      cost,
      commits: commits.length,
    },
    links: {
      mission: `/performance/source/missions/${mission.dir}/mission.md`,
      journal: `/performance/source/missions/${mission.dir}/journal.md`,
      review: review.exists ? `/performance/source/reviews/${mission.id}/review.md` : '',
    },
  }
}
