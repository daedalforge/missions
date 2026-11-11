#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BRANCHES_DIR } from '../lib/branches.js'
import { CHECKLIST_FILE } from '../lib/checklist.js'

/**
 * Migration : reprendre les checklists de l'ancien système dans les dossiers de
 * mission du panneau.
 *
 * L'ancien greffon lisait `<ancien>/<CLÉ>/checklist-manuelle.md` ; le panneau
 * lit `missions/<CLÉ>/checklist.md`. Le contenu est recopié tel quel — c'est un
 * historique, pas une réécriture — et le dossier reçoit un `mission.yml` réduit
 * à sa clé quand il n'en a pas : sans lui, le panneau ne peut pas résoudre le
 * dossier, donc pas afficher la checklist.
 *
 * Idempotent : un `checklist.md` déjà présent n'est jamais écrasé, seul un
 * dossier interrompu est complété. L'outil ne sert qu'une fois par workspace,
 * mais il est versionné pour que la migration soit rejouable et vérifiable.
 *
 *   node tools/import-checklists.mjs <ancien-dossier> [--to <missions-dir>] [clé…]
 *
 * Sans clé, il prend tous les dossiers de l'ancien système qui portent une
 * checklist.
 */

/** Nom du fichier dans l'ancien système. */
export const OLD_CHECKLIST_FILE = 'checklist-manuelle.md'

/** Déclaration minimale : la clé seule, sans branche ni base inventées. */
function declarationFor(key) {
  return [
    `# Déclaration de la mission ${key}`,
    '# Fichier local du panneau Missions, jamais versionné.',
    '',
    `key: ${key}`,
    '',
  ].join('\n')
}

/**
 * Une clé est un nom de dossier, pas un chemin : `..` ou `/` écrirait hors de
 * `missions/` et sortirait de la migration.
 */
function assertKey(key) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(key)) || String(key).includes('..')) {
    throw new Error(`clé invalide : ${key}`)
  }
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  )

async function discover(source) {
  const entries = await readdir(source, { withFileTypes: true })
  const folders = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(join(source, entry.name, OLD_CHECKLIST_FILE))) folders.push(entry.name)
  }
  return folders.sort()
}

/**
 * Copie les checklists de `from` vers `to`.
 *
 * Rend un rapport par dossier — `imported`, `kept` (déjà présent) ou `absent` —
 * pour que la migration laisse une trace lisible dans le journal et la PR.
 */
export async function importChecklists({ from, to = BRANCHES_DIR, keys = null, log = () => {} }) {
  const source = toRoot(from)
  const root = toRoot(to)
  const folders = keys?.length ? [...keys] : await discover(source)
  const report = []

  for (const folder of folders) {
    assertKey(folder)
    const file = join(source, folder, OLD_CHECKLIST_FILE)
    if (!(await exists(file))) {
      report.push({ key: folder, status: 'absent' })
      log(`${folder}: pas de ${OLD_CHECKLIST_FILE} dans l'ancien système`)
      continue
    }

    const text = await readFile(file, 'utf8')
    const target = join(root, folder)
    await mkdir(target, { recursive: true })

    const declaration = join(target, 'mission.yml')
    const declared = !(await exists(declaration))
    if (declared) await writeFile(declaration, declarationFor(folder))

    const checklist = join(target, CHECKLIST_FILE)
    const copied = !(await exists(checklist))
    if (copied) await writeFile(checklist, text)

    const digest = createHash('sha256').update(text).digest('hex')
    report.push({ key: folder, status: copied ? 'imported' : 'kept', declared, length: text.length, digest })
    log(
      `${folder}: ${text.length} car. · sha256 ${digest.slice(0, 12)} · ${copied ? 'importée' : 'déjà présente, laissée telle quelle'}${declared ? ' · mission.yml créé' : ''}`,
    )
  }

  return report
}

function toRoot(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : String(dir)
}

/** CLI : `node tools/import-checklists.mjs <ancien-dossier>…`. */
async function main(argv) {
  const args = argv.slice(2)
  const from = args.shift()
  if (!from) {
    console.error('usage : node tools/import-checklists.mjs <ancien-dossier> [--to <missions-dir>] [clé…]')
    process.exit(1)
  }
  let to = BRANCHES_DIR
  const keys = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--to') {
      if (!args[index + 1]) {
        console.error('usage : node tools/import-checklists.mjs <ancien-dossier> [--to <missions-dir>] [clé…]')
        process.exit(1)
      }
      to = args[index + 1]
      index += 1
      continue
    }
    keys.push(args[index])
  }

  const report = await importChecklists({ from, to, keys, log: (line) => console.log(line) })
  const imported = report.filter((line) => line.status === 'imported').length
  const kept = report.filter((line) => line.status === 'kept').length
  const absent = report.filter((line) => line.status === 'absent').length
  console.log(`\n${imported} importée(s), ${kept} déjà présente(s), ${absent} absente(s) — ${report.length} dossier(s) examiné(s)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv)
}
