# Modèles de workflow

Un fichier par étape du parcours, dans l'ordre de la méthode : `cadrage.yml`,
`execution.yml`, `review.yml`, `cloture.yml`.

Le document `workflows/<étape>.md` reste la référence : il dit ce que l'étape
demande. Le modèle en est la vue éditable — les gestes et les arcs d'un état à
l'autre — et le panneau (onglet **Workflows**) l'édite. Le modèle n'est jamais
la source : quand les deux divergent, la concordance le signale, elle ne le
répare pas.

## Ce que contient un fichier

```yaml
workflow: cadrage            # le nom de l'étape, égal au nom du fichier
title: Cadrage               # ce que le panneau affiche
document: workflows/cadrage.md
entry: to-refine             # l'état d'où l'étape part
exit:
  - ready                    # les états où l'étape peut s'arrêter
nodes:
  - id: lire-ticket          # slug unique, jamais le nom d'un état
    label: Lire le ticket et son contexte
    section: Ce qu'on fait   # un titre du document
    writer: session          # qui fait le geste
    condition: …             # facultatif : quand le geste s'applique
    artifact: …              # facultatif : ce qu'il laisse derrière lui
    gate: …                  # facultatif : ce qu'il doit satisfaire
edges:
  - from: to-refine          # un état ou un geste
    to: lire-ticket          # un geste ou un état
    when: …                  # facultatif : la condition de la transition
```

`writer` vaut `demandeur`, `session` ou `outil`.

## Règles

Le fichier est validé à chaque écriture, et par `node tools/check-workflows.mjs`.

- **Clés strictes** : une clé inconnue est refusée — une faute de frappe se voit
  au lieu de se perdre.
- **Ids** : slug (`a-z`, `0-9`, tirets), unique, distinct du nom d'un état.
- **États** : `entry` et `exit` viennent du vocabulaire canonique de
  `missions/projects.yml`. Un état inconnu est refusé.
- **Sections** : le `section` d'un geste doit être un titre du document de
  l'étape, texte exact. Un titre sans geste est une **section orpheline** — un
  avertissement, pas une erreur.
- **Arcs** : `from` et `to` désignent un geste ou un état ; pas de boucle sur
  soi, pas de double arc. Tout geste doit être joignable depuis `entry`, et
  chaque `exit` joignable depuis un geste.
- **Pas de coordonnées** : le panneau calcule le dessin. Le fichier ne dit que
  le graphe.

## Vérifier à la main

```sh
node tools/check-workflows.mjs
```

La commande lit `missions/projects.yml` pour le vocabulaire, charge les quatre
modèles, et affiche pour chacun les erreurs et les sections orphelines. Elle
sort en erreur (code 1) dès qu'un modèle est invalide.
