/**
 * Normalization: from a tracker issue to the panel's shared shape.
 *
 * The canonical vocabulary comes from `projects.yml`; a project's mapping is
 * inverted once (tracker name -> canonical name), never guessed on screen.
 */

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
    type,
    priority,
    points,
    epic: epic ?? null,
    url: url ?? null,
    updatedAt: updatedAt ?? null,
  }
}
