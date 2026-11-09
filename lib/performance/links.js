import { readFileSync } from 'node:fs'

export function readLinks(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessions = parsed?.sessions ?? {}
    const links = new Map()
    for (const [missionId, ids] of Object.entries(sessions)) {
      links.set(missionId, new Set((Array.isArray(ids) ? ids : []).map((id) => String(id))))
    }
    return links
  } catch {
    return new Map()
  }
}

export function linksFor(links, missionId) {
  return links.get(missionId) ?? new Set()
}

export function inverseLinks(links) {
  const inverse = new Map()
  for (const [missionId, ids] of links) {
    for (const id of ids) {
      if (!inverse.has(id)) inverse.set(id, new Set())
      inverse.get(id).add(missionId)
    }
  }
  return inverse
}
