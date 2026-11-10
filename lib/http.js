/**
 * Minimal HTTP access: one JSON request, one typed error, one readable message.
 *
 * The panel only talks to its own routes; this module belongs to the host half,
 * which is the only place that holds tokens.
 */

export class HttpError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

/**
 * JSON request with a bearer token.
 *
 * `fetchImpl` is injectable: tests pass a fake `fetch`, never the network.
 */
export async function requestJson(url, { token, signal, headers = {}, fetchImpl = fetch, label = 'API' } = {}) {
  const requestHeaders = {
    accept: 'application/json',
    'user-agent': 'dsh-missions',
    ...headers,
  }
  if (token) requestHeaders.authorization = `Bearer ${token}`

  let response
  try {
    response = await fetchImpl(url, { headers: requestHeaders, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new HttpError(`${label} unreachable: ${error?.message ?? 'network failure'}`)
  }

  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    throw new HttpError(messageForStatus(response.status, response.headers, label), {
      status: response.status,
      body,
    })
  }
  return { body, headers: response.headers }
}

function messageForStatus(status, headers, label) {
  if (status === 401) return `${label} token missing or invalid`
  if (status === 403) {
    const remaining = Number(headers?.get?.('x-ratelimit-remaining') ?? NaN)
    if (remaining === 0) {
      const reset = Number(headers?.get?.('x-ratelimit-reset') ?? NaN)
      if (Number.isFinite(reset) && reset > 0) {
        const when = new Date(reset * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        return `${label} rate limit exhausted, retry after ${when}`
      }
      return `${label} rate limit exhausted`
    }
    return `${label} access denied (insufficient permissions)`
  }
  if (status === 404) return `resource not found on ${label} (repository or permissions)`
  if (status === 429) return `${label}: too many requests`
  return `${label}: HTTP ${status}`
}

/** Extract the next page URL from a `Link` header. */
export function nextLink(linkHeader) {
  if (!linkHeader) return null
  for (const part of String(linkHeader).split(',')) {
    const [url, ...params] = part.split(';')
    if (params.some((param) => param.trim() === 'rel="next"')) {
      return url.trim().replace(/^<|>$/g, '')
    }
  }
  return null
}
