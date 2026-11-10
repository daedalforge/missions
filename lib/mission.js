/**
 * Normalization: from a tracker issue to the panel's shared shape.
 *
 * The canonical vocabulary comes from `projects.yml`; a project's mapping is
 * inverted once (tracker name -> canonical name), never guessed on screen.
 */

/** Invert a project `map`: tracker values -> canonical names. */
export function invertMap(map = {}) {
  const states = new Map()
  const types = new Map()
  const priorities = new Map()
  for (const [canonical, value] of Object.entries(map.states ?? {})) {
    if (value !== null && value !== undefined) states.set(String(value), canonical)
  }
  for (const [canonical, value] of Object.entries(map.types ?? {})) {
    if (value !== null && value !== undefined) types.set(String(value), canonical)
  }
  for (const [canonical, value] of Object.entries(map.priorities ?? {})) {
    if (value !== null && value !== undefined) priorities.set(String(value), canonical)
  }
  return { states, types, priorities }
}

/** First value known to the table (GitHub labels, for instance). */
export function firstKnown(values, table) {
  for (const value of values) {
    if (table.has(String(value))) return String(value)
  }
  return null
}

/**
 * Reduce an issue to the shared shape.
 *
 * A state or type without a mapping stays `null`: the panel shows it as
 * unknown rather than lending it a value.
 */
export function normalizeIssue({
  project,
  key,
  number = null,
  title = '',
  rawState = null,
  rawType = null,
  rawPriority = null,
  rawPoints = null,
  epic = null,
  url = null,
  updatedAt = null,
  inverse,
}) {
  const state = rawState === null || rawState === undefined ? null : (inverse.states.get(String(rawState)) ?? null)
  const type = rawType === null || rawType === undefined ? null : (inverse.types.get(String(rawType)) ?? null)
  const priority =
    rawPriority === null || rawPriority === undefined ? null : (inverse.priorities.get(String(rawPriority)) ?? null)
  const points = Number.isFinite(Number(rawPoints)) && rawPoints !== null && rawPoints !== '' ? Number(rawPoints) : null

  return {
    project: project.id,
    key,
    number,
    title: String(title ?? ''),
    state,
    type,
    priority,
    points,
    epic: epic ?? null,
    url: url ?? null,
    updatedAt: updatedAt ?? null,
  }
}
