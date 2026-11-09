import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = { createElement: () => null }
const primitives = { MarkdownText: (props) => react.createElement('div', { className: 'markdown' }, props.text) }
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

const { readStored, writeStored, storedSnapshot, initialState, panelNotice } = client

function memoire() {
  const cells = new Map()
  return {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, String(value)),
  }
}

const pleine = () => {
  throw new Error('quota')
}

test('un stockage vide ne rend rien', () => {
  assert.equal(readStored(memoire(), 'dsh-missions:snapshot'), null)
  assert.equal(readStored(null, 'dsh-missions:snapshot'), null)
})

test('un snapshot écrit se relit tel quel', () => {
  const storage = memoire()
  writeStored(storage, 'dsh-missions:snapshot', { at: 42, data: { missions: [{ id: 'ABC-1' }] } })
  assert.deepEqual(readStored(storage, 'dsh-missions:snapshot'), { at: 42, data: { missions: [{ id: 'ABC-1' }] } })
})

test('un snapshot complet expose ses données, une forme partielle est ignorée', () => {
  const storage = memoire()
  writeStored(storage, 'dsh-missions:snapshot', { at: 42, data: { missions: [] } })
  assert.deepEqual(storedSnapshot(storage).data, { missions: [] })
  writeStored(storage, 'dsh-missions:snapshot', { data: { missions: [] } })
  assert.equal(storedSnapshot(storage), null)
  storage.setItem('dsh-missions:snapshot', 'pas du json')
  assert.equal(storedSnapshot(storage), null)
})

test('un stockage qui refuse l’écriture ne fait pas échouer le panneau', () => {
  const storage = { getItem: pleine, setItem: pleine }
  assert.equal(readStored(storage, 'dsh-missions:snapshot'), null)
  writeStored(storage, 'dsh-missions:snapshot', { at: 1, data: {} })
  assert.equal(storedSnapshot(storage), null)
})

test('les clés du stockage restent celles du panneau', () => {
  const storage = memoire()
  writeStored(storage, 'dsh-missions:sessions', { at: 7, value: { 'ABC-1': { count: 2 } } })
  assert.deepEqual(readStored(storage, 'dsh-missions:sessions').value, { 'ABC-1': { count: 2 } })
})

test('sans snapshot, le panneau démarre en chargement', () => {
  const state = initialState(memoire())
  assert.equal(state.phase, 'loading')
  assert.equal(state.data, null)
  assert.equal(state.error, '')
})

test('avec un snapshot, le panneau démarre en revalidation sur ses données', () => {
  const storage = memoire()
  writeStored(storage, 'dsh-missions:snapshot', { at: Date.now(), data: { missions: [{ id: 'ABC-1' }] } })
  const state = initialState(storage)
  assert.equal(state.phase, 'refreshing')
  assert.deepEqual(state.data.missions, [{ id: 'ABC-1' }])
})

test('un échec de revalidation se signale même quand un snapshot est peint', () => {
  assert.equal(panelNotice({ error: '', data: { missions: [] } }), '')
  assert.equal(panelNotice({ error: 'HTTP 500', data: null }), 'Lecture impossible : HTTP 500')
  assert.equal(
    panelNotice({ error: 'HTTP 500', data: { missions: [] } }),
    'Revalidation impossible : HTTP 500 — affichage du dernier état connu',
  )
})
