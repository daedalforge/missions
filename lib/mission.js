/**
 * Normalisation : d'une issue de tracker vers la forme commune du panneau.
 *
 * Le vocabulaire canonique vient de `projects.yml` ; la correspondance d'un
 * projet est inversée une fois (nom du tracker → nom canonique), jamais
 * devinée à l'affichage.
 */

/** Inverse le `map` d'un projet : valeurs du tracker → noms canoniques. */
export function inverser(map = {}) {
  const etats = new Map()
  const types = new Map()
  for (const [canonique, valeur] of Object.entries(map.states ?? {})) {
    if (valeur !== null && valeur !== undefined) etats.set(String(valeur), canonique)
  }
  for (const [canonique, valeur] of Object.entries(map.types ?? {})) {
    if (valeur !== null && valeur !== undefined) types.set(String(valeur), canonique)
  }
  return { etats, types }
}

/** Première valeur connue de la table (étiquettes GitHub, par exemple). */
export function premierConnu(valeurs, table) {
  for (const valeur of valeurs) {
    if (table.has(String(valeur))) return String(valeur)
  }
  return null
}

/**
 * Ramène une issue à la forme commune.
 *
 * Un état ou un type sans correspondance reste `null` : le panneau l'affiche
 * comme inconnu plutôt que de lui prêter une valeur.
 */
export function normaliserIssue({
  projet,
  cle,
  numero = null,
  titre = '',
  etatBrut = null,
  typeBrut = null,
  epic = null,
  url = null,
  maj = null,
  inverses,
}) {
  const etat = etatBrut === null || etatBrut === undefined ? null : (inverses.etats.get(String(etatBrut)) ?? null)
  const type = typeBrut === null || typeBrut === undefined ? null : (inverses.types.get(String(typeBrut)) ?? null)

  return {
    projet: projet.id,
    cle,
    numero,
    titre: String(titre ?? ''),
    etat,
    type,
    epic: epic ?? null,
    url: url ?? null,
    maj: maj ?? null,
  }
}
