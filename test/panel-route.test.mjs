import assert from 'node:assert/strict'
import { access, chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'

import { MISSION_FILE } from '../lib/branches.js'
import { apply } from '../lib/index.js'
import { resetRepositorySummary } from '../lib/repositories.js'
import { clearCache } from '../lib/trackers/index.js'
import { forgetToken } from '../lib/trackers/github.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

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
    project: null,
    branch: 'gh-49',
    base: 'main',
  })
  const text = await readFile(join(dir, 'missions', 'daedalforge-missions-49', MISSION_FILE), 'utf8')
  assert.match(text, /^key: daedalforge\/missions#49$/m)
  assert.match(text, /^branch: gh-49$/m)
})

test('POST déclare plusieurs paires et répond la liste', async (t) => {
  const { dir, handler } = await mount(t)
  const branches = [
    { branch: 'fix/mis-90-p1', base: 'main' },
    { branch: 'fix/mis-90-p2', base: 'fix/mis-90-p1' },
    { branch: 'fix/mis-90', base: 'fix/mis-90-p2' },
  ]

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/branches',
    body: { key: 'MIS-90', folder: 'MIS-90', project: 'missions', branches },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body.branches, branches)
  assert.equal(response.body.branch, 'fix/mis-90-p1', 'la première paire reste branch')
  assert.equal(response.body.base, 'main', 'la première paire reste base')

  const text = await readFile(join(dir, 'missions', 'MIS-90', MISSION_FILE), 'utf8')
  const declared = parse(text)
  assert.deepEqual(declared.branches, branches)
  assert.equal(declared.branch, undefined)
  assert.equal(declared.base, undefined)
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

test('POST épingle une mission dans pins.yml, GET est refusé', async (t) => {
  const { dir, handler } = await mount(t)

  const pinned = await call(handler, { method: 'POST', path: '/missions/api/pin', body: { key: 'MIS-14', pinned: true } })
  assert.equal(pinned.status, 200)
  assert.deepEqual(pinned.body, { key: 'MIS-14', pinned: true })
  const text = await readFile(join(dir, 'missions', 'pins.yml'), 'utf8')
  assert.match(text, /^# Épingles du poste — jamais versionné\.$/m)
  assert.match(text, /pinned:\n  - MIS-14\n/)

  const cleared = await call(handler, { method: 'POST', path: '/missions/api/pin', body: { key: 'MIS-14', pinned: false } })
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.body, { key: 'MIS-14', pinned: false })
  assert.deepEqual(parse(await readFile(join(dir, 'missions', 'pins.yml'), 'utf8')).pinned, [])

  const refused = await call(handler, { method: 'GET', path: '/missions/api/pin' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'POST')
  assert.match(refused.body.error, /method not allowed/)
})

test('une épingle sans clé ou mal typée répond 400 sans écrire', async (t) => {
  const { dir, handler } = await mount(t)

  const sansCle = await call(handler, { method: 'POST', path: '/missions/api/pin', body: { key: '  ', pinned: true } })
  assert.equal(sansCle.status, 400)
  assert.equal(sansCle.body.error, 'key is missing')

  const malTypee = await call(handler, { method: 'POST', path: '/missions/api/pin', body: { key: 'MIS-14', pinned: 'yes' } })
  assert.equal(malTypee.status, 400)
  assert.equal(malTypee.body.error, 'pinned must be a boolean')

  const corps = await call(handler, { method: 'POST', path: '/missions/api/pin', raw: '{' })
  assert.equal(corps.status, 400)

  await assert.rejects(readFile(join(dir, 'missions', 'pins.yml'), 'utf8'), { code: 'ENOENT' })
})

test('la lecture porte l’épingle de chaque mission et les erreurs du fichier', async (t) => {
  clearCache()
  t.after(() => clearCache())
  const fetchImpl = async (url) => {
    const href = String(url)
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (href.endsWith('/user')) return json({ login: 'me' })
    return json([
      { number: 2, state: 'open', title: 'Épinglée', labels: [{ name: 'ready' }] },
      { number: 3, state: 'open', title: 'Libre', labels: [{ name: 'ready' }] },
    ])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: mis
    name: Missions board
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
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
`)

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    await writeFile(join(dir, 'missions', 'pins.yml'), 'pinned:\n  - MIS-2\n')
    const avec = await call(handler, { path: '/missions/api/list' })
    assert.equal(avec.status, 200)
    assert.deepEqual(avec.body.missions.map((mission) => [mission.key, mission.pinned]), [['MIS-2', true], ['MIS-3', false]])

    await writeFile(join(dir, 'missions', 'pins.yml'), 'pinned: [MIS-2\n')
    const casse = await call(handler, { path: '/missions/api/list' })
    assert.equal(casse.status, 200)
    assert.ok(casse.body.errors.some((error) => error.project === 'pins'), 'le fichier cassé est signalé')
    assert.ok(casse.body.missions.every((mission) => mission.pinned === false), 'aucune épingle n’est devinée')
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
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
trackers:
  - id: mis
    name: Missions board
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
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
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

test('le compte de Done suit le périmètre déclaré, projet par projet', async (t) => {
  // Le tracker expose une close déclarée (9) et une close que rien ne déclare
  // (8) : seule la première entre dans le périmètre. Un second projet sans
  // dossier ne doit coûter aucune requête.
  const appels = []
  const fetchImpl = async (url) => {
    const href = String(url)
    appels.push(href)
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (href.endsWith('/user')) return json({ login: 'me' })
    if (href.includes('state=closed')) {
      return json([
        { number: 9, state: 'closed', title: 'Close', labels: [] },
        { number: 8, state: 'closed', title: 'Close non déclarée', labels: [] },
      ])
    }
    return json([{ number: 2, state: 'open', title: 'Ouverte', labels: [{ name: 'ready' }] }])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  t.after(() => clearCache())
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: mis
    name: Missions board
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
  - id: sig
    name: Signet board
    reference: SIG
    tracker: github
    github:
      owner: daedalforge
      repo: signet
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
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
  - id: signet
    name: Signet
    repo: ~/projects/signet
`)
  await mkdir(join(dir, 'missions', 'MIS-9'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-9', MISSION_FILE), 'key: MIS-9\nbranch: feat/mis-9\nbase: main\n')

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    clearCache()
    const compte = await call(handler, { path: '/missions/api/done/count' })
    assert.equal(compte.status, 200)
    assert.deepEqual(compte.body, { count: 1, errors: [] })
    // Une seule lecture close : celle du projet qui déclare au moins une clé.
    const closes = appels.filter((href) => href.includes('state=closed'))
    assert.equal(closes.length, 1)
    assert.match(closes[0], /\/repos\/daedalforge\/missions\/issues/)
    assert.equal(appels.some((href) => href.includes('/repos/daedalforge/signet/')), false, 'aucune requête pour un projet sans clé déclarée')

    // Le compte est celui des lignes que Done montrerait pour la même lecture.
    const lignes = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(lignes.body.missions.filter((mission) => mission.state === 'done').length, compte.body.count)

    // Déclaration retirée : le périmètre se vide, sans un seul appel au tracker.
    clearCache()
    await rm(join(dir, 'missions', 'MIS-9'), { recursive: true, force: true })
    appels.length = 0
    const vide = await call(handler, { path: '/missions/api/done/count' })
    assert.deepEqual(vide.body, { count: 0, errors: [] })
    assert.equal(appels.filter((href) => href.includes('state=closed')).length, 0)
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('le compte et les lignes de Done partagent leur lecture au montage', async (t) => {
  const appels = []
  const fetchImpl = async (url) => {
    const href = String(url)
    appels.push(href)
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (href.endsWith('/user')) return json({ login: 'me' })
    if (href.includes('state=closed')) {
      // La lecture close est lente : les deux routes partent avant qu'aucune
      // n'ait rempli le cache, comme au montage sur Done.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return json([{ number: 9, state: 'closed', title: 'Close', labels: [] }])
    }
    return json([])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  t.after(() => clearCache())
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: mis
    name: Missions board
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
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
`)
  await mkdir(join(dir, 'missions', 'MIS-9'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-9', MISSION_FILE), 'key: MIS-9\nbranch: feat/mis-9\nbase: main\n')

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    // Au montage sur Done, l'effet de montage et l'ouverture de l'onglet
    // partent ensemble : une seule lecture close doit être payée.
    clearCache()
    appels.length = 0
    const [compte, lignes] = await Promise.all([
      call(handler, { path: '/missions/api/done/count' }),
      call(handler, { path: '/missions/api/list?done=1' }),
    ])
    assert.deepEqual(compte.body, { count: 1, errors: [] })
    assert.equal(lignes.body.missions.length, 1)
    assert.equal(appels.filter((href) => href.includes('state=closed')).length, 1, 'les deux routes partagent une seule lecture close')

    // Une lecture déjà terminée reste partagée par les deux routes.
    clearCache()
    appels.length = 0
    const premieres = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(premieres.body.missions.length, 1)
    const closes = appels.filter((href) => href.includes('state=closed')).length
    const apres = await call(handler, { path: '/missions/api/done/count' })
    assert.deepEqual(apres.body, { count: 1, errors: [] })
    assert.equal(appels.filter((href) => href.includes('state=closed')).length, closes, 'le compte ne relit pas les closes')
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('une déclaration cassée accompagne le compte de ses erreurs', async (t) => {
  const appels = []
  const fetchImpl = async (url) => {
    const href = String(url)
    appels.push(href)
    const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) })
    if (href.endsWith('/user')) return json({ login: 'me' })
    return json([])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  t.after(() => clearCache())
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: mis
    name: Missions board
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
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
`)
  // Le dossier existe mais sa déclaration est illisible : le périmètre devient
  // partiel, et le compte ne peut plus prétendre à un nombre.
  await mkdir(join(dir, 'missions', 'MIS-9'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-9', MISSION_FILE), 'key: [\n')

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    clearCache()
    const compte = await call(handler, { path: '/missions/api/done/count' })
    assert.equal(compte.status, 200)
    assert.equal(compte.body.count, 0)
    assert.equal(compte.body.errors.length, 1)
    assert.match(compte.body.errors[0].message, /MIS-9/)
    // Aucune clé déclarée : pas une requête close.
    assert.equal(appels.filter((href) => href.includes('state=closed')).length, 0)
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('le compte de Done ne répond qu’en GET', async (t) => {
  const { handler } = await mount(t)
  const refused = await call(handler, { method: 'POST', path: '/missions/api/done/count' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET')
  assert.match(refused.body.error, /method not allowed/)
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

test('GET checklist-index rend les lignes des missions déclarées, une fois', async (t) => {
  const { dir, handler } = await mount(t)
  for (const [key, folder] of [['MIS-70', 'MIS-70'], ['MIS-71', 'MIS-71']]) {
    await mkdir(join(dir, 'missions', folder), { recursive: true })
    await writeFile(join(dir, 'missions', folder, MISSION_FILE), `key: ${key}\nbranch: feat/${key.toLowerCase()}\nbase: main\n`)
  }
  await writeFile(join(dir, 'missions', 'MIS-70', 'checklist.md'), [
    '# Checklist — MIS-70',
    '',
    '## Left',
    '- [x] Les tests passent.',
    '- [ ] Le README est à jour.',
    '',
  ].join('\n'))

  const response = await call(handler, { path: '/missions/api/checklist-index' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.errors, [])
  assert.deepEqual(response.body.missions.map((mission) => mission.key), ['MIS-70', 'MIS-71'])

  const [first, second] = response.body.missions
  assert.equal(first.folder, 'MIS-70')
  assert.equal(first.exists, true)
  assert.deepEqual(first.counts, { total: 2, checked: 1, partial: 0, open: 1 })
  assert.deepEqual(first.lines, [
    { text: 'Checklist — MIS-70', state: null, heading: true },
    { text: 'Left', state: null, heading: true },
    { text: 'Les tests passent.', state: 'checked' },
    { text: 'Le README est à jour.', state: 'open' },
  ])

  // Le dossier déclaré sans checklist reste dans l'index, en forme vide.
  assert.equal(second.exists, false)
  assert.deepEqual(second.lines, [])
  assert.deepEqual(second.counts, { total: 0, checked: 0, partial: 0, open: 0 })
})

test('GET checklist-index tient un cache court et le paie sur refresh', async (t) => {
  const { dir, handler } = await mount(t)
  await mkdir(join(dir, 'missions', 'MIS-70'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-70', MISSION_FILE), 'key: MIS-70\nbranch: feat/mis-70\nbase: main\n')
  await writeFile(join(dir, 'missions', 'MIS-70', 'checklist.md'), '- [ ] Un.\n')

  const first = await call(handler, { path: '/missions/api/checklist-index' })
  assert.equal(first.body.missions[0].counts.total, 1)

  // Le fichier change entre deux frappes : le cache le sert encore, sans lire.
  await writeFile(join(dir, 'missions', 'MIS-70', 'checklist.md'), '- [x] Un.\n- [ ] Deux.\n')
  const cached = await call(handler, { path: '/missions/api/checklist-index' })
  assert.equal(cached.body.missions[0].counts.total, 1)
  assert.equal(cached.body.missions[0].counts.checked, 0)

  // Le geste qui paie à nouveau.
  const refreshed = await call(handler, { path: '/missions/api/checklist-index?refresh=1' })
  assert.equal(refreshed.body.missions[0].counts.total, 2)
  assert.equal(refreshed.body.missions[0].counts.checked, 1)

  const refused = await call(handler, { method: 'POST', path: '/missions/api/checklist-index' })
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
  await writeFile(join(dir, 'missions', 'projects.yml'), await readFile(join(root, 'test', 'fixtures', 'projects.yml')))
  for (const workflow of ['cadrage', 'execution', 'review', 'cloture']) {
    await writeFile(join(dir, 'workflows', `${workflow}.md`), await readFile(join(root, 'workflows', `${workflow}.md`)))
    await writeFile(
      join(dir, 'workflows', 'model', `${workflow}.yml`),
      await readFile(join(root, 'workflows', 'model', `${workflow}.yml`)),
    )
  }
  await mkdir(join(dir, 'workflows', 'model', 'actions'), { recursive: true })
  await writeFile(
    join(dir, 'workflows', 'model', 'actions', 'decoupage.yml'),
    await readFile(join(root, 'workflows', 'model', 'actions', 'decoupage.yml')),
  )
}

/** Le modèle nu, tel que le panneau le renvoie au serveur. */
function bareModel(entry) {
  const { errors, orphanSections, headings, file, summary, counts, local, ...model } = entry
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

test('sans projetsFile, GET /workflows liste les cinq modèles du paquet, marqués versionnés', async (t) => {
  // Given : l'hôte monté sans fichier de projets, comme le déploiement par défaut.
  const { handler } = await mount(t, { projectsFile: null })

  // When
  const response = await call(handler, { path: '/missions/api/workflows' })

  // Then : les cinq modèles versionnés du paquet sont là, et rien d'autre ne l'est.
  assert.equal(response.status, 200)
  const versioned = response.body.workflows.filter((entry) => entry.local !== true)
  assert.deepEqual(versioned.map((entry) => entry.workflow), ['cadrage', 'execution', 'review', 'cloture', 'statuts'])
  for (const entry of versioned) {
    assert.equal(entry.local, false)
    assert.match(entry.file, /^workflows\/model\/[a-z-]+\.yml$/)
    assert.doesNotMatch(entry.file, /undefined/)
  }
  // Les workflows locaux réels du poste, quand il y en a, restent locaux et dans leur dossier.
  for (const entry of response.body.workflows.filter((entry) => entry.local === true)) {
    assert.match(entry.file, /^workflows\/local\/model\/[a-z-]+\.yml$/)
  }
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

test('POST /workflows ne reçoit que le titre, la description et le type', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const created = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows',
    body: {
      title: 'Incidents',
      description: 'Les incidents du workspace.',
      kind: 'etape',
    },
  })

  assert.equal(created.status, 201)
  assert.equal(created.body.workflow, 'incidents', 'la clé est le slug du titre')
  assert.equal(created.body.document, 'workflows/incidents.md', 'le document suit la clé')
  assert.equal(created.body.entry.kind, 'etape')
  assert.equal(created.body.entry.description, 'Les incidents du workspace.')
  assert.deepEqual(created.body.entry.nodes, [])
  assert.equal(await readFile(join(dir, 'workflows', 'incidents.md'), 'utf8'), '# Incidents\n\n## Ce qu\'on fait\n')
  const modele = await readFile(join(dir, 'workflows', 'model', 'incidents.yml'), 'utf8')
  assert.match(modele, /document: workflows\/incidents\.md/)
  assert.match(modele, /description: Les incidents du workspace\./)

  const again = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows',
    body: { title: 'Incidents', kind: 'etape' },
  })
  assert.equal(again.status, 400)
  assert.equal(again.body.errors[0].code, 'cle-double')
  assert.match(await readFile(join(dir, 'workflows', 'model', 'incidents.yml'), 'utf8'), /title: Incidents/)
})

test('POST /workflows refuse une clé, un document et une sortie invalides', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  const corps = { workflow: 'incidents', title: 'Incidents', kind: 'etape', document: 'workflows/incidents.md', entry: 'to-refine', exit: ['ready'] }

  const cle = await call(handler, { method: 'POST', path: '/missions/api/workflows', body: { ...corps, workflow: '../main' } })
  assert.equal(cle.status, 400)
  assert.equal(cle.body.errors[0].field, 'key')
  assert.equal(cle.body.errors[0].code, 'cle-invalide')

  const document = await call(handler, { method: 'POST', path: '/missions/api/workflows', body: { ...corps, document: '../incidents.md' } })
  assert.equal(document.status, 400)
  assert.equal(document.body.errors[0].code, 'document-invalide')

  const sortie = await call(handler, { method: 'POST', path: '/missions/api/workflows', body: { ...corps, exit: ['shipped'] } })
  assert.equal(sortie.status, 400)
  assert.equal(sortie.body.errors[0].code, 'etat-inconnu')

  assert.equal(await readFile(join(dir, 'workflows', 'model', 'incidents.yml'), 'utf8').catch(() => null), null, 'rien n’est écrit')
})

test('POST /workflows pré-remplit un workflow de statuts, et la liste le rend', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const created = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows',
    body: {
      workflow: 'statuts',
      title: 'Statuts des missions',
      kind: 'statuts',
      document: 'workflows/statuts.md',
      entry: 'to-refine',
      exit: ['done'],
    },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.entry.kind, 'statuts')
  assert.deepEqual(created.body.entry.nodes.map((node) => node.id), ['to-refine', 'ready', 'in-progress', 'in-review', 'ready-for-prod', 'done'])
  assert.deepEqual(created.body.entry.edges, [])
  assert.equal(await readFile(join(dir, 'workflows', 'statuts.md'), 'utf8'), '# Statuts des missions\n')

  const list = await call(handler, { path: '/missions/api/workflows' })
  assert.equal(list.body.workflows.length, 5)
  assert.deepEqual(list.body.workflows.map((entry) => entry.workflow), ['cadrage', 'execution', 'review', 'cloture', 'statuts'])
  assert.equal(list.body.workflows.at(-1).kind, 'statuts')
  assert.deepEqual(list.body.workflows.at(-1).counts, { nodes: 6, edges: 0 })
})

test('GET /workflows rend aussi les action flows, liés à leur nœud', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const response = await call(handler, { path: '/missions/api/workflows' })

  assert.equal(response.status, 200)
  assert.equal(response.body.actionFlows.length, 1)
  const flow = response.body.actionFlows[0]
  assert.equal(flow.kind, 'action-flow')
  assert.equal(flow.flow, 'decoupage')
  assert.equal(flow.workflow, 'review')
  assert.equal(flow.action, 'decouper')
  assert.equal(flow.section, 'Quand la PR est trop grosse')
  assert.equal(flow.writer, 'session')
  assert.equal(flow.file, 'workflows/model/actions/decoupage.yml')
  assert.equal(flow.local, false)
  assert.deepEqual(flow.counts, { entry: 2, steps: 8, forbidden: 7 })
  assert.deepEqual(flow.errors, [])
  assert.equal(flow.text, undefined, 'le texte reste dans la route du flow')
})

test('GET /action-flows/model rend le YAML, un flow inconnu répond 400', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const response = await call(handler, { path: '/missions/api/action-flows/model?flow=decoupage' })
  assert.equal(response.status, 200)
  assert.match(response.body.text, /^kind: action-flow/)
  assert.equal(response.body.file, 'workflows/model/actions/decoupage.yml')
  assert.equal(response.body.entry.steps.length, 8)
  assert.deepEqual(response.body.errors, [])

  const missing = await call(handler, { path: '/missions/api/action-flows/model' })
  assert.equal(missing.status, 400)

  const unknown = await call(handler, { path: '/missions/api/action-flows/model?flow=deploy' })
  assert.equal(unknown.status, 400)
})

test('POST /action-flows/model enregistre un flow valide et relit le fichier', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  const list = await call(handler, { path: '/missions/api/workflows' })
  const { errors, local, file, text, counts, ...model } = list.body.actionFlows[0]
  model.title = 'Découper une PR trop grosse (relu)'
  model.steps = [model.steps[1], model.steps[0], ...model.steps.slice(2)]
  model.gate = 'le demandeur a confirmé les bornes'

  const saved = await call(handler, {
    method: 'POST',
    path: '/missions/api/action-flows/model',
    body: { flow: 'decoupage', model },
  })

  assert.equal(saved.status, 200)
  assert.equal(saved.body.flow, 'decoupage')
  assert.equal(saved.body.file, 'workflows/model/actions/decoupage.yml')
  assert.equal(saved.body.entry.title, 'Découper une PR trop grosse (relu)')
  assert.equal(saved.body.entry.gate, 'le demandeur a confirmé les bornes')
  assert.deepEqual(saved.body.entry.steps.slice(0, 2), [model.steps[0], model.steps[1]])
  const written = parse(await readFile(join(dir, 'workflows', 'model', 'actions', 'decoupage.yml'), 'utf8'))
  assert.equal(written.title, 'Découper une PR trop grosse (relu)')
  assert.deepEqual(written.steps, model.steps)
  assert.equal(written.gate, 'le demandeur a confirmé les bornes')

  const listed = await call(handler, { path: '/missions/api/workflows' })
  assert.equal(listed.body.actionFlows[0].title, 'Découper une PR trop grosse (relu)')
})

test('POST /action-flows/model refuse chaque écart et n’écrit rien', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  const list = await call(handler, { path: '/missions/api/workflows' })
  const { errors, local, file, text, counts, ...base } = list.body.actionFlows[0]
  const fichier = join(dir, 'workflows', 'model', 'actions', 'decoupage.yml')
  const avant = await readFile(fichier, 'utf8')

  const cas = [
    ['une gate vide', { gate: '' }, 'gate', 'gate-manquant'],
    ['un écrivain inconnu', { writer: 'robot' }, 'writer', 'ecrivain-inconnu'],
    ['une action inconnue', { action: 'deployer' }, 'action', 'action-inconnue'],
    ['une section divergente', { section: 'Ce qu’on constate' }, 'section', 'section-divergente'],
    ['un flow différent du fichier', { flow: 'autre' }, 'flow', 'flux-different'],
    ['des étapes en double', { steps: ['la même', 'la même'] }, 'steps[1]', 'etape-double'],
  ]

  for (const [nom, patch, field, code] of cas) {
    const refused = await call(handler, {
      method: 'POST',
      path: '/missions/api/action-flows/model',
      body: { flow: 'decoupage', model: { ...base, ...patch } },
    })
    assert.equal(refused.status, 400, nom)
    assert.equal(refused.body.errors[0].field, field, nom)
    assert.equal(refused.body.errors[0].code, code, nom)
    assert.equal(await readFile(fichier, 'utf8'), avant, `${nom} : le fichier reste intact`)
  }
})

test('POST /action-flows/model refuse un couple déjà pris en 409', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  await writeFile(join(dir, 'workflows', 'model', 'actions', 'decoupage-bis.yml'), [
    'kind: action-flow',
    'flow: decoupage-bis',
    'title: Découpage bis',
    'workflow: review',
    'action: decouper',
    'section: Quand la PR est trop grosse',
    'writer: session',
    'entry:',
    '  - une condition',
    'steps:',
    '  - une étape',
    'gate: une gate',
    'forbidden:',
    '  - un interdit',
    'proof: une preuve',
    '',
  ].join('\n'), 'utf8')
  const fichier = join(dir, 'workflows', 'model', 'actions', 'decoupage-bis.yml')
  const avant = await readFile(fichier, 'utf8')

  const refused = await call(handler, {
    method: 'POST',
    path: '/missions/api/action-flows/model',
    body: {
      flow: 'decoupage-bis',
      model: {
        kind: 'action-flow',
        flow: 'decoupage-bis',
        title: 'Découpage bis',
        workflow: 'review',
        action: 'decouper',
        section: 'Quand la PR est trop grosse',
        writer: 'session',
        entry: ['une condition'],
        steps: ['une étape'],
        gate: 'une gate',
        forbidden: ['un interdit'],
        proof: 'une preuve',
      },
    },
  })

  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'action flow conflict')
  assert.ok(refused.body.errors.some((error) => error.code === 'paire-double'))
  assert.equal(await readFile(fichier, 'utf8'), avant)
})

test('un flow local est listé local, lu et édité dans son dossier', async (t) => {
  // Given : un flow rangé sous workflows/local/model/actions/.
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  const local = join(dir, 'workflows', 'local', 'model', 'actions')
  await mkdir(local, { recursive: true })
  await writeFile(join(local, 'constat.yml'), [
    'kind: action-flow',
    'flow: constat',
    'title: Constater la validation',
    'workflow: review',
    'action: constater-validation',
    "section: Ce qu'on constate",
    'writer: session',
    'entry:',
    '  - une PR ouverte',
    'steps:',
    '  - lire les avis',
    'gate: chaque PR porte son verdict',
    'forbidden:',
    '  - approuver une PR',
    'proof: la validation citée',
    '',
  ].join('\n'), 'utf8')

  // When : la liste et la route du flow.
  const listed = await call(handler, { path: '/missions/api/workflows' })
  const read = await call(handler, { path: '/missions/api/action-flows/model?flow=constat' })

  // Then : le flow est marqué local, lu depuis son dossier, et validé.
  const flow = listed.body.actionFlows.find((entry) => entry.flow === 'constat')
  assert.ok(flow)
  assert.equal(flow.local, true)
  assert.equal(flow.file, 'workflows/local/model/actions/constat.yml')
  assert.deepEqual(flow.errors, [])
  assert.equal(read.status, 200)
  assert.equal(read.body.local, true)
  assert.match(read.body.file, /^workflows\/local\/model\/actions\/constat\.yml$/)

  // Et l'édition en place passe par la même route.
  const { errors, local: rangement, file, text, counts, ...model } = flow
  model.gate = 'chaque PR porte son verdict, daté'
  const saved = await call(handler, {
    method: 'POST',
    path: '/missions/api/action-flows/model',
    body: { flow: 'constat', model },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.local, true)
  assert.equal(saved.body.entry.gate, 'chaque PR porte son verdict, daté')
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
trackers:
  - id: mis
    name: Missions board
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
      points: "sp:"
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
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
    project: null,
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
  assert.deepEqual(response.body, { key: 'MIS-110', blocked: false, comment: null, project: null })
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
  assert.deepEqual(response.body, { key: 'MIS-110', value: 'priority:high', priority: 'high', project: null })
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
  assert.match(response.body.error, /priority low has no tracker value for mis/)
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

/** Le même projet, sans préfixe de points : la taille n'a alors aucune forme native. */
const NULL_POINTS_PROJECTS = BLOCKED_PROJECTS.replace('      points: "sp:"\n', '')

/** Un projet Jira qui déclare son champ de story points, à côté de la table canonique. */
const JIRA_POINTS_PROJECTS = `canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: ex
    name: Example board
    reference: EX
    tracker: jira
    jira:
      site: https://example.atlassian.net
      cloud_id: cloud-1
      email: me@example.test
      story_points_field: customfield_10032
    map:
      states:
        to-refine: To Do
        ready: Ready
        in-progress: In Progress
        in-review: In Review
      types:
        bug: Bug
        story: Story
      priorities:
        urgent: Highest
        high: High
        normal: Medium
        low: Low
projects:
  - id: alpha
    name: Alpha
    repo: ~/projects/alpha
`

test('POST points pose le label de la taille et rend la forme native', async (t) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${decodeURIComponent(String(url))}`)
    // L'issue portait déjà une taille : la route la remplace.
    if ((init.method ?? 'GET') === 'GET') return trackerResponse({ labels: [{ name: 'ready' }, { name: 'sp:8' }] })
    return trackerResponse({})
  }
  const { handler } = await mountBlocked(t, fetchImpl)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/points',
    body: { key: 'MIS-110', points: 5 },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { key: 'MIS-110', value: 'sp:5', points: 5, project: null })
  assert.deepEqual(calls, [
    'GET https://api.github.com/repos/daedalforge/missions/issues/110',
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/sp:8',
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels',
  ])
})

test('POST points sur Jira écrit le champ du projet, une seule fois', async (t) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null })
    return trackerResponse(undefined, { status: 204 })
  }
  const { dir, handler } = await mountBlocked(t, fetchImpl)
  await writeFile(join(dir, 'missions', 'projects.yml'), JIRA_POINTS_PROJECTS)
  const before = { token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL }
  process.env.JIRA_API_TOKEN = 'test-jira-token'
  process.env.JIRA_EMAIL = 'me@example.test'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/points',
      body: { key: 'EX-7', points: 3 },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { key: 'EX-7', field: 'customfield_10032', points: 3, project: null })
    assert.deepEqual(calls.map((entry) => `${entry.method} ${entry.url}`), [
      'PUT https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/EX-7',
    ])
    assert.deepEqual(JSON.parse(calls[0].body), { fields: { customfield_10032: 3 } })
  } finally {
    if (before.token === undefined) delete process.env.JIRA_API_TOKEN
    else process.env.JIRA_API_TOKEN = before.token
    if (before.email === undefined) delete process.env.JIRA_EMAIL
    else process.env.JIRA_EMAIL = before.email
  }
})

test('POST points accepte la demi-pointe sur GitHub comme sur Jira', async (t) => {
  const githubCalls = []
  const jiraCalls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (target.includes('atlassian')) {
      jiraCalls.push({ url: target, method: init.method ?? 'GET', body: init.body ?? null })
      return trackerResponse(undefined, { status: 204 })
    }
    githubCalls.push(`${init.method ?? 'GET'} ${decodeURIComponent(target)}`)
    // L'issue portait déjà `sp:3` : la demi-pointe la remplace.
    if ((init.method ?? 'GET') === 'GET') return trackerResponse({ labels: [{ name: 'ready' }, { name: 'sp:3' }] })
    return trackerResponse({})
  }
  const { dir, handler } = await mountBlocked(t, fetchImpl)

  const github = await call(handler, {
    method: 'POST',
    path: '/missions/api/points',
    body: { key: 'MIS-110', points: 0.5 },
  })

  assert.equal(github.status, 200)
  assert.deepEqual(github.body, { key: 'MIS-110', value: 'sp:0.5', points: 0.5, project: null })
  assert.deepEqual(githubCalls, [
    'GET https://api.github.com/repos/daedalforge/missions/issues/110',
    'DELETE https://api.github.com/repos/daedalforge/missions/issues/110/labels/sp:3',
    'POST https://api.github.com/repos/daedalforge/missions/issues/110/labels',
  ])

  // Jira : la même demi-pointe, sur le champ que le projet déclare.
  await writeFile(join(dir, 'missions', 'projects.yml'), JIRA_POINTS_PROJECTS)
  const before = { token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL }
  process.env.JIRA_API_TOKEN = 'test-jira-token'
  process.env.JIRA_EMAIL = 'me@example.test'
  try {
    const jira = await call(handler, {
      method: 'POST',
      path: '/missions/api/points',
      body: { key: 'EX-7', points: 0.5 },
    })

    assert.equal(jira.status, 200)
    assert.deepEqual(jira.body, { key: 'EX-7', field: 'customfield_10032', points: 0.5, project: null })
    assert.deepEqual(jiraCalls.map((entry) => `${entry.method} ${entry.url}`), [
      'PUT https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/EX-7',
    ])
    assert.deepEqual(JSON.parse(jiraCalls[0].body), { fields: { customfield_10032: 0.5 } })
  } finally {
    if (before.token === undefined) delete process.env.JIRA_API_TOKEN
    else process.env.JIRA_API_TOKEN = before.token
    if (before.email === undefined) delete process.env.JIRA_EMAIL
    else process.env.JIRA_EMAIL = before.email
  }
})

test('POST points refuse une clé absente avant tout appel au tracker', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, { method: 'POST', path: '/missions/api/points', body: { points: 5 } })

  assert.equal(response.status, 400)
  assert.match(response.body.error, /key is missing/)
  assert.equal(touched, 0)
})

test('POST points refuse une taille absente ou hors échelle avant tout appel', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const missing = await call(handler, { method: 'POST', path: '/missions/api/points', body: { key: 'MIS-110' } })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /points is missing/)

  for (const points of [0, 1.5, 0.25, 4, 13.5, -2, 'cinq', '']) {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/points',
      body: { key: 'MIS-110', points },
    })
    assert.equal(response.status, 400, `la taille ${JSON.stringify(points)} est refusée`)
    assert.match(response.body.error, /points/)
  }
  assert.equal(touched, 0)
})

test('POST points refuse une clé que personne ne déclare', async (t) => {
  let touched = 0
  const { handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/points',
    body: { key: 'ZZZ-1', points: 3 },
  })

  assert.equal(response.status, 404)
  assert.match(response.body.error, /no project declares ZZZ-1/)
  assert.equal(touched, 0)
})

test('POST points refuse un projet dont la taille n’a pas de forme native', async (t) => {
  let touched = 0
  const { dir, handler } = await mountBlocked(t, async () => {
    touched += 1
    return trackerResponse({})
  })
  await writeFile(join(dir, 'missions', 'projects.yml'), NULL_POINTS_PROJECTS)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/points',
    body: { key: 'MIS-110', points: 3 },
  })

  assert.equal(response.status, 400)
  assert.match(response.body.error, /points have no tracker value for mis/)
  assert.equal(touched, 0)
})

test('GET est refusé sur la route points', async (t) => {
  const { handler } = await mountBlocked(t, async () => trackerResponse({}))

  const response = await call(handler, { method: 'GET', path: '/missions/api/points' })

  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'POST')
  assert.match(response.body.error, /method not allowed/)
})

test('un refus du tracker sur les points devient une erreur d’amont', async (t) => {
  const { handler } = await mountBlocked(t, async () => trackerResponse({ message: 'Bad credentials' }, { status: 401 }))

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/points',
    body: { key: 'MIS-110', points: 3 },
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
    // Une `Error` en réponse est un échec de git : le module lit `stderr`.
    if (answer instanceof Error) throw Object.assign(answer, { stderr: answer.stderr ?? answer.message })
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

test('GET repositories/tree n’existe plus : la route répond 404', async (t) => {
  const root = await workspace(t, ['alpha'])
  const { run } = fauxGitRun({})
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const response = await call(handler, { path: '/missions/api/repositories/tree?name=alpha' })
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, { error: 'unknown route' })
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
trackers:
  - id: mis
    name: Missions board
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
        ready-for-prod: ready-for-prod
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
projects:
  - id: missions
    name: Workspace missions
    repo: ${repo}
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
    'key: MIS-136\nproject: missions\nbranch: feat/mis-136\nbase: main\n',
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
    body: { key: 'MIS-136', project: 'missions' },
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

test('POST local-close prouve chaque paire d’une mission découpée et journalise chaque PR', async (t) => {
  const tip1 = '1'.repeat(40)
  const merge2 = '9'.repeat(40)
  const trackerCalls = []
  const fetchImpl = async (url) => {
    trackerCalls.push(String(url))
    if (String(url).includes('/pulls')) {
      return trackerResponse([
        {
          number: 7,
          html_url: 'https://github.com/daedalforge/missions/pull/7',
          merged_at: '2026-11-12T10:00:00Z',
          merge_commit_sha: LOCAL_CLOSE.merge,
          head: { ref: 'feat/mis-136-p1', sha: tip1 },
          base: { ref: 'main' },
        },
        {
          number: 8,
          html_url: 'https://github.com/daedalforge/missions/pull/8',
          merged_at: '2026-11-13T10:00:00Z',
          merge_commit_sha: merge2,
          head: { ref: 'feat/mis-136', sha: LOCAL_CLOSE.tip },
          base: { ref: 'feat/mis-136-p1' },
        },
      ])
    }
    return trackerResponse({
      number: 136,
      title: 'Cloturer proprement le local',
      state: 'open',
      labels: [{ name: 'ready-for-prod' }],
    })
  }
  const { dir, handler, repo, worktree, useRun } = await mountClose(t, { fetchImpl })
  await writeFile(
    join(dir, 'missions', 'MIS-136', MISSION_FILE),
    [
      'key: MIS-136',
      'project: missions',
      'branches:',
      '  - branch: feat/mis-136-p1',
      '    base: main',
      '  - branch: feat/mis-136',
      '    base: feat/mis-136-p1',
      '',
    ].join('\n'),
  )

  const { run, calls } = fauxGitRun({
    'repo rev-parse --git-common-dir': '.git',
    'repo rev-parse --verify --quiet refs/heads/feat/mis-136-p1': tip1,
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
    [`repo merge-base --is-ancestor ${tip1} ${tip1}`]: '',
    [`repo rev-list --first-parent ${tip1}..${tip1}`]: '',
    [`repo merge-base --is-ancestor ${LOCAL_CLOSE.tip} ${LOCAL_CLOSE.tip}`]: '',
    [`repo rev-list --first-parent ${LOCAL_CLOSE.tip}..${LOCAL_CLOSE.tip}`]: '',
    [`repo merge-base --is-ancestor ${LOCAL_CLOSE.merge} origin/main`]: '',
    [`repo merge-base --is-ancestor ${merge2} origin/main`]: '',
    'repo fetch origin main': '',
    [`repo worktree remove ${worktree}`]: '',
    'repo checkout main': '',
    'repo merge --ff-only origin/main': '',
    'repo rev-parse HEAD': LOCAL_CLOSE.base,
    'repo branch -D feat/mis-136-p1': '',
    'repo branch -D feat/mis-136': '',
  })
  useRun(run)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/local-close',
    body: { key: 'MIS-136', project: 'missions' },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body.branchesRemoved, ['feat/mis-136-p1', 'feat/mis-136'])
  assert.equal(response.body.base, 'main', 'la base de mission reste la première paire')
  assert.equal(trackerCalls.length, 4, 'deux GET par paire, aucun écrit tracker')
  assert.ok(calls.includes('repo branch -D feat/mis-136-p1'))
  assert.ok(calls.includes('repo branch -D feat/mis-136'))
  assert.equal(await readFile(join(repo, '.git', 'machete'), 'utf8'), 'main\n  fix/one\n')

  const journal = await readFile(join(dir, 'missions', 'MIS-136', 'journal.md'), 'utf8')
  assert.equal((journal.match(/^- PR : /gm) ?? []).length, 2, 'une ligne - PR : par paire')
  assert.match(journal, /- PR : #7 .*base `main`\./)
  assert.match(journal, /- PR : #8 .*base `feat\/mis-136-p1`\./)
})

test('POST local-close refuse en nommant la paire dont la PR n’est pas mergée', async (t) => {
  const tip1 = '1'.repeat(40)
  const fetchImpl = async (url) => {
    if (String(url).includes('/pulls')) {
      return trackerResponse([
        {
          number: 7,
          html_url: 'https://github.com/daedalforge/missions/pull/7',
          merged_at: '2026-11-12T10:00:00Z',
          merge_commit_sha: LOCAL_CLOSE.merge,
          head: { ref: 'feat/mis-136-p1', sha: tip1 },
          base: { ref: 'main' },
        },
        {
          number: 8,
          html_url: 'https://github.com/daedalforge/missions/pull/8',
          merged_at: null,
          merge_commit_sha: null,
          head: { ref: 'feat/mis-136', sha: LOCAL_CLOSE.tip },
          base: { ref: 'feat/mis-136-p1' },
        },
      ])
    }
    return trackerResponse({
      number: 136,
      title: 'Cloturer proprement le local',
      state: 'open',
      labels: [{ name: 'ready-for-prod' }],
    })
  }
  const { dir, handler, useRun } = await mountClose(t, { fetchImpl })
  await writeFile(
    join(dir, 'missions', 'MIS-136', MISSION_FILE),
    [
      'key: MIS-136',
      'project: missions',
      'branches:',
      '  - branch: feat/mis-136-p1',
      '    base: main',
      '  - branch: feat/mis-136',
      '    base: feat/mis-136-p1',
      '',
    ].join('\n'),
  )
  const { run, calls } = fauxGitRun({})
  useRun(run)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/local-close',
    body: { key: 'MIS-136', project: 'missions' },
  })

  assert.equal(response.status, 409)
  assert.match(response.body.error, /MIS-136 \(feat\/mis-136 sur feat\/mis-136-p1\): pull request #8 is not merged/)
  assert.deepEqual(calls, [], 'un refus ne lance aucun verbe git')
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
    body: { key: 'MIS-136', project: 'missions' },
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
    body: { key: 'MIS-136', project: 'missions' },
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

  const unknown = await call(handler, { method: 'POST', path: '/missions/api/local-close', body: { key: 'ZZZ-1', project: 'missions' } })
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
trackers:
  - id: mis
    name: Missions board
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
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
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
      `key: ${key}\nproject: missions\nbranch: feat/mis-${closedIssue.number}\nbase: main\n`,
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
      body: { key: 'MIS-42', project: 'missions' },
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
      'key: MIS-42\nproject: missions\nbranch: feat/mis-42\nbase: main\n',
    )

    const done = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body.missions, [])

    // Second envoi : le dossier n'est plus déclaré, rien n'est écrasé.
    const again = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42', project: 'missions' },
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

/*
 * Le cas d'une clé réutilisée : l'archive d'un premier archivage est encore
 * là, réduite à sa déclaration. Le geste doit aboutir et ranger le dossier
 * dedans — c'est le refus en 409 « already exists » qui bloquait le panneau.
 */
test('POST /archive se pose sur l’archive existante d’une clé re-déclarée', async (t) => {
  const { dir, handler } = await mountArchive(t, { issue: CLOSED_42 })
  const declaration = 'key: MIS-42\nproject: missions\nbranch: feat/mis-42\nbase: main\n'
  await mkdir(join(dir, 'missions', 'archives', 'MIS-42'), { recursive: true })
  await writeFile(join(dir, 'missions', 'archives', 'MIS-42', MISSION_FILE), declaration)
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive',
      body: { key: 'MIS-42', project: 'missions' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
      archived: 'missions/archives/MIS-42',
      folder: 'MIS-42',
      project: 'missions',
    })
    assert.deepEqual((await readdir(join(dir, 'missions'))).sort(), ['archives', 'projects.yml'])
    assert.deepEqual((await readdir(join(dir, 'missions', 'archives', 'MIS-42'))).sort(), [
      'journal.md',
      MISSION_FILE,
    ])
    assert.equal(
      await readFile(join(dir, 'missions', 'archives', 'MIS-42', MISSION_FILE), 'utf8'),
      declaration,
    )

    const done = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(done.status, 200)
    assert.deepEqual(done.body.missions, [])
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
    body: { key: 'ZZZ-1', project: 'missions' },
  })
  assert.equal(unknownProject.status, 404)
  assert.match(unknownProject.body.error, /no project declares/)

  const unknownMission = await call(handler, {
    method: 'POST',
    path: '/missions/api/archive',
    body: { key: 'MIS-99', project: 'missions' },
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
      body: { key: 'MIS-42', project: 'missions' },
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
      body: { key: 'MIS-42', project: 'missions' },
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
      body: { key: 'MIS-42', project: 'missions' },
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
      body: { key: 'MIS-42', project: 'missions' },
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
      body: { key: 'MIS-42', project: 'missions' },
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

/**
 * L'archivage en lot : les clés rendues par l'onglet Done en une requête. Une
 * ligne refusée ne défait pas les autres ; un dossier déplacé reste déplacé.
 */
test('POST /archive-batch archive les done et refuse les autres dans une réponse', async (t) => {
  const { dir, handler } = await mountArchive(t, { issues: [CLOSED_42, CLOSED_43] })
  await mkdir(join(dir, 'missions', 'MIS-44'), { recursive: true })
  await writeFile(join(dir, 'missions', 'MIS-44', MISSION_FILE), 'key: MIS-44\nproject: missions\nbranch: feat/mis-44\nbase: main\n')
  await writeFile(join(dir, 'missions', 'MIS-44', 'journal.md'), '# Journal — MIS-44\n')
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive-batch',
      body: {
        keys: ['MIS-42', 'MIS-43', 'MIS-44', 'MIS-99', 'ZZZ-1'],
        projects: { 'MIS-42': 'missions', 'MIS-43': 'missions', 'MIS-44': 'missions', 'MIS-99': 'missions' },
      },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(
      response.body.archived.map((entry) => entry.archived),
      ['missions/archives/MIS-42', 'missions/archives/MIS-43'],
    )
    assert.deepEqual(response.body.refused, [
      { key: 'MIS-44', error: 'MIS-44 is not done' },
      { key: 'MIS-99', error: 'no mission folder for MIS-99' },
      { key: 'ZZZ-1', error: 'no project declares ZZZ-1' },
    ])
    assert.deepEqual((await readdir(join(dir, 'missions'))).sort(), ['MIS-44', 'archives', 'projects.yml'])
    assert.equal(await readFile(join(dir, 'missions', 'MIS-44', 'journal.md'), 'utf8'), '# Journal — MIS-44\n')

    const list = await call(handler, { path: '/missions/api/list?done=1' })
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.missions, [])
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('POST /archive-batch dit le refus d’une ligne sans défaire les autres', async (t) => {
  const { dir, handler } = await mountArchive(t, { issues: [CLOSED_42, CLOSED_43] })
  await mkdir(join(dir, 'missions', 'archives', 'MIS-43'), { recursive: true })
  await writeFile(join(dir, 'missions', 'archives', 'MIS-43', 'journal.md'), 'ancien\n')
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive-batch',
      body: { keys: ['MIS-42', 'MIS-43'], projects: { 'MIS-42': 'missions', 'MIS-43': 'missions' } },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body.archived.map((entry) => entry.key), ['MIS-42'])
    assert.deepEqual(response.body.refused, [
      { key: 'MIS-43', error: 'missions/archives/MIS-43 already exists: journal.md differs' },
    ])
    assert.equal(await readFile(join(dir, 'missions', 'archives', 'MIS-43', 'journal.md'), 'utf8'), 'ancien\n')
    assert.equal(await readFile(join(dir, 'missions', 'archives', 'MIS-42', 'journal.md'), 'utf8'), '# Journal — MIS-42\n')
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('POST /archive-batch refuse une requête invalide avant tout déplacement', async (t) => {
  const { dir, handler } = await mountArchive(t, { issues: [CLOSED_42] })
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const wrongMethod = await call(handler, { path: '/missions/api/archive-batch' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.allow, 'POST')

    const broken = await call(handler, { method: 'POST', path: '/missions/api/archive-batch', raw: '{"keys":' })
    assert.equal(broken.status, 400)

    for (const body of [{}, { keys: 'MIS-42' }, { keys: [] }, { keys: ['  '] }]) {
      const invalid = await call(handler, { method: 'POST', path: '/missions/api/archive-batch', body })
      assert.equal(invalid.status, 400)
    }

    assert.deepEqual(await readdir(join(dir, 'missions')), ['MIS-42', 'projects.yml'])
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('POST /archive-batch : une panne du tracker répond 502 et ne déplace rien', async (t) => {
  const { dir, handler } = await mountArchive(t, { issues: [CLOSED_42, CLOSED_43], closedStatus: 401 })
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/archive-batch',
      body: { keys: ['MIS-42', 'MIS-43'], projects: { 'MIS-42': 'missions', 'MIS-43': 'missions' } },
    })

    assert.equal(response.status, 502)
    assert.match(response.body.error, /done missions: GitHub token missing or invalid/)
    assert.deepEqual((await readdir(join(dir, 'missions'))).sort(), ['MIS-42', 'MIS-43', 'projects.yml'])
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
trackers:
  - id: mis
    name: Missions board
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
        ready-for-prod: ready-for-prod
      types:
        bug: Bug
        story: Feature
      priorities:
        urgent: priority:urgent
        high: priority:high
        normal: priority:normal
        low: priority:low
projects:
  - id: missions
    name: Workspace missions
    repo: ${repo}
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
    'key: MIS-171\nproject: missions\nbranch: feat/mis-171\nbase: main\n',
  )
  return { ...mounted, repo }
}

function postTolgee(handler, key = 'MIS-171') {
  return call(handler, { method: 'POST', path: '/missions/api/tolgee', body: { key, project: 'missions' } })
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

test('le dossier des missions suit le fichier de projets même sans configuration', () => {
  // Le panneau tourne sans `projectsFile` dans sa config : la racine des
  // missions est alors celle du `projects.yml` par défaut. Avant, elle restait
  // `undefined` et l'import Tolgee répondait `Invalid URL`.
  const ctx = { effect: (fn) => fn(), webServer: { register: () => {} } }

  const { projectsFile, branchesDir } = apply(ctx, {})

  assert.ok(projectsFile instanceof URL, 'le fichier de projets par défaut est résolu')
  assert.ok(branchesDir instanceof URL, 'la racine des missions est toujours définie')
  assert.equal(branchesDir.href, new URL('./', projectsFile).href, 'la racine suit le projects.yml')
  assert.match(branchesDir.href, /\/missions\/$/, 'les missions vivent dans missions/')
})

test('GET repositories/summary rend le scan, sa date de lecture et ses erreurs', async (t) => {
  resetRepositorySummary()
  // Le fixture du ticket : deux clones et un worktree, un dossier nu.
  const root = await workspace(t, [
    { name: 'alpha' },
    { name: 'beta' },
    { name: 'gamma', kind: 'worktree' },
    { name: 'plain', kind: 'plain' },
  ])
  const { run, calls } = fauxGitRun({
    'alpha status --porcelain=v2 --branch': ROUTE_STATUS,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
    'beta status --porcelain=v2 --branch': Object.assign(new Error('fatal: not a git repository'), { stderr: 'fatal: not a git repository' }),
    'gamma status --porcelain=v2 --branch': '# branch.head gh-20-hover\n# branch.ab +0 -0\n',
    'gamma log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
    'gamma worktree list --porcelain': `worktree ${join(root, 'alpha')}\nHEAD 1a2b3c4d\nbranch refs/heads/main\n`,
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const response = await call(handler, { path: '/missions/api/repositories/summary' })

  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body.root, root)
  assert.equal(response.body.count, 3)
  assert.ok(Number.isFinite(response.body.durationMs))
  assert.equal(Number.isFinite(Date.parse(response.body.scannedAt)), true)
  // Le résumé est le scan : mêmes lignes, mêmes erreurs, une entrée illisible
  // qui ne fait pas échouer la racine.
  // L'entrée illisible n'a pas de dernier commit : elle ferme la marche.
  assert.deepEqual(response.body.repositories.map((row) => row.name), ['alpha', 'gamma', 'beta'])
  assert.match(response.body.repositories.find((row) => row.name === 'beta').error, /not a git repository/)
  assert.deepEqual(response.body.errors, [{ name: 'beta', message: 'not a git repository' }])
  // Un `status` et un `log` par entrée lisible, la liste des worktrees du
  // worktree, et un seul `status` pour l'entrée qui échoue.
  assert.equal(calls.length, 6)

  // La racine du serveur reste la seule : `?root=` est ignoré.
  const ailleurs = await call(handler, { path: '/missions/api/repositories/summary?root=/etc' })
  assert.equal(ailleurs.status, 200)
  assert.equal(ailleurs.body.root, root)
})

test('GET repositories/summary relit le scan sur refresh=1, et le tient sinon', async (t) => {
  resetRepositorySummary()
  const root = await workspace(t, ['alpha'])
  const { run, calls } = fauxGitRun({
    'alpha status --porcelain=v2 --branch': ROUTE_STATUS,
    'alpha log -1 --no-decorate --format=%h%x1f%ct%x1f%s': ROUTE_COMMIT,
  })
  const { handler } = await mount(t, { workspaceRoot: root, runGit: run })

  const first = await call(handler, { path: '/missions/api/repositories/summary' })
  assert.equal(first.status, 200)
  assert.equal(calls.length, 2)
  // Deux lectures rapprochées, un seul scan : le bouton Retry est le seul à
  // forcer.
  const again = await call(handler, { path: '/missions/api/repositories/summary' })
  assert.equal(again.status, 200)
  assert.equal(calls.length, 2)
  assert.equal(again.body.scannedAt, first.body.scannedAt)

  const forced = await call(handler, { path: '/missions/api/repositories/summary?refresh=1' })
  assert.equal(forced.status, 200)
  assert.equal(calls.length, 4)
  assert.ok(Date.parse(forced.body.scannedAt) >= Date.parse(first.body.scannedAt))

  // Une route de lecture, comme les autres.
  const post = await call(handler, { method: 'POST', path: '/missions/api/repositories/summary', body: {} })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('GET repositories/summary nomme une racine illisible', async (t) => {
  resetRepositorySummary()
  const { handler } = await mount(t, { workspaceRoot: join(tmpdir(), 'missions-absente-192') })

  const response = await call(handler, { path: '/missions/api/repositories/summary' })
  assert.equal(response.status, 500)
  assert.match(response.body.error, /missions-absente-192/)
})

/** Le playbook du dépôt, copié dans le dossier temporaire que la route lit. */
async function playbookFixture(dir) {
  await cp(join(ROOT, 'test', 'fixtures', 'playbook'), join(dir, 'playbook'), { recursive: true })
}

test('GET playbooks liste les cinq pages sans leur texte', async (t) => {
  // Given
  const { dir, handler } = await mount(t)
  await playbookFixture(dir)

  // When
  const response = await call(handler, { path: '/missions/api/playbooks' })

  // Then
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.pages.map((page) => page.page), ['cadrage', 'execution', 'revue', 'cloture', 'workspace'])
  assert.deepEqual(response.body.pages.map((page) => page.step), ['cadrage', 'exécution', 'revue', 'clôture', null])
  assert.deepEqual(response.body.pages.map((page) => page.stateLine), [
    { entry: 'to-refine', exit: 'ready' },
    { entry: 'ready', exit: 'in-review' },
    { entry: 'in-review', exit: 'ready-for-prod' },
    { entry: 'ready-for-prod', exit: 'done' },
    { entry: null, exit: null },
  ])
  for (const page of response.body.pages) {
    assert.equal('text' in page, false)
    assert.equal('mtimeMs' in page, false)
    assert.equal('maxLines' in page, false, `${page.page} ne porte pas la projection entière`)
    assert.equal(page.exists, true)
    assert.match(page.file, /^playbook\/.+\.md$/)
    assert.equal(typeof page.lines, 'number')
    assert.equal(typeof page.title, 'string')
  }
  // L'index n'est pas une page, et la liste ne le sert pas.
  assert.ok(response.body.pages.every((page) => !page.file.endsWith('README.md')))

  // Les méthodes autres que GET sont refusées.
  const post = await call(handler, { method: 'POST', path: '/missions/api/playbooks', body: {} })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
})

test('GET playbooks/page rend le texte et sa version, 400 puis 404 sinon', async (t) => {
  // Given
  const { dir, handler } = await mount(t)
  await playbookFixture(dir)
  const expected = await readFile(join(ROOT, 'test', 'fixtures', 'playbook', 'execution.md'), 'utf8')

  // When
  const response = await call(handler, { path: '/missions/api/playbooks/page?page=execution' })

  // Then
  assert.equal(response.status, 200)
  assert.equal(response.body.text, expected)
  assert.equal(response.body.file, 'playbook/execution.md')
  assert.equal(response.body.step, 'exécution')
  assert.match(response.body.title, /^Exécution/)
  assert.equal(response.body.mtimeMs, (await stat(join(dir, 'playbook', 'execution.md'))).mtimeMs)
  assert.equal(response.body.maxLines, 200)
  assert.equal(response.body.sections.length, 6)
  assert.ok(response.body.sections.every((section) => section.ok))
  assert.deepEqual(response.body.stateLine, { ok: true, entry: 'ready', exit: 'in-review' })
  assert.deepEqual(response.body.document, { path: 'workflows/execution.md', ok: true })
  assert.match(response.body.html, /<h2 id="avant-d-agir">/)
  assert.match(response.body.html, /<table>/)
  assert.doesNotMatch(response.body.html, /## Avant d'agir/)

  const unknown = await call(handler, { path: '/missions/api/playbooks/page?page=inconnue' })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /unknown playbook page/)

  const index = await call(handler, { path: '/missions/api/playbooks/page?page=README' })
  assert.equal(index.status, 400)

  await rm(join(dir, 'playbook', 'revue.md'))
  const missing = await call(handler, { path: '/missions/api/playbooks/page?page=revue' })
  assert.equal(missing.status, 404)

  const put = await call(handler, { method: 'PUT', path: '/missions/api/playbooks/page?page=revue' })
  assert.equal(put.status, 405)
  assert.equal(put.headers.allow, 'GET, POST')
})

test('POST playbooks/page écrit une page valide et refuse une page fautive', async (t) => {
  // Given
  const { dir, handler } = await mount(t)
  await playbookFixture(dir)
  const read = await call(handler, { path: '/missions/api/playbooks/page?page=cadrage' })
  const changed = `${read.body.text}\nUne ligne de plus.\n`

  // When
  const saved = await call(handler, {
    method: 'POST',
    path: '/missions/api/playbooks/page',
    body: { page: 'cadrage', text: changed, mtimeMs: read.body.mtimeMs },
  })

  // Then
  assert.equal(saved.status, 200)
  assert.equal(saved.body.file, 'playbook/cadrage.md')
  assert.notEqual(saved.body.mtimeMs, read.body.mtimeMs)
  assert.equal(saved.body.mtimeMs, (await stat(join(dir, 'playbook', 'cadrage.md'))).mtimeMs)
  assert.equal(saved.body.maxLines, 200)
  assert.equal(saved.body.sections.length, 6)
  assert.deepEqual(saved.body.stateLine, { ok: true, entry: 'to-refine', exit: 'ready' })
  assert.deepEqual(saved.body.document, { path: 'workflows/cadrage.md', ok: true })
  assert.match(saved.body.html, /<span class="pb-doc-num">01<\/span>/)
  assert.equal(await readFile(join(dir, 'playbook', 'cadrage.md'), 'utf8'), changed)

  // Une version périmée ne réécrit rien.
  const stale = await call(handler, {
    method: 'POST',
    path: '/missions/api/playbooks/page',
    body: { page: 'cadrage', text: `${changed}Autre.\n`, mtimeMs: read.body.mtimeMs },
  })
  assert.equal(stale.status, 409)
  assert.equal(await readFile(join(dir, 'playbook', 'cadrage.md'), 'utf8'), changed)

  // Une page fautive revient avec les erreurs du CLI, sans toucher au fichier.
  const broken = read.body.text.replace('## Pièges observés', '## Pièges')
  const refused = await call(handler, {
    method: 'POST',
    path: '/missions/api/playbooks/page',
    body: { page: 'cadrage', text: broken, mtimeMs: saved.body.mtimeMs },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /page invalid/)
  assert.ok(refused.body.errors.some((error) => /section manquante/.test(error)))
  assert.equal(await readFile(join(dir, 'playbook', 'cadrage.md'), 'utf8'), changed)

  // L'index reste hors panneau, et aucune route ne crée de page.
  const readme = await call(handler, {
    method: 'POST',
    path: '/missions/api/playbooks/page',
    body: { page: 'README', text: '# Index', mtimeMs: Date.now() },
  })
  assert.equal(readme.status, 400)
  const traversal = await call(handler, {
    method: 'POST',
    path: '/missions/api/playbooks/page',
    body: { page: '../../etc/passwd', text: 'x', mtimeMs: Date.now() },
  })
  assert.equal(traversal.status, 400)
})

test('POST /workflows range la création locale sous workflows/local/ et la liste la marque', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  const created = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows',
    body: { title: 'Brouillon local', description: 'deux\nlignes', kind: 'etape', local: true },
  })

  assert.equal(created.status, 201)
  assert.equal(created.body.local, true)
  assert.equal(created.body.file, 'workflows/local/model/brouillon-local.yml')
  assert.equal(created.body.document, 'workflows/local/brouillon-local.md')
  assert.equal(created.body.entry.local, true)
  assert.match(await readFile(join(dir, 'workflows', 'local', 'model', 'brouillon-local.yml'), 'utf8'), /description: \|-/)
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'brouillon-local.md'), 'utf8'), '# Brouillon local\n\n## Ce qu\'on fait\n')
  assert.equal(await readFile(join(dir, 'workflows', 'model', 'brouillon-local.yml'), 'utf8').catch(() => null), null)

  const list = await call(handler, { path: '/missions/api/workflows' })
  const local = list.body.workflows.find((entry) => entry.workflow === 'brouillon-local')
  assert.ok(local, 'la liste réunit les deux dossiers')
  assert.equal(local.local, true)
  assert.equal(local.file, 'workflows/local/model/brouillon-local.yml')
  assert.equal(local.document, 'workflows/local/brouillon-local.md')
  assert.ok(list.body.workflows.slice(0, 4).every((entry) => entry.local === false), 'les étapes restent versionnées')

  const read = await call(handler, { path: '/missions/api/workflows/model?workflow=brouillon-local' })
  assert.equal(read.status, 200)
  assert.equal(read.body.local, true)
  assert.equal(read.body.file, 'workflows/local/model/brouillon-local.yml')
  assert.match(read.body.text, /document: workflows\/local\/brouillon-local\.md/)
})

test('POST /workflows refuse une description de 281 caractères sans rien écrire', async (t) => {
  // Given : un dépôt temporaire dont seuls les cinq modèles versionnés existent.
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)

  // When : la création poste une description d'un caractère de trop.
  const refused = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows',
    body: { title: 'Description trop longue', description: 'x'.repeat(281), kind: 'etape', local: true },
  })

  // Then : le refus nomme la description, et rien n'est écrit dans les deux dossiers.
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error, 'workflow invalid')
  assert.equal(refused.body.errors[0].field, 'description')
  assert.equal(refused.body.errors[0].code, 'description-invalide')
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'model', 'description-trop-longue.yml'), 'utf8').catch(() => null), null)
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'description-trop-longue.md'), 'utf8').catch(() => null), null)
  assert.equal(await readFile(join(dir, 'workflows', 'model', 'description-trop-longue.yml'), 'utf8').catch(() => null), null)
})

test('POST /workflows/model bascule un workflow local puis le ramène, en un geste', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  const list = await call(handler, { path: '/missions/api/workflows' })
  const model = bareModel(list.body.workflows[0])

  const moved = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows/model',
    body: { workflow: 'cadrage', model, local: true },
  })
  assert.equal(moved.status, 200)
  assert.equal(moved.body.local, true)
  assert.equal(moved.body.file, 'workflows/local/model/cadrage.yml')
  assert.equal(moved.body.entry.local, true)
  assert.match(await readFile(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'), 'utf8'), /document: workflows\/local\/cadrage\.md/)
  assert.equal(await readFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'utf8').catch(() => null), null)

  const back = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows/model',
    body: { workflow: 'cadrage', model: moved.body.model, local: false },
  })
  assert.equal(back.status, 200)
  assert.equal(back.body.local, false)
  assert.equal(back.body.file, 'workflows/model/cadrage.yml')
  assert.equal(await readFile(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'), 'utf8').catch(() => null), null)
})

test('un déplacement qui collisionne répond 409 sans toucher la source', async (t) => {
  const { dir, handler } = await mount(t)
  await copyWorkflows(dir)
  await mkdir(join(dir, 'workflows', 'local', 'model'), { recursive: true })
  await writeFile(join(dir, 'workflows', 'local', 'model', 'cadrage.yml'), 'workflow: cadrage\n', 'utf8')
  const source = await readFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'utf8')
  const list = await call(handler, { path: '/missions/api/workflows' })
  const model = bareModel(list.body.workflows[0])

  const refused = await call(handler, {
    method: 'POST',
    path: '/missions/api/workflows/model',
    body: { workflow: 'cadrage', model, local: true },
  })

  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'workflow conflict')
  assert.equal(refused.body.errors[0].code, 'cle-double')
  assert.equal(await readFile(join(dir, 'workflows', 'model', 'cadrage.yml'), 'utf8'), source, 'la source reste intacte')
})

/**
 * La déclaration de la création : deux boards GitHub au vocabulaire différent et
 * deux dépôts, pour prouver que le formulaire sépare la carte du checkout.
 */
const CREATE_PROJECTS = `canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: mis
    name: Missions board
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
  - id: leg
    name: Legacy board
    reference: LEG
    tracker: github
    github:
      owner: daedalforge
      repo: legacy
    map:
      states:
        to-refine: to-refine
        ready: ready
        in-progress: in-progress
        in-review: in-review
      types:
        bug: Bug
        story: User Story
      priorities:
        urgent: block
        high: priority:high
        normal: priority:normal
        low: priority:low
projects:
  - id: missions
    name: Workspace missions
    repo: ~/projects/missions
  - id: legacy
    name: Legacy
    repo: ~/projects/legacy
`

async function mountCreate(t, fetchImpl, config = {}) {
  const mounted = await mount(t, { fetchImpl, ...config })
  await mkdir(join(mounted.dir, 'missions'), { recursive: true })
  await writeFile(join(mounted.dir, 'missions', 'projects.yml'), CREATE_PROJECTS)
  return mounted
}

test('GET /create rend les boards et les dépôts, séparés', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  const { handler } = await mountCreate(t, async () => trackerResponse({}))

  const response = await call(handler, { path: '/missions/api/create' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    status: 'to-refine',
    defaultPriority: 'normal',
    trackers: [
      { id: 'mis', name: 'Missions board', tracker: 'github', types: ['bug', 'story'], priorities: ['urgent', 'high', 'normal', 'low'] },
      { id: 'leg', name: 'Legacy board', tracker: 'github', types: ['bug', 'story'], priorities: ['urgent', 'high', 'normal', 'low'] },
    ],
    repositories: [
      { id: 'missions', name: 'Workspace missions', repo: '~/projects/missions' },
      { id: 'legacy', name: 'Legacy', repo: '~/projects/legacy' },
    ],
  })

  const refused = await call(handler, { method: 'PUT', path: '/missions/api/create' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET')
})

test('GET /create/epics exige une board connue et rend ses milestones', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  const calls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('/milestones')) {
      return trackerResponse([{ number: 1, title: 'Fondations' }])
    }
    return trackerResponse({ message: 'unexpected' }, { status: 500 })
  }
  const { handler } = await mountCreate(t, fetchImpl)

  const missing = await call(handler, { path: '/missions/api/create/epics' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /tracker is missing/)

  const unknown = await call(handler, { path: '/missions/api/create/epics?tracker=inconnu' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /unknown tracker: inconnu/)
  assert.deepEqual(calls, [])

  const response = await call(handler, { path: '/missions/api/create/epics?tracker=mis' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    tracker: 'mis',
    epics: [{ id: '1', label: 'MIS-1 · Fondations' }],
  })
  assert.deepEqual(calls, ['https://api.github.com/repos/daedalforge/missions/milestones?state=all&per_page=100'])
})

test('GET /create/epics nomme un refus du tracker en 502', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  const { handler } = await mountCreate(t, async () => trackerResponse({ message: 'Bad credentials' }, { status: 401 }))

  const response = await call(handler, { path: '/missions/api/create/epics?tracker=mis' })

  assert.equal(response.status, 502)
  assert.match(response.body.error, /GitHub token missing or invalid/)
})

test('POST /create refuse chaque champ invalide avant tout appel au tracker', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  let touched = 0
  const { handler } = await mountCreate(t, async (url) => {
    touched += 1
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'moi' })
    return trackerResponse({ number: 1 }, { status: 201 })
  })

  const invalid = [
    [{ project: 'missions', title: 'T', type: 'story', priority: 'normal' }, 400, /tracker is missing/],
    [{ tracker: 'mis', title: 'T', type: 'story', priority: 'normal' }, 400, /project is missing/],
    [{ tracker: 'mis', project: 'missions', type: 'story', priority: 'normal' }, 400, /title is missing/],
    [{ tracker: 'mis', project: 'missions', title: '   ', type: 'story', priority: 'normal' }, 400, /title is missing/],
    [{ tracker: 'mis', project: 'missions', title: 'x'.repeat(256), type: 'story', priority: 'normal' }, 400, /title is longer than 255/],
    [{ tracker: 'mis', project: 'missions', title: 'T', description: 'x'.repeat(4001), type: 'story', priority: 'normal' }, 400, /description is longer than 4000/],
    [{ tracker: 'mis', project: 'missions', title: 'T', type: 'epic', priority: 'normal' }, 400, /unknown type: epic/],
    [{ tracker: 'mis', project: 'missions', title: 'T', type: 'story', priority: 'critical' }, 400, /unknown priority: critical/],
    [{ tracker: 'mis', project: 'missions', title: 'T', type: 'story', priority: 'normal', epic: 'MIS-7' }, 400, /epic must be a GitHub milestone number/],
    [{ tracker: 'inconnu', project: 'missions', title: 'T', type: 'story', priority: 'normal' }, 404, /unknown tracker: inconnu/],
    [{ tracker: 'mis', project: 'inconnu', title: 'T', type: 'story', priority: 'normal' }, 404, /unknown project: inconnu/],
  ]
  for (const [body, status, error] of invalid) {
    const response = await call(handler, { method: 'POST', path: '/missions/api/create', body })
    assert.equal(response.status, status, JSON.stringify(body))
    assert.match(response.body.error, error)
  }
  assert.equal(touched, 0)
})

test('POST /create écrit la mission, son dossier, et ouvre la liste rafraîchie', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  clearCache()
  let reads = 0
  let createdFlag = false
  const posted = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (target.endsWith('/user')) return trackerResponse({ login: 'slucienvauthier-so' })
    if (init.method === 'POST') {
      posted.push({ url: target, body: JSON.parse(init.body) })
      createdFlag = true
      return trackerResponse({
        number: 42,
        title: 'Créer une mission',
        labels: [{ name: 'to-refine' }, { name: 'priority:high' }],
        milestone: { number: 3, title: 'Fondations' },
        type: { name: 'Feature' },
        html_url: 'https://github.com/daedalforge/missions/issues/42',
        updated_at: '2026-11-14T10:00:00Z',
      }, { status: 201 })
    }
    if (target.includes('/repos/daedalforge/legacy/')) return trackerResponse([])
    reads += 1
    const created = [{
      number: 42,
      title: 'Créer une mission',
      labels: [{ name: 'to-refine' }, { name: 'priority:high' }],
      milestone: null,
      type: { name: 'Feature' },
      html_url: 'https://github.com/daedalforge/missions/issues/42',
      updated_at: '2026-11-10T10:00:00Z',
    }]
    return trackerResponse(createdFlag ? created : [])
  }
  const { dir, handler } = await mountCreate(t, fetchImpl)

  const warm = await call(handler, { path: '/missions/api/list' })
  assert.deepEqual(warm.body.missions, [])

  const created = await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: {
      tracker: 'mis',
      project: 'missions',
      title: 'Créer une mission',
      description: 'Le formulaire du tiroir.',
      type: 'story',
      priority: 'high',
      epic: '3',
    },
  })

  assert.equal(created.status, 201)
  assert.deepEqual(created.body, {
    key: 'MIS-42',
    reference: 'MIS',
    tracker: 'github',
    number: 42,
    url: 'https://github.com/daedalforge/missions/issues/42',
    // Le 201 prouve la ligne : le panneau la reçoit déjà normalisée, comme la
    // lirait une liste, pour l'afficher sans une seconde lecture du tracker.
    mission: {
      project: 'missions',
      projectName: 'Workspace missions',
      trackerId: 'mis',
      trackerName: 'Missions board',
      key: 'MIS-42',
      number: 42,
      title: 'Créer une mission',
      state: 'to-refine',
      stateConflict: [],
      blockedByLabel: false,
      blockers: [],
      blocked: false,
      type: 'story',
      priority: 'high',
      points: null,
      repo: '~/projects/missions',
      translations: null,
      epic: 'MIS-3 · Fondations',
      url: 'https://github.com/daedalforge/missions/issues/42',
      updatedAt: '2026-11-14T10:00:00Z',
    },
    project: 'missions',
  })
  assert.deepEqual(posted[0].body, {
    title: 'Créer une mission',
    body: 'Le formulaire du tiroir.',
    labels: ['to-refine', 'priority:high'],
    assignees: ['slucienvauthier-so'],
    type: 'Feature',
    milestone: 3,
  })

  // Le dossier de la mission est écrit juste après l'issue : la clé et le
  // dépôt choisi, rien de la board.
  const declaration = parse(await readFile(join(dir, 'missions', 'MIS-42', MISSION_FILE), 'utf8'))
  assert.deepEqual(declaration, { key: 'MIS-42', project: 'missions' })

  const reloaded = await call(handler, { path: '/missions/api/list' })
  assert.equal(reads, 2, 'la création jette la liste ouverte en cache')
  assert.deepEqual(reloaded.body.missions.map((mission) => mission.key), ['MIS-42'])
  assert.equal(reloaded.body.missions[0].state, 'to-refine', 'la mission relue est née to-refine')
})

test('POST /create écrit le dossier qu’une board Jira ne rend pas', async (t) => {
  const before = { token: process.env.JIRA_API_TOKEN, email: process.env.JIRA_EMAIL }
  process.env.JIRA_API_TOKEN = 'test-jira-token'
  process.env.JIRA_EMAIL = 'me@example.test'
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    calls.push({ url: target, method: init.method ?? 'GET', body: init.body ?? null })
    if (target.endsWith('/rest/api/3/myself')) return trackerResponse({ accountId: 'acc-1' })
    return trackerResponse({ id: '10007', key: 'EX-7' }, { status: 201 })
  }
  const { dir, handler } = await mountCreate(t, fetchImpl)
  await writeFile(join(dir, 'missions', 'projects.yml'), JIRA_POINTS_PROJECTS)

  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/create',
      body: {
        tracker: 'ex',
        project: 'alpha',
        title: 'Créer sur une board Jira',
        description: 'Le formulaire.',
        type: 'story',
        priority: 'normal',
      },
    })

    assert.equal(response.status, 201)
    assert.equal(response.body.warning, undefined, 'aucun avertissement : le dossier est écrit')
    assert.deepEqual(response.body, {
      key: 'EX-7',
      tracker: 'jira',
      reference: 'EX',
      number: null,
      url: 'https://example.atlassian.net/browse/EX-7',
      mission: {
        key: 'EX-7',
        project: 'alpha',
        projectName: 'Alpha',
        repo: '~/projects/alpha',
        translations: null,
        trackerId: 'ex',
        trackerName: 'Example board',
      },
      project: 'alpha',
    })
    assert.deepEqual(
      parse(await readFile(join(dir, 'missions', 'EX-7', MISSION_FILE), 'utf8')),
      { key: 'EX-7', project: 'alpha' },
    )
    assert.ok(calls.some((entry) => entry.url.endsWith('/rest/api/3/issue')), 'l’issue naît sur la board Jira')
  } finally {
    if (before.token === undefined) delete process.env.JIRA_API_TOKEN
    else process.env.JIRA_API_TOKEN = before.token
    if (before.email === undefined) delete process.env.JIRA_EMAIL
    else process.env.JIRA_EMAIL = before.email
  }
})

test('POST /create écrit l’issue sur la board choisie, pas dans le dépôt', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  clearCache()
  const posted = []
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'slucienvauthier-so' })
    if (init.method === 'POST') {
      posted.push({ url: String(url), body: JSON.parse(init.body) })
      return trackerResponse({
        number: 42,
        title: 'Une mission du dépôt missions',
        labels: [{ name: 'to-refine' }, { name: 'block' }],
        milestone: null,
        type: { name: 'User Story' },
        html_url: 'https://github.com/daedalforge/legacy/issues/42',
        updated_at: '2026-11-14T10:00:00Z',
      }, { status: 201 })
    }
    return trackerResponse([])
  }
  const { dir, handler } = await mountCreate(t, fetchImpl)

  const created = await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: { tracker: 'leg', project: 'missions', title: 'Une mission du dépôt missions', type: 'story', priority: 'urgent' },
  })

  assert.equal(created.status, 201)
  assert.equal(created.body.key, 'LEG-42')
  assert.equal(created.body.mission.project, 'missions')
  assert.equal(created.body.mission.trackerId, 'leg')
  // Le vocabulaire est celui de la board, pas celui du dépôt.
  assert.deepEqual(posted[0].body.labels, ['to-refine', 'block'])
  assert.equal(posted[0].body.type, 'User Story')
  assert.equal(posted[0].url, 'https://api.github.com/repos/daedalforge/legacy/issues')
  assert.deepEqual(
    parse(await readFile(join(dir, 'missions', 'LEG-42', MISSION_FILE), 'utf8')),
    { key: 'LEG-42', project: 'missions' },
  )
})

test('POST /create n’écrit aucun dossier quand la board refuse', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'moi' })
    if (init.method === 'POST') return trackerResponse({ message: 'Validation Failed' }, { status: 422 })
    return trackerResponse([])
  }
  const { dir, handler } = await mountCreate(t, fetchImpl)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: { tracker: 'mis', project: 'missions', title: 'T', type: 'story', priority: 'normal' },
  })

  assert.equal(response.status, 502)
  const entries = await readdir(join(dir, 'missions'), { withFileTypes: true })
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), [])
})

test('POST /create répond 201 et prévient quand le dossier ne s’écrit pas', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  clearCache()
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'slucienvauthier-so' })
    if (init.method === 'POST') return trackerResponse(CREATED_ISSUE_42, { status: 201 })
    return trackerResponse([])
  }
  const { dir, handler } = await mountCreate(t, fetchImpl)
  // Le dossier des missions n'accueille plus aucune écriture : la déclaration
  // échoue après l'issue. La réponse le dit sans faire rejouer le formulaire.
  const root = join(dir, 'missions')
  await chmod(root, 0o555)

  try {
    const response = await call(handler, {
      method: 'POST',
      path: '/missions/api/create',
      body: { tracker: 'mis', project: 'missions', title: 'Créer une mission', type: 'story', priority: 'high' },
    })

    assert.equal(response.status, 201)
    assert.equal(response.body.project, 'missions')
    assert.match(response.body.warning, /the issue was created, but its mission folder could not be written/)
    assert.deepEqual((await readdir(root)).sort(), ['projects.yml'])
  } finally {
    await chmod(root, 0o755)
  }
})

test('POST /create nomme un refus du tracker en 502', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'moi' })
    if (init.method === 'POST') return trackerResponse({ message: 'Validation Failed' }, { status: 422 })
    return trackerResponse([])
  }
  const { handler } = await mountCreate(t, fetchImpl)

  const response = await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: { tracker: 'mis', project: 'missions', title: 'T', type: 'story', priority: 'normal' },
  })

  assert.equal(response.status, 502)
  assert.match(response.body.error, /GitHub/)
})

/** Le 201 que GitHub rend pour une mission créée, réduit à ce que la ligne lit. */
const CREATED_ISSUE_42 = {
  number: 42,
  title: 'Créer une mission',
  labels: [{ name: 'to-refine' }, { name: 'priority:high' }],
  milestone: null,
  type: { name: 'Feature' },
  html_url: 'https://github.com/daedalforge/missions/issues/42',
  updated_at: '2026-11-14T10:00:00Z',
}

test('la liste rafraîchie porte la mission créée même quand le tracker ne la liste pas encore', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  clearCache()
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'slucienvauthier-so' })
    if (init.method === 'POST') return trackerResponse(CREATED_ISSUE_42, { status: 201 })
    // Le tracker sert encore la page d'avant la création : la preuve est le 201.
    return trackerResponse([])
  }
  const { handler } = await mountCreate(t, fetchImpl)

  const created = await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: { tracker: 'mis', project: 'missions', title: 'Créer une mission', type: 'story', priority: 'high', epic: '3' },
  })
  assert.equal(created.status, 201)

  const reloaded = await call(handler, { path: '/missions/api/list?refresh=1' })

  assert.equal(reloaded.status, 200)
  assert.deepEqual(reloaded.body.missions.map((mission) => mission.key), ['MIS-42'])
  assert.equal(reloaded.body.missions[0].state, 'to-refine')
  assert.equal(reloaded.body.missions[0].priority, 'high')
})

test('la ligne créée ne se double pas et disparaît dès que le tracker porte la clé', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  clearCache()
  let listed = false
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'slucienvauthier-so' })
    if (init.method === 'POST') return trackerResponse(CREATED_ISSUE_42, { status: 201 })
    if (String(url).includes('/repos/daedalforge/legacy/')) return trackerResponse([])
    return trackerResponse(listed ? [CREATED_ISSUE_42] : [])
  }
  const { handler } = await mountCreate(t, fetchImpl)

  await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: { tracker: 'mis', project: 'missions', title: 'Créer une mission', type: 'story', priority: 'high' },
  })
  const before = await call(handler, { path: '/missions/api/list?refresh=1' })
  assert.deepEqual(before.body.missions.map((mission) => mission.key), ['MIS-42'])

  // Then la page du tracker porte enfin la clé : une seule ligne.
  listed = true
  const after = await call(handler, { path: '/missions/api/list?refresh=1' })
  assert.deepEqual(after.body.missions.map((mission) => mission.key), ['MIS-42'])

  // Then la ligne créée est retirée, pas recollée : une page qui cesse de la
  // porter n'est pas masquée par la preuve de création.
  listed = false
  const gone = await call(handler, { path: '/missions/api/list?refresh=1' })
  assert.deepEqual(gone.body.missions, [])
})

test('la ligne créée ne survit pas à la fenêtre courte', async (t) => {
  process.env.GH_TOKEN = 'test-token'
  forgetToken()
  clearCache()
  let clock = 1_000
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'slucienvauthier-so' })
    if (init.method === 'POST') return trackerResponse(CREATED_ISSUE_42, { status: 201 })
    return trackerResponse([])
  }
  const { handler } = await mountCreate(t, fetchImpl, { now: () => clock })

  await call(handler, {
    method: 'POST',
    path: '/missions/api/create',
    body: { tracker: 'mis', project: 'missions', title: 'Créer une mission', type: 'story', priority: 'high' },
  })
  const present = await call(handler, { path: '/missions/api/list?refresh=1' })
  assert.deepEqual(present.body.missions.map((mission) => mission.key), ['MIS-42'])

  // When la fenêtre est passée, Then le tracker seul décide.
  clock += 5 * 60_000
  const expired = await call(handler, { path: '/missions/api/list?refresh=1' })
  assert.deepEqual(expired.body.missions, [])
})

test('une board partagée se lit une fois, chaque ligne porte son dépôt ou rien', async (t) => {
  // Given deux projets sur la même board et une mission que nul dossier ne déclare
  const appels = []
  const fetchImpl = async (url) => {
    const href = String(url)
    appels.push(href)
    const json = (body) => trackerResponse(body)
    if (href.endsWith('/user')) return json({ login: 'me' })
    return json([
      { number: 1, state: 'open', title: 'Clienthub', labels: [{ name: 'ready' }] },
      { number: 2, state: 'open', title: 'Backend', labels: [{ name: 'ready' }] },
      { number: 3, state: 'open', title: 'Sans dossier', labels: [{ name: 'ready' }] },
    ])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: soc
    name: Connect board
    reference: SOC
    tracker: github
    github:
      owner: daedalforge
      repo: connect
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
projects:
  - id: clienthub
    name: Clienthub
    repo: ~/projects/clienthub
  - id: backend
    name: Backend
    repo: ~/projects/backend
`)
  await mkdir(join(dir, 'missions', 'SOC-1'), { recursive: true })
  await writeFile(join(dir, 'missions', 'SOC-1', MISSION_FILE), 'key: SOC-1\nproject: clienthub\nbranch: feat/soc-1\nbase: main\n')
  await mkdir(join(dir, 'missions', 'SOC-2'), { recursive: true })
  await writeFile(join(dir, 'missions', 'SOC-2', MISSION_FILE), 'key: SOC-2\nproject: backend\nbranch: feat/soc-2\nbase: main\n')

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    // When la liste est lue
    const liste = await call(handler, { path: '/missions/api/list' })
    assert.equal(liste.status, 200)
    // Then la board n'a été lue qu'une fois, pas une fois par dépôt
    assert.equal(appels.filter((href) => href.includes('/issues?')).length, 1)
    // Then chaque ligne porte le projet de son dossier, la non déclarée reste sans projet
    assert.deepEqual(
      liste.body.missions.map((mission) => [mission.key, mission.project, mission.projectName, mission.repo]),
      [
        ['SOC-1', 'clienthub', 'Clienthub', '~/projects/clienthub'],
        ['SOC-2', 'backend', 'Backend', '~/projects/backend'],
        ['SOC-3', null, null, null],
      ],
    )
    // Then le volet reçoit les dépôts de la board, pour offrir le champ Project
    assert.deepEqual(liste.body.missions[2].projectChoices.map((choice) => choice.id), ['clienthub', 'backend'])
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('une même clé travaillée dans deux projets donne deux missions, chacune son dépôt', async (t) => {
  clearCache()
  t.after(() => clearCache())
  // Given deux projets sur la même board et la même clé déclarée dans les deux
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/user')) return trackerResponse({ login: 'me' })
    return trackerResponse([{ number: 9, state: 'open', title: 'Partagée', labels: [{ name: 'ready' }] }])
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: soc
    name: Connect board
    reference: SOC
    tracker: github
    github:
      owner: daedalforge
      repo: connect
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
projects:
  - id: clienthub
    name: Clienthub
    repo: ~/projects/clienthub
  - id: backend
    name: Backend
    repo: ~/projects/backend
`)
  await mkdir(join(dir, 'missions', 'clienthub-SOC-9'), { recursive: true })
  await writeFile(join(dir, 'missions', 'clienthub-SOC-9', MISSION_FILE), 'key: SOC-9\nproject: clienthub\nbranch: feat/soc-9-clienthub\nbase: main\n')
  await mkdir(join(dir, 'missions', 'backend-SOC-9'), { recursive: true })
  await writeFile(join(dir, 'missions', 'backend-SOC-9', MISSION_FILE), 'key: SOC-9\nproject: backend\nbranch: feat/soc-9-backend\nbase: main\n')

  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    // When la liste est lue
    const liste = await call(handler, { path: '/missions/api/list' })
    assert.equal(liste.status, 200)
    // Then la même clé donne deux lignes, une par projet, avec le bon dossier
    assert.deepEqual(
      liste.body.missions
        .map((mission) => [mission.key, mission.project, mission.repo, mission.folder])
        .sort((left, right) => String(left[1]).localeCompare(String(right[1]))),
      [
        ['SOC-9', 'backend', '~/projects/backend', 'backend-SOC-9'],
        ['SOC-9', 'clienthub', '~/projects/clienthub', 'clienthub-SOC-9'],
      ],
    )
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})

test('les routes de board lisent la clé seule, les routes de dossier le dépôt', async (t) => {
  // Given deux dépôts et une mission dont le dossier ne nomme aucun d'eux
  const appels = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    appels.push({ href, method: init.method ?? 'GET', body: init.body ?? null })
    if (href.endsWith('/user')) return trackerResponse({ login: 'me' })
    if (href.includes('/issues/3') && (init.method ?? 'GET') === 'GET') return trackerResponse({ labels: [] })
    return trackerResponse({})
  }
  const { dir, handler } = await mount(t, { fetchImpl })
  await writeFile(join(dir, 'missions', 'projects.yml'), `
canonical:
  states: [to-refine, ready, in-progress, in-review]
  types: [bug, story]
  priorities: [urgent, high, normal, low]
trackers:
  - id: soc
    name: Connect board
    reference: SOC
    tracker: github
    github:
      owner: daedalforge
      repo: connect
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
      points: 'sp:'
projects:
  - id: clienthub
    name: Clienthub
    repo: ~/projects/clienthub
  - id: backend
    name: Backend
    repo: ~/projects/backend
`)
  const before = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  try {
    // When points est appelée sans dépôt, Then la clé suffit et la board reçoit
    const points = await call(handler, {
      method: 'POST',
      path: '/missions/api/points',
      body: { key: 'SOC-3', points: 3 },
    })
    assert.equal(points.status, 200)
    assert.deepEqual(points.body, { key: 'SOC-3', points: 3, project: null, value: 'sp:3' })
    assert.ok(appels.some((entry) => entry.method === 'POST' && entry.href.includes('/issues/3/labels')))

    // When priorité et blocage la suivent, Then elles n'ont pas plus besoin du dépôt
    const priority = await call(handler, {
      method: 'POST',
      path: '/missions/api/priority',
      body: { key: 'SOC-3', priority: 'high' },
    })
    assert.equal(priority.status, 200)
    assert.equal(priority.body.project, null)
    const blocked = await call(handler, {
      method: 'POST',
      path: '/missions/api/blocked',
      body: { key: 'SOC-3', blocked: false },
    })
    assert.equal(blocked.status, 200)
    assert.equal(blocked.body.project, null)

    // When un dépôt est quand même envoyé, Then il n'est pas relu
    const avec = await call(handler, {
      method: 'POST',
      path: '/missions/api/points',
      body: { key: 'SOC-3', project: 'clienthub', points: 3 },
    })
    assert.equal(avec.status, 200)
    assert.equal(avec.body.project, null)

    // When une route de dossier part sans dépôt, Then elle refuse en le nommant
    for (const path of ['/missions/api/local-close', '/missions/api/archive', '/missions/api/tolgee']) {
      const refused = await call(handler, { method: 'POST', path, body: { key: 'SOC-3' } })
      assert.equal(refused.status, 400, `${path} sans dépôt`)
      assert.equal(refused.body.error, 'project is required', `${path} sans dépôt`)
    }
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = before
  }
})
