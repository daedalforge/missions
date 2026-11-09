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
const primitives = { MarkdownText: (props) => react.createElement('div', { className: 'markdown' }, props.text) }
const theme = createPanelComponents(react.createElement)
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
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

const mission = { id: 'ABC-75', title: 'Mission de démonstration', status: 'active', priority: 'urgent', epic: 'Missions', repo: '~/konoha', type: 'conteneur' }
const journal = '# 2026-10-30 — Cadrage\n\nFiche écrite, points ouverts tranchés.\n\n## Validation\n\nGo reçu.'

function render(body, extra = {}) {
  return toTree(
    client.MissionSheet({
      mission,
      sheet: { source: '# Mission de démonstration\n\nCorps.', journal: body, checklist: { exists: false, text: '' } },
      tab: 'journal',
      ...extra,
    }),
  )
}

test('l’onglet Journal rend le journal entier, titres de date compris', () => {
  const tree = render({ exists: true, text: journal })
  const body = text(byClass(tree, 'dm-sheet-body')[0])

  assert.match(body, /# 2026-10-30 — Cadrage/)
  assert.match(body, /Fiche écrite, points ouverts tranchés/)
  assert.match(body, /## Validation/)
})

test('un journal absent est dit, sans markdown vide', () => {
  const tree = render({ exists: false, text: '' })

  assert.match(text(byClass(tree, 'dm-sheet-note')[0]), /n’a pas de journal/)
  assert.equal(byClass(tree, 'markdown').length, 0)
})

test('un journal encore vide annonce le chargement', () => {
  const tree = render({ exists: true, text: '  ' })

  assert.match(text(byClass(tree, 'dm-sheet-note')[0]), /Chargement…/)
})

test('le journal d’une mission ne dépend pas du chargement de sa fiche', () => {
  const tree = render({ exists: true, text: journal }, { sheet: { source: '', journal: { exists: true, text: journal } } })

  assert.match(text(byClass(tree, 'dm-sheet-body')[0]), /Go reçu/)
})

test('partInfo distingue absence, contenu et partie explicite', () => {
  assert.deepEqual(client.partInfo(undefined), { exists: false, text: '' })
  assert.deepEqual(client.partInfo({ exists: false, text: 'x' }), { exists: false, text: 'x' })
  assert.deepEqual(client.partInfo({ exists: true, text: 'x' }), { exists: true, text: 'x' })
  assert.deepEqual(client.partInfo('texte'), { exists: true, text: 'texte' })
  assert.deepEqual(client.partInfo({ exists: true, source: '# 2026-10-30\n\nBloc.' }), { exists: true, text: '# 2026-10-30\n\nBloc.' })
  assert.deepEqual(client.partInfo({ exists: false, source: '' }), { exists: false, text: '' })
})
