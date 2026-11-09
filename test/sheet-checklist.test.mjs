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

const mission = { id: 'ABC-75', title: 'Mission de démonstration', status: 'active', priority: '', epic: 'Missions', repo: '~/konoha', type: 'conteneur' }
const checklist = '# Checklist manuelle\n\n| Point | Attendu | Preuve |\n| --- | --- | --- |\n| Trois colonnes | 392 / 1fr / 336 | capture |\n| Onglet Session | écrit dans la session | échange visible |'

function render(body) {
  return toTree(
    client.MissionSheet({
      mission,
      sheet: { source: '# Mission de démonstration\n\nCorps.', journal: { exists: true, text: 'journal' }, checklist: body },
      tab: 'checklist',
    }),
  )
}

test('la checklist est rendue sans son titre de fichier, tableau compris', () => {
  const body = text(byClass(render({ exists: true, text: checklist }), 'dm-sheet-body')[0])

  assert.doesNotMatch(body, /^# Checklist manuelle/)
  assert.match(body, /\| Trois colonnes \| 392 \/ 1fr \/ 336 \| capture \|/)
  assert.match(body, /Onglet Session/)
})

test('une checklist absente est signalée explicitement', () => {
  const tree = render({ exists: false, text: '' })

  assert.match(text(byClass(tree, 'dm-sheet-note')[0]), /n’a pas de checklist/)
  assert.equal(byClass(tree, 'markdown').length, 0)
})

test('une checklist vide n’affiche rien plutôt qu’un blanc', () => {
  const tree = render({ exists: true, text: '# Checklist manuelle\n' })

  assert.equal(byClass(tree, 'markdown').length, 0)
  assert.equal(byClass(tree, 'dm-sheet-note').length, 0)
})

test('une checklist en cours de lecture annonce le chargement', () => {
  const tree = render({ exists: true, text: '' })

  assert.match(text(byClass(tree, 'dm-sheet-note')[0]), /Chargement…/)
})
