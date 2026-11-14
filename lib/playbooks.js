/**
 * The five playbook pages, read and written by the panel.
 *
 * One list, derived from `PLAYBOOK_STEP_FILES` and `PLAYBOOK_WORKSPACE` in
 * `lib/view.js`: the page of a step is named `cadrage`, `execution`, `revue` or
 * `cloture`, and the free page is `workspace`. The list is the perimeter — a
 * page outside it is refused before any path is built, so the route can never
 * be told to read or write another file.
 *
 * The form of a page is `lib/playbook-rules.js`, the rules the CLI applies: a
 * save refuses exactly what `node tools/check-playbook.mjs` would refuse, and
 * never writes when it refuses. The index (`playbook/README.md`) is not a page:
 * no route names it, and nothing here creates or removes a file.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomically } from './branches.js'
import { checkPage } from './playbook-rules.js'
import { PLAYBOOK_DIR, PLAYBOOK_STEP_FILES, PLAYBOOK_WORKSPACE } from './view.js'

/** A refusal the host answers as is: a status, a message, and the page's errors. */
export class PlaybookError extends Error {
  constructor(status, message, errors = []) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

/**
 * The pages the panel may open, in parcours order then the workspace.
 *
 * `page` is the file name without `.md` — URL-safe, accents kept out of the
 * route — and `step` is the French key of `PLAYBOOK_STEP_FILES`, or null for
 * the workspace page.
 */
export const PLAYBOOK_PAGES = Object.freeze([
  ...Object.entries(PLAYBOOK_STEP_FILES).map(([step, file]) => ({
    page: file.slice(0, -'.md'.length),
    name: file,
    file: `${PLAYBOOK_DIR}/${file}`,
    step,
  })),
  {
    page: PLAYBOOK_WORKSPACE.slice(0, -'.md'.length),
    name: PLAYBOOK_WORKSPACE,
    file: `${PLAYBOOK_DIR}/${PLAYBOOK_WORKSPACE}`,
    step: null,
  },
])

/** The page of a route parameter, or null when it is outside the list. */
export function findPlaybookPage(page) {
  const wanted = typeof page === 'string' ? page.trim() : ''
  return PLAYBOOK_PAGES.find((entry) => entry.page === wanted) ?? null
}

function toRoot(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : String(dir)
}

function titleOf(source) {
  const match = /^#\s+(.+)$/m.exec(source)
  return match ? match[1].trim() : null
}

function lineCount(source) {
  return (source.match(/\n/g) ?? []).length
}

async function readEntry(root, entry) {
  const path = join(root, entry.name)
  let source
  let info
  try {
    ;[source, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { ...entry, title: null, lines: 0, exists: false, text: null, mtimeMs: null }
  }
  return {
    ...entry,
    title: titleOf(source),
    lines: lineCount(source),
    exists: true,
    text: source,
    mtimeMs: info.mtimeMs,
  }
}

/**
 * The five pages, without their text: what the list shows.
 *
 * A page missing from the disk keeps its place with `exists: false` — the
 * contract names it, and the panel has to say so rather than hide it.
 */
export async function listPlaybooks(playbookDir) {
  const root = toRoot(playbookDir)
  const pages = []
  for (const entry of PLAYBOOK_PAGES) {
    const read = await readEntry(root, entry)
    const { text, mtimeMs, name, ...visible } = read
    pages.push(visible)
  }
  return pages
}

/** One page as raw markdown, with the version a save must send back. */
export async function readPlaybook(playbookDir, page) {
  const entry = findPlaybookPage(page)
  if (!entry) throw new PlaybookError(400, `unknown playbook page: ${page ?? ''}`)
  const root = toRoot(playbookDir)
  const read = await readEntry(root, entry)
  if (!read.exists) throw new PlaybookError(404, `${entry.file} is missing`)
  const { name, ...visible } = read
  return visible
}

/**
 * Validate a page, refuse it without writing, then write it atomically.
 *
 * `mtimeMs` is the version the client read: the file must still be the one it
 * saw, or the answer is a 409 — the panel never overwrites an editor's change
 * it did not show. The save re-reads the file afterwards, because the atomic
 * write renews the mtime: the response carries the new version.
 */
export async function savePlaybook(playbookDir, body = {}) {
  const entry = findPlaybookPage(body.page)
  if (!entry) throw new PlaybookError(400, `unknown playbook page: ${body.page ?? ''}`)
  if (typeof body.text !== 'string') throw new PlaybookError(400, 'text is missing')
  if (typeof body.mtimeMs !== 'number' || !Number.isFinite(body.mtimeMs)) {
    throw new PlaybookError(400, 'mtimeMs is missing')
  }

  const root = toRoot(playbookDir)
  const current = await readEntry(root, entry)
  if (!current.exists) throw new PlaybookError(404, `${entry.file} is missing`)
  if (current.mtimeMs !== body.mtimeMs) {
    throw new PlaybookError(409, `${entry.file} changed since it was read`)
  }

  const errors = []
  checkPage(entry.file, body.text, errors)
  if (errors.length > 0) throw new PlaybookError(400, 'page invalid', errors)

  await writeAtomically(join(root, entry.name), body.text)

  const saved = await readEntry(root, entry)
  return savedPlaybook(saved)
}

/** What a successful save answers: the page, without its text, and its version. */
export function savedPlaybook(read = {}) {
  const { text, name, ...visible } = read
  return visible
}
