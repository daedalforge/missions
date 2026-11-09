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

const { searchMissions, searchTokens, normalizeQuery, emptyNotice, filterMissions } = client
const ids = (missions) => missions.map((mission) => mission.id)

const missions = [
  {
    id: 'ABC-1',
    priority: 'urgent',
    epic: 'UV-483',
    search: 'abc-1 la liste des missions\nrecherche global\npr 1184\nfeat/liste-recherche',
  },
  { id: 'ABC-2', priority: 'important', epic: 'UV-483', search: 'abc-2 secrets gpg\n.env chiffre par workspace' },
  { id: 'ABC-3', priority: 'urgent', epic: '', search: 'abc-3 recette manuelle\nscenario joue par un agent neuf' },
]

test('sans requête, la liste reste entière', () => {
  assert.deepEqual(ids(searchMissions(missions, '')), ['ABC-1', 'ABC-2', 'ABC-3'])
  assert.deepEqual(ids(searchMissions(missions, '   ')), ['ABC-1', 'ABC-2', 'ABC-3'])
})

test('la requête ignore la casse et les accents', () => {
  assert.deepEqual(ids(searchMissions(missions, 'SCÉNARIO')), ['ABC-3'])
  assert.deepEqual(ids(searchMissions(missions, 'Chiffré')), ['ABC-2'])
})

test('plusieurs mots se combinent en ET, chacun dans un champ différent', () => {
  assert.deepEqual(ids(searchMissions(missions, 'ABC-2 gpg')), ['ABC-2'])
  assert.deepEqual(ids(searchMissions(missions, 'gpg ABC-1')), [])
})

test('une valeur de frontmatter invisible dans la liste trouve sa mission', () => {
  assert.deepEqual(ids(searchMissions(missions, '1184')), ['ABC-1'])
  assert.deepEqual(ids(searchMissions(missions, 'liste-recherche')), ['ABC-1'])
})

test('une sous-chaîne suffit, sans mot entier', () => {
  assert.deepEqual(ids(searchMissions(missions, 'abc-')), ['ABC-1', 'ABC-2', 'ABC-3'])
  assert.deepEqual(ids(searchMissions(missions, 'ABC-1')), ['ABC-1'])
})

test('les mots de la requête sont normalisés et découpés', () => {
  assert.deepEqual(searchTokens('  ABC-2   GPG '), ['abc-2', 'gpg'])
  assert.equal(normalizeQuery('Écrit à l’écran'), 'ecrit a l’ecran')
  assert.deepEqual(searchTokens(''), [])
})

test('la recherche se compose avec les filtres en intersection', () => {
  const searched = searchMissions(missions, 'abc-')
  assert.deepEqual(ids(filterMissions(searched, 'urgent', '')), ['ABC-1', 'ABC-3'])
  assert.deepEqual(ids(filterMissions(searched, '', 'UV-483')), ['ABC-1', 'ABC-2'])
  assert.deepEqual(ids(filterMissions(searchMissions(missions, 'agent'), '', 'UV-483')), [])
})

test("l'état vide nomme la requête", () => {
  assert.equal(emptyNotice('', '', 'zzz'), 'Aucune mission ne correspond à « zzz ».')
  assert.equal(emptyNotice('urgent', '', 'zzz'), 'Aucune mission ne correspond à « zzz » avec ces filtres.')
  assert.equal(emptyNotice('urgent', ''), 'Aucune mission avec cette priorité.')
})

test('une fiche sans texte cherchable ne casse pas la recherche', () => {
  assert.deepEqual(ids(searchMissions([{ id: 'ABC-9' }], 'abc')), [])
  assert.deepEqual(ids(searchMissions([{ id: 'ABC-9' }], '')), ['ABC-9'])
})
