# Revue — de la validation au label

L'exécution a construit la branche et la PR ; les collègues ont relu le diff ;
la revue constate leur validation, l'enregistre dans le ticket et pose le
label. Le diff n'est pas relu ici : il l'a été à l'aveugle en exécution.

`Entrée : in-review → Sortie : ready-for-prod`.

Document de l'étape : [`playbook/revue.md`](../playbook/revue.md) — à lire
avant d'agir.

## Ce qu'on constate

- **La validation des collègues**, sur la PR :
  `gh pr view <n> --json reviewDecision,reviews,comments`. Un `reviewDecision`
  vide n'est pas une absence de validation : une approbation explicite en
  commentaire compte, citée avec son verdict et sa date.
- **Chaque critère d'acceptation** avec sa preuve : le test, le commentaire
  daté, le fichier. Un critère sans preuve est un refus.
- **Le périmètre** : la PR ne contient que ce que le cadrage a décidé.
- **Les tests** : la suite s'exécute sur la tête de branche, et le compte des
  tests ajoutés est noté.
- **Le journal et la checklist** : chaque étape et chaque case cochée annonce
  une preuve que l'on peut retrouver.

Un constat ne se transforme pas en relecture : refaire la revue du diff est le
geste de l'exécution, pas celui-ci.

## Décisions possibles

| Constat | Décision | Label |
| --- | --- | --- |
| Validation citée, critères et preuves complets, périmètre et tests vérifiés, journal et checklist à jour | La revue est faite : on enregistre et on passe le ticket | `ready-for-prod` |
| Les collègues ont remonté des changements sur la PR | La revue renvoie en exécution : le demandeur pose le label, la session de remontées corrige sur la branche | `in-progress` |
| La PR sort du périmètre du cadrage | Le cadrage reprend la main : le demandeur pose le label, la branche et la PR restent ouvertes | `to-refine` |

La décision retenue est écrite en commentaire daté dans le ticket, jamais
seulement dans la session. Le merge et la fermeture sont les gestes du
demandeur : la revue ne les fait pas.

## Condition de sortie

- [ ] La validation des collègues est citée (verdict et date) sur la PR.
- [ ] Chaque critère d'acceptation porte sa preuve, vérifiée une à une.
- [ ] Le périmètre et les tests sont vérifiés sur la tête de branche.
- [ ] Le journal et la checklist sont à jour, chaque case avec sa preuve.
- [ ] La décision datée est écrite dans le ticket et le label d'état est posé.

## Ce qui n'est pas un motif de refus

- **Le style** : une préférence de forme ne bloque pas une PR conforme.
- **Le goût** : un choix défendable, documenté au cadrage, ne se rejuge pas ici.
- **Une amélioration hors fiche** : elle se propose pour un autre ticket, elle
  ne retarde pas celui-ci.
- **Une demande de meilleure formulation** : elle se note en suggestion, sans
  refuser la validation.

## Sur le tracker

```bash
# 1. Lire la validation des collègues, et les commentaires qui l'accompagnent.
gh pr view <n> -R <owner>/<repo> --json reviewDecision,reviews,comments

# 2. Écrire la décision datée dans le ticket, avec la preuve de chaque critère.
gh issue comment <n> -R <owner>/<repo> --body "Décision du <date> : ..."

# 3. Poser le label de la décision (retirer l'ancien état).
gh issue edit <n> -R <owner>/<repo> --add-label ready-for-prod --remove-label in-review
```

La décision d'un retour est écrite de la même façon, puis le demandeur pose
`in-progress` (remontées) ou `to-refine` (hors périmètre). La revue ne publie
jamais d'avis GitHub (`gh pr review --approve`) et ne merge pas : `in-review →
ready-for-prod` est la colonne qu'un désaccord peut vider, une décision repose
sur les constats, pas sur la confiance.
