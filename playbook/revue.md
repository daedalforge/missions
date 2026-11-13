# Revue — de la PR à la décision

Relire la PR contre les critères et poser une décision, sans merger.

`Entrée : in-review → Sortie : ready-for-prod`. Document de l'étape :
[`workflows/review.md`](../workflows/review.md).

## Avant d'agir

- Relire les CA du ticket, le journal et la checklist.
- Lire le diff réel au CLI : `gh pr diff <n> -R <owner>/<repo>` ; ne pas se
  fier au corps de la PR.
- Vérifier que la CI et `npm test` sont verts sur la tête de branche.

## Les gestes, dans l'ordre

1. **Reprendre les six points** de `workflows/review.md` : CA, diff, périmètre,
   tests, journal, checklist.
2. **Vérifier chaque CA** contre une preuve du diff ou d'un test ; un CA sans
   preuve est un refus, pas une présomption.
3. **Chercher l'élargissement** : un fichier modifié hors du périmètre de la
   fiche est un constat, pas un détail.
4. **Écrire les constats** dans le ticket (commentaire daté), pas seulement
   dans la session.
5. **Décider** :
   - approuvé →
     `gh issue edit <n> -R <owner>/<repo> --add-label ready-for-prod --remove-label in-review` ;
   - à reprendre →
     `--add-label in-progress --remove-label in-review`, puis nouvelle session
     d'exécution ;
   - retour cadrage →
     `--add-label to-refine --remove-label in-review`.
6. **S'arrêter** : la revue ne merge pas, ne ferme pas, ne publie pas de revue
   GitHub.

## Pièges observés

- `workflows/review.md` dit « review Approuve » : publier une revue est interdit
  par `standards/interdits.md` (4, 5) — la décision se pose en label et en
  commentaire, pas en review GitHub.
- Approuver le ticket n'est pas approuver la PR : les deux gestes sont
  distincts, seul le label `ready-for-prod` fait avancer la mission.
- Lire le corps de la PR au lieu du diff laisse passer un écart de périmètre.
- Noter la décision seulement dans la session la perd : le ticket est le seul
  journal durable.

## Preuve de sortie

- Un commentaire daté porte la décision et, pour chaque CA, la preuve vérifiée
  ou le refus.
- Le ticket porte `ready-for-prod` (ou l'état de reprise) et **aucun** autre
  label d'état.
- Le journal et la checklist portent la décision et les preuves.
- Aucune revue GitHub publiée, aucune PR mergée.

## Où lire les règles

- [`workflows/review.md`](../workflows/review.md) — l'étape que la page met en
  œuvre.
- [`standards/revue.md`](../standards/revue.md) — la grille de revue.
- [`standards/code.md`](../standards/code.md) — ce qu'un diff doit respecter.
- [`standards/interdits.md`](../standards/interdits.md) — merge et revue
  interdits.
- [`standards/repos/missions.md`](../standards/repos/missions.md) — commandes
  du dépôt.
