import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { GIT_TIMEOUT_MS, execGit } from './repositories.js'

/**
 * The translation side of a mission: which `t('…')` keys the files its branch
 * changes call, and which of them are missing from the project's declared
 * locales.
 *
 * The diff alone decides the scope, and the files are read in the branch, never
 * in the worktree: a key outside the branch is not this mission's business.
 * Nothing here reaches Tolgee.
 */

/** The XLIFF file written in the mission folder, next to `mission.yml`. */
export const IMPORT_FILE = 'import-tolgee.xliff'

/** Tests and Cypress specs ship no translation key. */
const NOT_SHIPPED = /\.(test|cy)\.[^/]+$/

/** `t('literal')` or `t("literal")`, the form Manager uses. */
const CALL = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g

/** A refused import is a message for the panel, not a crash. */
export class TolgeeError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.name = 'TolgeeError'
    this.status = status
  }
}

export function isShippedFile(file) {
  return !NOT_SHIPPED.test(String(file))
}

/** Calls of one source text, with their key and their offset in the text. */
export function extractCalls(text) {
  const calls = []
  for (const match of String(text).matchAll(CALL)) {
    calls.push({ key: unescapeKey(match[2]), index: match.index })
  }
  return calls
}

function unescapeKey(value) {
  return value.replace(/\\(['"\\])/g, '$1')
}

/** The 1-based line of an offset: the note names `file:line`. */
export function lineOf(text, index) {
  let line = 1
  for (let at = 0; at < index; at += 1) {
    if (String(text).charCodeAt(at) === 10) line += 1
  }
  return line
}

/**
 * Read a dotted key in a translations table. i18next files mix flat keys and
 * nested objects, and a flat key wins: it is the exact name the file declares.
 */
export function lookup(table, key) {
  if (table === null || typeof table !== 'object') return undefined
  if (Object.hasOwn(table, key)) return table[key]
  let cursor = table
  for (const part of String(key).split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** A locale says nothing with an absent, null, or blank value. */
export function isPresent(value) {
  if (value === undefined || value === null) return false
  return typeof value === 'string' ? value.trim() !== '' : true
}

export function expandHome(value) {
  const text = String(value ?? '')
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/**
 * The files the branch changes, against the merge base with the base branch:
 * the three-dot form ignores what landed on the base since the branch started.
 */
export async function changedFiles({ repo, base, branch, run = execGit }) {
  const root = expandHome(repo)
  let stdout
  try {
    ;({ stdout } = await run('git', ['-C', root, 'diff', '--name-only', `${base}...${branch}`], {
      timeout: GIT_TIMEOUT_MS,
    }))
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]
    throw new TolgeeError(`cannot read the diff of ${branch} against ${base}: ${detail}`)
  }
  return String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isShippedFile)
}

/** One table per declared locale, read from `languageFile`. */
export async function readLocales({ repo, translations, read = readFile }) {
  const root = expandHome(repo)
  const locales = []
  for (const locale of translations.locales) {
    const path = translations.languageFile.replaceAll('{locale}', locale)
    let text
    try {
      text = await read(join(root, path), 'utf8')
    } catch (error) {
      throw new TolgeeError(`${path} is missing for ${locale}: ${error?.code ?? 'read failed'}`)
    }
    try {
      locales.push({ locale, table: JSON.parse(text) })
    } catch {
      throw new TolgeeError(`${path} is not valid JSON`)
    }
  }
  return locales
}

/** The branch's own version of a file: the worktree may sit on another revision. */
async function readOnBranch({ repo, branch, file, run }) {
  const root = expandHome(repo)
  const { stdout } = await run('git', ['-C', root, 'show', `${branch}:${file}`], { timeout: GIT_TIMEOUT_MS })
  return String(stdout ?? '')
}

/** A file the branch removed from the diff is skipped, not an error. */
function branchReadReason(error, branch) {
  const detail = String(error?.stderr ?? error?.message ?? error).trim().split('\n')[0]
  if (/does not exist in/.test(detail)) {
    return `deleted on ${branch}, skipped`
  }
  return detail || 'read failed'
}

/** Every key called by the files, with the occurrences that call it. */
export async function collectCalls({ repo, branch, files, run = execGit }) {
  const calls = new Map()
  const warnings = []
  for (const file of files) {
    let text
    try {
      text = await readOnBranch({ repo, branch, file, run })
    } catch (error) {
      warnings.push(`${file}: ${branchReadReason(error, branch)}`)
      continue
    }
    for (const call of extractCalls(text)) {
      const occurrence = `${file}:${lineOf(text, call.index)}`
      const entry = calls.get(call.key) ?? { key: call.key, occurrences: [] }
      if (!entry.occurrences.includes(occurrence)) entry.occurrences.push(occurrence)
      calls.set(call.key, entry)
    }
  }
  return { calls, warnings }
}

/**
 * Split the calls in two: a key the reference locale does not write yet cannot
 * be imported (it is listed apart), a key missing from any other locale is the
 * import itself.
 */
export function missingKeys({ calls, locales, reference }) {
  const referenceTable = locales.find((entry) => entry.locale === reference)?.table
  const keys = []
  const untranslated = []
  for (const call of calls.values()) {
    const value = lookup(referenceTable, call.key)
    if (!isPresent(value)) {
      untranslated.push({ key: call.key, occurrences: call.occurrences })
      continue
    }
    const missing = locales
      .filter((entry) => !isPresent(lookup(entry.table, call.key)))
      .map((entry) => entry.locale)
    if (missing.length > 0) keys.push({ key: call.key, value, missing, occurrences: call.occurrences })
  }
  return { keys, untranslated }
}

/**
 * The whole check: the branch's files, the project's locales, the keys to
 * import. A branch absent locally or a diff with no source file is refused with
 * a message, never answered with an empty file.
 */
export async function planImport({ repo, base, branch, translations, run = execGit, read = readFile } = {}) {
  if (!repo) throw new TolgeeError('the project declares no repository')
  if (!translations) throw new TolgeeError('the project declares no translations')
  if (!base || !branch) throw new TolgeeError('the mission declares no branch or base')
  const files = await changedFiles({ repo, base, branch, run })
  if (files.length === 0) {
    throw new TolgeeError(`no changed source file on ${branch} against ${base}`)
  }
  const locales = await readLocales({ repo, translations, read })
  const { calls, warnings } = await collectCalls({ repo, branch, files, run })
  const { keys, untranslated } = missingKeys({ calls, locales, reference: translations.reference })
  return { files, keys, untranslated, warnings }
}
