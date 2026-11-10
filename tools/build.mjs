#!/usr/bin/env node
/**
 * build.mjs — assemble `lib/client.js` from `src/client.template.js` and the
 * pure helpers of `lib/view.js`.
 *
 * The DSH module loader expects a self-contained bundle (a synchronous
 * `factory` with a provided `require`), so the view helpers are copied in,
 * without their `export` keywords.
 */
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

const template = await read('src/client.template.js')
const view = (await read('lib/view.js')).replace(/^export /gm, '').trimEnd()
const indented = view
  .split('\n')
  .map((line) => (line ? `    ${line}` : ''))
  .join('\n')

await writeFile(new URL('lib/client.js', root), template.replace('    /* __VIEW__ */', indented), 'utf8')
console.log('lib/client.js written')
