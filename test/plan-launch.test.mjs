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

const session = (sessionId, extra = {}) => ({ sessionId, blank: false, explicit: false, titleMatch: false, ...extra })

test('attachedSessionId : le lien explicite l’emporte sur le titre', () => {
  assert.equal(
    client.attachedSessionId([session('s-titre', { titleMatch: true }), session('s-lien', { explicit: true })]),
    's-lien',
  )
})

test('attachedSessionId : un titre qui porte l’identifiant suffit', () => {
  assert.equal(client.attachedSessionId([session('s-titre', { titleMatch: true })]), 's-titre')
})

test('attachedSessionId : une simple mention de journal n’est jamais la session de la mission', () => {
  assert.equal(client.attachedSessionId([session('s-mention', { mentions: 3 })]), '')
})

test('attachedSessionId : une session vide n’est pas la session de la mission', () => {
  assert.equal(client.attachedSessionId([session('s-vide', { blank: true, explicit: true })]), '')
})

test('attachedSessionId : aucune session rattachée', () => {
  assert.equal(client.attachedSessionId([]), '')
  assert.equal(client.attachedSessionId(undefined), '')
})

test('goPrompt : nomme la mission, sa fiche et l’autorisation de partir', () => {
  const data = { displayRoot: '~/konoha/missions' }
  const text = client.goPrompt({ id: 'ABC-92', title: 'Lancer l’exécution après validation' }, data)
  assert.match(text, /^Mission ABC-92 — Lancer l’exécution après validation/)
  assert.match(text, /Fiche : ~\/konoha\/missions\/ABC-92\/mission\.md/)
  assert.match(text, /`~\/konoha\/workflows\/missions\.md`/)
  assert.match(text, /le plan d’exécution est validé/i)
  assert.match(text, /Aucun go supplémentaire n’est attendu\./)
})

test('goPrompt : garde des chemins absolus quand la fiche est ouverte hors konoha', () => {
  const text = client.goPrompt({ id: 'ABC-92' }, { displayRoot: '/Users/…/konoha/missions/' })
  assert.match(text, /Fiche : \/Users\/…\/konoha\/missions\/ABC-92\/mission\.md/)
  assert.match(text, /`\/Users\/…\/konoha\/workflows\/missions\.md`/)
})

test('goPrompt : dérive la méthode du dossier parent, quel que soit son nom', () => {
  const text = client.goPrompt({ id: 'ABC-92' }, { displayRoot: '/Users/…/konoha/fiches' })
  assert.match(text, /Fiche : \/Users\/…\/konoha\/fiches\/ABC-92\/mission\.md/)
  assert.match(text, /`\/Users\/…\/konoha\/workflows\/missions\.md`/)
})

test('goPrompt : sans snapshot, la fiche renvoie au chemin de konoha', () => {
  const text = client.goPrompt({ id: 'ABC-92' })
  assert.match(text, /Fiche : ~\/konoha\/missions\/ABC-92\/mission\.md/)
})

test('planBannerHead : aucune mission à ouvrir', () => {
  assert.equal(client.planBannerHead([]), 'Plan validé · aucune mission à ouvrir')
  assert.equal(client.planBannerHead(undefined), 'Plan validé · aucune mission à ouvrir')
})

test('planBannerHead : un plafond atteint n’est pas un plan validé', () => {
  assert.equal(client.planBannerHead([], 'limit'), 'Plafond de sessions atteint')
})

test('planBannerHead : un lancement par mission, l’échec compté à part', () => {
  assert.equal(client.planBannerHead([{ id: 'ABC-92' }, { id: 'ABC-93' }]), 'Plan validé · 2 missions lancées')
  assert.equal(client.planBannerHead([{ id: 'ABC-92' }]), 'Plan validé · 1 mission lancée')
  assert.equal(
    client.planBannerHead([{ id: 'ABC-92' }, { id: 'ABC-93', error: 'refus' }]),
    'Plan validé · 1 mission lancée · 1 échec',
  )
})

test('validatePlan : lance les missions, n’ouvre plus de brouillon', () => {
  const body = source.match(/const validatePlan = async \(\) => \{[\s\S]*?\n      \}\n/)?.[0] ?? ''
  assert.ok(body.length > 0)
  assert.doesNotMatch(body, /startSession/)
  assert.match(body, /launchMission\(/)
  assert.match(body, /const openable = budget\.open/)
  assert.match(body, /body: JSON\.stringify\(\{ ids: openable \}\)/)
  assert.match(body, /setPlanBanner\(\{ \.\.\.banner, entries: \[\.\.\.entries\] \}\)/)
})

test('validatePlan : une vague pleine n’appelle pas l’hôte et le dit', () => {
  const body = source.match(/const validatePlan = async \(\) => \{[\s\S]*?\n      \}\n/)?.[0] ?? ''
  const guard = body.indexOf('if (openable.length === 0)')
  const post = body.indexOf('await fetch(')
  assert.ok(guard >= 0 && post >= 0 && guard < post)
  assert.match(body, /blocked: 'limit'/)
})

test('sessionBudget : le plafond nombre de sessions en cours décide des missions ouvertes', () => {
  const budget = client.sessionBudget(['ABC-92', 'ABC-93', 'ABC-94'], 2, 5)
  assert.deepEqual(budget, { total: 5, used: 2, free: 3, open: ['ABC-92', 'ABC-93', 'ABC-94'], deferred: [] })
})

test('sessionBudget : au-delà du plafond, les missions restent en file dans l’ordre de la vague', () => {
  const budget = client.sessionBudget(['ABC-92', 'ABC-93', 'ABC-94'], 4, 5)
  assert.deepEqual(budget.open, ['ABC-92'])
  assert.deepEqual(budget.deferred, ['ABC-93', 'ABC-94'])
})

test('sessionBudget : une vague pleine n’ouvre rien et reporte tout', () => {
  assert.deepEqual(client.sessionBudget(['ABC-92'], 5, 5), { total: 5, used: 5, free: 0, open: [], deferred: ['ABC-92'] })
  assert.deepEqual(client.sessionBudget(['ABC-92'], 6, 5).open, [])
})

test('sessionBudget : sans réglage, le défaut est cinq', () => {
  assert.equal(client.sessionBudget(['ABC-92'], 0, undefined).total, 5)
})

test('sessionsCounter : compte les sessions en cours et ce qui vient hors missions', () => {
  assert.equal(client.sessionsCounter(2, 5, 0), '2/5 sessions en cours')
  assert.equal(client.sessionsCounter(3, 5, 1), '3/5 sessions en cours · dont 1 hors missions')
})

test('planLimitNote : le plafond atteint se nomme et la reprise se dit', () => {
  assert.match(client.planLimitNote({ limit: 5, running: 5, deferred: 2, blocked: 'limit' }), /5\/5 sessions en cours · 2 missions reportées · libérez une session/)
  assert.match(client.planLimitNote({ limit: 5, running: 4, deferred: 1 }), /4\/5 sessions au départ · 1 mission reportée/)
  assert.equal(client.planLimitNote({ limit: 5, running: 2, deferred: 0 }), '')
})

test('bareSessionId : session-<uuid> et <uuid> désignent la même session', () => {
  assert.equal(client.bareSessionId('session-abc'), 'abc')
  assert.equal(client.bareSessionId('abc'), 'abc')
  assert.equal(client.bareSessionId(undefined), undefined)
})

test('effectiveLimit : le réglage vivant prime, le défaut reprend quand la valeur manque', () => {
  assert.equal(client.effectiveLimit(null, 3), 3)
  assert.equal(client.effectiveLimit({ status: 'loading', value: {} }, 3), 3)
  assert.equal(client.effectiveLimit({ status: 'ready', value: { maxRunningSessions: 2 } }, 5), 2)
  assert.equal(client.effectiveLimit({ status: 'ready', value: { maxRunningSessions: 0 } }, 5), 5)
  assert.equal(client.effectiveLimit({ status: 'ready', value: {} }, 5), 5)
  assert.equal(client.effectiveLimit({ status: 'ready', value: { maxRunningSessions: 80 } }, 5), 50)
})

test('runningRows : les sessions en cours du workspace, une fois chacune, sans les sous-agents', () => {
  const rows = new Map([
    ['a', { id: 'a', running: true }],
    ['b', { id: 'b', running: false }],
    ['c', { id: 'c', running: true }],
    ['d', { id: 'd', running: true, parentId: 'a', origin: 'subagent' }],
    ['a', { id: 'a', running: true }],
  ])
  assert.deepEqual(client.runningRows(rows, new Set(['session-a', 'session-b', 'session-d'])).map((row) => row.id), ['a'])
  assert.deepEqual(client.runningRows(rows, new Set()).map((row) => row.id), ['a', 'c'])
  assert.deepEqual(client.runningRows(rows, null).map((row) => row.id), ['a', 'c'])
  assert.deepEqual(client.runningRows(null, new Set(['a'])), [])
})

test('launchMission : archive la session rattachée avant de créer la suivante', () => {
  const body = source.match(/const launchMission = async \(mission, workspace\) => \{[\s\S]*?\n      \}\n/)?.[0] ?? ''
  assert.ok(body.length > 0)
  const archive = body.indexOf('ui.archiveSession(attached, { stopActivity: true })')
  const create = body.indexOf('sessions.create({ workspaceId')
  assert.ok(archive >= 0 && create >= 0 && archive < create)
})

test('launchMission : envoie le go dans la session, il ne pré-remplit pas un brouillon', () => {
  assert.match(source, /sessions\.using\(sessionId, \{ source: 'missions' \}/)
  assert.match(source, /session\.prompt\(\[\{ type: 'text', text: goPrompt\(mission, data\) \}\], 'queue'\)/)
  assert.match(source, /if \(!sent\?\.ok\) throw new Error\(sent\?\.error\?\.message/)
})

test('la validation du plan efface le rang de la fiche qu’elle ouvre', async () => {
  const server = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  const body = server.match(/for \(const mission of wanted\) \{[\s\S]*?appendJournalBlock\(/)?.[0] ?? ''
  assert.ok(body.includes("updateMissionStatus(readFileSync(file, 'utf8'), 'active')"))
  assert.ok(body.includes('updateMissionQueue(opened.content, 0)'))
})

test('unionSessionIds : réunit les sessions des deux racines de mission', () => {
  const ids = client.unionSessionIds([
    { workspaceId: 'w-konoha', sessionIds: ['session-a', 'session-b'] },
    { workspaceId: 'w-projects', sessionIds: ['session-b', 'session-c'] },
    null,
  ])
  assert.deepEqual([...ids].sort(), ['session-a', 'session-b', 'session-c'])
  assert.deepEqual([...client.unionSessionIds(null)], [])
})

test('le compteur de sessions lit les deux racines de mission', () => {
  assert.match(source, /unionSessionIds\(\[workspace, productRoot\]\)/)
})
