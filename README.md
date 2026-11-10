# Workspace missions

L'épine dorsale du workspace tient en deux dossiers : ce qu'est une mission
(`missions/`) et comment elle avance (`workflows/`). Tout le reste — code,
configuration, outils — s'y accroche.

## Une mission vit dans son tracker

Une mission est un travail identifiable par un ticket, et ce ticket vit dans le
tracker du projet : **GitHub** ou **Jira**, jamais dans un fichier local. Le
workspace ne stocke pas l'état des missions ; le tracker en est la seule source
de vérité. Ce dépôt porte la **méthode**, pas les fiches.

Conséquence : pas de mission « locale » ni de mission de méthode. Un travail qui
n'a pas de ticket n'est pas une mission ; il se range dans une mission existante
ou il crée son ticket.

## Un seul type de mission, un seul workflow

Il n'existe plus qu'un type de mission. Le parcours est le même pour toutes :
**cadrage → exécution → revue → clôture**. Ce qui varie d'un projet à l'autre
n'est pas le workflow mais le **tracker** : une mission de `Manager` s'ouvre sur
Jira, une mission de `missions` s'ouvre sur GitHub. Le projet, son dépôt et son
tracker sont déclarés une fois dans [`missions/projects.yml`](missions/projects.yml).

## Les deux piliers

- [`missions/`](missions/README.md) — la mission : son identité, ses états, où
  elle vit, le gabarit qui la décrit, et le tableau des projets.
- [`workflows/`](workflows/README.md) — le parcours : une page par étape, plus
  la table de correspondance entre états du workflow et états du tracker.

## Le plugin

Le panneau vit dans `lib/` : moitié hôte (`index.js`, `trackers/`) et bundle
client. `lib/client.js` est **généré** — éditer `src/client.template.js` et
`lib/view.js`, puis `node tools/build.mjs`. Les helpers de `lib/view.js`
(filtre, groupes, âge relatif) sont purs et testés sans DOM.

## Conventions

- **Le code est en anglais** : identifiants, chaînes, commentaires, messages
  d'erreur, libellés d'interface. C'est la langue de l'outillage et des API
  qu'il appelle.
- **La documentation est en français** : ce README, `missions/`, `workflows/`
  et les fiches de mission.
- Une PR se renseigne comme son issue : assignation, type, état, lien, milestone
  ([`workflows/execution.md`](workflows/execution.md)).

## Règles de lecture

- Un document de workflow décrit **un geste**, pas un outil : les commandes
  Jira et GitHub sont données côte à côte quand elles diffèrent.
- Un critère d'acceptation sans preuve n'est pas un critère : chaque étape dit
  ce qui doit être vérifiable à sa sortie.
- Ce dépôt ne contient ni code produit, ni fiche de mission, ni journal de
  session.
