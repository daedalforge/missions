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

function rows(tree) {
  const found = {}
  for (const row of byClass(tree, 'dm-ctxrow')) found[text(row.children[0])] = text(row.children[1])
  return found
}

const missions = [
  { id: 'ABC-75', title: 'Mission de démonstration', status: 'active', priority: 'urgent', epic: 'Missions', repo: '~/konoha', type: 'conteneur' },
  { id: 'ABC-74', title: 'Maquette de démonstration', status: 'awaiting_validation', priority: '', epic: 'Missions', repo: '~/konoha', type: 'conteneur' },
  { id: 'ABC-73', title: 'Cadrage de démonstration', status: 'draft', priority: 'un_jour', epic: '', repo: '~/projects/registre', type: 'produit' },
]
const mission = missions[0]
const session = { id: 'session-abc', title: 'Mission de démonstration', running: true, updatedAt: Date.now() - 60_000, explicit: true }
const noop = () => {}

test('la barre de la fiche ne garde que l’identifiant', () => {
  const tree = toTree(
    client.MissionSheet({
      mission,
      sheet: { source: '# Mission de démonstration\n\nCorps.', journal: { exists: true, text: 'journal' }, checklist: { exists: false, text: '' } },
    }),
  )
  const bar = text(byClass(tree, 'dm-sheet-bar')[0])

  assert.equal(bar, '←ABC-75')
})

test('la priorité et le statut se changent depuis la colonne de contexte', () => {
  const picked = []
  const tree = toTree(
    client.ContextColumn({
      mission: { ...mission, type: 'produit' },
      sessions: [],
      sheet: { journal: { exists: false }, checklist: { exists: false } },
      statusMenuOpen: true,
      priorityMenuOpen: true,
      onPickStatus: (status) => picked.push(status),
      onPickPriority: (priority) => picked.push(priority),
    }),
  )

  for (const item of byClass(tree, 'dm-fmenu-item')) {
    if (text(item) === 'En review') item.props.onClick()
    if (text(item) === 'Un jour') item.props.onClick()
  }

  assert.deepEqual(picked, ['in_review', 'un_jour'])
})

test('la barre de méta ne propose plus de menu, le statut d’un conteneur reste un jeton', () => {
  const sheet = toTree(client.MissionSheet({ mission: { ...mission, type: 'conteneur' }, sheet: { source: '# x\n\nCorps.' } }))
  const context = toTree(
    client.ContextColumn({
      mission: { ...mission, type: 'conteneur' },
      sessions: [],
      sheet: { journal: { exists: false }, checklist: { exists: false } },
    }),
  )

  assert.equal(byClass(sheet, 'dm-fmenu').length, 0)
  assert.equal(byClass(context, 'dm-fmenu-menu').length, 0)
  assert.equal(byClass(context, 'dm-ctx-btn').length, 1)
  assert.ok(text(context).includes('En cours'))
})

test('les quatre onglets sont toujours présents et l’actif est marqué', () => {
  const seen = []
  const tree = toTree(client.MissionSheet({ mission, sheet: { source: '# x\n\nCorps.' }, tab: 'journal', controls: {}, onSelectTab: (key) => seen.push(key) }))
  const tabs = byClass(tree, 'dsh-panel-tab')

  assert.deepEqual(tabs.map(text), ['Fiche', 'Journal', 'Checklist', 'Performance'])
  const active = tabs.filter((tab) => tab.props['aria-selected'] === 'true')

  assert.equal(active.length, 1)
  assert.equal(text(active[0]), 'Journal')

  tabs[2].props.onClick()
  tabs[3].props.onClick()

  assert.deepEqual(seen, ['checklist', 'performance'])
})

test('la liste groupe les missions par étape et marque la sélection', () => {
  const selected = []
  const groups = client.groupMissions(missions)
  const tree = toTree(
    client.MissionList({
      groups,
      selectedId: 'ABC-74',
      sessionsFor: (id) => (id === 'ABC-75' ? [session] : []),
      onSelect: (entry) => selected.push(entry.id),
    }),
  )

  assert.deepEqual(byClass(tree, 'dm-mgroup').map((group) => text(group).replace(/\d+$/, '')), ['En cours', 'En attente de validation', 'En cadrage'])
  assert.equal(byClass(tree, 'dm-mitem-on').length, 1)
  assert.match(text(byClass(tree, 'dm-mitem-on')[0]), /ABC-74/)
  assert.equal(byClass(tree, 'dm-run').length, 1)

  byClass(tree, 'dm-mitem')[0].props.onClick()

  assert.deepEqual(selected, ['ABC-75'])
})

test('le filtre de statut propose les statuts présents', () => {
  const missions = [
    { ...mission, id: 'A', status: 'active' },
    { ...mission, id: 'B', status: 'draft' },
    { ...mission, id: 'C', status: 'active' },
  ]

  assert.deepEqual(client.statusFilterOptions(missions), [
    { key: '', label: 'Toutes' },
    { key: 'active', label: 'En cours' },
    { key: 'draft', label: 'En cadrage' },
  ])
})

test('la colonne de contexte reprend les quatre cartes de la maquette, plus les faits et les dépendances', () => {
  const tree = toTree(
    client.ContextColumn({
      mission,
      sessions: [session],
      sheet: { journal: { exists: true, text: 'journal' }, checklist: { exists: false, text: '' } },
    }),
  )
  const cards = byClass(tree, 'dm-ctxcard')

  assert.deepEqual(cards.map((card) => text(card.children[0])), [
    'Prochaine action',
    'Session',
    'Dépôt',
    'Frontmatter',
    'Dépendances',
    'Livrable',
  ])
  assert.match(text(cards[0]), /En cours/)
  assert.match(text(cards[0]), /Priorité/)
  assert.doesNotMatch(text(cards[0]), /Étape/)
  assert.match(text(cards[1]), /Mission de démonstration/)
  assert.match(text(cards[1]), /en cours/)
  assert.match(text(cards[2]), /konoha/)
  assert.match(text(cards[3]), /Création/)
  assert.match(text(cards[3]), /Chaîne/)
  assert.match(text(cards[4]), /Bloque/)
  assert.match(text(cards[4]), /Bloquée par/)
  assert.match(text(cards[5]), /présent/)
  assert.match(text(cards[5]), /absente/)
})

test('sans mission chargée, aucune fiche n’est rendue', () => {
  assert.equal(client.MissionSheet({ mission: null, sheet: null }), null)
})

test('les onglets de la fiche suivent l’ordre de la maquette', () => {
  assert.deepEqual(client.SHEET_TABS.map((entry) => entry.key), ['fiche', 'journal', 'checklist', 'performance'])
})

test('les missions se trient par priorité puis statut puis identifiant naturel', () => {
  const sorted = client.sortMissions([missions[1], missions[2], missions[0]])

  assert.deepEqual(sorted.map((entry) => entry.id), ['ABC-75', 'ABC-73', 'ABC-74'])
})

test('le bouton de session ouvre la session liée ou en crée une', () => {
  const picked = []
  const linked = toTree(
    client.ContextColumn({
      mission,
      sessions: [session],
      sheet: { journal: { exists: true, text: 'journal' }, checklist: { exists: true, text: 'checklist' } },
      onNew: () => picked.push('nouvelle'),
      onPickSession: (entry) => picked.push(entry.id),
    }),
  )
  const linkedButton = byClass(linked, 'dm-fbtn')

  assert.deepEqual(linkedButton.map(text), ['Ouvrir la session'])
  linkedButton[0].props.onClick()
  assert.deepEqual(picked, ['session-abc'])
  assert.equal(byClass(linked, 'dm-fmenu-item').length, 0)

  const empty = toTree(
    client.ContextColumn({
      mission,
      sessions: [],
      sheet: { journal: { exists: false, text: '' }, checklist: { exists: false, text: '' } },
      onNew: () => picked.push('nouvelle'),
      onPickSession: (entry) => picked.push(entry.id),
    }),
  )
  const emptyButton = byClass(empty, 'dm-fbtn')

  assert.deepEqual(emptyButton.map(text), ['Lier une session'])
  emptyButton[0].props.onClick()
  assert.deepEqual(picked, ['session-abc', 'nouvelle'])
  assert.equal(byClass(empty, 'dm-fmenu-item').length, 0)
})

const produitSource = [
  '---',
  'id: UV-1240',
  'type: produit',
  'status: draft',
  'priority: normal',
  'epic: UV-483',
  'story_points: 5',
  'repo: ~/projects/registre',
  'base_branch: main',
  'category: feat',
  'branch_name: feat/UV-1240',
  'pr: https://example.test/manager/pull/12',
  'suite: UV-1241',
  'queue: 2',
  'bruno: []',
  '---',
  '',
  '# Fiche',
].join('\n')

function contextFor(extra) {
  return toTree(
    client.ContextColumn({
      mission,
      sessions: [],
      sheet: { journal: { exists: false }, checklist: { exists: false } },
      ...extra,
    }),
  )
}

test('la carte Frontmatter lit les faits du frontmatter produit', () => {
  const tree = contextFor({
    mission: { ...mission, id: 'UV-1240', type: 'produit' },
    sheet: { source: produitSource, journal: { exists: false }, checklist: { exists: false } },
  })
  const facts = rows(tree)
  const links = collect(tree, (node) => node.type === 'a')

  assert.equal(facts['Story points'], '5')
  assert.equal(facts['Catégorie'], 'feat')
  assert.equal(facts['Branche'], 'feat/UV-1240')
  assert.equal(facts['Base de branche'], 'main')
  assert.equal(facts['PR'], 'https://example.test/manager/pull/12')
  assert.equal(facts['Chaîne'], 'UV-1241')
  assert.equal(facts['File'], '2')
  assert.equal(facts['Bruno'], '—')
  assert.equal(links.length, 1)
  assert.equal(links[0].props.href, 'https://example.test/manager/pull/12')
})

test('une clé absente se lit comme un tiret', () => {
  const tree = contextFor({
    mission: { ...mission, type: 'conteneur' },
    sheet: {
      source: '---\nid: ABC-90\ntype: conteneur\ncreated: 2026-11-02\nqueue:\n---\n\n# Fiche\n',
      journal: { exists: false },
      checklist: { exists: false },
    },
  })
  const facts = rows(tree)

  assert.equal(facts['Création'], '2026-11-02')
  assert.equal(facts['Chaîne'], '—')
  assert.equal(facts['File'], '—')
  assert.equal(facts['Bruno'], '—')
  assert.equal(facts['Bloque'], '—')
  assert.equal(facts['Bloquée par'], '—')
  assert.equal(facts['Story points'], undefined)
})

test('la carte Frontmatter suit le type de la mission', () => {
  const tree = contextFor({
    mission: { ...mission, id: 'POC-42', type: 'poc' },
    sheet: {
      source: '---\nid: POC-42\ntype: poc\nrepos:\n  - ~/projects/registre\n  - ~/projects/atelier\ntimebox: 2 jours\ncreated: 2026-10-30\nbruno:\n  - api\n---\n\n# Fiche\n',
      journal: { exists: false },
      checklist: { exists: false },
    },
  })
  const facts = rows(tree)

  assert.equal(facts['Dépôts'], '~/projects/registre, ~/projects/atelier')
  assert.equal(facts['Timebox'], '2 jours')
  assert.equal(facts['Création'], '2026-10-30')
  assert.equal(facts['Bruno'], 'api')
  assert.equal(facts['Story points'], undefined)
})

test('les dépendances reprennent les causes du plan dans les deux sens', () => {
  const plan = {
    blockedBy: {
      'UV-1241': [{ id: 'UV-1240', cause: 'suite' }],
      'UV-1240': [{ id: 'XYZ-9', cause: 'suite' }],
    },
  }
  const blocker = rows(contextFor({ mission: { ...mission, id: 'UV-1240', type: 'produit' }, plan }))
  const blocked = rows(contextFor({ mission: { ...mission, id: 'UV-1241', type: 'produit' }, plan }))

  assert.equal(blocker['Bloque'], 'UV-1241 (chaîne)')
  assert.equal(blocker['Bloquée par'], 'XYZ-9 (chaîne)')
  assert.equal(blocked['Bloque'], '—')
  assert.equal(blocked['Bloquée par'], 'UV-1240 (chaîne)')
})

test('le lecteur de faits accepte le BOM et les guillemets', () => {
  const facts = client.readFacts(`\ufeff${['---', 'titre: "x : y"', 'bruno: []', '---', '', '# t'].join('\r\n')}`)

  assert.equal(facts.titre, 'x : y')
  assert.equal(facts.bruno, '[]')
})
