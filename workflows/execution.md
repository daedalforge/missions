# Exécution

Produire le changement décrit par le cadrage, sans sortir du périmètre.

## Ce qu'on fait

1. **Ouvrir la branche** depuis la branche principale du projet, nommée d'après la
   clé du ticket (`soc-1541`, `gh-12`).
2. **Passer le ticket en cours** dans le tracker, une fois la branche poussée.
3. **Travailler par petits commits**, un sujet par commit, chacun préfixé de la
   clé : `SOC-1541: referme l'accès au panneau`.
4. **Vérifier au fur et à mesure** : les tests du projet passent, le changement
   fait ce que le cadrage annonce.
5. **Ouvrir la PR** vers la branche principale : titre préfixé de la clé,
   description qui dit ce que ça change et comment le vérifier.

## Condition de sortie — la mission est « en revue »

- [ ] La branche est poussée et nommée d'après la clé.
- [ ] Les commits sont préfixés de la clé, un sujet par commit.
- [ ] Les tests du projet passent (ou l'absence de tests est justifiée dans la PR).
- [ ] La PR est ouverte, liée au ticket.
- [ ] Chaque critère d'acceptation porte sa preuve dans la description de la PR.

## Renseigner la PR

Une PR n'est pas qu'un diff : elle doit se retrouver dans une liste et se relier
à son issue sans qu'on ouvre le code.

- **Assignée** à la personne qui l'a ouverte.
- **Typée** comme son issue : `bug` ou `story`, jamais les deux.
- **Étiquetée `in-review`**, comme l'issue qu'elle sert.
- **Liée** : `Closes #N` quand elle termine la mission, `Réf. #N` quand elle
  n'en fait qu'une partie. GitHub relie alors la PR à l'issue.
- **Même milestone** que l'issue quand elle en a un — c'est l'epic de la
  mission. On ne crée pas de milestone pour l'occasion : sans epic, la PR n'en
  porte pas.

## Règles de conduite

- **Un seul sujet.** Une idée qui n'est pas dans les critères devient un ticket,
  pas un commit de plus.
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
| Ouvrir la revue | statut In Review, lien vers la PR | PR ouverte avec `Closes #<numéro>` |
