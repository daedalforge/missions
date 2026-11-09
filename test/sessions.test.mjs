import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import {
  canonicalSessionId,
  decompressZstdFrames,
  mergeMissionSessions,
  readArchivedSessions,
  missionsInSnippet,
  scanSessionCandidates,
  sessionTitle,
  titleMentions,
} from '../lib/index.js'

const missions = [{ id: 'ABC-50' }, { id: 'XYZ-1493' }]
const frame = (text) => zstdCompressSync(Buffer.from(`${text}\n`))

function writeSession(root, id, frames) {
  const dir = join(root, 'ws', `session-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

test('canonicalSessionId normalise vers la forme session-<uuid>', () => {
  assert.equal(canonicalSessionId('session-abc'), 'session-abc')
  assert.equal(canonicalSessionId('abc'), 'session-abc')
  assert.equal(canonicalSessionId('  session-abc  '), 'session-abc')
  assert.equal(canonicalSessionId(undefined), '')
})

test('missionsInSnippet ne retient que les missions connues', () => {
  const known = new Set(missions.map((mission) => mission.id))
  assert.deepEqual(missionsInSnippet('voir missions/ABC-50/mission.md', known), ['ABC-50'])
  assert.deepEqual(missionsInSnippet('missions/INCONNUE-1/x et missions/XYZ-1493/mission.md', known), ['XYZ-1493'])
  assert.deepEqual(missionsInSnippet('missions/ABC-50/a et missions/ABC-50/b', known), ['ABC-50'])
  assert.deepEqual(missionsInSnippet('aucune référence', known), [])
})

test('decompressZstdFrames recolle les trames successives', () => {
  const joined = decompressZstdFrames(Buffer.concat([
    frame('{"type":"message","text":"bonjour"}'),
    frame('{"type":"message","text":"missions/XYZ-1493/x"}'),
  ]))
  assert.match(joined, /bonjour/)
  assert.match(joined, /missions\/XYZ-1493\/x/)
})

test('sessionTitle lit le titre et dé-échappe les guillemets', () => {
  assert.equal(sessionTitle('{"type":"session"}\n{"title":"Sur la mission XYZ-1493"}'), 'Sur la mission XYZ-1493')
  assert.equal(sessionTitle('{"title":"Un \\"mot\\" cité"}'), 'Un "mot" cité')
  assert.equal(sessionTitle('{"type":"session"}'), '')
})

test('titleMentions exige un jeton entier', () => {
  const known = new Set(['XYZ-1493', 'XYZ-149'])
  assert.deepEqual(titleMentions('Sur la mission XYZ-1493, suite', known), ['XYZ-1493'])
  assert.deepEqual(titleMentions('XYZ-14930 est autre chose', known), [])
  assert.deepEqual(titleMentions('', known), [])
})

test('scanSessionCandidates pondère les mentions et ignore les sous-agents', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-missions-'))
  try {
    writeSession(root, 'conv', [
      frame('{"type":"session","delegationDepth":0}'),
      frame('{"title":"Reprise de missions/ABC-50/journal.md"}'),
      frame('{"type":"message","text":"missions/ABC-50/mission.md et missions/XYZ-1493/x"}'),
    ])
    writeSession(root, 'agent', [
      frame('{"type":"session","delegationDepth":1}'),
      frame('{"type":"message","text":"missions/ABC-50/mission.md"}'),
    ])
    const { byMission, scanned } = scanSessionCandidates(root, new Set(['ABC-50', 'XYZ-1493']))
    assert.equal(scanned, 1)
    assert.equal(byMission['ABC-50'].length, 1)
    assert.equal(byMission['ABC-50'][0].sessionId, 'session-conv')
    assert.equal(byMission['ABC-50'][0].mentions, 2)
    assert.equal(byMission['ABC-50'][0].titleMatch, true)
    assert.equal(byMission['XYZ-1493'][0].mentions, 1)
    assert.equal(byMission['XYZ-1493'][0].titleMatch, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanSessionCandidates lit les trames ajoutées après la première', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-missions-'))
  try {
    writeSession(root, 'abc', [
      frame('{"type":"session","delegationDepth":0}'),
      frame('{"type":"message","text":"début sans référence"}'),
      frame('{"type":"message","text":"voir missions/ABC-50/journal.md"}'),
    ])
    const { byMission, scanned } = scanSessionCandidates(root, new Set(['ABC-50']))
    assert.equal(scanned, 1)
    assert.deepEqual(byMission['ABC-50'].map((row) => row.sessionId), ['session-abc'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mergeMissionSessions ordonne explicit > titre > mentions et déduplique', () => {
  const links = { 'ABC-50': ['session-explicit'] }
  const content = {
    'ABC-50': [
      { sessionId: 'session-explicit', mentions: 2 },
      { sessionId: 'session-titre', mentions: 3, titleMatch: true },
      { sessionId: 'session-fort', mentions: 120 },
      { sessionId: 'session-faible', mentions: 1 },
    ],
    'XYZ-1493': [{ sessionId: 'session-seule', mentions: 8 }],
  }
  const merged = mergeMissionSessions(links, content, missions)
  assert.deepEqual(merged['ABC-50'].map((row) => row.sessionId), ['session-explicit', 'session-titre', 'session-fort', 'session-faible'])
  assert.deepEqual(merged['XYZ-1493'].map((row) => row.sessionId), ['session-seule'])
})

test('mergeMissionSessions ignore les missions sans session et borne à 4', () => {
  assert.deepEqual(mergeMissionSessions({}, {}, missions), {})
  const content = { 'ABC-50': Array.from({ length: 9 }, (_, index) => ({ sessionId: `s${index}`, mentions: index })) }
  const merged = mergeMissionSessions({}, content, missions)
  assert.equal(merged['ABC-50'].length, 4)
  assert.equal(merged['ABC-50'][0].sessionId, 'session-s8')
})

test('mergeMissionSessions ignore les sessions archivées', () => {
  const links = { 'ABC-50': ['session-archived-link'] }
  const content = {
    'ABC-50': [
      { sessionId: 'session-archived-link', mentions: 9 },
      { sessionId: 'session-archived-content', mentions: 7 },
      { sessionId: 'session-live', mentions: 1 },
    ],
  }
  const archived = new Set(['session-archived-link', 'session-archived-content'])
  const merged = mergeMissionSessions(links, content, missions, archived)
  assert.deepEqual(merged['ABC-50'].map((row) => row.sessionId), ['session-live'])
})

test('readArchivedSessions lit global.archivedSessionIds et normalise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-missions-archive-'))
  try {
    const file = join(dir, 'workspace.json')
    writeFileSync(file, JSON.stringify({ global: { archivedSessionIds: ['session-abc', 'def'] } }))
    assert.deepEqual([...readArchivedSessions(file)].sort(), ['session-abc', 'session-def'])
    assert.equal(readArchivedSessions(join(dir, 'absent.json')).size, 0)
    writeFileSync(file, '{not json')
    assert.equal(readArchivedSessions(file).size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeMissionSessions attribue une session à une seule mission', () => {
  const content = {
    'ABC-50': [{ sessionId: 'session-partagee', mentions: 40 }],
    'XYZ-1493': [{ sessionId: 'session-partagee', mentions: 3 }],
  }
  const merged = mergeMissionSessions({}, content, missions)
  assert.equal(merged['ABC-50'].length, 1)
  assert.equal(merged['XYZ-1493'], undefined)
})

test('mergeMissionSessions : le lien explicite réserve la session', () => {
  const links = { 'XYZ-1493': ['session-partagee'] }
  const content = { 'ABC-50': [{ sessionId: 'session-partagee', mentions: 90 }] }
  const merged = mergeMissionSessions(links, content, missions)
  assert.deepEqual(merged['XYZ-1493'].map((row) => row.sessionId), ['session-partagee'])
  assert.equal(merged['ABC-50'], undefined)
})

test('mergeMissionSessions : la correspondance de titre prime sur les mentions', () => {
  const content = {
    'ABC-50': [{ sessionId: 'session-partagee', mentions: 90 }],
    'XYZ-1493': [{ sessionId: 'session-partagee', mentions: 2, titleMatch: true }],
  }
  const merged = mergeMissionSessions({}, content, missions)
  assert.deepEqual(merged['XYZ-1493'].map((row) => row.sessionId), ['session-partagee'])
  assert.equal(merged['ABC-50'], undefined)
})

test('scanSessionCandidates marque vide une session sans message', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-missions-'))
  try {
    writeSession(root, 'vide', [frame('{"type":"session","delegationDepth":0}')])
    writeSession(root, 'pleine', [
      frame('{"type":"session","delegationDepth":0}'),
      frame('{"type":"user/message","text":"missions/ABC-50/mission.md"}'),
    ])
    const { sessions, byMission } = scanSessionCandidates(root, new Set(['ABC-50']))
    assert.equal(sessions['session-vide'].blank, true)
    assert.equal(sessions['session-pleine'].blank, false)
    assert.equal(byMission['ABC-50'][0].blank, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mergeMissionSessions marque un lien explicite vers une session vide', () => {
  const links = { 'ABC-50': ['session-vide'] }
  const sessions = { 'session-vide': { blank: true, title: '', updatedAt: 42 } }
  const merged = mergeMissionSessions(links, {}, missions, new Set(), sessions)
  assert.equal(merged['ABC-50'][0].blank, true)
  assert.equal(merged['ABC-50'][0].updatedAt, 42)
})

test('scanSessionCandidates relit un journal qui a grossi', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-missions-'))
  try {
    const cache = new Map()
    const known = new Set(['ABC-50', 'XYZ-1493'])
    const file = join(root, 'ws', 'session-live', 'session.v4.jsonl.zstd')
    // Given un journal qui ne cite que ABC-50, indexé une première fois
    writeSession(root, 'live', [
      frame('{"type":"session","delegationDepth":0}'),
      frame('{"type":"message","text":"missions/ABC-50/mission.md"}'),
    ])
    assert.deepEqual(Object.keys(scanSessionCandidates(root, known, cache).byMission), ['ABC-50'])
    // When une trame est ajoutée au même journal
    appendFileSync(file, frame('{"type":"message","text":"missions/XYZ-1493/mission.md"}'))
    // Then le second scan repart du disque et voit la nouvelle mention
    const { byMission } = scanSessionCandidates(root, known, cache)
    assert.deepEqual(Object.keys(byMission).sort(), ['ABC-50', 'XYZ-1493'])
    assert.equal(byMission['ABC-50'][0].mentions, 1)
    assert.equal(byMission['XYZ-1493'][0].mentions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanSessionCandidates réutilise le memo tant que le journal est inchangé', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-missions-'))
  try {
    const cache = new Map()
    const file = join(root, 'ws', 'session-stable', 'session.v4.jsonl.zstd')
    writeSession(root, 'stable', [
      frame('{"type":"session","delegationDepth":0}'),
      frame('{"type":"message","text":"missions/ABC-50/mission.md et missions/XYZ-1493/x"}'),
    ])
    // Given un premier scan qui remplit le memo
    const first = scanSessionCandidates(root, new Set(['ABC-50']), cache)
    const memo = cache.get(file)
    // When un second scan élargit le jeu de missions connues sans toucher au journal
    const second = scanSessionCandidates(root, new Set(['ABC-50', 'XYZ-1493']), cache)
    // Then le memo est réutilisé et le filtre porte sur le jeu courant
    assert.equal(cache.get(file), memo)
    assert.deepEqual(Object.keys(first.byMission), ['ABC-50'])
    assert.deepEqual(Object.keys(second.byMission).sort(), ['ABC-50', 'XYZ-1493'])
    assert.equal(second.scanned, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
