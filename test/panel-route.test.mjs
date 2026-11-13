import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
async function mount(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-route-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let handler = null
  // Le dossier temporaire reproduit le dépôt : `missions/projects.yml` d'un
  // côté, `workflows/model/` de l'autre — un modèle cherché au mauvais endroit
  // ne doit pas passer pour un modèle trouvé.
  await mkdir(join(dir, 'missions'), { recursive: true })
  apply(
    { effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler } } },
    { projectsFile: join(dir, 'missions', 'projects.yml'), ...config },
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
  const text = await readFile(join(dir, 'missions', 'daedalforge-missions-49', MISSION_FILE), 'utf8')
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
  const text = await readFile(join(dir, 'missions', 'daedalforge-missions-49', MISSION_FILE), 'utf8')
  assert.equal(parse(text).base, undefined)

  const refused = await call(handler, { method: 'GET', path: '/missions/api/branches' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'POST')
  assert.match(refused.body.error, /method not allowed/)

  const notPost = await call(handler, { method: 'POST', path: '/missions/api/list' })
  assert.equal(notPost.status, 405)
  assert.equal(notPost.headers.allow, 'GET')
})

test('la lecture ouverte ignore les closes, la lecture done les demande', async (t) => {
  const appels = []
  const fetchImpl = async (url) => {
    const href = String(url)
    appels.push(href)
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (href.endsWith('/user')) return json({ login: 'me' })
    if (href.includes('state=closed')) {
      return json([{ number: 9, state: 'closed', title: 'Close', labels: [] }])
    }
    return json([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
projects:
  - id: missions
    name: Workspace missions
    reference: MIS
    tracker: github
    github:
      owner: daedalforge
      repo: missions
    map:
      states:
        to-refine: to-refine
        ready: ready
        in-progress: in-progress
        in-review: in-review
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
`)
  // Une mission close n'est lisible que si son dossier la déclare.
  await mkdir(join(dir, 'missions', 'MIS-9'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-9', MISSION_FILE), 'key: MIS-9\nbranch: feat/mis-9\nbase: main\n')

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const ouvert = await call(handler, { path: '/missions/api/list' })
    assert.equal(ouvert.status, 200)
    assert.deepEqual(ouvert.body.missions.map((m) => m.key), ['MIS-2'])
    assert.equal(appels.filter((href) => href.includes('state=closed')).length, 0)

    const done = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body.missions.map((m) => m.key), ['MIS-9'])
    assert.equal(done.body.missions[0].state, 'done')
    assert.equal(appels.filter((href) => href.includes('state=closed')).length, 1)
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
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
  assert.deepEqual(await readdir(join(dir, 'missions')), [])
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
  assert.deepEqual(await readdir(join(dir, 'missions')), [])
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
  assert.deepEqual(await readdir(join(dir, 'missions')), [])
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
  assert.deepEqual(await readdir(join(dir, 'missions')), ['escape'])
})

test('GET journal lit le fichier de la mission déclarée', async (t) => {
  const { dir, handler } = await mount(t)
  await mkdir(join(dir, 'missions', 'MIS-69'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-69', MISSION_FILE), 'key: MIS-69\nbranch: feat/mis-69\nbase: main\n')
  await writeFile(join(dir, 'missions', 'MIS-69', 'journal.md'), '# Journal — MIS-69\n\n## 2026-11-11 — Cadrage\n')

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
  assert.deepEqual(await readdir(join(dir, 'missions', 'MIS-69')), [MISSION_FILE])

  const missing = await call(handler, { path: '/missions/api/journal' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /key is missing/)

  const refused = await call(handler, { method: 'POST', path: '/missions/api/journal?key=MIS-69' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET')
})

test('GET checklist lit le fichier de la mission déclarée', async (t) => {
  const { dir, handler } = await mount(t)
  await mkdir(join(dir, 'missions', 'MIS-70'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-70', MISSION_FILE), 'key: MIS-70\nbranch: feat/mis-70\nbase: main\n')
  await writeFile(join(dir, 'missions', 'MIS-70', 'checklist.md'), '# Checklist — MIS-70\n\n- [x] Les tests passent.\n')

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
  assert.deepEqual(await readdir(join(dir, 'missions', 'MIS-70')), [MISSION_FILE])

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
  await mkdir(join(dir, 'missions'), { recursive: true })
  await mkdir(join(dir, 'workflows', 'model'), { recursive: true })
  await writeFile(join(dir, 'missions', 'projects.yml'), await readFile(join(root, 'missions', 'projects.yml')))
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

/** Réponse d'un tracker : ce que `requestJson` lit d'un vrai `fetch`. */
function trackerResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

/**
 * Une déclaration de projet complète : le chargement valide la table de
 * correspondance, donc un projet nu serait refusé avant même la route.
 */
const BLOCKED_PROJECTS = `canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
projects:
  - id: missions
    name: Workspace missions
    reference: MIS
    tracker: github
    github:
      owner: daedalforge
      repo: missions
    map:
      states:
        to-refine: to-refine
        ready: ready
        in-progress: in-progress
        in-review: in-review
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
`

async function mountBlocked(t, fetchImpl) {
  const mounted = await mount(t, { fetchImpl })
  await mkdir(join(mounted.dir, 'missions'), { recursive: true })
  await writeFile(join(mounted.dir, 'missions', 'projects.yml'), BLOCKED_PROJECTS)
  return mounted
}

test('POST pose le label bloqué puis commente la raison', async (t) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    return trackerResponse({
      html_url: 'https://github.com/daedalforge/missions/issues/110#issuecomment-9',
    })
  }
  const { handler } = await mountBlocked(t, fetchImpl)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/blocked',
    body: { key: 'MIS-110', blocked: true, message: 'Attente du ticket de données.' },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    key: 'MIS-110',
    blocked: true,
    comment: 'https://github.com/daedalforge/missions/issues/110#issuecomment-9',
    project: 'missions',
  })
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels',
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/comments',
  ])
  assert.deepEqual(JSON.parse(calls[0].body), { labels: ['blocked'] })
})

test('POST retire le label sans commentaire', async (t) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${String(url)}`)
    return trackerResponse({})
  }
  const { handler } = await mountBlocked(t, fetchImpl)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/blocked',
    body: { key: 'MIS-110', blocked: false },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { key: 'MIS-110', blocked: false, comment: null, project: 'missions' })
  assert.deepEqual(calls, ['DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/blocked'])
})

test('un blocage sans raison est refusé avant tout appel au tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/blocked',
    body: { key: 'MIS-110', blocked: true, message: '   ' },
  })

  assert.equal(response.status, 400)
  assert.match(response.body.error, /a reason is required to block a mission/)
  assert.equal(touched, 0)
})

test('une clé absente ou inconnue ne touche pas le tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const withoutKey = await call(handler, { method: 'POST', path: '/missions/api/blocked', body: { blocked: false } })
  assert.equal(withoutKey.status, 400)
  assert.match(withoutKey.body.error, /key is missing/)

  const unknown = await call(handler, {
    method: 'POST',
    path: '/missions/api/blocked',
    body: { key: 'ZZZ-1', blocked: false },
  })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /no project declares ZZZ-1/)
  assert.equal(touched, 0)
})

test('GET est refusé : la route n’écrit qu’en POST', async (t) => {
  const { handler } = await mountBlocked(t, async () => trackerResponse({}))

  const response = await call(handler, { method: 'GET', path: '/missions/api/blocked' })

  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'POST')
  assert.match(response.body.error, /method not allowed/)
})

test('un refus du tracker devient une erreur d’amont, pas une faute du panneau', async (t) => {
  const { handler } = await mountBlocked(t, async () => trackerResponse({ message: 'Bad credentials' }, { status: 401 }))

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/blocked',
    body: { key: 'MIS-110', blocked: true, message: 'Attente.' },
  })

  assert.equal(response.status, 502)
  assert.match(response.body.error, /GitHub token missing or invalid/)
})

/** La même table, mais le projet ne sait pas projeter `low` : le host le dit. */
const NULL_PRIORITY_PROJECTS = BLOCKED_PROJECTS.replace('        low: priority:low', '        low: null')

test('POST priorité retire les autres labels puis pose le libellé cible', async (t) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    return trackerResponse({})
  }
  const { handler } = await mountBlocked(t, fetchImpl)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/priority',
    body: { key: 'MIS-110', priority: 'high' },
  })

  assert.equal(response.status, 200)
  // Le panneau a envoyé un mot canonique ; l'hôte a choisi la valeur du tracker.
  assert.deepEqual(response.body, { key: 'MIS-110', value: 'priority:high', priority: 'high', project: 'missions' })
  assert.deepEqual(calls.map((c) => `${c.method} ${decodeURIComponent(c.url)}`), [
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/priority:urgent',
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/priority:normal',
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/priority:low',
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels',
  ])
  assert.deepEqual(JSON.parse(calls[3].body), { labels: ['priority:high'] })
})

test('une clé absente est refusée avant le tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, { method: 'POST', path: '/missions/api/priority', body: { priority: 'high' } })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /key is missing/)
  assert.equal(touched, 0)
})

test('une priorité absente est refusée avant le tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, { method: 'POST', path: '/missions/api/priority', body: { key: 'MIS-110' } })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /priority is missing/)
  assert.equal(touched, 0)
})

test('une priorité hors du vocabulaire est refusée avant le tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/priority',
    body: { key: 'MIS-110', priority: 'medium' },
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /unknown priority: medium/)
  assert.equal(touched, 0)
})

test('une clé que nul projet ne déclare répond 404 sans toucher le tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/priority',
    body: { key: 'ZZZ-1', priority: 'high' },
  })
  assert.equal(response.status, 404)
  assert.match(response.body.error, /no project declares ZZZ-1/)
  assert.equal(touched, 0)
})

test('une priorité que le projet ne projette pas répond 400 sans toucher le tracker', async (t) => {
  let touched = 0
  const { dir, handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })
  // Cas limite du chargement : `low` est déclarée mais projetée sur `null`.
  await writeFile(join(dir, 'missions', 'projects.yml'), NULL_PRIORITY_PROJECTS)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/priority',
    body: { key: 'MIS-110', priority: 'low' },
  })
  assert.equal(response.status, 400)
  assert.match(response.body.error, /priority low has no tracker value for missions/)
  assert.equal(touched, 0)
})

test('GET est refusé sur la route priorité', async (t) => {
  const { handler } = await mountBlocked(t, async () => trackerResponse({}))

  const response = await call(handler, { method: 'GET', path: '/missions/api/priority' })

  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'POST')
  assert.match(response.body.error, /method not allowed/)
})

test('un refus du tracker sur la priorité devient une erreur d’amont', async (t) => {
  const { handler } = await mountBlocked(t, async () => trackerResponse({ message: 'Bad credentials' }, { status: 401 }))

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/priority',
    body: { key: 'MIS-110', priority: 'low' },
  })

  assert.equal(response.status, 502)
  assert.match(response.body.error, /GitHub token missing or invalid/)
})

/**
 * Un dossier de travail jetable, avec les dépôts que le scan doit y trouver.
 * Un clone porte un dossier `.git`, un worktree un fichier `.git`, et un
 * dossier nu n'en porte aucun. Le lanceur git est un faux : la route est jugée
 * sur ce qu'elle envoie et sur ce qu'elle renvoie, pas sur l'état de la machine.
 */
async function workspace(t, entries = [{ name: 'alpha' }, { name: 'beta' }]) {
  const dir = await mkdtemp(join(tmpdir(), 'missions-workspace-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const entry of entries) {
    const spec = typeof entry === 'string' ? { name: entry } : entry
    await mkdir(join(dir, spec.name), { recursive: true })
    if (spec.kind === 'worktree') {
      await writeFile(join(dir, spec.name, '.git'), `gitdir: ${join(dir, '.git', 'worktrees', spec.name)}\n`)
    } else if (spec.kind !== 'plain') {
      await mkdir(join(dir, spec.name, '.git'))
    }
  }
  return dir
}

function fauxGitRun(answers = {}) {
  const calls = []
  const run = async (file, args) => {
    const at = args.indexOf('-C')
    const name = args[at + 1].split('/').pop()
    const command = args.slice(at + 2).join(' ')
    calls.push(`${name} ${command}`)
    const answer = answers[`${name} ${command}`]
    if (answer === undefined) throw Object.assign(new Error('commande imprévue'), { stderr: '' })
    return { stdout: answer, stderr: '' }
  }
  return { run, calls }
}

const ROUTE_STATUS = '# branch.head main\n# branch.ab +0 -0\n'
const ROUTE_COMMIT = 'a1b2c3d\x1f1794468058\x1fMIS-116: ajoute l’onglet repositories'

test('GET repositories rend une entrée par enfant direct, worktree compris', async (t) => {
  // Le fixture du cadrage : 4 dossiers, 2 clones, 1 worktree, 1 non-git.
  const root = await workspace(t, [
    { name: 'alpha' },
    { name: 'beta' },
    { name: 'gamma', kind: 'worktree' },
    { name: 'plain', kind: 'plain' },
  ])
  const { run, calls } = fauxGitRun({
    'alpha status --porcelain=v2 --branch': ROUTE_STATUS,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
    'beta status --porcelain=v2 --branch': ROUTE_STATUS,
    'beta log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n# branch.ab +0 -0\n',
    'gamma log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
    'gamma worktree list --porcelain': `worktree ${join(root, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const response = await call(handler, { path: '/missions/api/repositories' })

  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store', 'un scan ne se sert jamais du cache')
  assert.equal(response.body.root, root)
  assert.equal(response.body.count, 3, '4 dossiers, 3 dépôts : le dossier nu ne devient pas une ligne')
  assert.ok(Number.isFinite(response.body.durationMs))
  assert.deepEqual(response.body.repositories.map((row) => row.name), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(response.body.repositories.map((row) => row.kind), ['clone', 'clone', 'worktree'])
  assert.equal(response.body.repositories.find((row) => row.name === 'gamma').branch, 'gh-20-hover')
  assert.ok(!response.body.repositories.some((row) => row.name === 'plain'))
  assert.deepEqual(response.body.errors, [])
  const gamma = response.body.repositories.find((row) => row.name === 'gamma')
  assert.deepEqual(gamma.main, { name: 'alpha', path: join(root, 'alpha') }, 'le worktree nomme son principal')
  assert.equal(response.body.repositories.find((row) => row.name === 'alpha').main, null)
  assert.equal(calls.length, 7, 'deux commandes par dépôt, une de plus pour le worktree, aucune pour le dossier nu')
})

test('GET repositories ignore la racine demandée par le client', async (t) => {
  const root = await workspace(t, ['alpha'])
  const { run } = fauxGitRun({
    'alpha status --porcelain=v2 --branch': ROUTE_STATUS,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  // Le panneau ne choisit pas ce qui est lu : une racine passée en paramètre
  // est ignorée, la racine du serveur reste la seule.
  const response = await call(handler, { path: '/missions/api/repositories?root=/etc' })
  assert.equal(response.status, 200)
  assert.equal(response.body.root, root)
})

test('GET repositories/count compte les clones sans lancer git', async (t) => {
  // La pastille de l'onglet lit ce compte au montage : il ne doit coûter aucun
  // processus git. Le faux lanceur lèverait sur la moindre commande, et
  // `calls` prouve qu'aucune n'a été demandée.
  const root = await workspace(t, [
    { name: 'alpha' },
    { name: 'beta' },
    { name: 'gamma', kind: 'worktree' },
    { name: 'plain', kind: 'plain' },
  ])
  const { run, calls } = fauxGitRun({})
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const response = await call(handler, { path: '/missions/api/repositories/count' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { count: 2 }, 'les clones seulement : le worktree et le dossier nu ne comptent pas')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(calls, [], 'aucune commande git pour un compte')

  // La racine du serveur reste la seule : `?root=` est ignoré.
  const ailleurs = await call(handler, { path: '/missions/api/repositories/count?root=/etc' })
  assert.equal(ailleurs.status, 200)
  assert.deepEqual(ailleurs.body, { count: 2 })

  // Une route de lecture, comme les autres.
  const post = await call(handler, { method: 'POST', path: '/missions/api/repositories/count', body: {} })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('GET repositories/count nomme une racine illisible', async (t) => {
  const { handler } = await mount(t, { workspaceRoot: join(tmpdir(), 'missions-absente-142') })

  const response = await call(handler, { path: '/missions/api/repositories/count' })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /missions-absente-142/)
})

test('GET repositories/detail lit un dépôt, refuse un nom, un inconnu et un POST', async (t) => {
  const root = await workspace(t, ['alpha'])
  // Un dossier sans `.git` n'est pas un dépôt : c'est le 404 de la route.
  await mkdir(join(root, 'plain'))
  const { run } = fauxGitRun({
    'alpha status --porcelain=v2 --branch': ROUTE_STATUS,
    'alpha remote get-url origin': 'https://github.com/daedalforge/missions.git\n',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const ok = await call(handler, { path: '/missions/api/repositories/detail?name=alpha' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.name, 'alpha')
  assert.equal(ok.body.remote, 'https://github.com/daedalforge/missions.git')
  assert.equal('commits' in ok.body, false, 'le détail ne porte plus de clé commits')

  const missing = await call(handler, { path: '/missions/api/repositories/detail' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /invalid repository name/)

  const traversal = await call(handler, { path: '/missions/api/repositories/detail?name=..%2F..%2Fetc' })
  assert.equal(traversal.status, 400, 'un nom qui sort de la racine ne passe pas')

  const unknown = await call(handler, { path: '/missions/api/repositories/detail?name=plain' })
  assert.equal(unknown.status, 404)

  const post = await call(handler, { method: 'POST', path: '/missions/api/repositories', body: {} })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('GET repositories/commits sert une page de branche, et refuse le reste', async (t) => {
  const root = await workspace(t, ['alpha'])
  const { run, calls } = fauxGitRun({
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\nfeat/a\n',
    'alpha rev-list --count refs/heads/main': '3094\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 50 --skip=0 refs/heads/main': ROUTE_COMMIT + '\nbc0ffee\x1f1794467060\x1fMIS-114: empile les étiquettes\n',
    'alpha rev-list --count refs/heads/feat/a': '51\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 50 --skip=50 refs/heads/feat/a': 'd00d1e0\x1f1794460800\x1fMIS-120: fin\n',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const page = await call(handler, { path: '/missions/api/repositories/commits?name=alpha' })
  assert.equal(page.status, 200)
  assert.equal(page.body.branch, 'main', 'sans branche demandée, main est lue')
  assert.deepEqual(page.body.branches, ['main', 'feat/a'])
  assert.equal(page.body.total, 3094)
  assert.equal(page.body.hasMore, true)
  assert.deepEqual(page.body.commits[0], { sha: 'a1b2c3d', date: 1794468058000, subject: 'MIS-116: ajoute l’onglet repositories' })

  const second = await call(handler, { path: '/missions/api/repositories/commits?name=alpha&branch=feat%2Fa&skip=50' })
  assert.equal(second.status, 200)
  assert.equal(second.body.branch, 'feat/a')
  assert.equal(second.body.hasMore, false)

  const option = await call(handler, { path: '/missions/api/repositories/commits?name=alpha&branch=--all' })
  assert.equal(option.status, 400, 'un nom de branche est un nom, jamais une option')
  assert.match(option.body.error, /invalid branch name/)

  const unknown = await call(handler, { path: '/missions/api/repositories/commits?name=alpha&branch=feature%2Fzzz' })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /unknown branch/)

  const skip = await call(handler, { path: '/missions/api/repositories/commits?name=alpha&skip=-3' })
  assert.equal(skip.status, 400)
  assert.equal(calls.some((call) => /--all/.test(call.command)), false, 'le nom refusé n’atteint jamais git')

  const post = await call(handler, { method: 'POST', path: '/missions/api/repositories/commits?name=alpha', body: {} })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('POST repositories/adopt écrit une fois, et refuse tout le reste', async (t) => {
  const root = await workspace(t, ['alpha', { name: 'gamma', kind: 'worktree' }, { name: 'plain', kind: 'plain' }])
  const { run, calls } = fauxGitRun({
    'gamma worktree list --porcelain': `worktree ${join(root, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n',
    'alpha status --porcelain=v2 --branch': '# branch.head main\n',
    'gamma switch --detach': '',
    'alpha switch gh-20-hover': '',
    [`alpha worktree remove ${join(root, 'gamma')}`]: '',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const ok = await call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: 'gamma' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, {
    ok: true,
    source: 'gamma',
    branch: 'gh-20-hover',
    main: { name: 'alpha', path: join(root, 'alpha') },
    removed: true,
    reason: null,
  })
  assert.equal(ok.headers['cache-control'], 'no-store', 'la réponse d’un geste ne se sert pas du cache')

  // La route n'accepte qu'un POST : la lire n'est pas un geste.
  const get = await call(handler, { path: '/missions/api/repositories/adopt' })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')

  // Un nom absent, un dossier sans `.git`, un nom qui sort de la racine.
  const missing = await call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: {} })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /invalid repository name/)
  const plain = await call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: 'plain' } })
  assert.equal(plain.status, 404)
  const traversal = await call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: '../etc' } })
  assert.equal(traversal.status, 400)
  assert.equal(calls.filter((line) => line.includes(' switch ')).length, 2, 'un seul geste : deux switch, pas quatre')
})

test('POST repositories/remove retire le dossier d’un worktree, sans toucher à sa branche', async (t) => {
  const root = await workspace(t, ['alpha', { name: 'gamma', kind: 'worktree' }])
  const { run, calls } = fauxGitRun({
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n',
    'gamma status --porcelain --ignored=matching': '',
    [`gamma worktree remove ${join(root, 'gamma')}`]: '',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  // Un seul geste : `git worktree remove`, sans `--force` et sans branche.
  const ok = await call(handler, { method: 'POST', path: '/missions/api/repositories/remove', body: { name: 'gamma' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { name: 'gamma', removed: true })
  assert.equal(ok.headers['cache-control'], 'no-store', 'la réponse d’un geste ne se sert pas du cache')
  assert.deepEqual(calls, ['gamma status --porcelain=v2 --branch', 'gamma status --porcelain --ignored=matching', `gamma worktree remove ${join(root, 'gamma')}`])

  // La route n'accepte qu'un POST : la lire n'est pas un geste.
  const get = await call(handler, { path: '/missions/api/repositories/remove' })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')

  // Un nom absent, un clone, un nom qui sort de la racine.
  const missing = await call(handler, { method: 'POST', path: '/missions/api/repositories/remove', body: {} })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /invalid repository name/)
  const clone = await call(handler, { method: 'POST', path: '/missions/api/repositories/remove', body: { name: 'alpha' } })
  assert.equal(clone.status, 400)
  assert.match(clone.body.error, /alpha is not a worktree/)
  const unknown = await call(handler, { method: 'POST', path: '/missions/api/repositories/remove', body: { name: 'ghost' } })
  assert.equal(unknown.status, 404)
  const traversal = await call(handler, { method: 'POST', path: '/missions/api/repositories/remove', body: { name: '../etc' } })
  assert.equal(traversal.status, 400)
})

test('POST repositories/remove rend le refus du worktree, puis accepte les ignorés consentis', async (t) => {
  const root = await workspace(t, ['alpha', { name: 'gamma', kind: 'worktree' }])
  const { run, calls } = fauxGitRun({
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n1 .M N... 100644 100644 100644 aaa bbb README.md\n',
    'gamma status --porcelain': ' M README.md\n',
    'gamma status --porcelain --ignored=matching': '',
    [`gamma worktree remove ${join(root, 'gamma')}`]: '',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const refused = await call(handler, { method: 'POST', path: '/missions/api/repositories/remove', body: { name: 'gamma' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.side, 'worktree')
  assert.deepEqual(refused.body.files, ['README.md'])
  assert.equal(refused.body.error, 'the worktree gamma has uncommitted changes (one file: README.md) — commit or stash them first')
  assert.equal(calls.some((line) => /worktree remove/.test(line)), false, 'un refus n’écrit pas')

  // Un worktree propre mais lesté d'un dossier ignoré : la route le nomme et
  // attend `acceptIgnored` avant de le supprimer avec le dossier.
  const sale = fauxGitRun({
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n',
    'gamma status --porcelain --ignored=matching': '!! node_modules/\n',
    [`gamma worktree remove ${join(root, 'gamma')}`]: '',
  })
  const second = await mount(t, { workspaceRoot: root, runGit: sale.run })
  const ignored = await call(second.handler, { method: 'POST', path: '/missions/api/repositories/remove', body: { name: 'gamma' } })
  assert.equal(ignored.status, 409)
  assert.equal(ignored.body.side, 'worktree')
  assert.equal(ignored.body.ignored, true)
  assert.deepEqual(ignored.body.files, ['node_modules'])
  assert.match(ignored.body.error, /^the worktree gamma holds 1 ignored entry \(node_modules\)/)

  const consented = await call(second.handler, {
    method: 'POST',
    path: '/missions/api/repositories/remove',
    body: { name: 'gamma', acceptIgnored: true },
  })
  assert.equal(consented.status, 200)
  assert.deepEqual(consented.body, { name: 'gamma', removed: true })
})

test('POST repositories/adopt rend le refus de l’état, avec son côté et ses fichiers', async (t) => {
  const root = await workspace(t, ['alpha', { name: 'gamma', kind: 'worktree' }])
  const { run, calls } = fauxGitRun({
    'gamma worktree list --porcelain': `worktree ${join(root, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n',
    'alpha status --porcelain=v2 --branch': '# branch.head main\n1 .M N... 100644 100644 100644 aaa bbb yarn.lock\n',
    'alpha status --porcelain': ' M yarn.lock\n',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const refused = await call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: 'gamma' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.side, 'main')
  assert.deepEqual(refused.body.files, ['yarn.lock'])
  assert.equal(refused.body.error, 'alpha has uncommitted changes (one file: yarn.lock) — commit or stash them first')
  assert.equal(calls.some((line) => line.includes(' switch ')), false, 'un refus n’écrit pas')
})

test('GET repositories/tree lit le layout, les commits et les worktrees', async (t) => {
  const root = await workspace(t, ['alpha'])
  await writeFile(join(root, 'alpha', '.git', 'machete'), 'main\n    feat/a  PR #12\n    ghost\n')
  const worktrees = [
    `worktree ${join(root, 'alpha')}`, 'HEAD abc1234', 'branch refs/heads/main', '',
    `worktree ${join(root, 'alpha-12')}`, 'HEAD def5678', 'branch refs/heads/feat/a', '',
  ].join('\n')
  const { run } = fauxGitRun({
    'alpha rev-parse --git-common-dir': '.git\n',
    'alpha worktree list --porcelain': worktrees,
    'alpha for-each-ref --format=%(refname:short) refs/heads': 'main\nfeat/a\n',
    'alpha log --format=%h%x1f%ct%x1f%s -n 11 main..refs/heads/feat/a': 'c0ffee1\x1f1794468058\x1ffeat: a\n',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const response = await call(handler, { path: '/missions/api/repositories/tree?name=alpha' })
  assert.equal(response.status, 200)
  assert.equal(response.body.layout, true)
  assert.deepEqual(response.body.branches.map((row) => [row.name, row.depth, row.parent, row.missing]), [
    ['main', 0, null, false],
    ['feat/a', 1, 'main', false],
    ['ghost', 1, 'main', true],
  ])
  assert.equal(response.body.branches[1].annotation, 'PR #12')
  assert.equal(response.body.branches[1].worktree, 'alpha-12')
  assert.equal(response.body.branches[1].commits[0].sha, 'c0ffee1')
  assert.deepEqual(response.body.branches[2].commits, [])
  const ici = response.body.worktrees.find((row) => row.path === join(root, 'alpha'))
  assert.equal(ici.current, true)
  assert.equal(ici.branch, 'main')

  const missing = await call(handler, { path: '/missions/api/repositories/tree' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /invalid repository name/)

  const post = await call(handler, { method: 'POST', path: '/missions/api/repositories/tree?name=alpha', body: {} })
  assert.equal(post.status, 405)
})

test('une racine illisible est une erreur du serveur, pas un 404', async (t) => {
  const { handler } = await mount(t, { workspaceRoot: join(tmpdir(), 'missions-absente-116') })

  const response = await call(handler, { path: '/missions/api/repositories' })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /missions-absente-116/)
})

test('les routes des dépôts refusent une requête non locale', async (t) => {
  const root = await workspace(t, ['alpha'])
  const { run } = fauxGitRun({})
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  for (const path of [
    '/missions/api/repositories',
    '/missions/api/repositories/count',
    '/missions/api/repositories/detail?name=alpha',
    '/missions/api/repositories/commits?name=alpha',
    '/missions/api/repositories/tree?name=alpha',
  ]) {
    const response = await call(handler, { path, remoteAddress: '10.0.0.7' })
    assert.equal(response.status, 403, path)
  }
})

/**
 * La clôture locale : une clé en entrée, une preuve lue au tracker, des gestes
 * git en sortie. Le faux runner enregistre tout : un refus ne doit lui avoir
 * envoyé aucun verbe d'écriture.
 */
const LOCAL_CLOSE = { tip: 'a'.repeat(40), base: 'b'.repeat(40), merge: 'c'.repeat(40) }

function closeProjects(repo) {
  return `canonical:
  states: [to-refine, ready, in-progress, in-review, ready-for-prod]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
projects:
  - id: missions
    name: Workspace missions
    reference: MIS
    repo: ${repo}
    tracker: github
    github:
      owner: daedalforge
      repo: missions
    map:
      states:
        to-refine: to-refine
        ready: ready
        in-progress: in-progress
        in-review: in-review
        ready-for-prod: ready-for-prod
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
`
}

async function mountClose(t, { fetchImpl } = {}) {
  // Le runner est installé après coup : ses réponses dépendent des chemins que
  // ce montage crée, alors que le handler est déjà construit.
  const runner = { fn: async () => { throw new Error('git runner not installed') } }
  const mounted = await mount(t, {
    runGit: (...args) => runner.fn(...args),
    fetchImpl,
    githubToken: 'test-token',
  })
  const repo = join(mounted.dir, 'repo')
  const worktree = join(mounted.dir, 'wt')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(worktree, { recursive: true })
  await mkdir(join(mounted.dir, 'missions', 'MIS-136'), { recursive: true })
  await writeFile(join(mounted.dir, 'missions', 'projects.yml'), closeProjects(repo))
  await writeFile(
    join(mounted.dir, 'missions', 'MIS-136', MISSION_FILE),
    'key: MIS-136\nbranch: feat/mis-136\nbase: main\n',
  )
  await writeFile(join(repo, '.git', 'machete'), 'main\n  feat/mis-136\n    fix/one\n')
  return { ...mounted, repo, worktree, useRun: (run) => { runner.fn = run } }
}

function closeTracker({ labels = ['ready-for-prod'] } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    if (String(url).includes('/pulls')) {
      return trackerResponse([
        {
          number: 7,
          html_url: 'https://github.com/daedalforge/missions/pull/7',
          merged_at: '2026-11-12T10:00:00Z',
          merge_commit_sha: LOCAL_CLOSE.merge,
          // The squash shape: the PR's head is the local tip, and neither is on
          // `main` — only the merge commit is.
          head: { ref: 'feat/mis-136', sha: LOCAL_CLOSE.tip },
          base: { ref: 'main' },
        },
      ])
    }
    return trackerResponse({ number: 136, title: 'Cloturer proprement le local', state: 'open', labels: labels.map((name) => ({ name })) })
  }
  return { fetchImpl, calls }
}

test('POST local-close ferme le checkout après la preuve tracker', async (t) => {
  const tracker = closeTracker()
  const { dir, handler, repo, worktree, useRun } = await mountClose(t, { fetchImpl: tracker.fetchImpl })
  const { run, calls } = fauxGitRun({
    'repo rev-parse --git-common-dir': '.git',
    'repo rev-parse --verify --quiet refs/heads/feat/mis-136': LOCAL_CLOSE.tip,
    'repo rev-parse --verify --quiet origin/main': LOCAL_CLOSE.base,
    'repo worktree list --porcelain': [
      `worktree ${repo}`,
      `HEAD ${LOCAL_CLOSE.tip}`,
      'branch refs/heads/feat/mis-136',
      '',
      `worktree ${worktree}`,
      `HEAD ${LOCAL_CLOSE.tip}`,
      'branch refs/heads/feat/mis-136',
      '',
    ].join('\n'),
    'repo status --porcelain': '',
    'wt status --porcelain': '',
    [`repo merge-base --is-ancestor ${LOCAL_CLOSE.tip} ${LOCAL_CLOSE.tip}`]: '',
    [`repo rev-list --first-parent ${LOCAL_CLOSE.tip}..${LOCAL_CLOSE.tip}`]: '',
    [`repo merge-base --is-ancestor ${LOCAL_CLOSE.merge} origin/main`]: '',
    'repo fetch origin main': '',
    [`repo worktree remove ${worktree}`]: '',
    'repo checkout main': '',
    'repo merge --ff-only origin/main': '',
    'repo rev-parse HEAD': LOCAL_CLOSE.base,
    'repo branch -D feat/mis-136': '',
  })
  useRun(run)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/local-close',
    body: { key: 'MIS-136' },
  })

  assert.equal(response.status, 200)
  assert.equal(response.body.branch, 'feat/mis-136')
  assert.equal(response.body.base, 'main')
  assert.deepEqual(response.body.worktreesRemoved, [worktree])
  assert.equal(response.body.branchRemoved, true)
  assert.equal(response.body.macheteUpdated, true)

  assert.equal(await readFile(join(repo, '.git', 'machete'), 'utf8'), 'main\n  fix/one\n')
  const journal = await readFile(join(dir, 'missions', 'MIS-136', 'journal.md'), 'utf8')
  assert.match(journal, /^# Journal — MIS-136/)
  assert.match(journal, /## \d{4}-\d{2}-\d{2} — Clôture/)
  assert.match(journal, /PR : #7/)

  assert.equal(tracker.calls.length, 2, 'deux GET, aucun écrit tracker')
  assert.deepEqual(tracker.calls.map((c) => c.method), ['GET', 'GET'])
  const commands = calls.join('\n')
  assert.ok(commands.indexOf('repo fetch origin main') < commands.indexOf('repo worktree remove'))
  assert.ok(commands.indexOf('repo worktree remove') < commands.indexOf('repo branch -D feat/mis-136'))
})

test('POST local-close refuse un commit de travail caché derrière un merge de sync', async (t) => {
  // W n'est jamais arrivé sur la base, M merge `main` par-dessus : regarder le
  // seul tip accepterait, la marche first-parent depuis la tête de PR voit W.
  const tracker = closeTracker()
  const { handler, repo, worktree, useRun } = await mountClose(t, { fetchImpl: tracker.fetchImpl })
  const work = 'f'.repeat(40)
  const sync = 'd'.repeat(40)
  const { run, calls } = fauxGitRun({
    'repo rev-parse --git-common-dir': '.git',
    'repo rev-parse --verify --quiet refs/heads/feat/mis-136': LOCAL_CLOSE.tip,
    'repo rev-parse --verify --quiet origin/main': LOCAL_CLOSE.base,
    'repo worktree list --porcelain': [
      `worktree ${repo}`,
      `HEAD ${LOCAL_CLOSE.tip}`,
      'branch refs/heads/feat/mis-136',
      '',
      `worktree ${worktree}`,
      `HEAD ${LOCAL_CLOSE.tip}`,
      'branch refs/heads/feat/mis-136',
      '',
    ].join('\n'),
    'repo status --porcelain': '',
    'wt status --porcelain': '',
    [`repo merge-base --is-ancestor ${LOCAL_CLOSE.tip} ${LOCAL_CLOSE.tip}`]: '',
    [`repo rev-list --first-parent ${LOCAL_CLOSE.tip}..${LOCAL_CLOSE.tip}`]: `${LOCAL_CLOSE.tip}\n${work}`,
    [`repo rev-list --parents -n 1 ${LOCAL_CLOSE.tip}`]: `${LOCAL_CLOSE.tip} ${work} ${sync}`,
    [`repo merge-base --is-ancestor ${sync} origin/main`]: '',
    [`repo rev-list --parents -n 1 ${work}`]: `${work} ${LOCAL_CLOSE.tip}`,
  })
  useRun(run)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/local-close',
    body: { key: 'MIS-136' },
  })

  assert.equal(response.status, 409)
  assert.match(response.body.error, /local commit fffffff is not on origin\/main/)
  const writing = calls.filter((command) =>
    /(branch -D |worktree remove |checkout |merge --ff-only|fetch )/.test(command),
  )
  assert.deepEqual(writing, [], 'un refus ne supprime rien')
  assert.equal(tracker.calls.length, 2)
})

test('POST local-close refuse une mission pas ready-for-prod sans écrire', async (t) => {
  const tracker = closeTracker({ labels: ['in-review'] })
  const { run, calls } = fauxGitRun({})
  const { handler } = await mountClose(t, { runGit: run, fetchImpl: tracker.fetchImpl })

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/local-close',
    body: { key: 'MIS-136' },
  })

  assert.equal(response.status, 409)
  assert.match(response.body.error, /not ready-for-prod/)
  assert.deepEqual(calls, [], 'aucun verbe git envoyé')
  assert.deepEqual(tracker.calls.map((c) => c.method), ['GET', 'GET'])
})

test('POST local-close valide la clé, le projet et la méthode', async (t) => {
  const tracker = closeTracker()
  const { run } = fauxGitRun({})
  const { handler } = await mountClose(t, { runGit: run, fetchImpl: tracker.fetchImpl })

  const missing = await call(handler, { method: 'POST', path: '/missions/api/local-close', body: {} })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /key is missing/)

  const unknown = await call(handler, { method: 'POST', path: '/missions/api/local-close', body: { key: 'ZZZ-1' } })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /no project declares ZZZ-1/)

  const wrongMethod = await call(handler, { path: '/missions/api/local-close' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
})

// ---------------------------------------------------------------------------
// Le relevé d'usage : deux routes, un fichier local, jamais un tracker.

test('GET du relevé ne crée pas le fichier et répond un relevé vide', async (t) => {
  const usageFile = join(await mkdtemp(join(tmpdir(), 'missions-usage-route-')), 'usage.json')
  const { handler } = await mount(t, { usageFile })

  const response = await call(handler, { path: '/missions/api/usage' })

  assert.equal(response.status, 200)
  assert.equal(response.body.broken, false)
  assert.equal(response.body.startedAt, null)
  assert.deepEqual(response.body.elements, {})
  assert.equal(response.headers['cache-control'], 'no-store')
  await assert.rejects(access(usageFile), { code: 'ENOENT' })
})

test('POST compte un geste, le relit, et n’appelle ni git ni le tracker', async (t) => {
  const calls = []
  const usageDir = await mkdtemp(join(tmpdir(), 'missions-usage-route-'))
  const usageFile = join(usageDir, 'nested', 'usage.json')
  const { handler } = await mount(t, {
    usageFile,
    fetchImpl: async (url) => { calls.push(String(url)); throw new Error('aucun appel réseau attendu') },
    runGit: () => { throw new Error('aucun git attendu') },
  })

  const written = await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'tab.missions' } })
  assert.equal(written.status, 200)
  assert.deepEqual(written.body, { element: 'tab.missions', count: 1 })

  const read = await call(handler, { path: '/missions/api/usage' })
  const entry = read.body.elements['tab.missions']
  assert.equal(entry.count, 1)
  assert.match(entry.lastUsed, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(entry.lastUsed, entry.firstUsed)
  assert.deepEqual(entry.values, {})
  assert.deepEqual(calls, [])

  // Le dossier manquant est créé : un premier geste peut être la première
  // écriture sous `storages/`.
  await access(join(usageDir, 'nested'))
})

test('POST retient le détail d’un geste, et deux gestes font deux', async (t) => {
  const usageFile = join(await mkdtemp(join(tmpdir(), 'missions-usage-route-')), 'usage.json')
  const { handler } = await mount(t, { usageFile })

  await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'filter.state', detail: 'ready' } })
  await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'filter.state', detail: 'ready' } })

  const read = await call(handler, { path: '/missions/api/usage' })
  assert.equal(read.body.elements['filter.state'].count, 2)
  assert.deepEqual(read.body.elements['filter.state'].values, { ready: 2 })
})

test('POST d’un identifiant inconnu répond 400 et n’écrit rien', async (t) => {
  const usageFile = join(await mkdtemp(join(tmpdir(), 'missions-usage-route-')), 'usage.json')
  const { handler } = await mount(t, { usageFile })

  const response = await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'tab.nope' } })

  assert.equal(response.status, 400)
  assert.match(response.body.error, /unknown element: tab\.nope/)
  await assert.rejects(access(usageFile), { code: 'ENOENT' })
})

test('POST sans élément ou avec un détail invalide répond 400 sans rien écrire', async (t) => {
  const usageFile = join(await mkdtemp(join(tmpdir(), 'missions-usage-route-')), 'usage.json')
  const { handler } = await mount(t, { usageFile })

  const missing = await call(handler, { method: 'POST', path: '/missions/api/usage', body: {} })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /element is missing/)

  const notAString = await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'tab.done', detail: 42 } })
  assert.equal(notAString.status, 400)
  assert.match(notAString.body.error, /detail must be a string/)

  const tooLong = await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'tab.done', detail: 'x'.repeat(65) } })
  assert.equal(tooLong.status, 400)
  assert.match(tooLong.body.error, /longer than 64/)

  const control = await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'tab.done', detail: 'bad\u0007detail' } })
  assert.equal(control.status, 400)
  assert.match(control.body.error, /control characters/)

  const empty = await call(handler, { method: 'POST', path: '/missions/api/usage', raw: '' })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /empty request body/)

  const invalid = await call(handler, { method: 'POST', path: '/missions/api/usage', raw: '{ not json' })
  assert.equal(invalid.status, 400)
  assert.match(invalid.body.error, /invalid JSON body/)

  await assert.rejects(access(usageFile), { code: 'ENOENT' })
})

test('la route du relevé refuse les autres méthodes et les origines distantes', async (t) => {
  const usageFile = join(await mkdtemp(join(tmpdir(), 'missions-usage-route-')), 'usage.json')
  const { handler } = await mount(t, { usageFile })

  const refused = await call(handler, { method: 'PUT', path: '/missions/api/usage', body: {} })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET, POST')

  const distant = await call(handler, { path: '/missions/api/usage', remoteAddress: '10.0.0.7' })
  assert.equal(distant.status, 403)
})

test('un fichier cassé se dit broken à la lecture, puis repart au geste suivant', async (t) => {
  const fetchImpl = async (url) => {
    const href = String(url)
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (href.endsWith('/user')) return json({ login: 'me' })
    return json([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }
  const usageFile = join(await mkdtemp(join(tmpdir(), 'missions-usage-route-')), 'usage.json')
  await writeFile(usageFile, 'half a file', 'utf8')
  const { dir, handler } = await mount(t, { usageFile, fetchImpl })
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
projects:
  - id: missions
    name: Workspace missions
    reference: MIS
    tracker: github
    github:
      owner: daedalforge
      repo: missions
    map:
      states:
        to-refine: to-refine
        ready: ready
        in-progress: in-progress
        in-review: in-review
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
`)

  const read = await call(handler, { path: '/missions/api/usage' })
  assert.equal(read.status, 200)
  assert.equal(read.body.broken, true)
  assert.deepEqual(read.body.elements, {})

  // Le relevé n'est qu'un fichier local : même cassé, il ne prend pas la
  // liste des missions en otage. La route liste répond, avec ses lignes.
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const list = await call(handler, { path: '/missions/api/list' })
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.missions.map((mission) => mission.key), ['MIS-2'])
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }

  const written = await call(handler, { method: 'POST', path: '/missions/api/usage', body: { element: 'workflow.step', detail: 'execution' } })
  assert.equal(written.status, 200)
  assert.equal(written.body.count, 1)
  const restarted = await call(handler, { path: '/missions/api/usage' })
  assert.equal(restarted.body.broken, false)
  assert.equal(restarted.body.elements['workflow.step'].count, 1)
  assert.deepEqual(restarted.body.elements['workflow.step'].values, { execution: 1 })
})

/**
 * L'archivage, de bout en bout côté hôte : le dossier d'une mission done quitte
 * `missions/` pour `missions/archives/`. Le test sert un faux tracker : la
 * preuve de `done` est lue à chaque appel, la lecture done d'après l'archive
 * ne demande plus rien puisque le dossier n'est plus déclaré.
 */
async function mountArchive(t, { issue = null, issues = null, closedStatus = 200 } = {}) {
  const closed = issues ?? (issue === null ? [] : [issue])
  const folders = issues ?? [CLOSED_42]
  const calls = []
  const json = (body, status = 200) => trackerResponse(body, { status })
  const fetchImpl = async (url) => {
    const href = String(url)
    calls.push(href)
    if (href.endsWith('/user')) return json({ login: 'me' })
    if (href.includes('state=closed')) {
      if (closedStatus !== 200) return json({ message: 'Bad credentials' }, closedStatus)
      return json(closed)
    }
    return json([])
  }
  const mounted = await mount(t, { fetchImpl })
  await writeFile(join(mounted.dir, 'missions', 'projects.yml'), BLOCKED_PROJECTS)
  for (const closedIssue of folders) {
    const key = `MIS-${closedIssue.number}`
    await mkdir(join(mounted.dir, 'missions', key), { recursive: true })
    await writeFile(
      join(mounted.dir, 'missions', key, MISSION_FILE),
      `key: ${key}\nbranch: feat/mis-${closedIssue.number}\nbase: main\n`,
    )
    await writeFile(join(mounted.dir, 'missions', key, 'journal.md'), `# Journal — ${key}\n`)
  }
  return { ...mounted, calls }
}

const CLOSED_42 = { number: 42, state: 'closed', title: 'Archiver une mission', labels: [] }
const CLOSED_43 = { number: 43, state: 'closed', title: 'Autre mission close', labels: [] }

test('POST /archive déplace une mission done et la retire de la lecture done', async (t) => {
  const { dir, handler } = await mountArchive(t, { issue: CLOSED_42 })
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
      archived: 'missions/archives/MIS-42',
      folder: 'MIS-42',
      project: 'missions',
    })
    assert.deepEqual((await readdir(join(dir, 'missions'))).sort(), ['archives', 'projects.yml'])
    assert.equal(
      await readFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'utf8'),
      '# Journal — MIS-42\n',
    )
    assert.equal(
      await readFile(join(dir, 'missions', 'archives', 'MIS-42', MISSION_FILE), 'utf8'),
      'key: MIS-42\nbranch: feat/mis-42\nbase: main\n',
    )

    const done = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body.missions, [])

    // Second envoi : le dossier n'est plus déclaré, rien n'est écrasé.
    const again = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })
    assert.equal(again.status, 409)
    assert.match(again.body.error, /no mission folder for MIS-42/)
    assert.equal(
      await readFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'utf8'),
      '# Journal — MIS-42\n',
    )
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('un refus d’archive ne déplace rien : méthode, corps, projet, dossier', async (t) => {
  const { dir, handler } = await mountArchive(t, { issue: CLOSED_42 })

  const wrongMethod = await call(handler, { path: '/missions/api/archive' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const broken = await call(handler, { method: 'POST', path: '/missions/api/archive', raw: '{"key":' })
  assert.equal(broken.status, 400)
  assert.match(broken.body.error, /invalid JSON body/)

  const noKey = await call(handler, { method: 'POST', path: '/missions/api/archive', body: {} })
  assert.equal(noKey.status, 400)
  assert.match(noKey.body.error, /key is missing/)

  const unknownProject = await call(handler, {
    method: 'POST',
    path: '/missions/api/archive',
    body: { key: 'ZZZ-1' },
  })
  assert.equal(unknownProject.status, 404)
  assert.match(unknownProject.body.error, /no project declares/)

  const unknownMission = await call(handler, {
    method: 'POST',
    path: '/missions/api/archive',
    body: { key: 'MIS-99' },
  })
  assert.equal(unknownMission.status, 409)
  assert.match(unknownMission.body.error, /no mission folder for MIS-99/)

  assert.deepEqual((await readdir(join(dir, 'missions'))).sort(), ['MIS-42', 'projects.yml'])
  assert.equal(await readFile(join(dir, 'missions', 'MIS-42', 'journal.md'), 'utf8'), '# Journal — MIS-42\n')
})

test('refuse une mission que le tracker ne dit pas done', async (t) => {
  const { dir, handler } = await mountArchive(t, { issue: null })
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /MIS-42 is not done/)
    assert.deepEqual((await readdir(join(dir, 'missions'))).sort(), ['MIS-42', 'projects.yml'])
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('une destination déjà occupée est refusée sans écrasement', async (t) => {
  const { dir, handler } = await mountArchive(t, { issue: CLOSED_42 })
  await mkdir(join(dir, 'missions', 'archives', 'MIS-42'), { recursive: true })
  await writeFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'ancien\n')
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /missions\/archives\/MIS-42 already exists/)
    assert.equal(await readFile(join(dir, 'missions', 'MIS-42', 'journal.md'), 'utf8'), '# Journal — MIS-42\n')
    assert.equal(await readFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'utf8'), 'ancien\n')
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('un refus d’archive ne tronque pas la lecture Done', async (t) => {
  const { dir, handler } = await mountArchive(t, { issues: [CLOSED_42, CLOSED_43] })
  await mkdir(join(dir, 'missions', 'archives', 'MIS-42'), { recursive: true })
  await writeFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'ancien\n')
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const initial = await call(handler, { path: '/missions/api/list?done=1' })
    assert.deepEqual(initial.body.missions.map((mission) => mission.key).sort(), ['MIS-42', 'MIS-43'])

    const refused = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })
    assert.equal(refused.status, 409)
    assert.match(refused.body.error, /missions\/archives\/MIS-42 already exists/)

    // Sans refresh : la lecture doit servir tout Done, pas la seule clé lue
    // pour la preuve. Le défaut laissait ici MIS-42 seul, ou une liste vide.
    const after = await call(handler, { path: '/missions/api/list?done=1' })
    assert.deepEqual(after.body.missions.map((mission) => mission.key).sort(), ['MIS-42', 'MIS-43'])
    assert.equal(await readFile(join(dir, 'missions', 'MIS-42', 'journal.md'), 'utf8'), '# Journal — MIS-42\n')
    assert.equal(await readFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'utf8'), 'ancien\n')
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('un échec interne du déplacement répond 500 et ne déplace rien', async (t) => {
  const { dir, handler } = await mountArchive(t, { issue: CLOSED_42 })
  // `missions/archives` est un fichier : mkdir échoue, hors ArchiveError. Un
  // défaut de la machine se dit 500, pas 502 (qui est une panne du tracker).
  await writeFile(join(dir, 'missions', 'archives'), 'pas un dossier\n')
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })
    assert.equal(response.status, 500)
    assert.match(response.body.error, /EEXIST|file already exists/)
    assert.equal(await readFile(join(dir, 'missions', 'MIS-42', 'journal.md'), 'utf8'), '# Journal — MIS-42\n')
    assert.equal(await readFile(join(dir, 'missions', 'archives'), 'utf8'), 'pas un dossier\n')
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('une panne du tracker répond 502 et ne déplace rien', async (t) => {
  const { dir, handler } = await mountArchive(t, { closedStatus: 401 })
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42' },
    })
    assert.equal(response.status, 502)
    assert.match(response.body.error, /done missions: GitHub token missing or invalid/)
    assert.equal(await readFile(join(dir, 'missions', 'MIS-42', 'journal.md'), 'utf8'), '# Journal — MIS-42\n')
    await assert.rejects(readdir(join(dir, 'missions', 'archives')), { code: 'ENOENT' })
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('POST repositories/adopt ne supprime pas des fichiers ignorés sans un second oui', async (t) => {
  const root = await workspace(t, ['alpha', { name: 'gamma', kind: 'worktree' }])
  const { run, calls } = fauxGitRun({
    'gamma worktree list --porcelain': `worktree ${join(root, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n',
    'alpha status --porcelain=v2 --branch': '# branch.head main\n',
    'gamma status --porcelain --ignored=matching': '!! node_modules/\n!! .env\n',
    'gamma switch --detach': '',
    'alpha switch gh-20-hover': '',
    [`alpha worktree remove ${join(root, 'gamma')}`]: '',
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const refused = await call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: 'gamma' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.ignored, true, 'le corps dit pourquoi la question est posée')
  assert.equal(refused.body.side, 'worktree')
  assert.deepEqual(refused.body.files, ['node_modules', '.env'])
  assert.match(refused.body.error, /holds 2 ignored entries \(node_modules, \.env\)/)
  assert.equal(calls.some((line) => line.includes(' switch ')), false, 'le premier refus n’écrit rien')

  const accepted = await call(handler, {
    method: 'POST',
    path: '/missions/api/repositories/adopt',
    body: { name: 'gamma', acceptIgnored: true },
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.removed, true)
  assert.equal(accepted.body.branch, 'gh-20-hover')
})

test('deux POST repositories/adopt ne se chevauchent pas', async (t) => {
  const root = await workspace(t, ['alpha', { name: 'gamma', kind: 'worktree' }])
  const base = fauxGitRun({
    'gamma worktree list --porcelain': `worktree ${join(root, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n',
    'alpha status --porcelain=v2 --branch': '# branch.head main\n',
    'gamma switch --detach': '',
    'alpha switch gh-20-hover': '',
    [`alpha worktree remove ${join(root, 'gamma')}`]: '',
  })
  // Le vrai git prend des millisecondes : sans verrou, les deux gestes liraient
  // le même état puis écriraient tous les deux. On compte les chevauchements.
  let active = 0
  let peak = 0
  const run = async (file, args) => {
    active += 1
    peak = Math.max(peak, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return await base.run(file, args)
    } finally {
      active -= 1
    }
  }
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const [first, second] = await Promise.all([
    call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: 'gamma' } }),
    call(handler, { method: 'POST', path: '/missions/api/repositories/adopt', body: { name: 'gamma' } }),
  ])
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(peak, 1, 'le second geste attend que le premier ait fini')
})

/* Tolgee: le diff de la mission devient un fichier XLIFF dans son dossier. */

function tolgeeProjects(repo, translations = true) {
  const block = translations
    ? `    translations:
      locales: [fr, en]
      languageFile: locales/{locale}.json
      reference: fr
`
    : ''
  return `canonical:
  states: [to-refine, ready, in-progress, in-review, ready-for-prod]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
projects:
  - id: missions
    name: Workspace missions
    reference: MIS
    repo: ${repo}
    tracker: github
    github:
      owner: daedalforge
      repo: missions
    map:
      states:
        to-refine: to-refine
        ready: ready
        in-progress: in-progress
        in-review: in-review
        ready-for-prod: ready-for-prod
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
${block}`
}

async function mountTolgee(t, {
  source = "const greet = t('greet')\n",
  locales = { fr: { greet: 'Bonjour' }, en: {} },
  translations = true,
  run = null,
  fetchImpl = undefined,
} = {}) {
  const mounted = await mount(t, {
    runGit: async (command, args) => {
      if (args.includes('show')) {
        const spec = args.at(-1)
        const file = spec.slice(spec.indexOf(':') + 1)
        return { stdout: await readFile(join(mounted.dir, 'repo', file), 'utf8'), stderr: '' }
      }
      return run ? run(command, args) : { stdout: 'src/a.js', stderr: '' }
    },
    fetchImpl,
  })
  const repo = join(mounted.dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'locales'), { recursive: true })
  await writeFile(join(repo, 'src', 'a.js'), source)
  for (const [locale, table] of Object.entries(locales)) {
    await writeFile(join(repo, 'locales', `${locale}.json`), JSON.stringify(table))
  }
  await writeFile(join(mounted.dir, 'missions', 'projects.yml'), tolgeeProjects(repo, translations))
  await mkdir(join(mounted.dir, 'missions', 'MIS-171'), { recursive: true })
  await writeFile(
    join(mounted.dir, 'missions', 'MIS-171', MISSION_FILE),
    'key: MIS-171\nbranch: feat/mis-171\nbase: main\n',
  )
  return { ...mounted, repo }
}

function postTolgee(handler, key = 'MIS-171') {
  return call(handler, { method: 'POST', path: '/missions/api/tolgee', body: { key } })
}

test('POST tolgee écrit le XLIFF de la mission et rend le bilan', async (t) => {
  const reseau = []
  const { dir, handler } = await mountTolgee(t, {
    // Aucun accès Tolgee, direct ou indirect : la route ne doit rien demander
    // au réseau, pas même un jeton ou une observation.
    fetchImpl: async (url) => {
      reseau.push(String(url))
      throw new Error('network must not be called')
    },
  })

  const response = await postTolgee(handler)

  assert.equal(response.status, 200)
  assert.equal(response.body.project, 'missions')
  assert.equal(response.body.file, 'missions/MIS-171/import-tolgee.xliff')
  assert.deepEqual(response.body.keys.map((entry) => entry.key), ['greet'])
  assert.deepEqual(response.body.keys[0].missing, ['en'])
  assert.deepEqual(response.body.untranslated, [])
  assert.deepEqual(response.body.warnings, [])

  const xliff = await readFile(join(dir, 'missions', 'MIS-171', 'import-tolgee.xliff'), 'utf8')
  assert.match(xliff, /<xliff xmlns="urn:oasis:names:tc:xliff:document:1\.2" version="1\.2">/)
  assert.match(xliff, /<file source-language="fr" target-language="fr" original="MIS-171"/)
  assert.match(xliff, /<trans-unit id="greet" resname="greet">/)
  assert.match(xliff, /<source>Bonjour<\/source>/)
  assert.match(xliff, /<target>Bonjour<\/target>/)
  assert.match(xliff, /<note>src\/a\.js:1<\/note>/)
  assert.deepEqual(reseau, [], 'la route ne fait aucun appel réseau')
})

test('POST tolgee sans clé manquante n’écrit aucun fichier', async (t) => {
  const { dir, handler } = await mountTolgee(t, { locales: { fr: { greet: 'Bonjour' }, en: { greet: 'Hello' } } })

  const response = await postTolgee(handler)

  assert.equal(response.status, 200)
  assert.equal(response.body.file, null)
  assert.deepEqual(response.body.keys, [])
  await assert.rejects(access(join(dir, 'missions', 'MIS-171', 'import-tolgee.xliff')))
})

test('POST tolgee liste à part une clé sans valeur fr, hors XLIFF', async (t) => {
  const { dir, handler } = await mountTolgee(t, { source: "t('newKey')\n", locales: { fr: {}, en: {} } })

  const response = await postTolgee(handler)

  assert.equal(response.status, 200)
  assert.equal(response.body.file, null)
  assert.deepEqual(response.body.keys, [])
  assert.deepEqual(response.body.untranslated, [{ key: 'newKey', occurrences: ['src/a.js:1'] }])
  await assert.rejects(access(join(dir, 'missions', 'MIS-171', 'import-tolgee.xliff')))
})

test('POST tolgee refuse un diff vide avec une phrase', async (t) => {
  const { dir, handler } = await mountTolgee(t, { run: async () => ({ stdout: '' }) })

  const response = await postTolgee(handler)

  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'no changed source file on feat/mis-171 against main')
  await assert.rejects(access(join(dir, 'missions', 'MIS-171', 'import-tolgee.xliff')))
})

test('POST tolgee refuse une branche absente sans écrire', async (t) => {
  const { dir, handler } = await mountTolgee(t, {
    run: async () => {
      throw Object.assign(new Error('git failed'), { stderr: "fatal: ambiguous argument 'main...feat/mis-171'" })
    },
  })

  const response = await postTolgee(handler)

  assert.equal(response.status, 409)
  assert.match(response.body.error, /^cannot read the diff of feat\/mis-171 against main: fatal: ambiguous argument/)
  await assert.rejects(access(join(dir, 'missions', 'MIS-171', 'import-tolgee.xliff')))
})

test('POST tolgee refuse un projet qui ne déclare pas de traductions', async (t) => {
  const { handler } = await mountTolgee(t, { translations: false })

  const response = await postTolgee(handler)

  assert.equal(response.status, 409)
  assert.equal(response.body.error, 'missions declares no translations')
})

test('la route tolgee est un POST qui demande une clé', async (t) => {
  const { handler } = await mountTolgee(t)

  const read = await call(handler, { method: 'GET', path: '/missions/api/tolgee?key=MIS-171' })
  assert.equal(read.status, 405)
  assert.equal(read.headers.allow, 'POST')

  const empty = await call(handler, { method: 'POST', path: '/missions/api/tolgee', body: {} })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /key is missing/)

  const unknown = await postTolgee(handler, 'OTHER-1')
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /no project declares OTHER-1/)
})
