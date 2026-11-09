#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { checkWorkspace } from '../lib/workflows/check.js'

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
const rootFlag = argv.indexOf('--root')
const root = rootFlag >= 0 && argv[rootFlag + 1] ? resolve(argv[rootFlag + 1]) : findRoot()
const report = checkWorkspace(root)

let failed = 0
for (const entry of report.models) {
  if (entry.errors.length) {
    failed += 1
    console.log(`✗ ${entry.workflow} — ${entry.errors.length} écart(s)`)
    for (const error of entry.errors) console.log(`   ${error}`)
  } else {
    console.log(`✓ ${entry.workflow}`)
  }
}

for (const entry of report.documents) {
  if (entry.errors.length) {
    failed += 1
    console.log(`✗ ${entry.source}`)
    for (const error of entry.errors) console.log(`   ${error}`)
  } else {
    console.log(`✓ ${entry.source} : transitions conformes à standards/types.md`)
  }
}

for (const entry of report.models) {
  if (!entry.orphanSections.length) continue
  console.log(`· ${entry.workflow} : ${entry.orphanSections.length} section(s) sans geste`)
  for (const section of entry.orphanSections) console.log(`   ${section}`)
}

for (const unknown of report.statuses.unknown) {
  failed += 1
  console.log(`✗ ${unknown}`)
}

console.log(failed ? `\n${failed} écart(s).` : '\nAucun écart.')
process.exit(failed ? 1 : 0)
