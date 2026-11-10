import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { apply, missionsSignature } from '../lib/index.js'

const FICHE = `---
id: ABC-1
title: Une mission
status: active
priority: normal
---

# Une mission
`

const JOURNAL = `# Journal — ABC-1

**Prochaine action** : rien.
`

async function atelier() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-missions-list-'))
  const workspace = join(home, 'konoha')
  const root = join(workspace, 'missions')
  await mkdir(join(root, 'ABC-1'), { recursive: true })
  await mkdir(join(root, 'archives', 'ABC-0'), { recursive: true })
  await mkdir(join(workspace, 'epics', 'UV-757'), { recursive: true })
  await mkdir(join(workspace, 'workflows'), { recursive: true })
  await writeFile(join(root, 'ABC-1', 'mission.md'), FICHE, 'utf8')
  await writeFile(join(root, 'ABC-1', 'journal.md'), JOURNAL, 'utf8')
  await writeFile(join(workspace, 'epics', 'UV-757', 'epic.md'), '---\nkey: UV-757\ntitle: Epic\nstatus: active\n---\n', 'utf8')
  await writeFile(join(workspace, 'workflows', 'queue.md'), '- ABC-1\n', 'utf8')
  return { home, workspace, root }
}

const disposers = []

test.after(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

function monter(root) {
  const routes = []
  const workspace = dirname(root)
  const home = dirname(workspace)
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register: (entry) => {
        routes.push(entry)
        return () => {}
      },
    },
  }
  apply(ctx, {
    missionsRoot: root,
    sessionsRoot: join(workspace, 'sessions'),
    linksFile: join(workspace, 'links.json'),
    workspaceStore: join(workspace, 'workspace.json'),
    performance: {
      sources: { git: false, gh: false, jira: false, subagents: true },
      roots: {
        konohaRoot: workspace,
        projectsRoot: workspace,
        sessionsRoot: join(home, 'sessions'),
        ledgerFile: join(home, 'ledger.json'),
        linksFile: join(workspace, 'links.json'),
        jiraScript: '',
      },
    },
  })
  return routes
}

async function lire(route, query = '') {
  const res = {
    status: 0,
    payload: '',
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.payload = payload
    },
  }
  await route.handler({ method: 'GET', url: `/missions/api/list${query}`, headers: { host: '127.0.0.1:52018' } }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  return body.value
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 5))

test('deux lectures sans changement réutilisent le même scan', async () => {
  const { root } = await atelier()
  const [route] = monter(root)
  const premier = await lire(route)
  await pause()
  const second = await lire(route)
  assert.equal(premier.generatedAt, second.generatedAt)
  assert.equal(second.missions.length, 1)
  assert.equal(second.missions[0].id, 'ABC-1')
  assert.ok(second.plan && second.limits)
  assert.equal('workspace' in second, false)
})

test('une fiche retouchée relance le scan', async () => {
  const { root } = await atelier()
  const [route] = monter(root)
  const premier = await lire(route)
  await pause()
  await writeFile(join(root, 'ABC-1', 'mission.md'), FICHE.replace('status: active', 'status: ready'), 'utf8')
  const second = await lire(route)
  assert.notEqual(second.generatedAt, premier.generatedAt)
  assert.equal(second.missions[0].status, 'ready')
})

test('?refresh=1 force un nouveau scan', async () => {
  const { root } = await atelier()
  const [route] = monter(root)
  const premier = await lire(route)
  await pause()
  const second = await lire(route, '?refresh=1')
  assert.notEqual(second.generatedAt, premier.generatedAt)
  const troisieme = await lire(route)
  assert.equal(troisieme.generatedAt, second.generatedAt)
})

test('la signature suit les fiches, les epics, la file et les archives', async () => {
  const { workspace, root } = await atelier()
  const initiale = missionsSignature(root)
  assert.equal(missionsSignature(root), initiale)

  await writeFile(join(root, 'ABC-1', 'journal.md'), `${JOURNAL}\n## Suite\n`, 'utf8')
  const avecJournal = missionsSignature(root)
  assert.notEqual(avecJournal, initiale)

  await mkdir(join(root, 'archives', 'ABC-0b'), { recursive: true })
  const avecArchive = missionsSignature(root)
  assert.notEqual(avecArchive, avecJournal)

  await writeFile(join(workspace, 'epics', 'UV-757', 'epic.md'), '---\nkey: UV-757\ntitle: Epic\nstatus: done\n---\n', 'utf8')
  const avecEpic = missionsSignature(root)
  assert.notEqual(avecEpic, avecArchive)

  await mkdir(join(root, 'ABC-3'), { recursive: true })
  await writeFile(join(root, 'ABC-3', 'mission.md'), FICHE.replace('ABC-1', 'ABC-3'), 'utf8')
  const avecFiche = missionsSignature(root)
  assert.notEqual(avecFiche, avecEpic)

  await writeFile(join(workspace, 'workflows', 'queue.md'), '- ABC-3\n', 'utf8')
  assert.notEqual(missionsSignature(root), avecFiche)
})

async function poster(route, chemin, payload) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = `/missions/api/${chemin}`
  req.headers = { host: '127.0.0.1:52018' }
  req.destroy = () => {}
  const res = {
    status: 0,
    payload: '',
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.payload = payload
    },
  }
  const done = route.handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(payload), 'utf8'))
  req.emit('end')
  await done
  assert.equal(res.status, 200)
  return JSON.parse(res.payload).value
}

test('une écriture invalide le cache même quand le disque ne bouge pas', async () => {
  const { root } = await atelier()
  const [route] = monter(root)
  const premier = await lire(route)
  await pause()
  const ecriture = await poster(route, 'status', { missionId: 'ABC-1', status: 'active' })
  assert.equal(ecriture.changed, false)
  await pause()
  const second = await lire(route)
  assert.notEqual(second.generatedAt, premier.generatedAt)
})

test('le plugin installé sert la vue Missions et la vue Performance', async () => {
  const { root } = await atelier()
  const routes = monter(root)

  assert.deepEqual(routes.map((entry) => entry.path), ['/missions/api', '/performance'])
  assert.equal(routes[1].kind, 'prefix')
})
