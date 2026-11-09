#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  WORKFLOWS,
  documentPath,
  formatModel,
  listModels,
  loadModel,
  modelPath,
  parseModel,
  readHeadings,
  validateModel,
} from '../lib/workflows/model.js'

function findRoot(start = process.cwd()) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, 'workflows', 'model'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

const argv = process.argv.slice(2)
const structureOnly = argv.includes('--structure')
let root = findRoot()
const rootFlag = argv.indexOf('--root')
if (rootFlag >= 0 && argv[rootFlag + 1]) root = resolve(argv[rootFlag + 1])
const targets = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--root') {
    index += 1
    continue
  }
  if (arg.startsWith('--')) continue
  targets.push(arg)
}

const wanted = targets.length ? targets.filter((name) => name !== root && !name.startsWith('--')) : listModels(root)
if (!wanted.length) {
  console.error(`aucun modèle sous ${join(root, 'workflows', 'model')}`)
  process.exit(1)
}

let failed = 0
for (const workflow of wanted) {
  if (!WORKFLOWS.includes(workflow)) {
    console.error(`✗ ${workflow} : inconnu (${WORKFLOWS.join(', ')})`)
    failed += 1
    continue
  }
  const file = modelPath(root, workflow)
  if (!existsSync(file)) {
    console.error(`✗ ${workflow} : modèle absent (${file})`)
    failed += 1
    continue
  }
  let doc
  try {
    doc = parseModel(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`✗ ${workflow} : JSON illisible — ${error instanceof Error ? error.message : error}`)
    failed += 1
    continue
  }
  const docFile = documentPath(root, workflow)
  const headings = existsSync(docFile) ? readHeadings(readFileSync(docFile, 'utf8')) : null
  if (!headings) {
    console.error(`✗ ${workflow} : document absent (${docFile})`)
    failed += 1
    continue
  }
  const { errors } = validateModel(doc, structureOnly ? {} : { headings })
  if (errors.length) {
    failed += 1
    console.error(`✗ ${workflow} — ${errors.length} écart(s)`)
    for (const error of errors) console.error(`   ${error}`)
    continue
  }
  const normalized = formatModel(doc)
  const raw = readFileSync(file, 'utf8')
  const sorted = raw === normalized ? '' : ' (forme non canonique)'
  console.log(`✓ ${workflow} : ${doc.nodes.length} gestes, ${doc.edges.length} arcs${sorted}`)
}

for (const workflow of wanted) {
  const file = modelPath(root, workflow)
  if (existsSync(file) && !listModels(root).includes(workflow)) {
    console.error(`✗ ${workflow} : fichier hors modèle (${file})`)
    failed += 1
  }
}

process.exit(failed ? 1 : 0)
