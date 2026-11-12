/**
 * Normalization: from a tracker issue to the panel's shared shape.
 *
 * The canonical vocabulary comes from `projects.yml`; a project's mapping is
 * inverted once (tracker name -> canonical name), never guessed on screen.
 */

/**
 * The one label that says a mission is blocked, on both trackers.
 *
 * It is a label, never a state: the project `map` does not translate it, and a
 * blocked mission keeps the state it already had. The workspace names it, the
 * tracker only stores it.
 */
export const BLOCKED_LABEL = 'blocked'

/** Whether the tracker's labels carry the blocked label (case-insensitive). */
export function isBlocked(labels = []) {
  return (labels ?? []).some((label) => String(label).toLowerCase() === BLOCKED_LABEL)
}

/**
 * Invert one mapping table: tracker values -> canonical names.
 *
 * A canonical name may list several tracker values: a Jira workflow often has
 * more statuses than the canonical vocabulary, and several of them mean the
 * same step (`In Progress` and `Local Testing`, for instance).
 */
function invertTable(table = {}) {
  const inverse = new Map()
  for (const [canonical, value] of Object.entries(table ?? {})) {
    for (const single of Array.isArray(value) ? value : [value]) {
      if (single !== null && single !== undefined) inverse.set(String(single), canonical)
    }
  }
  return inverse
}

/** Invert a project `map`: tracker values -> canonical names. */
export function invertMap(map = {}) {
  return {
    states: invertTable(map.states),
    types: invertTable(map.types),
    priorities: invertTable(map.priorities),
  }
}

/** First value known to the table (GitHub labels, for instance). */
export function firstKnown(values, table) {
  for (const value of values) {
    if (table.has(String(value))) return String(value)
  }
  return null
}

/**
 * The only value known to the table, or none.
 *
 * The workflow allows one state label per mission: two known values are a
 * conflict to fix, not a precedence to resolve. `conflict` names the canonical
 * values, sorted so the message does not depend on the order the tracker
 * returned them in.
 */
export function onlyKnown(values, table) {
  const known = []
  for (const value of values) {
    const key = String(value)
    if (table.has(key) && !known.includes(key)) known.push(key)
  }
  if (known.length === 0) return { value: null, conflict: [] }
  if (known.length === 1) return { value: known[0], conflict: [] }
  const conflict = [...new Set(known.map((value) => table.get(value)))].sort()
  return { value: null, conflict }
}

/**
 * Product of an issue, from its Jira labels and the site's `products` table.
 *
 * The table order decides: the first known label wins. Labels that are themes
 * (`services-residents`), partners or tools are not products.
 */
function productOf(labels, table) {
  const known = new Set((labels ?? []).map((label) => String(label).toLowerCase()))
  for (const [label, name] of Object.entries(table ?? {})) {
    if (known.has(String(label).toLowerCase())) return { id: String(label).toLowerCase(), name }
  }
  return null
}

/**
 * Reduce an issue to the shared shape.
 *
 * A state or type without a mapping stays `null`: the panel shows it as
 * unknown rather than lending it a value. The project is the product label
 * when the source maps one; otherwise it is the declared source.
 */
export function normalizeIssue({
  project,
  key,
  number = null,
  title = '',
  rawState = null,
  stateConflict = [],
  rawType = null,
  rawPriority = null,
  rawPoints = null,
  rawLabels = [],
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

  const product = productOf(rawLabels, project.map?.labels)

  return {
    project: product ? product.id : project.id,
    projectName: product ? product.name : (project.name ?? project.id),
    key,
    number,
    title: String(title ?? ''),
    state,
    stateConflict: Array.isArray(stateConflict) ? stateConflict : [],
    // A label that never maps to a state: reading it does not translate it.
    blocked: isBlocked(rawLabels),
    type,
    priority,
    points,
    // The project's clone on this machine, declared in `projects.yml`: the
    // feedback session is told where the PR lives instead of guessing it.
    repo: project.repo ?? null,
    epic: epic ?? null,
    url: url ?? null,
    updatedAt: updatedAt ?? null,
  }
}
