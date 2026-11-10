/**
 * Accès HTTP minimal : une requête JSON, une erreur typée, un message lisible.
 *
 * Le panneau ne parle qu'à ses propres routes ; ce module ne sert qu'à la
 * moitié hôte, qui seule détient les jetons.
 */

export class ErreurHttp extends Error {
  constructor(message, { status = 0, corps = null } = {}) {
    super(message)
    this.name = 'ErreurHttp'
    this.status = status
    this.corps = corps
  }
}

/**
 * Requête JSON avec jeton porteur.
 *
 * `fetchImpl` est injectable : les tests passent un faux `fetch`, jamais le
 * réseau.
 */
export async function requeteJson(url, { token, signal, entetes = {}, fetchImpl = fetch, libelle = 'API' } = {}) {
  const enTetes = {
    accept: 'application/json',
    'user-agent': 'dsh-missions',
    ...entetes,
  }
  if (token) enTetes.authorization = `Bearer ${token}`

  let reponse
  try {
    reponse = await fetchImpl(url, { headers: enTetes, signal })
  } catch (erreur) {
    if (erreur?.name === 'AbortError') throw erreur
    throw new ErreurHttp(`${libelle} injoignable : ${erreur?.message ?? 'échec réseau'}`)
  }

  const texte = await reponse.text()
  let corps = null
  if (texte) {
    try {
      corps = JSON.parse(texte)
    } catch {
      corps = null
    }
  }

  if (!reponse.ok) {
    throw new ErreurHttp(messageDeStatut(reponse.status, reponse.headers, libelle), {
      status: reponse.status,
      corps,
    })
  }
  return { corps, entetes: reponse.headers }
}

function messageDeStatut(status, entetes, libelle) {
  if (status === 401) return `jeton ${libelle} absent ou invalide`
  if (status === 403) {
    const reste = Number(entetes?.get?.('x-ratelimit-remaining') ?? NaN)
    if (reste === 0) {
      const reinit = Number(entetes?.get?.('x-ratelimit-reset') ?? NaN)
      if (Number.isFinite(reinit) && reinit > 0) {
        const quand = new Date(reinit * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        return `quota ${libelle} épuisé, réessaie après ${quand}`
      }
      return `quota ${libelle} épuisé`
    }
    return `accès refusé par ${libelle} (droits insuffisants)`
  }
  if (status === 404) return `ressource introuvable sur ${libelle} (dépôt ou droits)`
  if (status === 429) return `${libelle} : trop de requêtes`
  return `${libelle} : HTTP ${status}`
}

/** Extrait l'URL de la page suivante d'un en-tête `Link`. */
export function lienSuivant(enteteLink) {
  if (!enteteLink) return null
  for (const morceau of String(enteteLink).split(',')) {
    const [url, ...params] = morceau.split(';')
    if (params.some((p) => p.trim() === 'rel="next"')) {
      return url.trim().replace(/^<|>$/g, '')
    }
  }
  return null
}
