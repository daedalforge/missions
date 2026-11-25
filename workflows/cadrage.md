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
   La fiche nomme 2 à 4 scénarios principaux en Given/When/Then, et chaque
   critère d'acceptation désigne le scénario qui le prouve : un critère sans
   scénario bloque le cadrage.
4. **Découper** si le travail dépasse une mission : plusieurs tickets, chacun avec
   son objectif propre. Un ticket trop gros revient en cadrage.
5. **Proposer un plan** : les étapes d'exécution, dans l'ordre, avec ce qui est
   vérifiable à chacune.
6. **Estimer les points** une fois le plan posé, avant de déclarer la branche :
   la route de l'hôte (`POST missions/api/points`) pose la taille sur le ticket
   avec la valeur native du projet, et retire les autres tailles de la famille.
   L'échelle est `1, 2, 3, 5, 8, 13` ; une autre valeur, une clé inconnue ou un
   projet sans forme native sont refusés avant le tracker, avec leur message.
   Relire le ticket : une seule taille, celle que le volet montrera. L'échelle et
   la forme native sont dans
   [`../missions/README.md`](../missions/README.md#correspondance-avec-le-tracker),
   la commande et la lecture d'un refus dans le playbook du cadrage.
7. **Déclarer la branche et sa base** — directement dans le volet de détail du
   panneau (champs « Branch » et « Base », bouton « Save »), ou à la main dans
   `missions/<dossier>/mission.yml` (format dans
   [`../missions/README.md`](../missions/README.md#branche-et-base)) : c'est ce
   qui autorise la session d'exécution. Le panneau crée le dossier de la
   mission s'il manque ; le fichier reste local (ignoré par git), il n'est
   jamais commité.
8. **Ouvrir le journal de mission** dans `missions/<dossier>/journal.md` : la
   demande verbatim, les lectures, l'état relevé, les hypothèses et les points
   ouverts (forme dans
   [`../missions/README.md`](../missions/README.md#journal-de-mission)).
9. **Ouvrir la checklist de mission** dans `missions/<dossier>/checklist.md` :
   un geste vérifiable par point du plan, avec la preuve attendue (forme dans
   [`../missions/README.md`](../missions/README.md#checklist-de-mission)).

## Condition de sortie — la mission est « prête »

- [ ] L'objectif tient en une phrase à l'infinitif.
- [ ] Le périmètre dit explicitement ce qui est **dehors**.
- [ ] Chaque critère d'acceptation est vérifiable par une commande, un test ou une
      observation précise, et désigne le scénario qui le prouve ; la fiche nomme
      2 à 4 scénarios principaux.
- [ ] Aucun critère ne dépend d'une décision non tranchée.
- [ ] Le plan d'exécution est écrit et tient en quelques étapes.
- [ ] La branche et sa base sont déclarées dans `missions/<dossier>/mission.yml`.
- [ ] Le journal est ouvert dans le dossier (demande, lectures, hypothèses, plan).
- [ ] La checklist est ouverte : un geste vérifiable par point, avec sa preuve attendue.
- [ ] L'estimation est posée sur le ticket : une seule taille de `1, 2, 3, 5, 8, 13`,
      relue sur la fiche.
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
| Poser les points | champ `story_points_field` du projet | champ `Story point` |
| Passer à prête | statut To Do + label `prête` | statut natif `Todo` |
| Valider | commentaire de validation du demandeur | commentaire de validation, ou pouce levé explicite |
