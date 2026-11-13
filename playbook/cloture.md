# Clôture — de la PR mergée au dossier fermé

Constate et archive ; ne merge pas, ne ferme pas.

`Entrée : ready-for-prod → Sortie : done`. Document de l'étape :
[`workflows/cloture.md`](../workflows/cloture.md).

## Avant d'agir

- La session **prépare** la clôture et s'arrête : le merge, la fermeture du
  ticket et la suppression de la branche sont les gestes du demandeur.
- Attendre son mot explicite avant de constater quoi que ce soit.
- Vérifier que la revue a bien laissé `ready-for-prod` sur le ticket.

## Les gestes, dans l'ordre

1. **Vérifier l'état** :
   `gh pr view <n> -R <owner>/<repo> --json state,merged,mergedAt,mergeCommit`
   et `gh issue view <n> -R <owner>/<repo> --json state`.
2. **Constater le merge** : lier le commit de merge, la date et la PR dans le
   journal.
3. **Vérifier la fin de branche** : `git branch -a` et
   `git ls-remote --heads origin <branche>` — c'est le demandeur qui supprime,
   pas la session.
4. **Fermer le journal** : décision finale, liens (PR, merge), points ouverts
   restants nommés.
5. **Solder la checklist** : chaque case cochée avec sa preuve, chaque case non
   faite avec sa raison et une suite nommée.
6. **S'arrêter** : aucune écriture sur le tracker, aucune suppression de
   branche, aucun merge.

## Pièges observés

- « Close the local checkout » est un geste du panneau, pas de la session : ne
  pas supprimer le worktree soi-même.
- Merger parce que le demandeur le demande reste interdit : le garde-fou prime
  sur la demande (interdit 3).
- Fermer un ticket dont la PR n'est pas mergée laisse une mission « done » sans
  code : constater, pas anticiper.
- Une session interrompue avant le merge laisse le ticket en `ready-for-prod` :
  c'est l'état attendu, pas une erreur.

## Preuve de sortie

- La PR est mergée par le demandeur (commit de merge lié dans le journal).
- Le ticket est fermé et son corps renvoie à la PR.
- La branche distante n'existe plus, et c'est le demandeur qui l'a supprimée.
- Le journal porte la clôture datée ; la checklist est soldée (faite ou suite
  nommée).

## Les règles

Communs à toutes les étapes — les treize sont dans
[`workspace.md`](workspace.md#les-règles) :

- **Aucun push sur `main` ni sur une branche protégée** (interdit 1).
- **Aucun force-push** (interdit 2).
- **Aucun merge de PR** (interdit 3).
- **Aucun `Approve` sur une PR** (interdit 4).

Ce que la clôture ajoute :

- **Le merge, la fermeture du ticket et la suppression de branche sont les
  gestes du demandeur**, même s'il les demande par écrit : la session constate
  et le dit (interdit 3).
- **On constate, on n'anticipe pas** : un ticket dont la PR n'est pas mergée
  reste ouvert ; le journal note l'attente au lieu de la contourner.
- **Le dossier local ne se ferme pas** : supprimer un worktree ou un dossier
  `missions/<dossier>/` est un geste du panneau.
- **Une dérogation est écrite et consignée**, et le treizième interdit n'en
  admet aucune ; la clôture ne crée pas de règle nouvelle (interdits 9, 10).
- **Aucune écriture sur le tracker** pour obtenir un état : on lit l'état réel,
  on ne le fabrique pas.
- **Journal et checklist soldés** : une case sans preuve n'est pas cochée, une
  case sans suite n'est pas close.
- **Rien hors de `~/projects`** (interdit 13), **aucun secret** (interdit 7).

## La fiche du dépôt

La base et la branche sont celles de `missions/<dossier>/mission.yml` ; la
clôture ne les crée ni ne les supprime. Les cinq dépôts sans projet déclaré
sont marqués « non déclaré ».

| Dépôt | Ce que la clôture constate |
| --- | --- |
| `missions` | PR mergée par le demandeur, ticket fermé par `Closes #N`, branche distante supprimée |
| `manager` | PR mergée, ticket Jira passé en `Released` par le demandeur, branche supprimée |
| `connect` | PR mergée, ticket Jira passé en `Released` par le demandeur, branche supprimée |
| `clienthub` | non déclaré : merge et fermeture restent au demandeur, sans tracker déclaré |
| `backend` | non déclaré : merge et fermeture restent au demandeur |
| `core-service` | non déclaré : merge et fermeture restent au demandeur |
| `marketplace-service` | non déclaré : merge et fermeture restent au demandeur |
| `ticketing-service` | non déclaré : merge et fermeture restent au demandeur |
