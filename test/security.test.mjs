import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDayKey, saveDay } from '../lib/performance/bilan.js'
import { titleMentions } from '../lib/sessions.js'
import { isTrustedRequest } from '../lib/trusted.js'

function request(headers) {
  return { headers }
}

test('garde : accepte une requête locale de même origine', () => {
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:52018', origin: 'http://127.0.0.1:52018' })), true)
  assert.equal(isTrustedRequest(request({ host: 'localhost:52018' })), true)
  assert.equal(isTrustedRequest(request({ host: '[::1]:52018', origin: 'http://[::1]:52018' })), true)
})

test('garde : refuse un hôte rebindé même si l’origine concorde', () => {
  assert.equal(isTrustedRequest(request({ host: 'evil.example:52018', origin: 'http://evil.example:52018' })), false)
  assert.equal(isTrustedRequest(request({ host: '192.168.1.10:52018', origin: 'http://192.168.1.10:52018' })), false)
})

test('garde : refuse une origine locale d’un autre port', () => {
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:52018', origin: 'http://127.0.0.1:9999' })), false)
})

test('garde : refuse une requête cross-site sans origine', () => {
  assert.equal(isTrustedRequest(request({ host: '127.0.0.1:52018', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedRequest(request({})), false)
})

test('bilan : seule une date ISO est acceptée', () => {
  assert.equal(isDayKey('2026-11-10'), true)
  assert.equal(isDayKey('../../../../.dsh-missions'), false)
  assert.equal(isDayKey('2026-11-10/../x'), false)
  assert.equal(isDayKey('2026-1-1'), false)
})

test('bilan : saveDay refuse une date hors format', () => {
  assert.throws(() => saveDay('../../../../.dsh-missions', { decision: 'x' }), RangeError)
})

test('sessions : un identifiant à métacaractères reste un jeton littéral', () => {
  const known = new Set(['ABC-75', '(a+)+'])
  assert.deepEqual(titleMentions('ABC-75 et (a+)+', known), ['ABC-75', '(a+)+'])
  assert.deepEqual(titleMentions('ABC-750', known), [])
  assert.deepEqual(titleMentions('(a+)+x', known), [])
  assert.deepEqual(titleMentions('a (a+)+ .', known), ['(a+)+'])
})
