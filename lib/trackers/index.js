import * as github from './github.js'
import * as jira from './jira.js'

/**
 * Registre des trackers et agrégation.
 *
 * Chaque projet est une source : sa lecture est indépendante (`allSettled`),
 * son échec devient une erreur nommée, et les autres continuent. Rien n'est
 * supposé partagé entre deux projets.
 */

const ADAPTATEURS = { github, jira }
const TTL_MS = 60_000
const cache = new Map()

export const trackers = Object.keys(ADAPTATEURS)

/** Liste les missions de tous les projets déclarés. */
export async function listerTout(projets, { signal, fetchImpl, frais = false } = {}) {
  const resultats = await Promise.allSettled(
    projets.map(async (projet) => {
      const memo = cache.get(projet.id)
      if (!frais && memo && Date.now() - memo.at < TTL_MS) return memo.missions

      const adaptateur = ADAPTATEURS[projet.tracker]
      if (!adaptateur) throw new Error(`tracker inconnu : ${projet.tracker}`)

      const missions = await adaptateur.lister(projet, { signal, fetchImpl })
      cache.set(projet.id, { at: Date.now(), missions })
      return missions
    }),
  )

  const missions = []
  const erreurs = []
  resultats.forEach((resultat, index) => {
    if (resultat.status === 'fulfilled') {
      missions.push(...resultat.value)
      return
    }
    const raison = resultat.reason
    erreurs.push({
      projet: projets[index]?.id ?? '?',
      message: raison instanceof Error ? raison.message : String(raison),
    })
  })

  missions.sort((a, b) => String(a.etat ?? 'zzz').localeCompare(String(b.etat ?? 'zzz')) || a.cle.localeCompare(b.cle))
  return { missions, erreurs }
}

/** Vide le cache (tests, ou rechargement forcé). */
export function viderCache() {
  cache.clear()
}
