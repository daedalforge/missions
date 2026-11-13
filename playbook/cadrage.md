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
2. **Décrire la mission** dans `missions/<dossier>/mission.yml` — trois champs
   seulement, `key`, `branch` et `base` ; le titre, le dépôt et le jalon sont
   des métadonnées du ticket, décrites par `missions/gabarit-mission.md`.
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

## Les règles

Communs à toutes les étapes — les treize sont dans
[`workspace.md`](workspace.md#les-règles) :

- **Aucun push sur `main` ni sur une branche protégée** (interdit 1).
- **Aucun force-push** (interdit 2).
- **Aucun merge de PR** (interdit 3).
- **Aucun `Approve` sur une PR** (interdit 4).

Ce que le cadrage ajoute :

- **Aucune exécution pendant le cadrage** (interdit 12) : ni branche, ni commit,
  ni PR tant que le ticket est `to-refine`. Le cadrage lit, décrit, négocie —
  il ne corrige pas.
- **Le ticket se lit au CLI**, jamais sa page HTML : une page `github.com` pèse
  ~350 Ko et se fait tronquer, un corps partiel se travaille sans qu'on le
  sache.
- **La fiche suit le gabarit** : proposition de valeur, périmètre,
  hors-périmètre, critères d'acceptation numérotés et observables, risques. Un
  CA qui ne se vérifie pas n'est pas un CA.
- **Un ticket = une branche = une PR** : une demande qui ne tient pas dans une
  PR se découpe en plusieurs tickets.
- **La branche et la base sont déclarées** dans `missions/<dossier>/mission.yml`
  et validées par le demandeur avant `ready` ; aucune branche n'est créée ici.
- **Un seul label d'état** : `ready` remplace `to-refine`, et l'invariant se
  vérifie à la pose.
- **Le cadrage n'écrit pas dans le dépôt** (interdit 6) : `missions/*/` reste
  ignoré par git, rien ne part dans la branche.
- **Rien hors de `~/projects`** (interdit 13), **aucun secret** (interdit 7).

## La fiche du dépôt

La base n'est pas fixée ici : elle est déclarée dans
`missions/<dossier>/mission.yml`. Les cinq dépôts sans projet déclaré sont
marqués « non déclaré » ; le cadrage n'en promet ni branche ni revue sans le
dire dans les risques.

| Dépôt | Ce que le cadrage en lit | Tracker |
| --- | --- | --- |
| `missions` | `AGENTS.md`, `playbook/`, `workflows/`, `test/`, le gabarit de mission | GitHub (`daedalforge/missions`) |
| `manager` | `README.md`, `package.json`, `tsconfig`, `cypress/`, le design system | Jira (`saas-office.atlassian.net`, SO) |
| `connect` | `README.md`, `composer.json`, `tests/`, `assets/` | Jira (`saas-office.atlassian.net`, SOC) |
| `clienthub` | non déclaré ; Flutter, `pubspec.yaml`, `test/` | non déclaré |
| `backend` | non déclaré ; PHP, API Platform, `tests/` | non déclaré |
| `core-service` | non déclaré ; Symfony, `tests/` | non déclaré |
| `marketplace-service` | non déclaré ; Symfony 7.4, API Platform 4, `tests/` | non déclaré |
| `ticketing-service` | non déclaré ; Symfony, `tests/` | non déclaré |
