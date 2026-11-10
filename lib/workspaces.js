/**
 * Workspace lookup, without depending on a host service.
 *
 * The desktop app keeps its workspace registry in `$DSH_HOME/storages/workspace.json`
 * (a `tables.workspaces` map of `id -> { path, ... }`). Reading it is read-only
 * and lets the panel resolve the code workspace even when `ctx.workspaceRegistry`
 * is not exposed to it.
 */

/** Normalise a path for comparison: no trailing slash, `~` expanded. */
export function normalizePath(value, home) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let path = value.trim()
  if (path === '~') path = home
  else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`
  return path.replace(/\/+$/, '')
}

/** Id of the workspace whose path matches, from a parsed registry store. */
export function findWorkspaceId(store, root, home) {
  const target = normalizePath(root, home)
  if (!target) return null

  const table = store?.tables?.workspaces
  if (!table || typeof table !== 'object') return null

  const entries = Array.isArray(table) ? table : Object.entries(table).map(([id, record]) => ({ id, ...record }))
  for (const record of entries) {
    if (!record || typeof record !== 'object') continue
    const path = normalizePath(record.path ?? record.root, home)
    if (path && path === target) return record.id ?? null
  }
  return null
}
