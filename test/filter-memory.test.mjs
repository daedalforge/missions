import { createPanelComponents } from './helpers/theme.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const react = { createElement: () => null }
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

const { FILTER_MEMORY_KEYS, readFilterValue, storeFilterValue, withStoredValue } = client

function memoire() {
  const cells = new Map()
  return {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, String(value)),
    removeItem: (key) => cells.delete(key),
  }
}

function sousLePanier(storage, run) {
  const previous = globalThis.window
  globalThis.window = { ...(previous ?? {}), localStorage: storage }
  try {
    return run()
  } finally {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
}

const valeurs = { search: 'gpg', status: 'active', priority: 'urgent', epic: 'UV-757', session: 'none' }

const statuts = [
  { key: '', label: 'Toutes' },
  { key: 'active', label: 'En cours' },
  { key: 'ready', label: 'En attente d’exécution' },
]

test('les cinq filtres ont chacun leur clé locale', () => {
  assert.deepEqual(FILTER_MEMORY_KEYS, {
    search: 'dsh-missions:search',
    status: 'dsh-missions:status-filter',
    priority: 'dsh-missions:priority-filter',
    epic: 'dsh-missions:epic-filter',
    session: 'dsh-missions:session-filter',
  })
})

test('un panneau rouvert relit les cinq filtres', () => {
  const storage = memoire()
  sousLePanier(storage, () => {
    for (const [name, key] of Object.entries(FILTER_MEMORY_KEYS)) storeFilterValue(key, valeurs[name])
  })
  const relu = sousLePanier(storage, () =>
    Object.fromEntries(Object.entries(FILTER_MEMORY_KEYS).map(([name, key]) => [name, readFilterValue(key)])),
  )
  assert.deepEqual(relu, valeurs)
})

test('un filtre sans mémoire se lit vide', () => {
  sousLePanier(memoire(), () => assert.equal(readFilterValue(FILTER_MEMORY_KEYS.priority), ''))
})

test('effacer un filtre efface sa clé', () => {
  const storage = memoire()
  sousLePanier(storage, () => {
    storeFilterValue(FILTER_MEMORY_KEYS.search, 'gpg')
    storeFilterValue(FILTER_MEMORY_KEYS.search, '')
  })
  assert.equal(storage.getItem('dsh-missions:search'), null)
})

test('un stockage qui refuse ne casse ni la lecture ni l’écriture', () => {
  const refus = () => {
    throw new Error('refus')
  }
  sousLePanier({ getItem: refus, setItem: refus, removeItem: refus }, () => {
    assert.equal(readFilterValue(FILTER_MEMORY_KEYS.session), '')
    storeFilterValue(FILTER_MEMORY_KEYS.session, 'none')
  })
  sousLePanier(undefined, () => {
    assert.equal(readFilterValue(FILTER_MEMORY_KEYS.session), '')
    storeFilterValue(FILTER_MEMORY_KEYS.session, 'none')
  })
})

test('une valeur mémorisée absente des options reste affichée', () => {
  assert.deepEqual(withStoredValue(statuts, 'awaiting_validation', 'En attente de validation'), [
    ...statuts,
    { key: 'awaiting_validation', label: 'En attente de validation' },
  ])
})

test('une valeur proposée n’est pas dupliquée, une valeur vide ne change rien', () => {
  assert.deepEqual(withStoredValue(statuts, 'active', 'En cours'), statuts)
  assert.deepEqual(withStoredValue(statuts, '', 'Toutes'), statuts)
})

test('les cinq états du panneau passent par la mémoire locale', () => {
  const branches = [
    'const [filter, setFilter] = useStoredFilter(PRIORITY_FILTER_KEY)',
    'const [epicFilter, setEpicFilter] = useStoredFilter(EPIC_FILTER_KEY)',
    'const [query, setQuery] = useStoredFilter(SEARCH_KEY)',
    'const [statusFilter, setStatusFilter] = useStoredFilter(STATUS_FILTER_KEY)',
    'const [sessionFilter, setSessionFilter] = useStoredFilter(SESSION_FILTER_KEY)',
  ]
  for (const branch of branches) assert.ok(source.includes(branch), branch)
})
