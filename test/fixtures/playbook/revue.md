# Revue

Entrée : in-review → Sortie : ready-for-prod

Document : workflows/review.md

## Avant d'agir
- Vérifier le ticket et la branche.

## Les gestes, dans l'ordre
- Premier geste.
- Second geste.

## Pièges observés
- Piège connu.

## Preuve de sortie
- [ ] Un commentaire daté porte la décision et, pour chaque critère, son
  scénario et sa preuve vérifiés, ou le refus.
- [x] Le journal et la checklist portent la décision et les preuves.

## Les règles
- **La validation est un fait du dépôt** : elle se lit sur la PR, pas dans un
  souvenir ni dans un message.

### Constats et décisions
| Constat | Décision | Qui pose l'état |
| --- | --- | --- |
| Validation citée sur chaque PR, critères et scénarios complets, journal et checklist à jour | La revue est faite : ticket prêt à partir | La session, `ready-for-prod` |
| Les collègues ont remonté des changements sur la PR | Retour en exécution : la session de remontées corrige sur la branche | Le demandeur, `in-progress` |
| La PR sort du périmètre du cadrage, ou un critère n'a pas de scénario | Retour au cadrage, branche et PR ouvertes | Le demandeur, `to-refine` |

## La fiche du dépôt
- Dépôt : `example`.
