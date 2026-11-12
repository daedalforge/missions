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
 * `method` and `body` cover the one write of the panel (the blocked label and
 * its comment); a request without a body is still a plain `GET`. `fetchImpl` is
 * injectable: tests pass a fake `fetch`, never the network.
 */
export async function requestJson(
  url,
  { token, signal, method = 'GET', body, headers = {}, fetchImpl = fetch, label = 'API' } = {},
) {
  const requestHeaders = {
    accept: 'application/json',
    'user-agent': 'dsh-missions',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  }
  if (token) requestHeaders.authorization = `Bearer ${token}`

  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: requestHeaders,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new HttpError(`${label} unreachable: ${error?.message ?? 'network failure'}`)
  }

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    throw new HttpError(messageForStatus(response.status, response.headers, label), {
      status: response.status,
      body: payload,
    })
  }
  return { body: payload, headers: response.headers }
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

/** Extract a page URL from a `Link` header by its `rel` relation. */
function relLink(linkHeader, rel) {
  if (!linkHeader) return null
  for (const part of String(linkHeader).split(',')) {
    const [url, ...params] = part.split(';')
    if (params.some((param) => param.trim() === `rel="${rel}"`)) {
      return url.trim().replace(/^<|>$/g, '')
    }
  }
  return null
}

/** Extract the next page URL from a `Link` header. */
export function nextLink(linkHeader) {
  return relLink(linkHeader, 'next')
}

/**
 * Extract the last page URL from a `Link` header.
 *
 * The last page holds the newest items of a list, so one hop to `rel="last"`
 * is enough to read its end without walking every page.
 */
export function lastLink(linkHeader) {
  return relLink(linkHeader, 'last')
}
