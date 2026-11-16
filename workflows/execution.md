# Exécution

Produire le changement décrit par le cadrage, sans sortir du périmètre.

Une mission s'exécute sur la **branche déclarée** dans son dossier
`missions/<dossier>/mission.yml`, et sa PR vise la **base déclarée**. Sans les
deux, pas de session : le panneau refuse de l'ouvrir, et le dossier se crée au
cadrage (voir [`../missions/README.md`](../missions/README.md#branche-et-base)).

## Ce qu'on fait

1. **Ouvrir la branche** déclarée dans `missions/<dossier>/mission.yml`, depuis sa
   `base` déclarée. Par convention son nom est `<type>/<clé en minuscules>`
   (`feat/mis-41`, `fix/ex-1541`) ; c'est la valeur déclarée qui fait foi.
2. **Passer le ticket en cours** dans le tracker, une fois la branche poussée.
3. **Travailler par petits commits**, un sujet par commit, chacun préfixé de la
   clé : `EX-1541: referme l'accès au panneau`.
4. **Vérifier au fur et à mesure** : les tests du projet passent, le changement
   fait ce que le cadrage annonce.
5. **Ouvrir la PR** vers la `base` déclarée : titre préfixé de la clé,
   description qui dit ce que ça change et comment le vérifier.
6. **Faire relire le diff à l'aveugle** : une fois la PR renseignée, un
   sous-agent en contexte neuf lit le ticket et le diff, puis valide ou rend ses
   constats ; un refus renvoie aux correctifs, puis à une nouvelle relecture
   (voir [Revue interne à l'aveugle](#revue-interne-à-laveugle)).
7. **Tenir le journal** : ajouter la section du jour à
   `missions/<dossier>/journal.md` — ce qui a changé, les preuves, les écarts.
8. **Cocher la checklist** : à chaque point vérifié, cocher `- [x]` dans
   `missions/<dossier>/checklist.md` et y laisser la preuve
   (`— *test* : npm test`). Une case qui ne peut pas être cochée devient une
   suite nommée, jamais un silence.

## Condition de sortie — la mission est « en revue »

- [ ] La branche déclarée est poussée (par convention, nommée d'après la clé).
- [ ] La PR cible la base déclarée dans le dossier de la mission.
- [ ] Les commits sont préfixés de la clé, un sujet par commit.
- [ ] Les tests du projet passent (ou l'absence de tests est justifiée dans la PR).
- [ ] La PR est ouverte, liée au ticket.
- [ ] Chaque critère d'acceptation porte sa preuve dans la description de la PR :
      le scénario qui le couvre, son test, sa capture ou son commentaire daté.
- [ ] La revue interne à l'aveugle est validée, et son verdict est consigné au journal.
- [ ] Le journal porte la section d'exécution (changements, preuves, écarts).
- [ ] La checklist est à jour : chaque case cochée porte sa preuve, les cases ouvertes sont nommées.

## Renseigner la PR

Une PR n'est pas qu'un diff : elle doit se retrouver dans une liste et se relier
à son issue sans qu'on ouvre le code.

- **Assignée** à la personne qui l'a ouverte.
- **Typée** comme son issue : `bug` ou `story`, jamais les deux.
- **Sans `in-review` avant le verdict** : l'étiquette ne se pose qu'une fois la
  revue interne validée, comme sur l'issue qu'elle sert.
- **Liée** : `Closes #N` quand elle termine la mission, `Réf. #N` quand elle
  n'en fait qu'une partie. Seul le mot-clé de fermeture remplit la section
  **Development** de l'issue ; un `Réf. #N` ne crée qu'une référence croisée,
  visible dans la chronologie, pas dans Development. Une PR partielle n'y
  apparaît donc pas : c'est attendu, pas un oubli.
- **Même milestone** que l'issue quand elle en a un — c'est l'epic de la
  mission. On ne crée pas de milestone pour l'occasion : sans epic, la PR n'en
  porte pas.

## Revue interne à l'aveugle

La PR renseignée, le diff se relit à froid avant de passer en revue : c'est la
condition de sortie, pas un geste de confort.

- **Qui relit.** Un sous-agent en contexte neuf, briefé avec le ticket et le
  diff seulement — sans le journal, la checklist ni l'historique de la session,
  qui racontent ce que l'exécution a cru faire.
- **Ce qu'il lit.** Le ticket au CLI
  (`gh issue view <n> -R <owner>/<repo> --json number,title,body,...`) et le
  diff de la PR (`gh pr diff <n> -R <owner>/<repo>`), avec les critères
  d'acceptation.
- **Ce qu'il rend.** « Validé », ou les constats : pour chacun, le critère visé
  et la preuve manquante. Le verdict et les constats s'écrivent au journal et à
  la checklist ; aucune revue ni aucun commentaire ne se publie sur la PR — la
  publication reste le geste du demandeur.
- **Les deux issues.** Validé : le ticket passe en `in-review`, la PR avec lui.
  Refusé : la session corrige sur la branche, pousse, et fait relire — sans
  borne de passages, jusqu'à validation. Un constat qui sort du périmètre
  renvoie au cadrage.

## Règles de conduite

- **Un seul sujet.** Une idée qui n'est pas dans les critères devient un ticket,
  pas un commit de plus.
- **Un scénario, un `it`.** Chaque scénario principal de la fiche donne un `it`
  unique, nommé en français, avec plusieurs assertions ; un test par critère
  d'acceptation est exclu. Les variantes de forme et cas limites sans effet
  observable ne s'écrivent pas en test ; un défaut constaté garde son test de
  régression.
- **Pas de mélange de forme et de fond** dans un même commit : un reformatage se
  fait à part, ou pas du tout.
- **Le périmètre change ?** Retour au cadrage : mettre à jour la fiche, faire
  revalider, puis reprendre. Un élargissement silencieux est un défaut de mission.
- **Bloqué ?** Le dire dans le ticket le jour où ça arrive, avec ce qui bloque et
  ce qu'il faudrait pour débloquer.

## Sur le tracker

| Geste | Jira | GitHub |
|---|---|---|
| Passer en cours | statut In Progress | label `in-progress` |
| Ouvrir la revue | statut In Review, lien vers la PR | PR ouverte avec `Closes #<numéro>`, revue interne validée |
