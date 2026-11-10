import { chargerProjets } from './projects.js'
import { listerTout } from './trackers/index.js'

/**
 * Moitié hôte du panneau Missions.
 *
 * Elle seule parle aux trackers : elle détient les jetons, lit les projets
 * déclarés dans `missions/projects.yml` et expose une liste normalisée au
 * client, qui n'a jamais accès à un secret.
 */
export const name = '@daedalforge/dsh-missions'
export const inject = ['webServer']

const MAX_REQUETE = 8 * 1024

export function apply(ctx, config = {}) {
  const fichier = config?.projectsFile ? new URL(config.projectsFile, 'file:///') : undefined

  const gestion = async (req, res) => {
    if (!requeteLocale(req)) return envoyer(res, 403, { erreur: 'origine non autorisée' })

    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return envoyer(res, 400, { erreur: 'requête invalide' })
    }

    if (url.pathname !== '/missions/api/list') {
      return envoyer(res, 404, { erreur: 'route inconnue' })
    }
    if ((req.method ?? 'GET') !== 'GET') {
      return envoyer(res, 405, { erreur: 'méthode non autorisée' })
    }

    try {
      const { projets } = await chargerProjets(fichier)
      const frais = url.searchParams.get('frais') === '1'
      const { missions, erreurs } = await listerTout(projets, { frais })
      return envoyer(res, 200, { missions, erreurs })
    } catch (erreur) {
      return envoyer(res, 500, { erreur: erreur instanceof Error ? erreur.message : 'erreur interne' })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/missions/api', handler: gestion }))
}

function envoyer(res, status, valeur) {
  const corps = JSON.stringify(valeur)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(corps)
}

/** Seules les requêtes locales sont servies (le panneau tourne sur le poste). */
function requeteLocale(req) {
  const distance = req.socket?.remoteAddress ?? ''
  const local = distance === '127.0.0.1' || distance === '::1' || distance === '::ffff:127.0.0.1'
  if (!local) return false
  const origine = req.headers?.origin
  if (!origine) return true
  try {
    const hote = new URL(origine).hostname
    return hote === '127.0.0.1' || hote === 'localhost' || hote === '[::1]'
  } catch {
    return false
  }
}

export { MAX_REQUETE }
