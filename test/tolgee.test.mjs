import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  TolgeeError,
  changedFiles,
  extractCalls,
  isPresent,
  isShippedFile,
  lineOf,
  lookup,
  missingKeys,
  planImport,
} from '../lib/tolgee.js'
import { buildXliff, escapeXml } from '../lib/tolgee-xliff.js'

const TRANSLATIONS = {
  locales: ['de', 'en', 'fr'],
  languageFile: 'locales/{locale}/translations.json',
  reference: 'fr',
}

/** Un dépôt factice : les fichiers de locale sur disque, le diff par un faux git. */
async function fixture(t, { files, locales, diff }) {
  const root = await mkdtemp(join(tmpdir(), 'tolgee-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [locale, table] of Object.entries(locales)) {
    const path = join(root, 'locales', locale, 'translations.json')
    await mkdir(join(root, 'locales', locale), { recursive: true })
    await writeFile(path, JSON.stringify(table))
  }
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(root, file), text)
  }
  const calls = []
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '))
    if (diff instanceof Error) throw Object.assign(diff, { stderr: 'fatal: bad revision' })
    return { stdout: diff, stderr: '' }
  }
  return { root, run, calls }
}

test('seuls les fichiers livrés comptent : ni test, ni Cypress', () => {
  assert.equal(isShippedFile('src/account.js'), true)
  assert.equal(isShippedFile('src/account.test.js'), false)
  assert.equal(isShippedFile('src/account.cy.ts'), false)
})

test('les appels t() livrent la clé et la ligne, jamais un gabarit', () => {
  const text = ["const a = t('account.title')", "const b = t(\"account.save\")", 'const c = t(`dynamic.${key}`)'].join('\n')
  const calls = extractCalls(text)

  assert.deepEqual(
    calls.map((call) => [call.key, lineOf(text, call.index)]),
    [
      ['account.title', 1],
      ['account.save', 2],
    ],
  )
})

test('une clé pointée se lit dans un tableau imbriqué, la clé plate gagne', () => {
  const table = { account: { title: 'Compte', 'with.dot': 'plate' }, 'account.title': 'exact' }

  assert.equal(lookup(table, 'account.title'), 'exact')
  assert.equal(lookup({ account: { title: 'Compte' } }, 'account.title'), 'Compte')
  assert.equal(lookup(table, 'account.missing'), undefined)
})

test('une valeur absente, nulle ou blanche est manquante', () => {
  assert.equal(isPresent('Compte'), true)
  assert.equal(isPresent(''), false)
  assert.equal(isPresent('   '), false)
  assert.equal(isPresent(undefined), false)
  assert.equal(isPresent(0), true)
})

test('le diff passé lit base...branche et écarte les fichiers de test', async (t) => {
  const { root, run, calls } = await fixture(t, {
    files: { 'src/account.js': '' },
    locales: { fr: {} },
    diff: 'src/account.js\nsrc/account.test.js\nsrc/login.cy.ts\n',
  })

  const files = await changedFiles({ repo: root, base: 'main', branch: 'feat/mis-171', run })

  assert.deepEqual(files, ['src/account.js'])
  assert.deepEqual(calls, [`git -C ${root} diff --name-only main...feat/mis-171`])
})

test('une branche absente est un refus qui dit pourquoi', async (t) => {
  const { root, run } = await fixture(t, { files: {}, locales: { fr: {} }, diff: new Error('git failed') })

  await assert.rejects(
    () => changedFiles({ repo: root, base: 'main', branch: 'feat/mis-171', run }),
    (error) => error instanceof TolgeeError && /cannot read the diff of feat\/mis-171 against main/.test(error.message),
  )
})

test('CA4 — la clé manquante en de entre au fichier, la complète et l’hors-diff restent dehors', async (t) => {
  const source = [
    "import { t } from 'i18next'",
    "export const title = t('account.title')",
    "export const save = t('account.save')",
  ].join('\n')
  const { root, run } = await fixture(t, {
    files: {
      'src/account.js': source,
      'src/account.test.js': "t('test.only')",
      'src/other.js': "t('other.key')",
    },
    locales: {
      fr: { 'account.title': 'Mon compte', 'account.save': 'Enregistrer', 'other.key': 'Autre' },
      en: { 'account.title': 'My account', 'account.save': 'Save', 'other.key': 'Other' },
      de: { 'account.save': 'Speichern', 'other.key': 'Andere' },
    },
    diff: 'src/account.js\nsrc/account.test.js\n',
  })

  const plan = await planImport({ repo: root, base: 'main', branch: 'feat/x', translations: TRANSLATIONS, run })

  assert.deepEqual(plan.keys, [
    {
      key: 'account.title',
      value: 'Mon compte',
      missing: ['de'],
      occurrences: ['src/account.js:2'],
    },
  ])
  assert.deepEqual(plan.untranslated, [])
})

test('CA5 — sans valeur fr, la clé est listée à part et n’entre pas dans le XLIFF', async (t) => {
  const { root, run } = await fixture(t, {
    files: { 'src/help.js': "export const help = t('account.help')\n" },
    locales: {
      fr: { 'account.help': '  ' },
      en: { 'account.help': 'Help' },
      de: { 'account.help': 'Hilfe' },
    },
    diff: 'src/help.js',
  })

  const plan = await planImport({ repo: root, base: 'main', branch: 'feat/x', translations: TRANSLATIONS, run })

  assert.deepEqual(plan.keys, [])
  assert.deepEqual(plan.untranslated, [{ key: 'account.help', occurrences: ['src/help.js:1'] }])
})

test('un diff vide est un refus, jamais un fichier vide', async (t) => {
  const { root, run } = await fixture(t, { files: { 'src/a.js': '' }, locales: { fr: {} }, diff: '' })

  await assert.rejects(
    () => planImport({ repo: root, base: 'main', branch: 'feat/x', translations: TRANSLATIONS, run }),
    (error) => error instanceof TolgeeError && error.status === 409 && /no changed source file/.test(error.message),
  )
})

test('une locale illisible est un refus nommé', async (t) => {
  const { root, run } = await fixture(t, {
    files: { 'src/a.js': "t('a')" },
    locales: {},
    diff: 'src/a.js',
  })

  await assert.rejects(
    () => planImport({ repo: root, base: 'main', branch: 'feat/x', translations: TRANSLATIONS, run }),
    (error) => error instanceof TolgeeError && /locales\/de\/translations\.json is missing for de/.test(error.message),
  )
})

test('missingKeys sépare les clés importables de celles à écrire en fr', () => {
  const calls = new Map([
    ['a', { key: 'a', occurrences: ['src/a.js:1'] }],
    ['b', { key: 'b', occurrences: ['src/b.js:2'] }],
  ])
  const locales = [
    { locale: 'fr', table: { a: 'A' } },
    { locale: 'en', table: { b: 'B' } },
  ]

  assert.deepEqual(missingKeys({ calls, locales, reference: 'fr' }), {
    keys: [{ key: 'a', value: 'A', missing: ['en'], occurrences: ['src/a.js:1'] }],
    untranslated: [{ key: 'b', occurrences: ['src/b.js:2'] }],
  })
})

test('CA3 — le XLIFF 1.2 porte source = target = fr, id = resname = clé, note = occurrences', () => {
  const xliff = buildXliff({
    entries: [
      { key: 'account.title', value: 'Mon compte', occurrences: ['src/account.js:12', 'src/layout.js:3'] },
      { key: 'account.save', value: 'Enregistrer & <continuer>', occurrences: ['src/account.js:20'] },
    ],
    original: 'SO-1503',
  })

  assert.match(xliff, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/)
  assert.match(xliff, /<xliff xmlns="urn:oasis:names:tc:xliff:document:1\.2" version="1\.2">/)
  assert.match(xliff, /<file source-language="fr" target-language="fr" original="SO-1503" datatype="plaintext">/)
  assert.match(xliff, /<trans-unit id="account\.title" resname="account\.title">/)
  assert.match(xliff, /<source>Mon compte<\/source>/)
  assert.match(xliff, /<target>Mon compte<\/target>/)
  assert.match(xliff, /<note>src\/account\.js:12, src\/layout\.js:3<\/note>/)
  assert.match(xliff, /<source>Enregistrer &amp; &lt;continuer&gt;<\/source>/)
})

test('escapeXml échappe les cinq entités XML', () => {
  assert.equal(escapeXml(`& < > " '`), '&amp; &lt; &gt; &quot; &apos;')
})

test('le XLIFF produit est bien formé (xmllint)', { skip: !hasXmllint() }, async (t) => {
  const xliff = buildXliff({ entries: [{ key: 'a&b', value: '<x>', occurrences: ['src/a.js:1'] }] })
  const root = await mkdtemp(join(tmpdir(), 'tolgee-xliff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'import-tolgee.xliff')
  await writeFile(file, xliff)

  execFileSync('xmllint', ['--noout', file])
})

function hasXmllint() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
