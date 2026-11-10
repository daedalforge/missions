import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { lienSuivant, requeteJson } from '../http.js'
import { inverser, normaliserIssue, premierConnu } from '../mission.js'

const execFileAsync = promisify(execFile)
const API = 'https://api.github.com'
const PAGES_MAX = 10

export const id = 'github'

let jetonMemoire = null

/**
 * Jeton GitHub, sans jamais en écrire un sur disque.
 *
 * Ordre : `GH_TOKEN`, `GITHUB_TOKEN`, puis `gh auth token` (le jeton reste dans
 * le trousseau du poste).
 */
export async function jeton() {
  if (jetonMemoire) return jetonMemoire
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (env && env.trim()) {
    jetonMemoire = env.trim()
    return jetonMemoire
  }
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10000 })
    const valeur = String(stdout ?? '').trim()
    if (!valeur) throw new Error('vide')
    jetonMemoire = valeur
    return jetonMemoire
  } catch {
    throw new Error('jeton GitHub introuvable : ni GH_TOKEN, ni `gh auth token`')
  }
}

/** Remet le jeton en jeu (tests, ou après un `gh auth login`). */
export function oublierJeton() {
  jetonMemoire = null
}

/** Liste les missions ouvertes d'un projet GitHub. */
export async function lister(projet, { signal, fetchImpl = fetch } = {}) {
  const { owner, repo } = projet.github ?? {}
  if (!owner || !repo) {
    throw new Error(`projet ${projet.id} : owner et repo sont requis pour un tracker GitHub`)
  }
  const jetonGithub = await jeton()
  const issues = await lireIssues({ owner, repo }, { jeton: jetonGithub, signal, fetchImpl })
  const inverses = inverser(projet.map)
  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => {
      const etiquettes = (issue.labels ?? [])
        .map((etiquette) => (typeof etiquette === 'string' ? etiquette : etiquette?.name))
        .filter(Boolean)
      return normaliserIssue({
        projet,
        cle: `${owner}/${repo}#${issue.number}`,
        numero: issue.number ?? null,
        titre: issue.title ?? '',
        etatBrut: premierConnu(etiquettes, inverses.etats),
        typeBrut: premierConnu(etiquettes, inverses.types),
        epic: issue.milestone?.title ?? null,
        url: issue.html_url ?? null,
        maj: issue.updated_at ?? null,
        inverses,
      })
    })
}

async function lireIssues({ owner, repo }, { jeton: valeur, signal, fetchImpl }) {
  const collecte = []
  let url = `${API}/repos/${owner}/${repo}/issues?state=open&per_page=100`
  for (let page = 0; page < PAGES_MAX && url; page += 1) {
    const { corps, entetes } = await requeteJson(url, {
      token: valeur,
      signal,
      fetchImpl,
      libelle: 'GitHub',
      entetes: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    })
    if (!Array.isArray(corps)) throw new Error('GitHub : réponse inattendue (liste attendue)')
    collecte.push(...corps)
    url = lienSuivant(entetes?.get?.('link'))
  }
  return collecte
}
