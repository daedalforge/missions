import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter, parseTitle, normalizeStatus, scanMissions, buildSearchText } from '../lib/missions.js'

const MISSION = `---
id: XYZ-1395
type: produit
status: active
epic: XYZ-1309
repo: ~/projects/atelier
base_branch:
bruno:
  - ~/bruno/missions/xyz-1395/connect
---

# Sujet de démonstration

## Contexte

Texte.
`

test('parseFrontmatter lit les clés top-level et ignore les sous-listes', () => {
  const fields = parseFrontmatter(MISSION)
  assert.equal(fields.id, 'XYZ-1395')
  assert.equal(fields.status, 'active')
  assert.equal(fields.epic, 'XYZ-1309')
  assert.equal(fields.repo, '~/projects/atelier')
  assert.equal(fields.bruno, '')
  assert.equal('  - ~/bruno/missions/xyz-1395/connect' in fields, false)
})

test('parseTitle renvoie le premier titre H1', () => {
  assert.equal(parseTitle(MISSION), 'Sujet de démonstration')
  assert.equal(parseTitle('pas de titre'), '')
})

test('normalizeStatus normalise casse, espaces et tirets', () => {
  assert.equal(normalizeStatus('In Review'), 'in_review')
  assert.equal(normalizeStatus('in-review'), 'in_review')
  assert.equal(normalizeStatus(undefined), '')
})

test('scanMissions exclut archives et missions terminées, trie naturellement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-missions-'))
  const missions = join(root, 'missions')
  const epics = join(root, 'epics')
  await mkdir(join(missions, 'XYZ-9'), { recursive: true })
  await mkdir(join(missions, 'XYZ-10'), { recursive: true })
  await mkdir(join(missions, 'XYZ-11'), { recursive: true })
  await mkdir(join(missions, 'archives', 'XYZ-1'), { recursive: true })
  await mkdir(join(missions, 'archives', 'XYZ-2'), { recursive: true })
  await mkdir(join(epics, 'XYZ-1309'), { recursive: true })

  await writeFile(join(missions, 'XYZ-9', 'mission.md'), MISSION.replace('XYZ-1395', 'XYZ-9'))
  await writeFile(join(missions, 'XYZ-10', 'mission.md'), MISSION.replaceAll('XYZ-1395', 'XYZ-10'))
  await writeFile(join(missions, 'XYZ-11', 'mission.md'), MISSION.replaceAll('XYZ-1395', 'XYZ-11').replace('status: active', 'status: done'))
  await writeFile(join(missions, 'archives', 'XYZ-1', 'mission.md'), MISSION.replaceAll('XYZ-1395', 'XYZ-1').replace('status: active', 'status: done'))
  await writeFile(join(epics, 'XYZ-1309', 'epic.md'), '---\nkey: XYZ-1309\nstatus: active\n---\n\n# Intégration de démonstration\n')

  const data = await scanMissions(missions)
  assert.deepEqual(
    data.missions.map((mission) => mission.id),
    ['XYZ-9', 'XYZ-10'],
  )
  assert.equal(data.archived, 2)
  assert.deepEqual(data.epics, [{ key: 'XYZ-1309', title: 'Intégration de démonstration', status: 'active', jira: '' }])
  assert.equal(data.missions[0].title, 'Sujet de démonstration')
  assert.equal(data.missions[0].epic, 'XYZ-1309')
  assert.ok(data.missions[0].search.includes('sujet de demonstration'))
  assert.ok(data.missions[0].search.includes('~/bruno/missions/xyz-1395/connect'))
})

test('le texte cherchable couvre le frontmatter, les listes et le corps, sans les clés', () => {
  const source = `---
id: XYZ-42
type: produit
status: active
branch_name: feat/branche-de-demonstration
story_points: 5
bruno:
  - ~/bruno/missions/xyz-42/connect
---

# Sujet de démonstration

Le contrôleur refuse une requête mal formée.
`
  const text = buildSearchText({
    id: 'XYZ-42',
    title: 'Sujet de démonstration',
    fields: parseFrontmatter(source),
    source,
  })
  assert.ok(text.includes('feat/branche-de-demonstration'), 'la branche')
  assert.ok(text.includes('story_points') === false, 'la clé du frontmatter reste dehors')
  assert.ok(text.includes('~/bruno/missions/xyz-42/connect'), 'la liste bruno')
  assert.ok(text.includes('le controleur refuse'), 'le corps, sans accents')
  assert.ok(!text.includes('é'))
  assert.equal(buildSearchText({ id: 'X', title: '', fields: {}, source: '' }), 'x')
})
