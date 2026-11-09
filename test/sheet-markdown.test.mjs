import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  }),
  cloneElement: (element, extra) => ({ type: element.type, props: { ...element.props, ...(extra ?? {}) } }),
}
const seen = []
const primitives = {
  MarkdownText: (props) => {
    seen.push(props)
    return react.createElement('div', { className: 'markdown' }, props.text)
  },
}
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const theme = createPanelComponents(react.createElement)
const previousWindow = globalThis.window
let client = null

globalThis.window = {
  __ModuleLoader__: {
    load: ({ factory }) => {
      client = factory((id) => {
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
        if (id === 'dsh-theme-konoha/client') return theme
        return react
      })
    },
  },
}
try {
  new Function(source)()
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}

function toTree(node) {
  if (node === null || node === undefined || node === true || node === false) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    return node.flatMap(toTree).filter((child) => child !== null)
  }
  if (typeof node.type === 'function') return toTree(node.type(node.props))
  if (node.type === react.Fragment) return toTree(node.props.children)
  const children = toTree(node.props.children)
  return { type: node.type, props: node.props, children: children === null ? [] : Array.isArray(children) ? children : [children] }
}

function collect(node, match) {
  if (node === null || typeof node === 'string') return []
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, match))
  const found = match(node) ? [node] : []
  return [...found, ...node.children.flatMap((child) => collect(child, match))]
}

function byClass(tree, className) {
  return collect(tree, (node) => typeof node.type === 'string' && String(node.props.className ?? '').split(' ').includes(className))
}

function text(node) {
  if (node === null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  return node.children.map(text).join('')
}

const mission = { id: 'ABC-75', title: 'Mission de démonstration', status: 'active', priority: '', epic: 'Missions', repo: '~/konoha', type: 'conteneur' }
const board = `---
id: ABC-75
type: conteneur
status: active
repo: ~/konoha
---

# Mission de démonstration

## Intention

Retrouver la vue de démonstration.

## Fini quand

- Trois colonnes visibles.
`

function render(sheetSource, tab = 'fiche') {
  return toTree(client.MissionSheet({ mission, sheet: { source: sheetSource, journal: { exists: true, text: 'j' }, checklist: { exists: true, text: 'c' } }, tab }))
}

test('la fiche masque son frontmatter et son titre de premier niveau', () => {
  const body = text(byClass(render(board), 'dm-sheet-body')[0])

  assert.doesNotMatch(body, /^id: ABC-75/)
  assert.doesNotMatch(body, /^# /)
  assert.match(body, /## Intention/)
  assert.match(body, /Retrouver la vue de démonstration/)
  assert.match(body, /## Fini quand/)
})

test('le markdown de la fiche reçoit les libellés de rendu', () => {
  seen.length = 0
  render(board)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].labels.code.copyLabel, 'Copier')
  assert.equal(seen[0].labels.code.copiedLabel, 'Copié')
  assert.equal(seen[0].labels.footnotes, 'Notes')
})

test('un frontmatter sans titre est retiré de la même façon', () => {
  const body = text(byClass(render('---\nid: ABC-1\n---\n\n## Périmètre\n\nDedans.'), 'dm-sheet-body')[0])

  assert.doesNotMatch(body, /id: ABC-1/)
  assert.match(body, /## Périmètre/)
})

test('une fiche sans corps n’offre pas de markdown vide', () => {
  const tree = render('---\nid: ABC-1\n---\n\n# Titre\n')

  assert.equal(text(byClass(tree, 'dm-sheet-body')[0]).trim(), '')
})

test('l’onglet Fiche ne montre jamais le journal ni la checklist', () => {
  const body = text(byClass(render(board, 'fiche'), 'dm-sheet-body')[0])

  assert.doesNotMatch(body, /^journal$/)
  assert.doesNotMatch(body, /^checklist$/)
})
