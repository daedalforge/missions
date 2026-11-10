# Le workflow

Un seul parcours, le même pour toutes les missions : **cadrage → exécution →
revue → clôture**. Ce qui change d'un projet à l'autre est le tracker, pas le
workflow.

```
  à cadrer ──▶ prête ──▶ en cours ──▶ en revue ──▶ terminée
      │           │          │            │
      │           │          │            └─ PR approuvée puis mergée
      │           │          └─ branche poussée, PR ouverte, tests verts
      │           └─ cadrage validé : périmètre, critères, plan
      └─ ticket créé, rien n'est encore décidé
```

## Les cinq états

La projection exacte, projet par projet, est déclarée dans
[`../missions/projects.yml`](../missions/projects.yml), bloc `map` ; le tableau
ci-dessous en donne la forme courante pour les deux trackers.

| État | Jira | GitHub |
|---|---|---|
| **à cadrer** | Backlog ou To Do | issue ouverte, label `to-refine` |
| **prête** | To Do | label `ready` |
| **en cours** | In Progress | label `in-progress`, branche poussée |
| **en revue** | In Review | label `in-review`, PR ouverte |
| **terminée** | Done | PR mergée, issue fermée |

Le tracker porte l'état. Rien dans le workspace ne le duplique : pas de fichier
de statut, pas de tableau local, pas de journal d'avancement.

Sur GitHub, le tracker se limite à la liste des issues : **pas de board GitHub
Projects**. Une mission est une issue, ses sous-étapes sont des critères
d'acceptation, et rien d'autre ne porte l'avancement. Une mission peut être
rattachée à un epic, qui est un milestone (voir
[`../missions/README.md`](../missions/README.md)).

## Les quatre étapes

| Étape | Entrée | Sortie | Page |
|---|---|---|---|
| Cadrage | ticket à cadrer | ticket **prête** : périmètre, critères, plan | [cadrage.md](cadrage.md) |
| Exécution | ticket prête | ticket **en revue** : branche, commits, PR | [execution.md](execution.md) |
| Revue | ticket en revue | décision : approuvé ou à reprendre | [review.md](review.md) |
| Clôture | ticket approuvé | ticket **terminée**, branche supprimée | [cloture.md](cloture.md) |

Une étape peut renvoyer à la précédente — un cadrage faux se refait, un diff hors
périmètre retourne en cadrage — mais jamais sauter une étape.

## Règles invariantes

1. **Une mission = un ticket = une branche = une PR.** Pas de branche fourre-tout,
   pas de PR qui règle deux missions.
2. **La clé du ticket préfixe tout.** Branche : clé en minuscules (`soc-1541`,
   `gh-12`). Commit : `<CLÉ>: <impératif>`. PR : la clé dans le titre.
3. **Un commit, un sujet.** Un commit qui mélange deux sujets se scinde avant la
   revue.
4. **Chaque critère d'acceptation porte sa preuve.** À la sortie de l'exécution
   et à la clôture, chaque critère est coché avec la commande, le test ou
   l'observation qui le démontre.
5. **Le périmètre ne s'élargit pas en cours de route.** Une idée hors périmètre
   devient un ticket, pas un commit supplémentaire.
6. **Le demandeur valide le cadrage.** Sans validation explicite, la mission
   reste à l'état « prête » ou « à cadrer ».
