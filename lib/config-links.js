import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { parse } from 'yaml'

/**
 * The links that carry this repository's configuration to the machine.
 *
 * `config/links-home.yml` declares, link by link, a `source` relative to the
 * repository root, a real `target` expressed from `$HOME`, and an optional
 * `platform` (`darwin`, `linux`). The platform bound exists because the same
 * file does not live in the same place on every system, and because a
 * configuration may be meaningless elsewhere.
 *
 * Everything here is pure: reading the manifest text, validating it, computing
 * the links for one platform and one home, and deciding what an observed target
 * means. The filesystem work belongs to `tools/link-config.mjs`, which keeps the
 * decisions testable without touching a real home.
 */

/** The platforms a link may be bound to. */
export const PLATFORMS = ['darwin', 'linux']

/** Outcomes of observing a target, before anything is written. */
export const LINK_OK = 'ok'
export const LINK_MISSING = 'missing'
export const LINK_DRIFT = 'drift'
export const LINK_BLOCKED = 'blocked'

/**
 * Read and validate a manifest from its text.
 *
 * An unknown platform, an absolute or escaping `source`, a `target` outside
 * `$HOME`, a missing field and a target declared twice are all errors: a typo
 * must fail loudly rather than silently produce a link to nowhere.
 */
export function parseManifest(text, { file = 'config/links-home.yml' } = {}) {
  let raw
  try {
    raw = parse(String(text))
  } catch (error) {
    throw new Error(`${file}: invalid YAML — ${error.message}`)
  }
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: expected a mapping with a "links" list`)
  }
  if (!Array.isArray(raw.links) || raw.links.length === 0) {
    throw new Error(`${file}: "links" must be a non-empty list`)
  }

  const links = raw.links.map((entry, index) => readLink(entry, index, file))
  assertUniqueTargets(links, file)
  return { links }
}

function readLink(entry, index, file) {
  const at = `${file}: links[${index}]`
  if (entry === null || entry === undefined || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${at} must be a mapping`)
  }

  const source = String(entry.source ?? '').trim()
  const target = String(entry.target ?? '').trim()
  const platform = entry.platform === null || entry.platform === undefined ? null : String(entry.platform).trim()

  if (!source) throw new Error(`${at}: "source" is missing`)
  if (!target) throw new Error(`${at}: "target" is missing`)
  if (isAbsolute(source) || escapes(normalize(source))) {
    throw new Error(`${at}: "source" must be a relative path inside the repository, without ".."`)
  }
  if (!target.startsWith('~/')) {
    throw new Error(`${at}: "target" must start with "~/" (the link is declared from $HOME)`)
  }
  if (escapes(normalize(target.slice(2)))) {
    throw new Error(`${at}: "target" must stay inside $HOME`)
  }
  if (platform !== null && !PLATFORMS.includes(platform)) {
    throw new Error(`${at}: unknown platform "${platform}" (expected one of ${PLATFORMS.join(', ')})`)
  }

  return { source: normalize(source), target, platform }
}

/** Whether a normalized relative path walks above its root. */
function escapes(path) {
  return path === '..' || path.startsWith(`..${sep}`)
}

function assertUniqueTargets(links, file) {
  const seen = new Map()
  for (const link of links) {
    const previous = seen.get(link.target)
    if (previous) {
      throw new Error(`${file}: target "${link.target}" is declared twice (${previous} and ${link.source})`)
    }
    seen.set(link.target, link.source)
  }
}

/**
 * The declared sources that are absent from the repository.
 *
 * The check takes an `exists` predicate instead of reading the filesystem, so
 * the contract is the same in a test and in the command.
 */
export function missingSources(manifest, { repoRoot, exists }) {
  if (typeof exists !== 'function') throw new Error('missingSources needs an "exists" predicate')
  return manifest.links.filter((link) => !exists(join(repoRoot, link.source))).map((link) => link.source)
}

/**
 * The links that apply to one platform and one home.
 *
 * Returns absolute paths: the source resolved inside the repository, the target
 * resolved inside `home`. A link with no platform applies everywhere.
 */
export function planLinks(manifest, { platform, home, repoRoot }) {
  const name = String(platform ?? '').trim()
  if (!PLATFORMS.includes(name)) {
    throw new Error(`unknown platform "${name}" (expected one of ${PLATFORMS.join(', ')})`)
  }
  if (!home) throw new Error('a home directory is required')
  const root = resolve(String(home))

  return manifest.links
    .filter((link) => link.platform === null || link.platform === name)
    .map((link) => {
      const source = resolve(repoRoot, link.source)
      const target = resolve(root, link.target.slice(2))
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error(`target "${link.target}" resolves outside the home directory`)
      }
      return {
        declaredSource: link.source,
        declaredTarget: link.target,
        platform: name,
        source,
        target,
      }
    })
}

/**
 * What an observed target means.
 *
 * `kind` comes from the caller's observation (`missing`, `link`, `file`,
 * `directory`); `linkTarget` is the raw `readlink` value when it is a symlink.
 * A target that is anything but the expected link, or a missing one, is not the
 * state we want — and a regular file is *blocked* rather than drifted: the
 * command never overwrites it without an explicit `--force`.
 */
export function classifyTarget({ kind, linkTarget = null, source }) {
  switch (kind) {
    case 'missing':
      return LINK_MISSING
    case 'link':
      return linkTarget === source ? LINK_OK : LINK_DRIFT
    case 'file':
    case 'directory':
      return LINK_BLOCKED
    default:
      throw new Error(`unknown target kind "${kind}"`)
  }
}
