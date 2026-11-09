import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MISSION_ID = /\b(?:SLV|SOC|SO)-\d+\b/g
const JIRA_KEYS = /\b(?:SOC|SO)-\d+\b/g

export async function collectGit({ konohaRoot, projectsRoot, from, to, timeoutMs = 6000 }) {
  const commits = []
  const repos = []
  const roots = [konohaRoot]
  try {
    for (const name of readdirSync(projectsRoot)) {
      const repo = join(projectsRoot, name)
      try {
        const stat = statSync(join(repo, '.git'))
        if (stat.isDirectory() || stat.isFile()) roots.push(repo)
      } catch {
      }
    }
  } catch {
  }
  for (const repo of roots) {
    try {
      const { stdout } = await run(
        'git',
        ['-C', repo, 'log', `--since=${from}T00:00:00`, `--until=${to}T23:59:59`, '--format=%H%x09%ad%x09%s', '--date=iso-strict'],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      )
      const list = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, date, ...rest] = line.split('\t')
          const subject = rest.join('\t')
          return { repo, hash, date, subject, missions: [...new Set(subject.match(MISSION_ID) ?? [])] }
        })
      commits.push(...list)
      repos.push({ repo, commits: list.length, status: 'ok' })
    } catch (error) {
      repos.push({ repo, commits: 0, status: 'absent', message: String(error?.message ?? error) })
    }
  }
  return { commits, repos, coverage: { from, to } }
}

export async function collectPullRequests({ repos, from, timeoutMs = 10000, limit = 10 }) {
  const prs = []
  const errors = []
  for (const repo of repos.slice(0, limit)) {
    try {
      const { stdout } = await run(
        'gh',
        ['pr', 'list', '--state', 'merged', '--search', `merged:>=${from}`, '--json', 'number,title,url,mergedAt', '--limit', '50'],
        { cwd: repo, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      )
      for (const pr of JSON.parse(stdout || '[]')) prs.push({ ...pr, repo })
    } catch (error) {
      errors.push({ repo, message: String(error?.message ?? error) })
    }
  }
  return { prs, errors }
}

export async function collectJira({ jiraScript, keys, timeoutMs = 20000 }) {
  const issues = new Map()
  const errors = []
  for (const key of [...new Set(keys)]) {
    try {
      const { stdout } = await run(jiraScript, ['issue', key, '--json'], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 })
      issues.set(key, JSON.parse(stdout))
    } catch (error) {
      errors.push({ key, message: String(error?.message ?? error) })
    }
  }
  return { issues, errors }
}

export function jiraKeysOf(missions) {
  const keys = new Set()
  for (const mission of missions) {
    for (const key of `${mission.epic} ${mission.id}`.match(JIRA_KEYS) ?? []) keys.add(key)
  }
  return [...keys]
}
