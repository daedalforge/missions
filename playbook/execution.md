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

## Où lire les règles

- [`workflows/execution.md`](../workflows/execution.md) — l'étape que la page
  met en œuvre.
- [`standards/code.md`](../standards/code.md) — conventions de code et de test.
- [`standards/interdits.md`](../standards/interdits.md) — merge, force-push et
  écriture `main` interdits.
- [`standards/repos/missions.md`](../standards/repos/missions.md) — commandes
  du dépôt.
