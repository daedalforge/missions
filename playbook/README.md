# Le playbook

Une session sait **quoi** faire par `workflows/`, **sous quelles règles** par
`standards/`. Ce dossier dit **comment** : l'ordre des gestes, les commandes
exactes, les artefacts, les pièges et la preuve de sortie. Le prompt de session
nomme une page ; la session la lit et suit sa recette au lieu de la redériver.

## Index

| Page | Pour qui | Document lié |
| --- | --- | --- |
| `playbook/cadrage.md` | étape cadrage (`to-refine`) | `workflows/cadrage.md` |
| `playbook/execution.md` | étape exécution (`ready`, `in-progress`) | `workflows/execution.md` |
| `playbook/revue.md` | étape revue (`in-review`) | `workflows/review.md` |
| `playbook/cloture.md` | étape clôture (`ready-for-prod`) | `workflows/cloture.md` |
| `playbook/workspace.md` | session libre, remontées de PR, gestes transverses | `workflows/README.md` |

## Le contrat de lecture

Le prompt du panneau nomme une seule page, celle de l'étape du ticket. La
session la lit avant d'agir et n'a pas à parcourir l'index.

| Étape | Page |
| --- | --- |
| cadrage | `playbook/cadrage.md` |
| exécution | `playbook/execution.md` |
| revue | `playbook/revue.md` |
| clôture | `playbook/cloture.md` |

La session libre et celle des remontées de PR nomment `playbook/workspace.md` :
ce sont des gestes, pas une étape, et une remontée peut arriver dans n'importe
quel état.

## La forme d'une page

Chaque page porte, dans cet ordre, cinq sections :

1. `## Avant d'agir` — ce qu'on relit, ce qui doit être vrai pour commencer.
2. `## Les gestes, dans l'ordre` — la recette numérotée, commandes exactes et
   artefacts.
3. `## Pièges observés` — les erreurs déjà payées, avec la mission qui les a
   payées.
4. `## Preuve de sortie` — ce qui doit être vrai pour rendre la main.
5. `## Où lire les règles` — les documents `workflows/` et `standards/` de
   l'étape ; une page renvoie, elle ne recopie pas.

Une page d'étape ajoute, sous son titre, `Entrée : <état> → Sortie : <état>` et
le document `workflows/<document>.md` qu'elle met en œuvre. Une page tient en
80 lignes : au-delà, elle recopie une règle au lieu de la citer.

## La frontière

- `workflows/` dit **quoi** : l'étape, ses gestes attendus, sa condition de
  sortie.
- `standards/` dit **les règles** : code, revue, interdits, commandes du dépôt.
- `playbook/` dit **comment** : l'ordre, les commandes, les pièges, la preuve.
  Une règle manquante s'ajoute dans `standards/`, jamais ici ; une page renvoie
  au document qui la porte.

## Ajouter une page

1. Écrire la page aux cinq sections, 80 lignes au plus, en renvoyant aux
   documents `workflows/` et `standards/` au lieu de les recopier.
2. L'indexer dans la table de l'index ci-dessus.
3. Si l'étape doit la lire, l'ajouter au contrat de lecture **et** à
   `PLAYBOOK_STEP_FILES` dans `lib/view.js`.
4. Relancer `node tools/check-playbook.mjs` et `npm test` : une page indexée
   absente, une page présente non indexée, une section manquante ou un renvoi
   `workflows/` retiré échouent en nommant le fichier.
