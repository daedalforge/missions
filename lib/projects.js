import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

/** Chemin par défaut : `missions/projects.yml`, à la racine du paquet. */
export const FICHIER_PROJETS = new URL('../missions/projects.yml', import.meta.url)

const TRACKERS = new Set(['github', 'jira'])

/**
 * Charge et valide la déclaration des projets.
 *
 * Un projet dont le `map` ne couvre pas tout le vocabulaire canonique est
 * refusé : mieux vaut une erreur explicite qu'un état deviné à l'affichage.
 */
export async function chargerProjets(fichier = FICHIER_PROJETS) {
  const texte = await readFile(fichier, 'utf8')
  const brut = parse(texte) ?? {}
  const canonique = lireCanonique(brut.canonical)
  const projets = (Array.isArray(brut.projects) ? brut.projects : []).map((projet) =>
    validerProjet(projet, canonique),
  )
  return { canonique, projets }
}

function lireCanonique(canonique) {
  const etats = canonique?.states
  const types = canonique?.types
  if (!Array.isArray(etats) || etats.length === 0) {
    throw new Error('projects.yml : canonical.states manquant')
  }
  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('projects.yml : canonical.types manquant')
  }
  return { states: etats.map(String), types: types.map(String) }
}

function validerProjet(projet, canonique) {
  const id = String(projet?.id ?? '').trim()
  if (!id) throw new Error('projects.yml : projet sans identifiant')
  const tracker = String(projet?.tracker ?? '')
  if (!TRACKERS.has(tracker)) {
    throw new Error(`projects.yml : ${id} a un tracker inconnu (« ${tracker} »)`)
  }
  const map = projet?.map ?? {}
  const etatsManquants = canonique.states.filter((etat) => !(etat in (map.states ?? {})))
  const typesManquants = canonique.types.filter((type) => !(type in (map.types ?? {})))
  if (etatsManquants.length > 0 || typesManquants.length > 0) {
    const manquants = [...etatsManquants, ...typesManquants].join(', ')
    throw new Error(`projects.yml : ${id} n'a pas de correspondance pour ${manquants}`)
  }
  return {
    id,
    nom: String(projet.name ?? id),
    repo: projet.repo ?? null,
    tracker,
    github: projet.github ?? null,
    jira: projet.jira ?? null,
    map: { states: map.states, types: map.types },
  }
}
