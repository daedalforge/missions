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
const readBinary = async (path) => (await readFile(new URL(path, root))).toString('base64')

const template = await read('src/client.template.js')
const view = (await read('lib/view.js')).replace(/^export /gm, '').trimEnd()
const indented = view
  .split('\n')
  .map((line) => (line ? `    ${line}` : ''))
  .join('\n')

// The theme's three photographs are inlined as data URIs: the bundle stays
// self-contained and the panel makes no network request for its decoration.
const ART = {
  village: await readBinary('assets/konoha-village.webp'),
  konoha: await readBinary('assets/konoha-naruto.webp'),
  avatar: await readBinary('assets/naruto-avatar.webp'),
}
const art = [
  'const ART = {',
  `  village: 'data:image/webp;base64,${ART.village}',`,
  `  konoha: 'data:image/webp;base64,${ART.konoha}',`,
  `  avatar: 'data:image/webp;base64,${ART.avatar}',`,
  '}',
].join('\n')
const indentedArt = art
  .split('\n')
  .map((line) => `    ${line}`)
  .join('\n')

const bundle = template
  .replace('    /* __VIEW__ */', indented)
  .replace('    /* __ART__ */', indentedArt)

await writeFile(new URL('lib/client.js', root), bundle, 'utf8')
console.log('lib/client.js written')
