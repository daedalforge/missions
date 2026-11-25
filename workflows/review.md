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
- **Chaque PR d'une mission découpée** : la liste `branches:` du `mission.yml`
  donne les paires ; `gh pr list --head <branche> --state all` retrouve la PR
  de chacune. La revue lit les PR une à une ; `ready-for-prod` n'est posé que
  si **chacune** est validée, et le refus nomme la PR qui manque. Une mission
  encore à une paire se lit exactement comme avant.
- **Chaque critère d'acceptation** contre le scénario qui le couvre : le test
  du scénario, le commentaire daté, la capture. Un critère sans scénario est un
  refus, et il renvoie au cadrage sans réclamer de test supplémentaire.
- **Le périmètre** : la PR ne contient que ce que le cadrage a décidé.
- **Les tests** : la suite s'exécute sur la tête de branche, scénario par
  scénario ; la revue ne compte pas les tests ajoutés.
- **Le journal et la checklist** : chaque étape et chaque case cochée annonce
  une preuve que l'on peut retrouver.

Un constat ne se transforme pas en relecture : refaire la revue du diff est le
geste de l'exécution, pas celui-ci.

## Quand la PR est trop grosse

Une PR trop grosse pour une revue sérieuse peut être découpée **à la revue**,
par le bouton « Split into several PRs » du volet : il n'est rendu qu'à
`in-review`, pour une mission à une paire, et il est désactivé quand la session
est bloquée. La session de découpe retrouve la PR, propose les bornes et les
fait confirmer ; elle crée les branches aux commits existants (aucun commit
nouveau, aucun force-push), ouvre une PR pour chaque partie précédente,
retargete la PR d'origine sur la partie précédente et écrit la liste
`branches:` par la route. La revue reprend ensuite sur chaque PR de la pile.

Découper n'est pas un geste de la revue : le demandeur confirme le découpage,
la revue constate seulement que la pile est ouverte.

## Décisions possibles

| Constat | Décision | Statut natif ou label |
| --- | --- | --- |
| Validation citée sur chaque PR, critères et scénarios complets, périmètre et tests vérifiés, journal et checklist à jour | La revue est faite : on enregistre et on passe le ticket | label `ready-for-prod` |
| Les collègues ont remonté des changements sur la PR | La revue renvoie en exécution : le demandeur pose le statut natif `In progress`, la session de remontées corrige sur la branche | statut natif `In progress` |
| La PR sort du périmètre du cadrage, ou un critère n'a pas de scénario | Le cadrage reprend la main : le demandeur pose le statut natif `Backlog`, la branche et la PR restent ouvertes | statut natif `Backlog` |

La décision retenue est écrite en commentaire daté dans le ticket, jamais
seulement dans la session. Le merge et la fermeture sont les gestes du
demandeur : la revue ne les fait pas.

## Condition de sortie

- [ ] La validation des collègues est citée (verdict et date) sur chaque PR,
      et une mission découpée nomme celle qui manque s'il en manque une.
- [ ] Chaque critère d'acceptation porte sa preuve contre le scénario qui le
      couvre, vérifié un à un.
- [ ] Le périmètre et les tests sont vérifiés sur la tête de branche.
- [ ] Le journal et la checklist sont à jour, chaque case avec sa preuve.
- [ ] La décision datée est écrite dans le ticket, le label `ready-for-prod`
      est posé et le statut natif reste `In review`.

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

# 3. Poser `ready-for-prod` : un label, pas un statut. L'état reste le statut
#    natif de l'issue (`In review`) ; la revue ne le déplace pas.
node tools/field.mjs state <KEY> ready-for-prod
```

`<KEY>` est la clé de la mission (`CFG-7`), l'outil est celui du dépôt
`missions` : il résout le tracker, vérifie le vocabulaire et crée le label au
premier usage. `gh issue edit --add-label` fonctionne aussi mais ne contrôle
rien et écrit à côté du vocabulaire déclaré.

La décision d'un retour est écrite de la même façon, puis le demandeur pose
le statut natif `In progress` (remontées) ou `Backlog` (hors périmètre). La
revue ne publie jamais d'avis GitHub (`gh pr review --approve`) et ne merge
pas : `in-review → ready-for-prod` est la colonne qu'un désaccord peut vider,
une décision repose sur les constats, pas sur la confiance.
