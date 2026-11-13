# Cadrage — de la demande à la mission

Transformer un ticket vague en mission exécutable, et s'arrêter là.

`Entrée : to-refine → Sortie : ready`. Document de l'étape :
[`workflows/cadrage.md`](../workflows/cadrage.md).

## Avant d'agir

- Relire `workflows/README.md` et `workflows/cadrage.md` ; le cadrage ne touche
  ni au dépôt du projet ni à ses branches (interdit 12).
- Lire le ticket au CLI, jamais sa page HTML (tronquée) :
  `gh issue view <n> -R <owner>/<repo> --json number,title,state,body,labels,milestone,assignees,comments`.
- Regarder le terrain : le dépôt, ses tests, ce que la demande suppose.

## Les gestes, dans l'ordre

1. **Lire le ticket** et ses commentaires (`... --json comments`). Le corps cité
   doit suffire ; s'il manque une information, la demander, ne pas la deviner.
2. **Décrire la mission** dans `missions/<dossier>/mission.yml` (clé, titre,
   dépôt, branche proposée, base, jalon) à partir de `missions/gabarit-mission.md`.
3. **Écrire la fiche** : proposition de valeur, périmètre, hors-périmètre,
   critères d'acceptation numérotés, risques. La publier sur le ticket avec
   `gh issue edit <n> -R <owner>/<repo> --body-file <chemin>`.
4. **Découper** si la demande tient en plusieurs missions : un ticket = une
   branche = une PR.
5. **Ouvrir le journal** `missions/<dossier>/journal.md` (décisions numérotées
   D1…, points ouverts) et la **checklist** (gestes puis critères).
6. **Proposer la branche et la base**, les faire valider par le demandeur.
7. **Passer en `ready`** :
   `gh issue edit <n> -R <owner>/<repo> --add-label ready --remove-label to-refine`.
8. **S'arrêter** : le cadrage ne crée pas la branche, ne commit pas, n'ouvre
   pas de PR.

## Pièges observés

- La page HTML d'un ticket est tronquée (~350 Ko pour 12 Ko utiles) : toujours
  `gh`, avec `-R`, depuis `~/projects` qui n'est pas un dépôt (MIS-119, MIS-122).
- Deux labels d'état à la fois cassent le graphe : l'invariant « un seul état »
  se vérifie à la pose du label.
- Le périmètre dérive si le cadrage exécute : un correctif écrit en cadrage est
  un geste d'exécution sans branche ni revue (interdit 12).
- `missions/*/` est ignoré par git : journal et checklist ne se commitent pas,
  ils restent dans le dossier du poste.

## Preuve de sortie

- Le ticket porte le label `ready` et **aucun** autre label d'état :
  `gh issue view <n> -R <owner>/<repo> --json labels`.
- Le corps du ticket porte la fiche publiable (périmètre, CA numérotés).
- `missions/<dossier>/mission.yml`, `journal.md` et `checklist.md` existent.
- La branche et la base proposées sont notées dans `mission.yml` et validées.

## Où lire les règles

- [`workflows/cadrage.md`](../workflows/cadrage.md) — l'étape que la page met
  en œuvre.
- [`standards/README.md`](../standards/README.md) — le contrat de lecture.
- [`standards/repos/missions.md`](../standards/repos/missions.md) — commandes et
  conventions du dépôt.
