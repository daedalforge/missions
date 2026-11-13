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
  par [`workspace.md`](workspace.md#les-règles) (4, 5) — la décision se pose en
  label et en commentaire, pas en review GitHub.
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

## Les règles

Communs à toutes les étapes — les treize sont dans
[`workspace.md`](workspace.md#les-règles) :

- **Aucun push sur `main` ni sur une branche protégée** (interdit 1).
- **Aucun force-push** (interdit 2).
- **Aucun merge de PR** (interdit 3).
- **Aucun `Approve` sur une PR** (interdit 4).

Ce que la revue ajoute — quatre motifs de refus, une grille :

- **Un CA non tenu bloque.** Le constat cite le critère, le fichier et la
  ligne : `playbook/execution.md:12`. Un CA sans preuve dans le diff ou un test
  est un refus ; une présomption ne vaut pas une preuve.
- **Chaque changement se rattache à la mission** : une ligne qui répare, une
  ligne qu'un CA ou un test exige, une ligne née de la règle du projet, ou le
  renommage sans effet. Un changement qui ne rentre dans aucune des quatre
  catégories est une dérive.
- **Une violation de règle bloque**, qu'elle vienne d'une règle du playbook ou
  d'un critère du ticket — on ne peut pas refuser une ligne sans nommer la
  règle.
- **Une preuve annoncée se retrouve** : un `npm test` vert ou un diff cité se
  rejoue ; une affirmation invérifiable est un refus.
- **Ce qu'une revue ne peut pas refuser** : une convention préexistante du
  dépôt, une règle « produit » entendue au cadrage mais absente de la fiche, une
  règle inventée à la lecture. La règle applicable est écrite ; le reste ne
  fonde pas un refus.
- **L'approbation est un verdict de mission**, pas une review de PR : elle pose
  `ready-for-prod` et s'arrête. Publier sur la PR et merger sont les gestes du
  demandeur (interdits 3, 4, 5).
- **Le refus est aussi une décision** : « à reprendre » renvoie en exécution
  avec la liste des constats, « retour cadrage » renvoie en `to-refine` quand la
  fiche elle-même est en cause.

## La fiche du dépôt

Les gates se rejouent sur la tête de branche ; la base est celle de
`missions/<dossier>/mission.yml`. Les cinq dépôts sans projet déclaré sont
marqués « non déclaré ».

| Dépôt | Gates à rejouer |
| --- | --- |
| `missions` | `npm test` (contrat, workflow, playbook) ; `node tools/check-workflows.mjs` ; `node tools/build.mjs` puis `git diff --exit-code lib/client.js` |
| `manager` | `yarn typescript` ; `yarn lint` ; `yarn test` (Cypress component) reste à la CI |
| `connect` | `APP_ENV=testing composer test:parallel` ; les tests existants ne portent pas de Given / When / Then |
| `clienthub` | `fvm flutter analyze` ; `fvm flutter test` borné |
| `backend` | `composer test:unit` et `composer test:functional` ciblés ; `composer phpstan:analyse`, `composer phpcs:analyse`, `composer phpmd:analyse` |
| `core-service` | `symfony php bin/phpunit` ; la base de test se prépare avec `test:db:setup` |
| `marketplace-service` | `php bin/phpunit <chemin>` (env `test`) ; `test:all` et `test:coverage` restent à la CI ; snapshots `tests/Schema/*.json` intacts |
| `ticketing-service` | `symfony php bin/phpunit` ; la base de test se prépare avec `test:db:setup` |
