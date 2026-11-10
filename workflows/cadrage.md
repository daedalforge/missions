# Cadrage

Transformer un ticket vague en mission exécutable. C'est l'étape qui coûte le
moins cher et qui évite le plus de travail perdu.

## Ce qu'on fait

1. **Lire le ticket** et son contexte : demandeur, projet, échéance s'il y en a.
   Le type (`bug` ou `story`) est posé avec le ticket ; s'il est faux, on le
   corrige ici, pas en cours d'exécution.
2. **Regarder le terrain** : le code concerné, les données, les tickets voisins.
   Le cadrage se fait avec le dépôt ouvert, pas de mémoire.
3. **Écrire la fiche** dans le tracker à partir de
   [`../missions/gabarit-mission.md`](../missions/gabarit-mission.md) : contexte,
   objectif, périmètre (dedans / dehors), critères d'acceptation, contraintes.
4. **Découper** si le travail dépasse une mission : plusieurs tickets, chacun avec
   son objectif propre. Un ticket trop gros revient en cadrage.
5. **Proposer un plan** : les étapes d'exécution, dans l'ordre, avec ce qui est
   vérifiable à chacune.

## Condition de sortie — la mission est « prête »

- [ ] L'objectif tient en une phrase à l'infinitif.
- [ ] Le périmètre dit explicitement ce qui est **dehors**.
- [ ] Chaque critère d'acceptation est vérifiable par une commande, un test ou une
      observation précise.
- [ ] Aucun critère ne dépend d'une décision non tranchée.
- [ ] Le plan d'exécution est écrit et tient en quelques étapes.
- [ ] Le demandeur a validé — explicitement, dans le ticket.

## Signaux d'arrêt

- Le ticket décrit une solution (« ajouter un bouton ») sans dire le problème :
  revenir au contexte avant d'écrire des critères.
- Deux objectifs indépendants dans le même ticket : découper.
- Un critère invérifiable (« l'interface doit être agréable ») : le transformer en
  observation concrète ou le retirer.
- Une dépendance externe non disponible : la nommer comme risque, ne pas la
  supposer résolue.

## Sur le tracker

| Geste | Jira | GitHub |
|---|---|---|
| Créer la fiche | nouvelle issue, description = gabarit | nouvelle issue, corps = gabarit |
| Passer à prête | statut To Do + label `prête` | label `ready` |
| Valider | commentaire de validation du demandeur | commentaire de validation, ou pouce levé explicite |
