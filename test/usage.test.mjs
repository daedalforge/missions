import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { USAGE_ELEMENTS, USAGE_MAX_DETAIL, USAGE_MAX_VALUES } from '../lib/view.js'
import { UsageError, emptyUsage, readUsage, recordUsage, usagePath } from '../lib/usage.js'

/**
 * The tally on disk: one file, one gesture at a time.
 *
 * Every test works in its own temporary directory: the real `usage.json` of
 * the machine running the suite is never read, never written, never counted.
 */
async function tempPath(name = 'usage.json') {
  const dir = await mkdtemp(join(tmpdir(), 'missions-usage-'))
  return join(dir, name)
}

test('un fichier absent est un relevé vide, et une lecture ne le crée pas', async () => {
  const file = await tempPath()

  const usage = await readUsage(file)

  assert.deepEqual(usage, emptyUsage())
  assert.equal(usage.broken, false)
  assert.equal(usage.startedAt, null)
  await assert.rejects(stat(file), { code: 'ENOENT' })
})

test('un geste crée le fichier, pose startedAt, et incrémente', async () => {
  const file = await tempPath()
  const first = new Date('2026-11-01T09:00:00.000Z')
  const second = new Date('2026-11-02T09:00:00.000Z')

  const posted = await recordUsage(file, { element: 'tab.missions' }, first)
  assert.deepEqual(posted, { element: 'tab.missions', count: 1 })
  await recordUsage(file, { element: 'tab.missions' }, second)
  const usage = await readUsage(file)

  assert.equal(usage.broken, false)
  // `startedAt` dit depuis quand le relevé existe, `updatedAt` quand il a bougé :
  // la porte d'observation se lit sur le premier, jamais sur le second.
  assert.equal(usage.startedAt, '2026-11-01T09:00:00.000Z')
  assert.equal(usage.updatedAt, '2026-11-02T09:00:00.000Z')
  assert.deepEqual(usage.elements['tab.missions'], {
    count: 2,
    firstUsed: '2026-11-01T09:00:00.000Z',
    lastUsed: '2026-11-02T09:00:00.000Z',
    values: {},
  })
  // Deux éléments sont deux lignes : compter l'un ne compte jamais l'autre.
  await recordUsage(file, { element: 'tab.usage' }, second)
  assert.equal((await readUsage(file)).elements['tab.usage'].count, 1)
})

test('un détail se compte par valeur, et le 33e est ignoré sans perdre le geste', async () => {
  const file = await tempPath()

  for (let index = 0; index < USAGE_MAX_VALUES; index += 1) {
    await recordUsage(file, { element: 'filter.state', detail: `state-${index}` })
  }
  // Un détail déjà retenu s'incrémente, il ne s'ajoute pas.
  await recordUsage(file, { element: 'filter.state', detail: 'state-0' })
  const kept = (await readUsage(file)).elements['filter.state']
  assert.equal(kept.values['state-0'], 2)
  assert.equal(Object.keys(kept.values).length, USAGE_MAX_VALUES)

  // Le 33e détail distinct est perdu, mais le compteur de l'élément avance :
  // le geste a eu lieu, même si son nom ne rentre plus.
  await recordUsage(file, { element: 'filter.state', detail: 'state-late' })
  const late = (await readUsage(file)).elements['filter.state']
  assert.equal(Object.keys(late.values).length, USAGE_MAX_VALUES)
  assert.equal(late.values['state-late'], undefined)
  assert.equal(late.count, USAGE_MAX_VALUES + 2)
})

test('un élément inconnu ou un détail invalide est refusé, le fichier reste intact', async () => {
  const file = await tempPath()
  await recordUsage(file, { element: 'tab.missions' })
  const before = await readFile(file, 'utf8')

  await assert.rejects(recordUsage(file, { element: 'tab.nope' }), /unknown element: tab\.nope/)
  await assert.rejects(recordUsage(file, {}), /element is missing/)
  await assert.rejects(recordUsage(file, { element: 'tab.missions', detail: 42 }), /detail must be a string/)
  await assert.rejects(recordUsage(file, { element: 'tab.missions', detail: 'x'.repeat(USAGE_MAX_DETAIL + 1) }), /longer than 64/)
  await assert.rejects(recordUsage(file, { element: 'tab.missions', detail: 'bad\u0000detail' }), /control characters/)
  await assert.rejects(recordUsage(file, { element: 'tab.missions', detail: 'bad\u001bdetail' }), /control characters/)
  await assert.rejects(recordUsage(file, { element: 'tab.nope' }), UsageError)

  assert.equal(await readFile(file, 'utf8'), before)
})

test('un fichier cassé se lit « broken » et repart au geste suivant', async () => {
  const file = await tempPath()
  await writeFile(file, '{ not json', 'utf8')

  const broken = await readUsage(file)
  assert.equal(broken.broken, true)
  assert.deepEqual(broken.elements, {})
  assert.equal(broken.startedAt, null)

  const stamp = new Date('2026-11-05T08:00:00.000Z')
  await recordUsage(file, { element: 'workflow.save' }, stamp)
  const fixed = await readUsage(file)
  assert.equal(fixed.broken, false)
  assert.equal(fixed.elements['workflow.save'].count, 1)
  assert.equal(fixed.startedAt, '2026-11-05T08:00:00.000Z')
})

test('deux écritures simultanées comptent deux gestes', async () => {
  const file = await tempPath()

  await Promise.all([
    recordUsage(file, { element: 'list.refresh' }),
    recordUsage(file, { element: 'list.refresh' }),
  ])

  assert.equal((await readUsage(file)).elements['list.refresh'].count, 2)
})

test('mille gestes tiennent sous cent kilooctets', async () => {
  const file = await tempPath()

  for (let index = 0; index < 1_000; index += 1) {
    await recordUsage(file, { element: 'filter.type', detail: `type-${index % (USAGE_MAX_VALUES + 1)}` })
  }

  const { size } = await stat(file)
  // Le fichier est un compteur, pas un journal : la liste des détails est
  // plafonnée, donc une année de clics reste plus petite qu'une capture d'écran.
  assert.ok(size < 100 * 1024, `usage.json pèse ${size} octets`)
  assert.equal((await readUsage(file)).elements['filter.type'].count, 1_000)
})

test('le chemin par défaut suit le profil, et la config le remplace', () => {
  assert.equal(usagePath({ dshHome: '/Users/ada/.dsh' }), '/Users/ada/.dsh/storages/dsh-missions/usage.json')
  assert.equal(usagePath({ usageFile: '/tmp/x/usage.json', dshHome: '/Users/ada/.dsh' }), '/tmp/x/usage.json')
  assert.equal(usagePath({ usageFile: new URL('file:///tmp/y/usage.json') }), '/tmp/y/usage.json')
})

test('chaque identifiant du registre s’écrit et se relit', async () => {
  const file = await tempPath()
  for (const element of USAGE_ELEMENTS) await recordUsage(file, { element: element.id })

  const { elements } = await readUsage(file)
  assert.equal(Object.keys(elements).length, USAGE_ELEMENTS.length)
  assert.deepEqual(Object.keys(elements).sort(), USAGE_ELEMENTS.map((element) => element.id).sort())
})
