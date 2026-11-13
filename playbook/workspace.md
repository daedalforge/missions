# Workspace — les gestes transverses

Ce qui ne dépend pas d'une étape : quel checkout, quel dépôt, quels gestes sont
permis. La session libre et celle des remontées de PR lisent cette page.

## Avant d'agir

- Se placer : `pwd` doit être sous `~/projects` ; jamais `/`, jamais hors du
  workspace (interdit 13).
- Choisir le checkout : `git worktree list` — le dépôt `missions` peut être sur
  la branche d'une autre session (MIS-163).
- Lire `AGENTS.md` du workspace, puis, dans le dépôt, `standards/repos/<projet>.md`.

## Les gestes, dans l'ordre

1. **Travailler dans un worktree dédié** quand une autre session tient le
   checkout principal :
   `git worktree add <chemin> -b <branche> origin/<base>`.
2. **Vérifier la branche avant tout commit** :
   `git rev-parse --abbrev-ref HEAD` et `git status --short`.
3. **Lire le ticket au CLI**, avec `-R` : `~/projects` n'est pas un dépôt, `gh`
   ne peut pas deviner le dépôt.
4. **Un ticket = une branche = une PR** : ne pas réutiliser la branche d'une
   autre mission.
5. **Écrire les métadonnées** de la PR : assigné, type, label d'état, jalon —
   les mêmes que le ticket.
6. **Tenir le journal et la checklist** dans `missions/<dossier>/` : ils sont
   ignorés par git et restent sur le poste.
7. **S'arrêter au bon moment** : merge, fermeture, suppression de branche sont
   des gestes du demandeur.

## Pièges observés

- Le checkout principal change de branche sous les pieds : vérifier `HEAD`
  avant chaque commit (MIS-163).
- `gh` sans `-R` échoue depuis `~/projects` : `fatal: not a git repository`.
- `missions/*/` est ignoré : un journal commité n'arrive jamais dans la PR.
- `lib/client.js` est généré : relancer `node tools/build.mjs` après tout
  changement de `lib/view.js` ou du template.
- Le prompt de session est épinglé : toute ligne ajoutée exige de mettre à jour
  `test/view.test.mjs`.

## Preuve de sortie

- Le checkout utilisé est nommé (`git worktree list`), sur la bonne branche.
- La branche est poussée, la PR liée au ticket par `Closes #N`.
- Le journal et la checklist sont à jour, avec leurs preuves.
- Aucune écriture sur `main`, aucun merge, aucune suppression de branche.

## Où lire les règles

- [`workflows/README.md`](../workflows/README.md) — la chaîne et ses invariants.
- [`standards/interdits.md`](../standards/interdits.md) — ce qui n'est jamais
  permis.
- [`standards/code.md`](../standards/code.md) — conventions de code.
- [`standards/repos/missions.md`](../standards/repos/missions.md) — commandes
  et pièges du dépôt.
