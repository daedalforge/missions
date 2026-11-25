# Le workflow

Un seul parcours, le même pour toutes les missions : **cadrage → exécution →
revue → clôture**. Ce qui change d'un projet à l'autre est le tracker, pas le
workflow.

Une session joue une seule étape : elle s'arrête à sa sortie, et l'étape suivante
se joue dans une nouvelle session. Le prompt du panneau nomme l'étape du statut
courant, et le bouton qui l'ouvre la nomme aussi.

```
  à cadrer ──▶ prête ──▶ en cours ──▶ en revue ──▶ prête à partir ──▶ terminée
      │           │          │            │              │
      │           │          │            │              └─ livrée : merge, issue fermée
      │           │          │            └─ PR approuvée
      │           │          └─ branche poussée, PR ouverte, tests verts, revue interne validée
      │           └─ cadrage validé : périmètre, critères, plan
      └─ ticket créé, rien n'est encore décidé
```

## Les six états

La projection exacte, projet par projet, est déclarée dans
la copie locale de `missions/projects.yml` (gabarit
[`../missions/projects.example.yml`](../missions/projects.example.yml)), bloc `map` ; le tableau
ci-dessous en donne la forme courante pour les deux trackers.

| État | Jira | GitHub |
|---|---|---|
| **à cadrer** | Backlog ou To Do | issue ouverte, champ `Workflow stage` = `To refine` |
| **prête** | To Do | champ `Workflow stage` = `Ready` |
| **en cours** | In Progress | champ `Workflow stage` = `In progress`, branche poussée |
| **en revue** | In Review | champ `Workflow stage` = `In review`, PR ouverte |
| **prête à partir** | `Ready for prod` (Alpha : `Local Testing`, `Staging Test`) | champ `Workflow stage` = `Ready for prod` |
| **terminée** | `Released` (Alpha), `Done` (Beta) | PR mergée, issue fermée |

Sur GitHub, l'état, la priorité et l'estimation sont des **champs
d'organisation** (`Workflow stage`, `Priority`, `Story point`) déclarés par le
bloc `fields` du tracker ; `blocked` est le seul label que la board garde.

L'état **prête à partir** est posé par la revue, pas par l'exécution : la PR est
approuvée, la mission n'est pas encore livrée. Sur Jira, plusieurs statuts
peuvent y mener selon le projet — Alpha y range ses trois temps de
déploiement, Beta son unique `Ready for prod` ; `Released` et `Done` restent
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
| Exécution | ticket prête | ticket **en revue** : branche, commits, PR, revue interne validée | [execution.md](execution.md) |
| Revue | ticket en revue | validation des collègues constatée : ticket **prêt à partir**, ou retour en exécution / au cadrage | [review.md](review.md) |
| Clôture | ticket prêt à partir | ticket **terminée** par le demandeur : merge, ticket fermé, branche supprimée ; journal et checklist soldés par la session | [cloture.md](cloture.md) |

Une étape peut renvoyer à la précédente — un cadrage faux se refait, un diff hors
périmètre retourne en cadrage — mais jamais sauter une étape. La revue est la
seule à pouvoir découper une PR trop grosse en plusieurs PR empilées : le geste
« Split into several PRs » du volet ouvre la session qui écrit la liste des
paires et ouvre une PR par partie.

Le choix des modèles — qui exécute, qui relit, qui contredit — est un
« comment » local : il vit dans `playbook/modeles.md` (page non versionnée),
citée par chaque page d'étape. Le workflow ne le duplique pas.

## Règles invariantes

1. **Une mission = un ticket ; à l'exécution, une branche et une PR.** Pas de
   branche fourre-tout, pas de PR qui règle deux missions. À la revue, la PR
   peut être découpée en plusieurs PR empilées : chaque partie a sa branche et
   sa PR, et la branche d'origine devient la dernière partie.
2. **La clé du ticket nomme tout.** Branche : `<type>/<clé en minuscules>`
   (`feat/mis-12`, `fix/ex-1541`). Commit : `<CLÉ>: <impératif>`. PR : la clé
   dans le titre.
3. **Un commit, un sujet.** Un commit qui mélange deux sujets se scinde avant la
   revue.
4. **Chaque critère d'acceptation désigne le scénario qui le prouve.** À la
   sortie de l'exécution et à la clôture, chaque critère est coché avec le
   scénario qui le couvre — son test, une capture ou une observation datée. Un
   scénario donne un seul `it` ; la revue ne compte pas les tests.
5. **Le périmètre ne s'élargit pas en cours de route.** Une idée hors périmètre
   devient un ticket, pas un commit supplémentaire.
6. **Le demandeur valide le cadrage.** Sans validation explicite, la mission
   reste à l'état « prête » ou « à cadrer ».
7. **Un seul état par mission.** Une issue porte exactement une valeur d'état —
   une option du champ `Workflow stage` sur GitHub, un statut sur Jira. Le choix
   unique du champ rend deux états simultanés impossibles ; sur Jira, plusieurs
   libellés laissent l'état indéterminé et bloquent le passage à l'étape
   suivante, on retire l'ancien en posant le nouveau.

## Le modèle éditable

Chaque étape a son modèle dans `workflows/model/<étape>.yml` : les gestes de ses
sections, les arcs qui les enchaînent, l'état d'entrée et les états de sortie.
Les workflows gardés hors du dépôt vivent dans `workflows/local/model/`, que git
ignore ; le format et les règles de rangement sont les mêmes. Le
parcours des statuts a le sien, `workflows/model/statuts.yml` : les six états
canoniques et les huit événements qui les relient, avec leur libellé, leur
description et leur projection de tracker. Le panneau liste tous les modèles du
dossier, les dessine, les édite et en crée de nouveaux dans son onglet
**Workflows** ; le format, les deux genres et leurs règles sont décrits dans
`workflows/model/README.md`.

À côté des workflows, les **action flows** documentent la procédure d'un nœud :
conditions d'entrée, étapes ordonnées, gate, interdits et preuve de sortie. Ils
vivent dans `workflows/model/actions/` (versionnés) et
`workflows/local/model/actions/` (ignorés), portent `kind: action-flow` et
citent le nœud qu'ils décrivent. Le panneau les liste au même niveau que les
workflows, avec le badge **Action flow** ; le type, le schéma
(en treize clés), le rangement, le lien, l'édition et la validation sont décrits
dans [`model/README.md`](model/README.md#les-action-flows).

Le document `.md` reste la référence : le modèle en est la vue éditable, et
`node tools/check-workflows.mjs` signale, étape par étape, une section du
document restée sans geste (ou un geste qui n'ancre aucune section). Une
divergence n'est jamais réparée d'office — c'est au rédacteur de trancher.
