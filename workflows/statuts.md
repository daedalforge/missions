# Statuts des missions

Tout ticket de mission traverse les six états canoniques du workspace, et les
huit événements ci-dessous le font passer de l'un à l'autre. Le tracker porte
l'état ; le modèle `workflows/model/statuts.yml` est la vue éditable de cette
page. Sur GitHub, l'état est le **statut natif** de l'issue, que GitHub fait
avancer lui-même (assignation, PR liée, fermeture) ; `ready-for-prod` reste un
**label**, faute de statut natif pour cette étape.

## Les six états

| État | Libellé | Tracker (projet missions) |
| --- | --- | --- |
| `to-refine` | À cadrer | statut natif `Backlog` |
| `ready` | Prête | statut natif `Todo` |
| `in-progress` | En cours | statut natif `In progress` |
| `in-review` | En revue | statut natif `In review` |
| `ready-for-prod` | Prête à partir | label `ready-for-prod` |
| `done` | Terminée | statut natif `Done` ou issue fermée |

`to-refine` est l'état initial, `done` l'état terminal. Un ticket ne porte
qu'un seul état à la fois.

## Les huit événements

| De | Vers | Événement | Écrivain | Artefact | Porte |
| --- | --- | --- | --- | --- | --- |
| `to-refine` | `ready` | cadrage validé | session | statut natif `Todo` | neuf cases du cadrage cochées et accord du demandeur |
| `ready` | `in-progress` | branche poussée | session | statut natif `In progress` | la branche est poussée vers la base |
| `in-progress` | `in-review` | PR ouverte et complète | session | statut natif `In review` | PR assignée, typée, milestone posée, `Closes #N`, revue interne à l'aveugle validée |
| `in-progress` | `to-refine` | cadrage faux | demandeur | statut natif `Backlog` | le cadrage ou le périmètre change |
| `in-review` | `ready-for-prod` | validation des collègues constatée | session | label `ready-for-prod` | cinq cases de sortie de revue cochées |
| `in-review` | `in-progress` | changements demandés | demandeur | statut natif `In progress` | une preuve manque |
| `in-review` | `to-refine` | diff hors périmètre | demandeur | statut natif `Backlog` | le diff sort du cadrage, ou un critère n'a pas de scénario |
| `ready-for-prod` | `done` | merge et ticket fermé | demandeur | issue fermée | PR mergée et ticket fermé |

Les trois retours (`in-progress` → `to-refine`, `in-review` → `in-progress`,
`in-review` → `to-refine`) sont les seuls arcs qui remontent le parcours ; le
panneau les dessine en pointillé, par la droite.

## Ce que le panneau édite

Les libellés et les descriptions des états s'éditent dans l'onglet Workflows ;
les identifiants, les rôles et le mapping tracker restent en lecture seule. Les
événements s'éditent de la même façon : le couple `from`/`to` est fixe, la
condition, l'écrivain, l'artefact et la porte sont modifiables. Le vocabulaire
des états vient de `missions/projects.yml` : un état inconnu, un doublon ou une
boucle sont refusés avant l'écriture.
