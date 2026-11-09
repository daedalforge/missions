import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

const react = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  }),
  cloneElement: (element, extra) => ({ type: element.type, props: { ...element.props, ...(extra ?? {}) } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useContext: (context) => context?.value,
  createContext: (value) => ({ value }),
  useSyncExternalStore: (subscribe, read) => read(),
}
const primitives = { MarkdownText: (props) => react.createElement('div', {}, props.text) }
const theme = { MarkdownText: primitives.MarkdownText }

const previousWindow = globalThis.window
const previousDocument = globalThis.document
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
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.document = {
  baseURI: 'http://localhost/',
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
}
try {
  new Function(source)()
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
}

const workspace = (workspaceId, path) => ({ workspaceId, path, title: workspaceId, sessionIds: [] })

test('le panneau Missions se rend sans erreur de portée', () => {
  const items = {
    items: [workspace('w-konoha', '/Users/…/konoha'), workspace('w-projects', '/Users/…/projects')],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'ready',
    phase: 'ready',
    error: null,
  }
  const services = {
    getService: (name) => (name === 'workspaces' ? { list: { getSnapshot: () => items } } : undefined),
  }
  const tree = client.MissionsPanel({ services })
  assert.ok(tree)
  assert.ok(tree.type)
})

test('aucune fonction du module n’est masquée par une constante locale', () => {
  const top = new Set([...source.matchAll(/^    function (\w+)\(/gm)].map((match) => match[1]))
  const local = new Set([...source.matchAll(/^ {6,}const (\w+) =/gm)].map((match) => match[1]))
  assert.deepEqual([...top].filter((name) => local.has(name)), [])
})
