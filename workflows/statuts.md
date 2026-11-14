# Statuts des missions

Tout ticket de mission traverse les six états canoniques du workspace, et les
huit événements ci-dessous le font passer de l'un à l'autre. Le tracker porte
l'état ; le modèle `workflows/model/statuts.yml` est la vue éditable de cette
page.

## Les six états

| État | Libellé | Tracker (projet missions) |
| --- | --- | --- |
| `to-refine` | À cadrer | `label to-refine` |
| `ready` | Prête | `label ready` |
| `in-progress` | En cours | `label in-progress` |
| `in-review` | En revue | `label in-review` |
| `ready-for-prod` | Prête à partir | `label ready-for-prod` |
| `done` | Terminée | issue fermée (`map: null`) |

`to-refine` est l'état initial, `done` l'état terminal. Un ticket ne porte
qu'un seul état à la fois.

## Les huit événements

| De | Vers | Événement | Écrivain | Artefact | Porte |
| --- | --- | --- | --- | --- | --- |
| `to-refine` | `ready` | cadrage validé | session | `label ready` | neuf cases du cadrage cochées et accord du demandeur |
| `ready` | `in-progress` | branche poussée | session | `label in-progress` | la branche est poussée vers la base |
| `in-progress` | `in-review` | PR ouverte et complète | session | `label in-review` | PR assignée, étiquetée, milestone posée, `Closes #N` |
| `in-progress` | `to-refine` | cadrage faux | demandeur | `label to-refine` | le cadrage ou le périmètre change |
| `in-review` | `ready-for-prod` | revue approuvée | session | `label ready-for-prod` | cinq cases de sortie de revue cochées |
| `in-review` | `in-progress` | changements demandés | demandeur | `label in-progress` | un critère ou une preuve manque |
| `in-review` | `to-refine` | diff hors périmètre | demandeur | `label to-refine` | le diff sort du cadrage |
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
