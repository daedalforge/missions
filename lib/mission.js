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

/**
 * Ramène une issue à la forme commune.
 *
 * Un état ou un type sans correspondance reste `null` : le panneau l'affiche
 * comme inconnu plutôt que de lui prêter une valeur.
 */
export function normaliserIssue({ issue, projet, inverses, cle }) {
  const etiquettes = (issue?.labels ?? [])
    .map((etiquette) => (typeof etiquette === 'string' ? etiquette : etiquette?.name))
    .filter(Boolean)

  const etat = etiquettes.map((nom) => inverses.etats.get(nom)).find(Boolean) ?? null
  const type = etiquettes.map((nom) => inverses.types.get(nom)).find(Boolean) ?? null

  return {
    projet: projet.id,
    cle,
    numero: issue?.number ?? null,
    titre: String(issue?.title ?? ''),
    etat,
    type,
    epic: issue?.milestone?.title ?? null,
    url: issue?.html_url ?? null,
    maj: issue?.updated_at ?? null,
  }
}
