import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ErreurHttp, requeteJson } from '../http.js'
import { inverser, normaliserIssue } from '../mission.js'

const execFileAsync = promisify(execFile)
const CHAMPS = 'summary,status,issuetype,parent,updated'
const PAGES_MAX = 5
const TAILLE_PAGE = 100

export const id = 'jira'

let jetonMemoire = null

/**
 * Jeton Jira, sans jamais en écrire un sur disque.
 *
 * Ordre : `JIRA_API_TOKEN`, puis le Trousseau du poste — même service que
 * `config/tools/atlassian/jira.sh` (`atlassian-token`).
 */
export async function jeton() {
  if (jetonMemoire) return jetonMemoire
  const env = process.env.JIRA_API_TOKEN
  if (env && env.trim()) {
    jetonMemoire = env.trim()
    return jetonMemoire
  }
  const service = process.env.ATLASSIAN_KEYCHAIN_SERVICE || 'atlassian-token'
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 10000,
    })
    const valeur = String(stdout ?? '').trim()
    if (!valeur) throw new Error('vide')
    jetonMemoire = valeur
    return jetonMemoire
  } catch {
    throw new Error(`jeton Jira introuvable : Trousseau « ${service} » ou JIRA_API_TOKEN`)
  }
}

export function oublierJeton() {
  jetonMemoire = null
}

/** Adresse du compte : champ `jira.email` du projet, sinon l'environnement. */
export function courriel(projet) {
  return projet?.jira?.email || process.env.JIRA_EMAIL || process.env.ATLASSIAN_EMAIL || null
}

/** Liste les missions non résolues d'un projet Jira. */
export async function lister(projet, { signal, fetchImpl = fetch } = {}) {
  const { site, key_prefix: prefixe } = projet.jira ?? {}
  if (!site) throw new Error(`projet ${projet.id} : jira.site requis`)
  if (!prefixe) throw new Error(`projet ${projet.id} : jira.key_prefix requis`)

  const utilisateur = courriel(projet)
  if (!utilisateur) throw new Error(`projet ${projet.id} : jira.email requis (ou JIRA_EMAIL)`)

  const motDePasse = await jeton()
  const entetes = {
    accept: 'application/json',
    authorization: `Basic ${Buffer.from(`${utilisateur}:${motDePasse}`).toString('base64')}`,
  }

  const base = site.replace(/\/+$/, '')
  const jql = `project = "${prefixe}" AND resolution = Unresolved ORDER BY updated DESC`
  const issues = await rechercher(base, jql, { entetes, signal, fetchImpl })

  const inverses = inverser(projet.map)
  return issues.map((issue) => {
    const champs = issue.fields ?? {}
    return normaliserIssue({
      projet,
      cle: issue.key,
      numero: null,
      titre: champs.summary ?? '',
      etatBrut: champs.status?.name ?? null,
      typeBrut: champs.issuetype?.name ?? null,
      epic: champs.parent?.key ?? null,
      url: `${base}/browse/${issue.key}`,
      maj: champs.updated ?? null,
      inverses,
    })
  })
}

async function rechercher(base, jql, { entetes, signal, fetchImpl }) {
  try {
    return await rechercherJql(base, jql, { entetes, signal, fetchImpl })
  } catch (erreur) {
    // Certains sites Cloud refusent encore `/search/jql` : on retombe sur
    // l'endpoint historique, à pagination par `startAt`.
    if (erreur instanceof ErreurHttp && (erreur.status === 404 || erreur.status === 410)) {
      return rechercherHerite(base, jql, { entetes, signal, fetchImpl })
    }
    throw erreur
  }
}

async function rechercherJql(base, jql, { entetes, signal, fetchImpl }) {
  const collecte = []
  let suivant = null
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const url = new URL(`${base}/rest/api/3/search/jql`)
    url.searchParams.set('jql', jql)
    url.searchParams.set('fields', CHAMPS)
    url.searchParams.set('maxResults', String(TAILLE_PAGE))
    if (suivant) url.searchParams.set('nextPageToken', suivant)

    const { corps } = await requeteJson(url.toString(), { entetes, signal, fetchImpl, libelle: 'Jira' })
    collecte.push(...(corps?.issues ?? []))
    suivant = corps?.nextPageToken ?? null
    if (!suivant) break
  }
  return collecte
}

async function rechercherHerite(base, jql, { entetes, signal, fetchImpl }) {
  const collecte = []
  for (let page = 0; page < PAGES_MAX; page += 1) {
    const url = new URL(`${base}/rest/api/3/search`)
    url.searchParams.set('jql', jql)
    url.searchParams.set('fields', CHAMPS)
    url.searchParams.set('startAt', String(page * TAILLE_PAGE))
    url.searchParams.set('maxResults', String(TAILLE_PAGE))

    const { corps } = await requeteJson(url.toString(), { entetes, signal, fetchImpl, libelle: 'Jira' })
    const issues = corps?.issues ?? []
    collecte.push(...issues)
    const total = Number(corps?.total ?? 0)
    if (issues.length < TAILLE_PAGE || collecte.length >= total) break
  }
  return collecte
}
