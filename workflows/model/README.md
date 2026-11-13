# Modèles de workflow

Un fichier par workflow, dans `workflows/model/`. Les quatre étapes de la
méthode s'appellent `cadrage.yml`, `execution.yml`, `review.yml` et `cloture.yml`
; le parcours des statuts s'appelle `statuts.yml`. Tout autre fichier `.yml` du
dossier est un workflow de plus ; la liste du panneau est le dossier.

Le document `workflows/<workflow>.md` reste la référence : il dit ce que
l'étape demande. Le modèle en est la vue éditable — les points et les arcs — et
le panneau (onglet **Workflows**) l'édite et le crée. Le modèle n'est jamais la
source : quand les deux divergent, la concordance le signale, elle ne le répare
pas.

## Deux genres

`kind` vaut `etape` ou `statuts`. Absent, il vaut `etape` : les quatre modèles
d'étape n'ont pas eu à être réécrits.

- Un workflow **d'étape** a des **gestes** : chaque nœud cite la section du
  document où le geste est décrit, et un écrivain.
- Un workflow de **statuts** a des **états** : chaque nœud est un état canonique
  de `missions/projects.yml`, avec son libellé lisible, sa description et la
  projection du tracker. Il n'a ni section ni écrivain — un état n'est pas un
  geste. Ses six nœuds se lisent une fois chacun, dans l'ordre du vocabulaire,
  et ses arcs sont les **événements** qui font passer d'un état à l'autre.

## Ce que contient un fichier d'étape

```yaml
workflow: cadrage            # le nom de l'étape, égal au nom du fichier
title: Cadrage               # ce que le panneau affiche
description: Lire le ticket # facultatif : une ligne, 280 caractères au plus
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

`description` est facultatif et purement documentaire : une ligne, 280
caractères au plus, écrite seulement quand elle est renseignée. C'est elle que
la carte de la liste affiche ; sans elle, la carte montre `summary`, le premier
paragraphe du document.

`writer` vaut `demandeur`, `session` ou `outil`.

## Ce que contient un fichier de statuts

```yaml
workflow: statuts
kind: statuts
title: Statuts des missions
document: workflows/statuts.md
entry: to-refine
exit:
  - done
nodes:                       # les six états canoniques, une fois chacun
  - id: to-refine
    label: À cadrer
    description: Le ticket est ouvert ; rien n'est encore décidé.
    tracker: label to-refine
edges:                       # les événements, d'un état au suivant
  - from: to-refine
    to: ready
    when: cadrage validé
    writer: session
    artifact: label ready
    gate: neuf cases du cadrage cochées et accord du demandeur
```

Un arc de statuts porte, en plus de `from`, `to` et `when`, les trois champs
facultatifs `writer`, `artifact` et `gate`. Le panneau les édite ; un modèle
d'étape qui les porte reste valide, et le panneau les y affiche aussi.

## Règles

Le fichier est validé à chaque écriture, et par `node tools/check-workflows.mjs`.

- **Clés strictes** : une clé inconnue est refusée — une faute de frappe se voit
  au lieu de se perdre. Un nœud de statuts qui porte `section` est une clé
  inconnue.
- **Ids** : pour une étape, slug (`a-z`, `0-9`, tirets), unique, distinct du nom
  d'un état. Pour les statuts, l'id est un état canonique, unique.
- **États** : `entry` et `exit` viennent du vocabulaire canonique de
  `missions/projects.yml`. Un état inconnu est refusé.
- **Six états** : le workflow de statuts les cite tous, une fois chacun, dans
  l'ordre du vocabulaire.
- **Sections** : le `section` d'un geste doit être un titre du document de
  l'étape, texte exact. Un titre sans geste est une **section orpheline** — un
  avertissement, pas une erreur. Les statuts n'ont pas de section.
- **Arcs** : `from` et `to` désignent un point connu ; pas de boucle sur soi,
  pas de double arc. Tout point doit être joignable depuis `entry`, et chaque
  `exit` joignable. Un graphe sans aucun arc est un brouillon valide : c'est ce
  qu'écrit la création d'un workflow.
- **Pas de coordonnées** : le panneau calcule le dessin. Le fichier ne dit que
  le graphe.

## Créer un workflow

Le panneau le fait par le bouton **Nouveau workflow**, dans l'onglet
**Informations** du panneau de droite : **trois champs seulement**, le titre, la
description et le genre (`Étapes` ou `Statuts`). Tout le reste est dérivé du
titre ou posé par défaut, et n'est jamais ressaisi.

- **La clé** est le titre replié en slug : accents retirés, casse basse, tout ce
  qui n'est pas une lettre ou un chiffre devient un tiret, 80 caractères au
  plus. `Déjà vu !` donne `deja-vu` ; un titre sans lettre ni chiffre est
  refusé (`cle-invalide`).
- **Le document** est `workflows/<clé>.md`.
- **L'entrée** vaut `to-refine`, **les sorties** valent `[done]`. La validation
  reste stricte : un état inconnu est refusé comme avant.
- **Le document** naît avec un squelette : `# <titre>\n\n## Ce qu'on fait\n`
  pour un parcours d'étapes — la section que le premier geste citera — et
  `# <titre>\n` pour un vocabulaire de statuts.
- **Une collision** est refusée, jamais suffixée : si `workflows/model/<clé>.yml`
  ou `workflows/<clé>.md` existe déjà, la création rend 400 (`cle-double` ou
  `document-double`) et n'écrit rien.

Le formulaire de création n'envoie que `{ title, description, kind }`. La route
accepte encore `workflow`, `document`, `entry` et `exit` quand un appel direct
les fournit — c'est la compatibilité des tests, pas la voie du panneau.

## Modifier un workflow

Cliquer un workflow ouvre le panneau sur l'onglet **Informations** : le titre, la
**description**, l'entrée et les sorties s'éditent ; la **clé**, le **genre** et
le **document** se lisent seulement — la clé nomme les fichiers, le genre change
la nature du modèle. **Enregistrer** poste le modèle complet à
`missions/api/workflows/model` ; **Annuler** revient au dernier état lu.

Quand le titre change, le premier titre de niveau 1 du document est réécrit en
`# <titre>` et le reste du fichier n'est pas touché. Sans changement de titre,
le document n'est pas réécrit. Un document absent n'est jamais créé par une
sauvegarde.

L'onglet **Graphe** porte l'édition du point et de l'arc sélectionnés, la carte
**Graphe** et le formulaire d'arc ; cliquer un nœud du canevas y bascule.

## Vérifier à la main

```sh
node tools/check-workflows.mjs
```

La commande lit `missions/projects.yml` pour le vocabulaire, charge les modèles
du dossier, et affiche pour chacun son genre, ses compteurs, ses erreurs et ses
sections orphelines. Elle sort en erreur (code 1) dès qu'un modèle est invalide.
