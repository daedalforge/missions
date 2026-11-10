import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

import { MISSION_FILE } from '../lib/branches.js'
import { apply } from '../lib/index.js'

/**
 * La route de déclaration, de bout en bout côté hôte.
 *
 * Le panneau n'écrit jamais de chemin : il envoie une clé et deux noms, la route
 * choisit le dossier, valide et écrit. Ces tests montent le vrai handler avec un
 * faux serveur web et de vraies requêtes, dans un dossier temporaire.
 */
async function mount(t) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-route-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let handler = null
  apply(
    { effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler } } },
    { projectsFile: join(dir, 'projects.yml') },
  )
  assert.ok(handler, 'la route est enregistrée')
  return { dir, handler }
}

async function call(handler, { method = 'GET', path, body, raw, origin, extraHeaders = {}, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = raw !== undefined ? [Buffer.from(raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: path,
    headers: { ...(origin ? { origin } : {}), ...extraHeaders },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }

  let status = 0
  let headers = null
  let payload = ''
  const res = {
    writeHead(value, sent) {
      status = value
      headers = sent
    },
    end(value) {
      payload = String(value ?? '')
    },
  }

  await handler(req, res)
  return { status, headers, body: payload ? JSON.parse(payload) : null }
}

test('POST déclare la branche et la base dans le dossier de la mission', async (t) => {
  const { dir, handler } = await mount(t)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'daedalforge/missions#49', branch: 'gh-49', base: 'main' },
  })

  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.deepEqual(response.body, {
    key: 'daedalforge/missions#49',
    folder: 'daedalforge-missions-49',
    branch: 'gh-49',
    base: 'main',
  })
  const text = await readFile(join(dir, 'daedalforge-missions-49', MISSION_FILE), 'utf8')
  assert.match(text, /^key: daedalforge\/missions#49$/m)
  assert.match(text, /^branch: gh-49$/m)
})

test('POST vide un champ retiré, GET est refusé', async (t) => {
  const { dir, handler } = await mount(t)
  await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'daedalforge/missions#49', branch: 'gh-49', base: 'main' },
  })

  const cleared = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'daedalforge/missions#49', branch: 'gh-49', base: '' },
  })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.base, null)
  const text = await readFile(join(dir, 'daedalforge-missions-49', MISSION_FILE), 'utf8')
  assert.equal(parse(text).base, undefined)

  const refused = await call(handler, { method: 'GET', path: '/missions/api/branches' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'POST')
  assert.match(refused.body.error, /method not allowed/)

  const notPost = await call(handler, { method: 'POST', path: '/missions/api/list' })
  assert.equal(notPost.status, 405)
  assert.equal(notPost.headers.allow, 'GET')
})

test('un corps invalide ou une déclaration invalide répond 400', async (t) => {
  const { dir, handler } = await mount(t)

  const broken = await call(handler, { method: 'POST', path: '/missions/api/branches', raw: '{"key":' })
  assert.equal(broken.status, 400)
  assert.match(broken.body.error, /invalid JSON body/)

  const empty = await call(handler, { method: 'POST', path: '/missions/api/branches' })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /empty request body/)

  const noKey = await call(handler, { method: 'POST', path: '/missions/api/branches', body: {} })
  assert.equal(noKey.status, 400)
  assert.match(noKey.body.error, /key is missing/)

  const notAString = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'daedalforge/missions#49', branch: 42 },
  })
  assert.equal(notAString.status, 400)
  assert.match(notAString.body.error, /branch must be a string/)

  // Rien n'a été créé par les requêtes refusées.
  assert.deepEqual(await readdir(dir), [])
})

test('un corps trop gros est refusé sur son en-tête', async (t) => {
  const { dir, handler } = await mount(t)

  const tooBig = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    raw: '{"key":"a#1"}',
    extraHeaders: { 'content-length': String(64 * 1024) },
  })
  assert.equal(tooBig.status, 400)
  assert.match(tooBig.body.error, /too large/)
  assert.deepEqual(await readdir(dir), [])
})

test('un corps trop gros reçoit son 400 sur un vrai socket', async (t) => {
  const { dir, handler } = await mount(t)
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()

  const post = (headers, payload) => new Promise((resolve, reject) => {
    let settled = false
    const finish = (value) => {
      settled = true
      resolve(value)
    }
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/missions/api/branches', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => finish({ status: res.statusCode, body }))
    })
    // Le serveur peut fermer la connexion pendant l'envoi : seul le 400 compte.
    req.on('error', (error) => { if (!settled) reject(error) })
    req.end(payload)
  })

  const declared = await post(
    { 'content-type': 'application/json', 'content-length': String(64 * 1024) },
    'x'.repeat(64 * 1024),
  )
  assert.equal(declared.status, 400)
  assert.match(JSON.parse(declared.body).error, /too large/)

  const chunked = await post({ 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, 'x'.repeat(64 * 1024))
  assert.equal(chunked.status, 400)
  assert.match(JSON.parse(chunked.body).error, /too large/)

  // Rien n'a été écrit par les requêtes refusées.
  assert.deepEqual(await readdir(dir), [])
})

test('un chemin ne peut pas sortir de missions : le dossier vient de la clé', async (t) => {
  const { dir, handler } = await mount(t)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: '../../escape', branch: 'x', base: 'main' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.folder, 'escape')
  assert.deepEqual(await readdir(dir), ['escape'])
})

test('une route inconnue répond 404, un appel non local répond 403', async (t) => {
  const { handler } = await mount(t)

  const unknown = await call(handler, { path: '/missions/api/unknown' })
  assert.equal(unknown.status, 404)

  const remote = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'a#1', branch: 'b', base: 'c' },
    remoteAddress: '10.0.0.2',
  })
  assert.equal(remote.status, 403)

  const forgedOrigin = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'a#1', branch: 'b', base: 'c' },
    origin: 'https://evil.example',
  })
  assert.equal(forgedOrigin.status, 403)
})
