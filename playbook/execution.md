# Exécution — de la branche à la PR

Jouer la mission : brancher, écrire, tester, pousser, ouvrir la PR.

`Entrée : ready → Sortie : in-review`. Document de l'étape :
[`workflows/execution.md`](../workflows/execution.md).

## Avant d'agir

- Vérifier le ticket : statut `ready` (ou déjà `in-progress`), branche et base
  déclarées dans `mission.yml`, fiche et CA lisibles.
- Vérifier le checkout : `git rev-parse --abbrev-ref HEAD` et `git status
  --short` — une autre session peut avoir changé de branche (MIS-163).
- Relire le journal et la checklist : le plan de commits y est déjà.

## Les gestes, dans l'ordre

1. **Créer la branche depuis la base**, pas depuis le HEAD courant :
   `git fetch origin && git switch -c <branche> origin/<base>`.
2. **Passer le ticket `in-progress`** une fois la branche poussée :
   `git push -u origin <branche>` puis
   `gh issue edit <n> -R <owner>/<repo> --add-label in-progress --remove-label ready`.
3. **Écrire par petits commits**, un sujet par commit, préfixés par la clé :
   `git commit -m "<CLÉ>: <impératif>"`.
4. **Vérifier** à chaque étape utile : `npm test`,
   `node tools/check-workflows.mjs` et, pour un changement de `lib/view.js`,
   `node tools/build.mjs` puis `git diff --exit-code lib/client.js`.
5. **Pousser** et **ouvrir la PR** vers la base, liée au ticket :
   `gh pr create --base <base> --head <branche> --title "<CLÉ>: <titre>" --body-file <corps>` ;
   le corps contient `Closes #<n>` et les preuves.
6. **Renseigner la PR** : assigné = soi, label `in-review`, même jalon que le
   ticket, pas de brouillon. Le type (`Feature`, `Bug`) est un champ du ticket :
   `gh pr view` ne l'expose pas pour une PR, ne pas le chercher.
7. **Mettre à jour** journal et checklist : chaque case avec sa preuve.
8. **Passer le ticket `in-review`** et **s'arrêter** :
   `gh issue edit <n> -R <owner>/<repo> --add-label in-review --remove-label in-progress`.
   Le merge est le geste du demandeur.

## Pièges observés

- `lib/client.js` est généré : l'éditer à la main est écrasé au build
  (`node tools/build.mjs`).
- Le prompt de session est épinglé caractère par caractère : toute ligne
  ajoutée casse `test/view.test.mjs` tant qu'il n'est pas mis à jour.
- Partir du HEAD courant au lieu de la base embarque les commits d'une autre
  mission dans la PR.
- `git push --force` et l'écriture sur `main` sont interdits, même pour
  « nettoyer » (interdits 1, 2).
- Un commit qui mélange deux sujets rend la revue et le revert impossibles.

## Preuve de sortie

- `npm test` vert, `node tools/check-workflows.mjs` vert, et
  `node tools/check-playbook.mjs` quand le playbook change.
- `git diff --exit-code lib/client.js` vide après `node tools/build.mjs`.
- La PR est ouverte vers la base, `Closes #<n>` dans le corps, labels type +
  `in-review`, jalon du ticket.
- Le ticket porte `in-review` et **aucun** autre label d'état.
- Journal et checklist portent leurs preuves datées.

## Les règles

Communs à toutes les étapes — les treize sont dans
[`workspace.md`](workspace.md#les-règles) :

- **Aucun push sur `main` ni sur une branche protégée** (interdit 1).
- **Aucun force-push** (interdit 2).
- **Aucun merge de PR** (interdit 3).
- **Aucun `Approve` sur une PR** (interdit 4).

Ce que l'exécution ajoute :

- **La langue** : identifiants, chaînes et messages d'erreur en anglais ;
  documentation, commits, journal et checklist en français. **Les noms de tests
  sont en français**, parce que le nom reste seul dans un rapport d'échec. Le
  code se lit avec son écosystème, la méthode se lit en français.
- **Un branchement s'écrit sur plusieurs lignes, entre accolades** : `if (x)
  return` se réécrit avec le corps à la ligne ; vaut pour `if`, `else if`,
  `else` et les boucles, quel que soit le langage. *Raison : la marge gauche
  doit montrer où sont les branches.*
- **Pas de commentaire**, sauf `// Given` / `// When` / `// Then` dans un test,
  le docblock dont l'analyse statique lit le typage, et la documentation que
  l'outillage publie pour une API publique. *Raison : rien ne vérifie un
  commentaire, il devient faux sans bruit.*
- **Une valeur choisie se nomme** : seuil, durée, taille par défaut, paramètre
  d'URL deviennent une constante nommée près de son usage ; restent en littéral
  `0`, `1`, `-1`. *Raison : un littéral ne dit ni d'où il vient ni pourquoi.*
- **Vérifier ce qui existe déjà** avant d'écrire local : espaces partagés,
  hooks, providers, composants du module ; une copie se justifie dans la PR.
- **Épuiser le langage, le framework et les dépendances déclarées** avant le
  code maison ; une dépendance nouvelle se justifie par son nom et ce qui
  manquait. *Bornes :* une dépendance seulement transitive ne compte pas.
- **Entre deux solutions équivalentes, garder celle qui crée le moins de
  fichiers** ; une rubrique qui exige un fichier ne se compte pas.
- **Le nom d'un test décrit le résultat attendu**, pas le sujet : dans un
  rapport d'échec, seul le nom reste.
- **Le corps d'un test suit Given / When / Then** : trois blocs commentés —
  contexte, action, assertions ; un test qui enchaîne plusieurs cycles se
  découpe.
- **Cypress** : sélection par `data-cy`, assertion sur un attribut dédié
  (`data-cy-value`), pas de `.find()` après un `data-cy` correct ; si
  l'attribut manque, il s'ajoute dans la même PR.
- **Un test de navigation monte la vraie vue** et lit une donnée qu'elle a
  chargée ; un stub n'est toléré que s'il contrôle l'URL émise.
- **La suite complète ne se lance depuis une session que si son coût est
  borné** : une suite qui compile, démarre des services ou sort des mégaoctets
  en échec appartient à la CI ; un lanceur qui ne rend que ses échecs est un
  gate de session, et la fiche du dépôt le dit.
- **Un commit = un sujet**, préfixé de la clé ; une idée hors critères devient
  un ticket, pas un commit de plus ; une correction découverte en route a sa
  mission, sauf si elle bloque l'exigence en cours.
- **Le périmètre est celui de la fiche** (interdit 6) ; un élargissement
  silencieux est un défaut de mission, et le périmètre qui change retourne au
  cadrage.
- **Pas de secret dans le workspace** (interdit 7), **pas d'accès Tolgee**
  (interdit 8), **aucune dérogation** (interdit 9), **aucune règle hors du
  playbook** (interdit 10), **PR sans draft** (interdit 11).

## La fiche du dépôt

La base n'est pas fixée ici : elle est déclarée dans
`missions/<dossier>/mission.yml`. Les cinq dépôts sans projet déclaré sont
marqués « non déclaré ». Les conventions produit complètes de `manager` et
`marketplace-service` ne sont pas recopiées : seuls les commandes, artefacts
générés et pièges que l'étape utilise figurent ici.

| Dépôt | Commandes | Gates et pièges |
| --- | --- | --- |
| `missions` | `npm test`, `node tools/build.mjs`, `node tools/check-workflows.mjs`, `node tools/check-playbook.mjs` | `lib/client.js` généré (diff vide après build) ; prompt épinglé au caractère près ; `node tools/check-playbook.mjs` quand le playbook change |
| `manager` | `yarn install`, `yarn typescript` (`tsc --noEmit`), `yarn lint` | `yarn test` (Cypress component) reste à la CI ; `.env` préparé depuis `.env.local.dist` ; `yarn.lock` ne bouge qu'avec une dépendance ; textes par le paquet `@tolgee/react`, jamais le CLI |
| `connect` | `composer install`, `APP_ENV=testing composer test:parallel` | les tests bornés de la fiche, avec `APP_ENV=testing` ; les tests existants ne portent pas de Given / When / Then, le code neuf suit la règle |
| `clienthub` | `fvm flutter pub get`, `fvm flutter analyze`, `fvm flutter test` | tests bornés ; SDK généré pour les appels d'API internes ; styles par les tokens du design system ; textes par le paquet `tolgee` |
| `backend` | `composer install`, `composer test:unit`, `composer test:functional`, `composer phpstan:analyse`, `composer phpcs:analyse`, `composer phpmd:analyse` | tests ciblés et analyseurs ; la suite complète reste à la CI |
| `core-service` | `symfony composer install`, `symfony composer test:db:setup`, `symfony php bin/phpunit`, `symfony composer test:db:drop` | base de test dédiée ; tests bornés de la fiche |
| `marketplace-service` | `composer install`, `composer test:db:setup`, `php bin/phpunit <chemin>` (env `test`), `composer test:db:drop` | `test:all` et `test:coverage` restent à la CI ; base `_test` ; les snapshots `tests/Schema/*.json` ne se régénèrent ni ne se committent ; une migration Casbin pose et retire chaque règle isolément |
| `ticketing-service` | `symfony composer install`, `symfony composer test:db:setup`, `symfony php bin/phpunit`, `symfony composer test:db:drop` | base de test dédiée ; tests bornés de la fiche |
