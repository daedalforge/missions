# Workspace missions

L'épine dorsale du workspace tient en trois dossiers : ce qu'est une mission
(`missions/`), comment elle avance (`workflows/`) et comment on la joue
(`playbook/`). Tout le reste — code, configuration, outils — s'y accroche.

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

## Les trois piliers

- [`missions/`](missions/README.md) — la mission : son identité, ses états, où
  elle vit, le gabarit qui la décrit, et le tableau des projets.
- [`workflows/`](workflows/README.md) — le parcours : une page par étape, plus
  la table de correspondance entre états du workflow et états du tracker.
- [`playbook/`](playbook/README.md) — le mode d'emploi par étape : la recette,
  les règles (code, revue, interdits) et la fiche du dépôt. Son contrat de
  lecture dit quelle page chaque étape lit ; le prompt de session nomme cette
  page, et la session la suit au lieu de redériver la recette.

`workflows/` dit **quoi** faire et garde les états ; `playbook/` dit **comment**,
**sous quelles règles** et **dans quel dépôt**. Une page de playbook ne recopie
pas `workflows/`, elle le cite.

## Le plugin

Le panneau vit dans `lib/` : moitié hôte (`index.js`, `trackers/`) et bundle
client. `lib/client.js` est **généré** — éditer `src/client.template.js` et
`lib/view.js`, puis `node tools/build.mjs`. Les helpers de `lib/view.js`
(filtre, groupes, âge relatif) sont purs et testés sans DOM.

Le panneau a deux périmètres de lecture. **Missions** et le **Dashboard** ne
lisent que les missions **ouvertes** : une mission `done` — issue fermée sur
GitHub, statut terminé sur Jira — n'y entre jamais, même si un ancien filtre
Statut la nommait. L'onglet **Done**, entre Missions et Repositories, est la
seule porte vers les missions closes : il lit les `done` dont le dossier est
déclaré sur le poste (`missions/<clé>/mission.yml`), avec sa propre barre de
filtres et son propre cache. Sans dossier déclaré, aucune mission close n'est
même lue ; l'onglet affiche « No done mission declared on this machine. ».

Depuis cet onglet, une mission close peut être **archivée** : son dossier passe
sous `missions/archives/<dossier>/`, rien n'est supprimé et le tracker n'est pas
modifié — la mission quitte Done et reste sur le disque.

Un projet peut déclarer ses **traductions** dans
[`missions/projects.yml`](missions/projects.yml) — `translations.locales`,
`translations.languageFile`, `translations.reference`. Le volet d'une mission de
ce projet gagne alors un bouton **Tolgee import** : il lit le diff de la branche
contre sa base, repère les clés `t()` ajoutées et écrit
`missions/<dossier>/import-tolgee.xliff`. Les clés manquantes en `fr` sont
listées à part, jamais dans le fichier ; Tolgee n'est jamais appelé, l'import du
fichier reste un geste manuel.

## Le relevé d'usage

Le panneau tient sa propre comptabilité : chaque geste — un onglet, un filtre,
un tiroir, une session — incrémente un compteur local. Un geste = un `POST
missions/api/usage`, jamais attendu et jamais bloquant : si le relevé échoue, le
clic qu'il comptait se fait quand même. Rien ne sort de la machine : le fichier
est `$DSH_HOME/storages/dsh-missions/usage.json`, écrit en une fois (dossier,
fichier temporaire, `rename`), avec au plus 32 détails distincts de 64 caractères
par geste.

L'onglet **Usage**, entre Repositories et Workflows, lit ce fichier par
`GET missions/api/usage` et le lit comme un rapport : les gestes utilisés rangés
par section et par nombre, le total et la fenêtre couverte, les gestes jamais
utilisés, et les identifiants retirés du registre — qui gardent leur compte au
lieu d'être effacés. Le registre `USAGE_ELEMENTS` ([`lib/view.js`](lib/view.js))
est la seule source des identifiants, libellés et sections ; ajouter un geste,
c'est l'y déclarer et l'appeler par `track()`.

Chaque ligne porte un verdict, imprimé avec le compte qui l'a produit. Aucun
verdict avant que la **porte** soit franchie — 7 jours et 20 gestes depuis
`startedAt` : un relevé jeune ne sait rien, et le dire vaut mieux que d'inventer.
Passé la porte, le verdict se lit dans cet ordre : **Remove** (0 usage),
**Improve** (dernier usage il y a plus de 30 jours, quel que soit son passé, ou
1 à 2 usages), **Grow** (≥ 15 usages, ou ≥ 10 % des gestes), **Keep** (le reste,
c'est-à-dire 3 à 14 usages récents et discrets). Ces seuils sont des hypothèses
de départ, pas des ordres : un verdict lit des nombres, le panneau ne supprime
jamais un geste.

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
