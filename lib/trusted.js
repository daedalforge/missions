const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostnameOf(value) {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return ''
  }
}

export function isTrustedRequest(req) {
  const headers = req.headers ?? {}
  const host = typeof headers.host === 'string' ? headers.host : ''
  if (!host || !LOOPBACK.has(hostnameOf(host))) return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return headers['sec-fetch-site'] !== 'cross-site'
}
