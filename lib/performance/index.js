import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, buildMission, buildWeek, localDate, periodRange, resolveRoots } from './metrics.js'
import { collectGit, collectJira, collectPullRequests, jiraKeysOf } from './sources.js'
import { scanAllMissions } from '../missions.js'
import { renderBilanPage, renderPage } from './render.js'
import { clearTimelineCache, timelineData } from './timeline.js'
import { buildDay, saveDay } from './bilan.js'
import { hasSnapshot, readLatestSnapshot, readSnapshot, snapshotKey, writeSnapshot } from './snapshot.js'

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(homedir(), '.dsh', 'storages', 'dsh-performance', 'config.json')
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()
const cache = new Map()
let refreshing = null
let refreshingDay = null

function loadConfig(overrides = {}) {
  let file = {}
  try {
    if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    file = {}
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...file,
    ...overrides,
    alerts: { ...DEFAULT_CONFIG.alerts, ...file.alerts, ...overrides.alerts },
    sources: { ...DEFAULT_CONFIG.sources, ...file.sources, ...overrides.sources },
    roots: { ...DEFAULT_CONFIG.roots, ...file.roots, ...overrides.roots },
  }
}

async function collectSources(settings, roots, range) {
  const sources = {}
  if (settings.sources?.git) {
    try {
      sources.git = await collectGit({ konohaRoot: roots.konohaRoot, projectsRoot: roots.projectsRoot, from: range.from, to: range.to })
    } catch {
      sources.git = { commits: [], repos: [], coverage: 'git indisponible' }
    }
  }
  if (settings.sources?.gh) {
    try {
      sources.gh = await collectPullRequests({ repos: (sources.git?.repos ?? []).map((entry) => entry.repo).filter(Boolean), from: range.from })
    } catch {
      sources.gh = { prs: [], errors: ['gh indisponible'] }
    }
  }
  return sources
}

function ttlOf(settings) {
  return Math.max(60_000, (Number(settings.refreshSeconds) || 300) * 1000)
}

function cleanFilters(filters) {
  return !Object.values(filters ?? {}).some((value) => value)
}

function triggerRefresh(settings) {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      return await weekData(settings, { period: 'week', anchor: localDate(new Date()), filters: {}, force: true })
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

function triggerDayRefresh(settings, date) {
  if (refreshingDay) return refreshingDay
  refreshingDay = (async () => {
    try {
      return await weekData(settings, { period: 'day', anchor: date, filters: {}, force: true })
    } finally {
      refreshingDay = null
    }
  })()
  return refreshingDay
}

async function weekData(settings, { period, anchor, filters, force = false }) {
  const roots = resolveRoots(settings)
  const ttl = ttlOf(settings)
  const range = periodRange(period, anchor)
  const key = snapshotKey(range.kind, range.from)
  const memKey = JSON.stringify({ period, anchor, filters, git: settings.sources?.git, gh: settings.sources?.gh, jira: settings.sources?.jira })
  if (!force) {
    if (cleanFilters(filters)) {
      const snapshot = readSnapshot(key)
      if (snapshot && snapshot.week?.period?.to === range.to) {
        const ageMs = Date.now() - snapshot.generatedAt
        return {
          week: { ...snapshot.week, snapshot: { generatedAt: snapshot.generatedAt, ageMs } },
          roots,
          fromSnapshot: true,
          stale: ageMs >= ttl,
        }
      }
    }
    const hit = cache.get(memKey)
    if (hit && Date.now() - hit.at < ttl) return { week: hit.week, roots, fromSnapshot: false }
  }
  const sources = await collectSources(settings, roots, range)
  let week = await buildWeek({ roots, config: settings, period, anchor, filters, sources })
  if (settings.sources?.jira) {
    const keys = [...new Set(week.table
      .filter((row) => row.type !== 'container' && row.type !== 'poc')
      .map((row) => row.id)
      .filter((id) => /^(SOC|SO)-\d+$/.test(id)))]
    if (keys.length > 0 && keys.length <= 60) {
      try {
        sources.jira = await collectJira({ jiraScript: roots.jiraScript, keys, timeoutMs: 1500 })
        week = await buildWeek({ roots, config: settings, period, anchor, filters, sources })
      } catch {
        sources.jira = { issues: new Map(), errors: ['jira indisponible'] }
      }
    }
  }
  const snapshot = writeSnapshot(key, { period, anchor, filters, week })
  week = { ...week, snapshot: { generatedAt: snapshot.generatedAt, ageMs: 0 } }
  cache.set(memKey, { at: snapshot.generatedAt, week })
  return { week, roots, fromSnapshot: false }
}

function readSource(konohaRoot, rel) {
  if (!rel || rel.includes('\0')) return null
  const abs = resolve(konohaRoot, rel)
  if (!abs.startsWith(`${konohaRoot.replace(/\/$/, '')}/`)) return null
  if (!/\.(md|txt)$/.test(abs)) return null
  try {
    const stat = statSync(abs)
    if (!stat.isFile() || stat.size > 1_000_000) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

function filtersOf(url) {
  return Object.fromEntries(['type', 'epic', 'repo', 'status'].map((key) => [key, url.searchParams.get(key) ?? '']))
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        req.destroy()
        resolveBody('')
      }
    })
    req.on('end', () => resolveBody(data))
    req.on('error', () => resolveBody(''))
  })
}

function renderLoadingPage(target = '/performance/panel', label = 'Chargement des données de performance…') {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Performance</title>
<style>
html,body{margin:0;height:100%;background:#f7f9fb;color:#4a5a6a;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.wrap{display:flex;height:100%;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px}
.dot{width:26px;height:26px;border-radius:50%;border:2px solid #23A6D9;border-right-color:transparent;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="wrap"><div class="dot"></div><p>${label}</p></div>
<script>
const target = ${JSON.stringify(target)}
let tries = 0
async function poll() {
  tries += 1
  try {
    const response = await fetch('/performance/api/version', { cache: 'no-store' })
    const body = await response.json()
    if (body.generatedAt && !body.building) { location.replace(target); return }
  } catch {}
  if (tries >= 150) { document.querySelector('p').textContent = 'La collecte échoue : recharger la page pour réessayer.'; return }
  setTimeout(poll, 700)
}
poll()
</script></body></html>`
}

async function handle(settings, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const send = (status, type, body) => {
    res.statusCode = status
    res.setHeader('content-type', type)
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }
  try {
    if (path === '/performance/panel.css') return send(200, 'text/css; charset=utf-8', readFileSync(join(here, 'panel.css')))
    if (path === '/performance/panel.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(join(here, 'panel.js')))
    if (path === '/performance/api/health') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, version: VERSION }))
    if (path === '/performance/bilan.js') return send(200, 'text/javascript; charset=utf-8', readFileSync(join(here, 'bilan-client.js')))

    if (path === '/performance/bilan') {
      const date = url.searchParams.get('date') ?? localDate(new Date())
      const filters = filtersOf(url)
      const dayKey = snapshotKey('day', periodRange('day', date).from)
      if (cleanFilters(filters) && !hasSnapshot(dayKey)) {
        triggerDayRefresh(settings, date).catch(() => {})
        return send(200, 'text/html; charset=utf-8', renderLoadingPage(url.pathname + url.search))
      }
      const result = await weekData(settings, { period: 'day', anchor: date, filters })
      if (result.stale) triggerDayRefresh(settings, date).catch(() => {})
      return send(200, 'text/html; charset=utf-8', renderBilanPage(buildDay(result.week, date)))
    }

    if (path === '/performance/api/bilan/day') {
      const date = url.searchParams.get('date') ?? localDate(new Date())
      if (req.method === 'POST') {
        const body = await readBody(req)
        let patch = {}
        try {
          patch = JSON.parse(body || '{}')
        } catch {
          return send(400, 'application/json; charset=utf-8', JSON.stringify({ error: 'json invalide' }))
        }
        const day = saveDay(typeof patch.date === 'string' && patch.date ? patch.date : date, patch)
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, day }))
      }
      const result = await weekData(settings, { period: 'day', anchor: date, filters: filtersOf(url) })
      return send(200, 'application/json; charset=utf-8', JSON.stringify(buildDay(result.week, date)))
    }

    if (path === '/performance/api/refresh') {
      clearTimelineCache()
      const { week } = await triggerRefresh(settings)
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, generatedAt: week?.snapshot?.generatedAt ?? Date.now() }))
    }

    if (path === '/performance/api/version') {
      const snapshot = readLatestSnapshot()
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, generatedAt: snapshot?.generatedAt ?? null, ageMs: snapshot ? Date.now() - snapshot.generatedAt : null, building: Boolean(refreshing || refreshingDay) }))
    }

    if (path === '/performance/panel') {
      const period = url.searchParams.get('period') ?? 'week'
      const anchor = url.searchParams.get('anchor') ?? localDate(new Date())
      const missionId = url.searchParams.get('mission')
      const filters = filtersOf(url)
      const panelKey = snapshotKey(period, periodRange(period, anchor).from)
      if (cleanFilters(filters) && !hasSnapshot(panelKey)) {
        (period === 'week' ? triggerRefresh(settings) : triggerDayRefresh(settings, anchor)).catch(() => {})
        return send(200, 'text/html; charset=utf-8', renderLoadingPage(url.pathname + url.search))
      }
      const result = await weekData(settings, { period, anchor, filters })
      if (result.stale) (period === 'week' ? triggerRefresh(settings) : triggerDayRefresh(settings, anchor)).catch(() => {})
      const mission = missionId ? await buildMission({ roots: result.roots, config: settings, id: missionId }) : null
      return send(200, 'text/html; charset=utf-8', renderPage({ week: result.week, mission }))
    }

    if (path === '/performance/timeline') {
      const period = url.searchParams.get('period') ?? 'week'
      const anchor = url.searchParams.get('anchor') ?? ''
      const timeline = await timelineData(settings, { period, anchor: anchor || undefined })
      return send(200, 'text/html; charset=utf-8', renderPage({ timeline }))
    }

    if (path === '/performance/api/week') {
      const period = url.searchParams.get('period') ?? 'week'
      const anchor = url.searchParams.get('anchor') ?? localDate(new Date())
      const result = await weekData(settings, { period, anchor, filters: filtersOf(url) })
      if (result.stale) (period === 'week' ? triggerRefresh(settings) : triggerDayRefresh(settings, anchor)).catch(() => {})
      return send(200, 'application/json; charset=utf-8', JSON.stringify(result.week))
    }

    if (path === '/performance/api/mission') {
      const id = url.searchParams.get('id')
      if (!id) return send(400, 'application/json; charset=utf-8', JSON.stringify({ error: 'id requis' }))
      const roots = resolveRoots(settings)
      const mission = await buildMission({ roots, config: settings, id })
      return send(200, 'application/json; charset=utf-8', JSON.stringify(mission))
    }

    if (path === '/performance/api/bilan') {
      const period = url.searchParams.get('period') ?? 'week'
      const anchor = url.searchParams.get('anchor') ?? localDate(new Date())
      const result = await weekData(settings, { period, anchor, filters: filtersOf(url) })
      if (result.stale) triggerRefresh(settings).catch(() => {})
      const week = result.week
      const text = typeof week.bilan === 'string' ? week.bilan : (week.bilan?.markdown ?? (week.bilan?.lines ?? []).join('\n'))
      return send(200, 'text/markdown; charset=utf-8', text)
    }

    if (path === '/performance/source') {
      const rel = url.searchParams.get('path')
      const roots = resolveRoots(settings)
      const text = readSource(roots.konoha, rel)
      if (text == null) return send(404, 'text/plain; charset=utf-8', 'introuvable')
      return send(200, 'text/markdown; charset=utf-8', text)
    }

    return send(404, 'text/plain; charset=utf-8', 'introuvable')
  } catch (error) {
    return send(500, 'application/json; charset=utf-8', JSON.stringify({ error: String(error?.message ?? error) }))
  }
}

export function apply(ctx, config = {}) {
  const settings = loadConfig(config)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/performance', handler: (req, res) => handle(settings, req, res) }))
  ctx.effect(() => {
    const warm = setTimeout(() => {
      triggerRefresh(settings)
        .catch(() => {})
        .then(() => triggerDayRefresh(settings, localDate(new Date())))
        .catch(() => {})
    }, 2_000)
    const timer = setInterval(() => { triggerRefresh(settings).catch(() => {}) }, ttlOf(settings))
    return () => {
      clearTimeout(warm)
      clearInterval(timer)
    }
  })
}
