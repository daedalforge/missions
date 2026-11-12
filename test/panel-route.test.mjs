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
  assert.equal(calls.length, 6, 'deux commandes par dépôt, aucune pour le dossier nu')
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

test('GET repositories/detail lit un dépôt, refuse un nom, un inconnu et un POST', async (t) => {
  const root = await workspace(t, ['alpha'])
  // Un dossier sans `.git` n'est pas un dépôt : c'est le 404 de la route.
  await mkdir(join(root, 'plain'))
  const { run } = fauxGitRun({
    'alpha status --porcelain=v2 --branch': ROUTE_STATUS,
    'alpha remote get-url origin': 'https://github.com/daedalforge/missions.git\n',
    'alpha log -n 10 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const ok = await call(handler, { path: '/missions/api/repositories/detail?name=alpha' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.name, 'alpha')
  assert.equal(ok.body.remote, 'https://github.com/daedalforge/missions.git')
  assert.equal(ok.body.commits.length, 1)

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

  for (const path of ['/missions/api/repositories', '/missions/api/repositories/detail?name=alpha']) {
    const response = await call(handler, { path, remoteAddress: '10.0.0.7' })
    assert.equal(response.status, 403, path)
  }
})
