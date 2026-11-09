import { readFileSync } from 'node:fs'

const TOTAL_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'costEur']

export function readLedger(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.days ? parsed : null
  } catch {
    return null
  }
}

export function emptyTotal() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, costEur: 0 }
}

export function sumDays(ledger, dates) {
  const total = emptyTotal()
  for (const date of dates) {
    const day = ledger?.days?.[date]
    if (!day) continue
    for (const key of TOTAL_KEYS) total[key] += Number(day[key]) || 0
  }
  return total
}

export function sessionsOf(ledger, dates) {
  const byId = new Map()
  for (const date of dates) {
    for (const session of ledger?.days?.[date]?.sessions ?? []) {
      if (!session || typeof session.id !== 'string') continue
      const previous = byId.get(session.id)
      const costEur = Number(session.costEur) || 0
      const input = Number(session.input) || 0
      const output = Number(session.output) || 0
      const cacheRead = Number(session.cacheRead) || 0
      if (previous) {
        previous.costEur += costEur
        previous.input += input
        previous.output += output
        previous.cacheRead += cacheRead
        previous.calls += Number(session.calls) || 0
      } else {
        byId.set(session.id, {
          id: session.id,
          date,
          at: Number(session.at) || 0,
          input,
          output,
          cacheRead,
          calls: Number(session.calls) || 0,
          costEur,
        })
      }
    }
  }
  return byId
}

export function cacheRate(total) {
  const input = Number(total?.input) || 0
  const reads = Number(total?.cacheRead) || 0
  return input + reads > 0 ? reads / (input + reads) : 0
}

export function ledgerRange(ledger) {
  const dates = Object.keys(ledger?.days ?? {}).sort()
  return { from: dates[0] ?? '', to: dates.at(-1) ?? '', days: dates.length }
}
