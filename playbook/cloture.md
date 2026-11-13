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

## Où lire les règles

- [`workflows/cloture.md`](../workflows/cloture.md) — l'étape que la page met
  en œuvre.
- [`standards/interdits.md`](../standards/interdits.md) — merge et écriture
  `main` interdits.
- [`standards/revue.md`](../standards/revue.md) — la décision qui a mené à
  `ready-for-prod`.
