import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstReadyToDev, importFiche, importJournal, parseJqlKeys, stateOf } from '../lib/performance/jira.js'
import { parseJournal, readMissionJournal, scanAllMissions } from '../lib/missions.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const KONOHA = resolve(HERE, '../../../..')
const JIRA_SH = join(HERE, '../../atlassian/jira.sh')
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

function usage() {
  process.stderr.write(`usage: node sync-jira-dates.mjs [--root <konoha>] [--check] [--only <KEY>]

  --root    racine konoha à mettre à jour (défaut: ${KONOHA})
  --check   vérifie le cache sans le réécrire (sort 1 s'il manque une mission ou un jira.json)
  --only    ne traite qu'un ticket
`)
}

const args = process.argv.slice(2)
let root = process.env.KONOHA_ROOT ? resolve(process.env.KONOHA_ROOT) : KONOHA
let check = false
let only = ''

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--check') check = true
  else if (arg === '--root') {
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      usage()
      process.exit(2)
    }
    root = resolve(value)
    index += 1
  } else if (arg === '--only') {
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      usage()
      process.exit(2)
    }
    only = value.toUpperCase()
    index += 1
  } else if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  } else {
    usage()
    process.exit(2)
  }
}

function runJira(jiraArgs) {
  const env = { ...process.env }
  if (!env.ATLASSIAN_CONF) env.ATLASSIAN_CONF = join(root, 'config', 'tools', 'atlassian', 'config.env')
  return execFileSync('bash', [JIRA_SH, ...jiraArgs], { encoding: 'utf8', timeout: 30_000, env })
}

function journalSource(dir) {
  const file = join(dir, 'journal.md')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

const missionsRoot = join(root, 'missions')
const missions = await scanAllMissions(missionsRoot)
const product = missions.filter((mission) => String(mission.type).toLowerCase() === 'produit')
const byId = new Map(product.map((mission) => [mission.id, mission]))
const epics = [...new Set(product.map((mission) => mission.epic).filter(Boolean))].sort()

if (epics.length === 0) {
  process.stderr.write('aucune epic trouvée dans les missions produit\n')
  process.exit(2)
}

const tickets = new Map()
const errors = []
for (const epic of epics) {
  try {
    const output = runJira(['jql', `parent = ${epic} ORDER BY key ASC`, '--limit', '200'])
    for (const key of parseJqlKeys(output)) if (!tickets.has(key)) tickets.set(key, epic)
  } catch (error) {
    errors.push(`${epic}: ${String(error.stderr ?? error.message).trim()}`)
  }
}

if (only) {
  if (!tickets.has(only)) {
    process.stderr.write(`${only}: absent des epics ${epics.join(', ')}\n`)
    process.exit(2)
  }
  for (const key of [...tickets.keys()]) if (key !== only) tickets.delete(key)
}

const report = { retenu: 0, rejete: 0, 'sans-transition': 0 }
const imported = []
const listed = { retenus: [], rejetes: [], sans: [] }

if (check) {
  const problems = []
  for (const [key] of tickets) {
    const mission = byId.get(key)
    if (!mission) {
      problems.push(`${key}: aucune mission konoha`)
      continue
    }
    const dir = dirname(mission.file)
    const cacheFile = join(dir, 'jira.json')
    if (!existsSync(cacheFile)) {
      problems.push(`${key}: jira.json absent`)
      continue
    }
    const cached = (() => {
      try {
        return JSON.parse(readFileSync(cacheFile, 'utf8'))
      } catch {
        return null
      }
    })()
    if (!cached) {
      problems.push(`${key}: jira.json illisible`)
      continue
    }
    const journal = parseJournal(journalSource(dir))
    const expected = stateOf({
      ready: firstReadyToDev(cached.transitions ?? []),
      created: cached.created,
      journalFirstDate: journal.events[0]?.date ?? '',
    })
    if (cached.state !== expected.state) problems.push(`${key}: état ${cached.state}, attendu ${expected.state}`)
    if ((cached.readyToDev ?? '') !== (firstReadyToDev(cached.transitions ?? [])?.at ?? '')) problems.push(`${key}: readyToDev incohérent`)
  }
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  process.stdout.write(`${tickets.size} ticket(s), ${problems.length} problème(s)\n`)
  process.exit(problems.length > 0 || errors.length > 0 ? 1 : 0)
}

for (const [key, epic] of tickets) {
  let data
  try {
    data = JSON.parse(runJira(['changelog', key, '--json']))
  } catch (error) {
    errors.push(`${key}: ${String(error.stderr ?? error.message).trim()}`)
    continue
  }
  const mission = byId.get(key)
  let dir
  if (mission) {
    dir = dirname(mission.file)
  } else {
    dir = join(missionsRoot, key)
    if (existsSync(join(dir, 'mission.md'))) {
      errors.push(`${key}: mission.md présent hors scan`)
      continue
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mission.md'), importFiche({ key, summary: data.summary, created: data.created, status: data.status, epic, today: TODAY }))
    writeFileSync(join(dir, 'journal.md'), importJournal({ key, summary: data.summary, created: data.created, status: data.status, epic, today: TODAY }))
    imported.push(key)
  }

  const journal = parseJournal(journalSource(dir))
  const ready = firstReadyToDev(data.transitions ?? [])
  const decision = stateOf({ ready, created: data.created, journalFirstDate: journal.events[0]?.date ?? '' })
  const payload = {
    key,
    summary: data.summary,
    created: data.created,
    status: data.status,
    readyToDev: ready?.at ?? '',
    readyFrom: ready?.from ?? '',
    transitions: data.transitions ?? [],
    state: decision.state,
    reason: decision.reason,
    syncedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, 'jira.json'), `${JSON.stringify(payload, null, 2)}\n`)
  report[decision.state] += 1
  if (decision.state === 'retenu') listed.retenus.push(`${key} (${ready?.at})`)
  else if (decision.state === 'rejete') listed.rejetes.push(`${key} (${decision.reason})`)
  else listed.sans.push(key)
}

process.stdout.write(`epics: ${epics.length} (${epics.join(', ')})\n`)
process.stdout.write(`tickets: ${tickets.size}\n`)
process.stdout.write(`importées: ${imported.length}${imported.length ? ` (${imported.join(', ')})` : ''}\n`)
process.stdout.write(`retenus: ${report.retenu}${listed.retenus.length ? ` (${listed.retenus.join(', ')})` : ''}\n`)
process.stdout.write(`rejetés: ${report.rejete}${listed.rejetes.length ? ` (${listed.rejetes.join(', ')})` : ''}\n`)
process.stdout.write(`sans transition: ${report['sans-transition']}\n`)
if (errors.length > 0) {
  process.stderr.write(`erreurs: ${errors.length}\n${errors.join('\n')}\n`)
  process.exitCode = 1
}
