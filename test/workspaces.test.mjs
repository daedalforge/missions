import assert from 'node:assert/strict'
import test from 'node:test'

import { findWorkspaceId, normalizePath } from '../lib/workspaces.js'

const HOME = '/Users/ada'
const STORE = {
  tables: {
    workspaces: {
      '6fd0e8b3': { path: '/Users/ada/Documents/deepseek-harness/default-workspace' },
      '7e4df5b8': { path: '/Users/ada/projects' },
    },
  },
}

test('trouve l’identifiant par chemin', () => {
  assert.equal(findWorkspaceId(STORE, '/Users/ada/projects', HOME), '7e4df5b8')
  assert.equal(findWorkspaceId(STORE, '/Users/ada/projects/', HOME), '7e4df5b8')
  assert.equal(findWorkspaceId(STORE, '~/projects', HOME), '7e4df5b8')
})

test('rend null quand rien ne correspond', () => {
  assert.equal(findWorkspaceId(STORE, '/Users/ada/ailleurs', HOME), null)
  assert.equal(findWorkspaceId({}, '/Users/ada/projects', HOME), null)
  assert.equal(findWorkspaceId(STORE, '', HOME), null)
})

test('accepte un tableau de dossiers', () => {
  const liste = { tables: { workspaces: [{ id: 'x', path: '/Users/ada/projects' }] } }
  assert.equal(findWorkspaceId(liste, '/Users/ada/projects', HOME), 'x')
})

test('normalise les chemins', () => {
  assert.equal(normalizePath('~/projects/', HOME), '/Users/ada/projects')
  assert.equal(normalizePath('~', HOME), '/Users/ada')
  assert.equal(normalizePath(null, HOME), null)
})
