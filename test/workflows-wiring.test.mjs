import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')

test('la vue Workflows est un chunk du panneau Missions', () => {
  const chunk = read('client.workflows.js')
  assert.match(chunk, /window\.__ModuleLoader__\.load\(\{\n {2}id: '@daedalforge\/dsh-missions',\n {2}chunk: 'client\.workflows\.js',/)
  assert.match(chunk, /missions\/api\/workflows\/list/)
  assert.match(chunk, /missions\/api\/workflows\/model/)
  assert.doesNotMatch(chunk, /sidebar\.panellist/)
  assert.doesNotMatch(chunk, /ctx\.slots\.register/)
})

test('le panneau hôte charge le chunk et montre la cinquième vue', () => {
  const host = read('client.js')
  assert.match(host, /require\s*\.async\('\.\/client\.workflows\.js'\)/)
  assert.match(host, /\{ id: 'workflows', label: 'Workflows' \}/)
  assert.match(host, /h\(WorkflowsView, \{ tabs: vueTabs\('workflows'\) \}\)/)
})

test('le panneau hôte réserve une seule entrée de barre latérale', () => {
  const host = read('client.js')
  assert.equal(host.match(/name: 'sidebar\.panellist'/g).length, 1)
})
