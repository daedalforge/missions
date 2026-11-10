import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

import { createWorkflows, listWorkspace, saveWorkspaceModel } from '../lib/workflows/server.js'

const repo = process.env.DSH_WORKSPACE ?? join(homedir(), 'konoha')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workflows-'))
  cpSync(join(repo, 'workflows'), join(root, 'workflows'), { recursive: true })
  cpSync(join(repo, 'standards'), join(root, 'standards'), { recursive: true })
  return root
}

function request(method, url, body) {
  const stream = new Readable({ read() {} })
  if (body !== undefined) stream.push(JSON.stringify(body))
  stream.push(null)
  return Object.assign(stream, { method, url, headers: { host: '127.0.0.1:52018' } })
}

function response() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload
    },
  }
}

async function call(handler, method, url, body) {
  const res = response()
  await handler(request(method, url, body), res)
  return { status: res.status, payload: JSON.parse(res.body) }
}

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function handlerFor(root) {
  const sendJson = (res, status, body) => {
    res.writeHead(status, {})
    res.end(JSON.stringify(body))
  }
  const fail = (res, status, code, message) => sendJson(res, status, { ok: false, error: { code, message } })
  const readJson = (req, limit = 16384) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')))
      req.on('error', reject)
      if (limit <= 0) reject(new Error('limite'))
    })
  return createWorkflows({ root, readJson, sendJson, fail })
}

test('la liste rend les sept workflows avec leurs gestes et leurs arcs', async (t) => {
  const root = fixture()
  roots.push(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { status, payload } = await call(handlerFor(root), 'GET', '/missions/api/workflows/list')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.workflows.length, 7)
  for (const entry of payload.value.workflows) {
    assert.ok(entry.gestures > 0, `${entry.workflow} : au moins un geste`)
    assert.ok(Array.isArray(entry.errors))
    assert.ok(Array.isArray(entry.orphanSections))
  }
})

test('le modèle d’un workflow se lit tel quel', async (t) => {
  const root = fixture()
  roots.push(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { status, payload } = await call(handlerFor(root), 'GET', '/missions/api/workflows/model?workflow=cadrage')
  assert.equal(status, 200)
  assert.equal(payload.value.workflow, 'cadrage')
  assert.match(payload.value.text, /"workflow": "cadrage"/)
})

test('un workflow inconnu est refusé avant toute lecture', async (t) => {
  const root = fixture()
  roots.push(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { status, payload } = await call(handlerFor(root), 'GET', '/missions/api/workflows/model?workflow=inconnu')
  assert.equal(status, 400)
  assert.equal(payload.error.code, 'invalid-workflow')
})

test('un modèle refusé nomme ses écarts et laisse le fichier intact', async (t) => {
  const root = fixture()
  roots.push(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'workflows', 'model', 'cadrage.json')
  const before = readFileSync(file, 'utf8')
  const model = JSON.parse(before)
  model.extra = true
  const { status, payload } = await call(handlerFor(root), 'POST', '/missions/api/workflows/model', {
    workflow: 'cadrage',
    model,
  })
  assert.equal(status, 400)
  assert.equal(payload.error.code, 'model-invalid')
  assert.ok(payload.error.errors.some((error) => error.includes('extra')))
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('un modèle valide est réécrit et validé', async (t) => {
  const root = fixture()
  roots.push(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const model = JSON.parse(readFileSync(join(root, 'workflows', 'model', 'cadrage.json'), 'utf8'))
  const { status, payload } = await call(handlerFor(root), 'POST', '/missions/api/workflows/model', {
    workflow: 'cadrage',
    model: { ...model, title: `${model.title} (essai)` },
  })
  assert.equal(status, 200)
  assert.match(payload.value.text, /\(essai\)/)
})

test('le contrôle de concordance répond au même préfixe', async (t) => {
  const root = fixture()
  roots.push(root)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { status, payload } = await call(handlerFor(root), 'POST', '/missions/api/workflows/check')
  assert.equal(status, 200)
  assert.ok(Array.isArray(payload.value.models))
  assert.ok(payload.value.models.every((entry) => Array.isArray(entry.errors)))
})

test('une écriture hors des modèles connus est refusée', () => {
  const root = fixture()
  roots.push(root)
  assert.throws(() => saveWorkspaceModel(root, 'inconnu', {}), /workflow inconnu/)
})

test('listWorkspace nomme les sections sans geste', () => {
  const root = fixture()
  roots.push(root)
  const value = listWorkspace(root)
  assert.equal(value.workflows.length, 7)
  assert.ok(value.workflows.every((entry) => entry.fingerprint.length > 0))
})
