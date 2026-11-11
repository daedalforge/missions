import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

test('GET journal lit le fichier de la mission déclarée', async (t) => {
  const { dir, handler } = await mount(t)
  await mkdir(join(dir, 'MIS-69'), { recursive: true })
  await writeFile(join(dir, 'MIS-69', MISSION_FILE), 'key: MIS-69\nbranch: feat/mis-69\nbase: main\n')
  await writeFile(join(dir, 'MIS-69', 'journal.md'), '# Journal — MIS-69\n\n## 2026-11-11 — Cadrage\n')

  const response = await call(handler, { path: '/missions/api/journal?key=MIS-69' })
  assert.equal(response.status, 200)
  assert.equal(response.body.key, 'MIS-69')
  assert.equal(response.body.folder, 'MIS-69')
  assert.equal(response.body.path, 'MIS-69/journal.md')
  assert.equal(response.body.exists, true)
  assert.equal(response.body.source, '# Journal — MIS-69\n\n## 2026-11-11 — Cadrage\n')
  assert.ok(response.body.mtimeMs > 0)
})

test('GET journal ne lève pas sur une clé inconnue et refuse une autre méthode', async (t) => {
  const { dir, handler } = await mount(t)

  const undeclared = await call(handler, { path: '/missions/api/journal?key=MIS-404' })
  assert.equal(undeclared.status, 200)
  assert.deepEqual(undeclared.body, { key: 'MIS-404', folder: null, path: null, exists: false, source: '', mtimeMs: 0 })

  // Le dossier déclaré existe mais le journal n'a pas encore été écrit : c'est
  // la forme vide, pas une erreur.
  const declared = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'MIS-69', branch: 'feat/mis-69', base: 'main' },
  })
  assert.equal(declared.status, 200)
  const noFile = await call(handler, { path: '/missions/api/journal?key=MIS-69' })
  assert.equal(noFile.status, 200)
  assert.equal(noFile.body.folder, 'MIS-69')
  assert.equal(noFile.body.exists, false)
  assert.equal(noFile.body.source, '')
  assert.equal(noFile.body.mtimeMs, 0)
  assert.deepEqual(await readdir(join(dir, 'MIS-69')), [MISSION_FILE])

  const missing = await call(handler, { path: '/missions/api/journal' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /key is missing/)

  const refused = await call(handler, { method: 'POST', path: '/missions/api/journal?key=MIS-69' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET')
})

test('GET checklist lit le fichier de la mission déclarée', async (t) => {
  const { dir, handler } = await mount(t)
  await mkdir(join(dir, 'MIS-70'), { recursive: true })
  await writeFile(join(dir, 'MIS-70', MISSION_FILE), 'key: MIS-70\nbranch: feat/mis-70\nbase: main\n')
  await writeFile(join(dir, 'MIS-70', 'checklist.md'), '# Checklist — MIS-70\n\n- [x] Les tests passent.\n')

  const response = await call(handler, { path: '/missions/api/checklist?key=MIS-70' })
  assert.equal(response.status, 200)
  assert.equal(response.body.key, 'MIS-70')
  assert.equal(response.body.folder, 'MIS-70')
  assert.equal(response.body.path, 'MIS-70/checklist.md')
  assert.equal(response.body.exists, true)
  assert.equal(response.body.source, '# Checklist — MIS-70\n\n- [x] Les tests passent.\n')
  assert.ok(response.body.mtimeMs > 0)
})

test('GET checklist ne lève pas sur une clé inconnue et refuse une autre méthode', async (t) => {
  const { dir, handler } = await mount(t)

  const undeclared = await call(handler, { path: '/missions/api/checklist?key=MIS-404' })
  assert.equal(undeclared.status, 200)
  assert.deepEqual(undeclared.body, { key: 'MIS-404', folder: null, path: null, exists: false, source: '', mtimeMs: 0 })

  // Le dossier déclaré existe mais la checklist n'a pas encore été écrite :
  // c'est la forme vide, pas une erreur.
  const declared = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'MIS-70', branch: 'feat/mis-70', base: 'main' },
  })
  assert.equal(declared.status, 200)
  const noFile = await call(handler, { path: '/missions/api/checklist?key=MIS-70' })
  assert.equal(noFile.status, 200)
  assert.equal(noFile.body.folder, 'MIS-70')
  assert.equal(noFile.body.exists, false)
  assert.equal(noFile.body.source, '')
  assert.equal(noFile.body.mtimeMs, 0)
  assert.deepEqual(await readdir(join(dir, 'MIS-70')), [MISSION_FILE])

  const missing = await call(handler, { path: '/missions/api/checklist' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /key is missing/)

  const refused = await call(handler, { method: 'POST', path: '/missions/api/checklist?key=MIS-70' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET')
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

/** Les modèles vivent à côté de `projects.yml`, comme dans le dépôt. */
async function copyWorkflows(dir) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })
  await writeFile(join(dir, 'projects.yml'), await readFile(join(root, 'missions', 'projects.yml')))
  for (const workflow of ['cadrage', 'execution', 'review', 'cloture']) {
    await writeFile(join(dir, 'workflows', `${workflow}.md`), await readFile(join(root, 'workflows', `${workflow}.md`)))
    await writeFile(
      join(dir, 'workflows', 'model', `${workflow}.yml`),
      await readFile(join(root, 'workflows', 'model', `${workflow}.yml`)),
    )
  }
}

/** Le modèle nu, tel que le panneau le renvoie au serveur. */
function bareModel(entry) {
  const { errors, orphanSections, headings, file, ...model } = entry
  return model
}

test('GET /workflows rend les quatre étapes et le vocabulaire', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const response = await call(handler, { path: '/missions/api/workflows' })

  assert.equal(response.status, 200)
  assert.equal(response.body.workflows.length, 4)
  assert.deepEqual(response.body.workflows.map((entry) => entry.workflow), ['cadrage', 'execution', 'review', 'cloture'])
  assert.deepEqual(response.body.writers, ['demandeur', 'session', 'outil'])
  assert.ok(response.body.states.includes('ready'))
  for (const entry of response.body.workflows) {
    assert.deepEqual(entry.errors, [], entry.workflow)
    assert.ok(entry.nodes.length > 0)
    assert.ok(entry.headings.length > 0)
  }
  assert.equal(response.body.workflows[0].text, undefined, 'le texte reste dans la route du modèle')
})

test('POST /workflows/model écrit un modèle valide', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const list = await call(handler, { path: '/missions/api/workflows' })
  const model = bareModel(list.body.workflows[0])
  model.nodes[0].label = 'Lire le ticket, puis son contexte'

  const saved = await call(handler, { method: 'POST', path: '/missions/api/workflows/model', body: { workflow: 'cadrage', model } })

  assert.equal(saved.status, 200)
  assert.equal(saved.body.model.nodes[0].label, 'Lire le ticket, puis son contexte')
  assert.deepEqual(saved.body.errors, [])
  const written = await readFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'utf8')
  assert.match(written, /puis son contexte/)
})

test('POST /workflows/model refuse un modèle invalide et n’écrit rien', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  const before = await readFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'utf8')

  const list = await call(handler, { path: '/missions/api/workflows' })
  const model = bareModel(list.body.workflows[0])
  model.entry = 'refined'

  const refused = await call(handler, { method: 'POST', path: '/missions/api/workflows/model', body: { workflow: 'cadrage', model } })

  assert.equal(refused.status, 400)
  assert.equal(refused.body.error, 'model invalid')
  assert.equal(refused.body.errors[0].code, 'etat-inconnu')
  assert.equal(await readFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'utf8'), before)
})

test('GET /workflows/model rend le YAML, un couple inconnu répond 400', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const response = await call(handler, { path: '/missions/api/workflows/model?workflow=review' })
  assert.equal(response.status, 200)
  assert.match(response.body.text, /^workflow: review/)
  assert.equal(response.body.file, 'workflows/model/review.yml')

  const missing = await call(handler, { path: '/missions/api/workflows/model' })
  assert.equal(missing.status, 400)

  const unknown = await call(handler, { path: '/missions/api/workflows/model?workflow=deploy' })
  assert.equal(unknown.status, 400)

  const refused = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows/model',
    body: { workflow: 'deploy', model: {} },
  })
  assert.equal(refused.status, 400)
})
