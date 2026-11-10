import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * Smoke test for the generated client bundle.
 *
 * It loads `lib/client.js` with a fake module loader and a fake React, mounts
 * the panel once, and renders every registered component. This is what catches
 * a render-time crash — the regression that made the panel blank when a
 * missing service was looked up through `ctx.get`.
 */
const SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

// Minimal DOM surface: the bundle mounts one <style> and nothing else.
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { append() {} },
}

function charger(storage) {
  let captured = null
  new Function('window', 'localStorage', SOURCE)({ __ModuleLoader__: { load: (module) => { captured = module } } }, storage)

  const h = (type, props, ...children) => ({ type, props, children })
  const React = {
    createElement: h,
    Fragment: 'fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
  }

  const registered = {}
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => {
        registered[options.name] = component
      },
    },
    // A cordis context throws on an unknown service: the panel must survive it.
    get: () => {
      throw new Error('service not found')
    },
  }

  const api = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { api, ctx, registered, id: captured.id }
}

test('le bundle charge et déclare ses slots', () => {
  const { api, ctx, registered, id } = charger()
  assert.equal(id, '@daedalforge/dsh-missions')
  assert.deepEqual(api.inject, ['slots'])

  api.apply(ctx)

  assert.deepEqual(Object.keys(registered).sort(), ['main', 'sidebar.panellist'])
})

test('chaque composant rend sans lever, même sans service uiWorkspace', () => {
  const { api, ctx, registered } = charger()
  api.apply(ctx)

  for (const [name, component] of Object.entries(registered)) {
    assert.doesNotThrow(() => component({}), `rendu de ${name}`)
  }
})

test('le volet de détail porte la branche et la base, et bloque sans elles', () => {
  // Le volet n'est pas enregistré comme slot : on vérifie le bundle construit,
  // seule preuve que l'aide de vue a bien été inlinée et que les lignes existent.
  assert.match(SOURCE, /label: 'Branch', value: mission\.branch/)
  assert.match(SOURCE, /label: 'Base', value: mission\.base/)
  assert.match(SOURCE, /function executionBlocker\(mission = \{\}\)/)
  assert.match(SOURCE, /Session blocked: \$\{blocker\}/)
  assert.match(SOURCE, /disabled: blocker !== null/)
  assert.match(SOURCE, /'aria-describedby': blocker \? 'missions-session-blocked' : undefined/)
})

test('le prompt de session reprend la branche et la base déclarées', () => {
  assert.match(SOURCE, /Branche : \$\{mission\.branch\} ; base : \$\{mission\.base\}\./)
})

test('les erreurs du bandeau ont une clé unique par ligne', () => {
  assert.ok(SOURCE.includes('key: `${error.project}-${index}`'))
})

test('le thème Naruto rend le bandeau et les images embarquées', () => {
  const { api, ctx, registered } = charger({ getItem: () => 'manga', setItem: () => {} })
  api.apply(ctx)
  const tree = registered.main({})
  const flat = JSON.stringify(tree)
  assert.match(flat, /"data-theme":"manga"/)
  assert.match(flat, /missions-hero/)
  assert.match(flat, /data:image\/webp;base64,/)
  assert.match(SOURCE, /Naruto theme/)
  assert.match(flat, /missions-drawer--empty/)
  assert.doesNotMatch(SOURCE, /missions-drawer--empty \{ display: none; \}/)
  assert.match(SOURCE, /\[data-theme="manga"\] \.missions-card:hover \{[^}]*background: color-mix/)
  assert.doesNotMatch(SOURCE, /\[data-theme="manga"\] \.missions-card:hover \{[^}]*translateY/)
})
