# Connect

## Contexte

- Dépôt produit PHP (`^8.5`), Composer pour les dépendances et npm pour les assets;
  `repo: ~/projects/Connect`.
- Origine GitHub `Flex-O-SAS/Connect`; la CI est déclenchée au push et son statut se
  constate depuis la plateforme, jamais depuis le poste.
- Commandes déclarées: `composer install`; tests parallèles
  `APP_ENV=testing composer test:parallel`; mutation `composer mutation` et
  `composer mutation:filter`; assets `yarn build` et `yarn dev`. Le README du dépôt
  fait foi pour le détail; il n'est pas recopié ici.
- Le dépôt a ses propres pratiques de test et de commentaire, constatées sur
  l'existant; `standards/code.md` prime sur le code neuf ou touché.

## Exécution

- `base` : déclarée dans `missions/<dossier>/mission.yml` ; la fiche du dépôt ne la fixe pas.
- Invariants: aucun.
- Preuves attendues: les tests bornés que la fiche demande, joués avec
  `APP_ENV=testing`; la suite complète reste réservée à la CI
  (`standards/code.md`).

## Pratiques existantes

### Les tests existants ne portent pas de marqueurs Given / When / Then

La préparation, l'action et les assertions sont séparées par des lignes vides. Un
commentaire dans un test ne sert qu'à expliquer une décision — pourquoi ce cas, quel
défaut il ferme —, jamais à étiqueter les trois temps.

**Raison**: les 277 fichiers de tests existants suivent cette forme; marquer les
seuls nouveaux ferait cohabiter deux styles, et reprendre l'existant coûterait une
passe entière sans gain de lecture. Pest fusionne action et assertion dans
`expect(fn () => …)->toThrow()`, ce qui rendrait le marquage faux sur les tests
d'erreur.

Cette forme décrit l'existant. Un test neuf ou touché suit `standards/code.md`.

**Portée**: tests existants, non touchés.

### Le code de production existant porte des commentaires de justification

Docblocks et `//` en corps de méthode expliquent une décision: pourquoi ce choix,
quel défaut il évite, ce que l'alternative aurait coûté. Cette forme décrit le
code existant; le code neuf ou touché suit `standards/code.md`. Les tests restent
soumis à la pratique précédente.

**Raison**: le code d'intégration — clients et traducteurs de fournisseurs — repose
sur des contraintes qui ne se lisent pas dans le code: dérivation d'une clé, ordre
des appels, compromis d'atomicité assumé. Ces règles de fournisseurs changent et ne
sont pas testables par signature; l'historique Git ne les rend pas lisibles dans le
fichier.

**Portée**: code de production existant, non touché. Le code neuf ou touché suit
`standards/code.md`.

## Interdits locaux

- Aucun.

## Review

- Gates à rejouer: les tests bornés de la fiche avec `APP_ENV=testing`; citer la
  sortie brute.
- Une violation de `standards/code.md` sur le code neuf ou touché est bloquante
  (`standards/interdits.md` #9). Les deux constats ci-dessus décrivent l'existant;
  ils ne créent aucune dérogation.
- Faux positifs connus: aucun.
