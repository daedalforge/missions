import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const self = 'test/neutrality.test.mjs'

const RULES = [
  ['identifiant de mission', /\b(?:SLV|SOC|SO)-\d+/],
  ['nom personnel', /St[ée]phane|Lucien|Vauthier|saas-office/i],
  ['chemin personnel', /\/Users\/[a-z]|\/home\/[a-z]|\/Volumes\/[a-z]/],
  ['adresse électronique', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['jeton GitHub', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['clé cloud', /AKIA[0-9A-Z]{16}/],
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['jeton JWT', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
]

function trackedFiles() {
  let out
  try {
    out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch {
    return null
  }
  return out.split('\0').filter(Boolean)
}

const files = trackedFiles()

test('le dépôt ne contient aucune donnée de mission ni donnée sensible', { skip: files === null && 'git indisponible' }, () => {
  assert.ok(files.length > 0, 'aucun fichier suivi')
  const offenders = []
  for (const path of files) {
    if (path === self) continue
    if (path.startsWith('preview/')) {
      offenders.push(`${path}: dossier de prévisualisation extrait`)
      continue
    }
    const text = readFileSync(join(root, path), 'utf8')
    const lines = text.split('\n')
    for (const [label, pattern] of RULES) {
      for (let index = 0; index < lines.length; index++) {
        if (pattern.test(lines[index])) offenders.push(`${path}:${index + 1}: ${label}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `données à neutraliser :\n${offenders.join('\n')}`)
})
