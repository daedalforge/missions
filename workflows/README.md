# Le workflow

Un seul parcours, le même pour toutes les missions : **cadrage → exécution →
revue → clôture**. Ce qui change d'un projet à l'autre est le tracker, pas le
workflow.

Une session joue une seule étape : elle s'arrête à sa sortie, et l'étape suivante
se joue dans une nouvelle session. Le prompt du panneau nomme l'étape du statut
courant, et le bouton qui l'ouvre la nomme aussi.

Une session ne porte pas les règles dans son prompt : elle lit les standards de
son étape, que le prompt nomme (le [contrat de
lecture](../standards/README.md#le-contrat-de-lecture) dit lesquels, étape par
étape, et la fiche du dépôt suit le projet de la mission).
`node tools/check-standards.mjs` vérifie que l'index, les fichiers présents et
les prompts disent la même chose.

```
  à cadrer ──▶ prête ──▶ en cours ──▶ en revue ──▶ prête à partir ──▶ terminée
      │           │          │            │              │
      │           │          │            │              └─ livrée : merge, issue fermée
      │           │          │            └─ PR approuvée
      │           │          └─ branche poussée, PR ouverte, tests verts
      │           └─ cadrage validé : périmètre, critères, plan
      └─ ticket créé, rien n'est encore décidé
```

## Les six états

La projection exacte, projet par projet, est déclarée dans
[`../missions/projects.yml`](../missions/projects.yml), bloc `map` ; le tableau
ci-dessous en donne la forme courante pour les deux trackers.

| État | Jira | GitHub |
|---|---|---|
| **à cadrer** | Backlog ou To Do | issue ouverte, label `to-refine` |
| **prête** | To Do | label `ready` |
| **en cours** | In Progress | label `in-progress`, branche poussée |
| **en revue** | In Review | label `in-review`, PR ouverte |
| **prête à partir** | `Ready for prod` (Manager : `Local Testing`, `Staging Test`) | label `ready-for-prod` |
| **terminée** | `Released` (Manager), `Done` (Connect) | PR mergée, issue fermée |

L'état **prête à partir** est posé par la revue, pas par l'exécution : la PR est
approuvée, la mission n'est pas encore livrée. Sur Jira, plusieurs statuts
peuvent y mener selon le projet — Manager y range ses trois temps de
déploiement, Connect son unique `Ready for prod` ; `Released` et `Done` restent
« terminée ».

Le tracker porte l'état. Rien dans le workspace ne le duplique : pas de fichier
de statut, pas de tableau local, pas de journal d'avancement. Le journal de
mission, lui, garde le récit de la session — ce qui a été lu, décidé et prouvé —
jamais l'état, qui reste celui du ticket (voir
[`../missions/README.md`](../missions/README.md#journal-de-mission)). La
checklist de mission garde, elle, les gestes à exécuter et leurs preuves (voir
[`../missions/README.md`](../missions/README.md#checklist-de-mission)).

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
| Revue | ticket en revue | décision : approuvé (ticket **prêt à partir**) ou à reprendre | [review.md](review.md) |
| Clôture | ticket prêt à partir | ticket **terminée** par le demandeur : merge, ticket fermé, branche supprimée ; journal et checklist soldés par la session | [cloture.md](cloture.md) |

Une étape peut renvoyer à la précédente — un cadrage faux se refait, un diff hors
périmètre retourne en cadrage — mais jamais sauter une étape.

## Règles invariantes

1. **Une mission = un ticket = une branche = une PR.** Pas de branche fourre-tout,
   pas de PR qui règle deux missions.
2. **La clé du ticket nomme tout.** Branche : `<type>/<clé en minuscules>`
   (`feat/mis-12`, `fix/soc-1541`). Commit : `<CLÉ>: <impératif>`. PR : la clé
   dans le titre.
3. **Un commit, un sujet.** Un commit qui mélange deux sujets se scinde avant la
   revue.
4. **Chaque critère d'acceptation porte sa preuve.** À la sortie de l'exécution
   et à la clôture, chaque critère est coché avec la commande, le test ou
   l'observation qui le démontre.
5. **Le périmètre ne s'élargit pas en cours de route.** Une idée hors périmètre
   devient un ticket, pas un commit supplémentaire.
6. **Le demandeur valide le cadrage.** Sans validation explicite, la mission
   reste à l'état « prête » ou « à cadrer ».
7. **Un seul état par mission.** Une issue porte exactement un libellé d'état.
   Plusieurs laissent l'état indéterminé et bloquent le passage à l'étape
   suivante : on retire l'ancien libellé en posant le nouveau.
8. **La session lit les standards de son étape.** Le prompt les nomme par
   chemin ; une règle qu'elle doit suivre vit dans `standards/`, jamais dans un
   document local ou hors du dépôt.

## Le modèle éditable

Chaque étape a son modèle dans `workflows/model/<étape>.yml` : les gestes de ses
sections, les arcs qui les enchaînent, l'état d'entrée et les états de sortie.
Le panneau les dessine et les édite dans son onglet **Workflows** ; le format et
ses règles sont décrits dans `workflows/model/README.md`.

Le document `.md` reste la référence : le modèle en est la vue éditable, et
`node tools/check-workflows.mjs` signale, étape par étape, une section du
document restée sans geste (ou un geste qui n'ancre aucune section). Une
divergence n'est jamais réparée d'office — c'est au rédacteur de trancher.
