# La mission

Une mission est un travail suivi par **un ticket de tracker**. Sa fiche, son
état et son historique vivent dans le tracker ; le workspace ne garde que ce que
le tracker ne sait pas porter : la branche de la mission et sa base.

## Identité

| Tracker | Forme | Exemple |
|---|---|---|
| Jira | `<RÉFÉRENCE>-<numéro>` | `SOC-1541`, `SO-1207` |
| GitHub | `<RÉFÉRENCE>-<numéro>` | `MIS-52` |

La clé est l'identifiant de travail, partout et sans exception : nom de branche,
préfixe de commit, message de PR, liens entre tickets. On ne réinvente pas de
numérotation locale. La référence est déclarée par le projet dans
[`projects.yml`](projects.yml) ; sur GitHub, elle préfixe le numéro de l'issue,
dont l'URL reste `…/issues/52`.

## États

Cinq états, dans cet ordre : **à cadrer**, **prête**, **en cours**, **en revue**,
**terminée**. Ils sont décrits dans [`../workflows/README.md`](../workflows/README.md),
qui porte aussi leur correspondance Jira et GitHub.

Un ticket ne saute pas d'état : chaque transition a une condition de sortie
écrite dans la page de l'étape correspondante.

Dans le panneau, les groupes sont rangés par attention — **en cours**, **en
revue**, **prête**, **à cadrer**, **prête à partir** — et non dans l'ordre du
workflow ; le filtre de statut, lui, garde l'ordre du workflow.

## Où vit quoi

| Élément | Emplacement | Versionné ici |
|---|---|---|
| Fiche de mission (titre, description, critères) | Tracker | Non |
| État, assignation, commentaires | Tracker | Non |
| Branche et base (déclarées) | `missions/<dossier>/mission.yml` | Non — local, ignoré par git |
| Branche et commits | Dépôt du projet | Selon le projet |
| Preuves de clôture | Commentaire du ticket | Non |
| Méthode (ce document, workflows) | Ce dépôt | Oui |

Sur GitHub, pas de board GitHub Projects : la liste des issues suffit. Une
mission n'a pas de sous-ticket ; ce qui aurait été une sous-tâche est un critère
d'acceptation ou une mission à part entière.

## Branche et base

Deux propriétés d'une mission n'existent ni sur GitHub ni sur Jira : la **branche
de travail** et sa **branche de base**, celle d'où elle part et où revient sa PR
(c'est ce qui permet de suivre l'arbre gitmachete et de viser la bonne branche).
Elles sont **déclarées**, jamais déduites : le panneau les lit dans le dépôt, il
n'interroge ni git ni gitmachete et ne devine pas un nom de branche.

Chaque mission exécutable a **un dossier** sous `missions/`, avec un
`mission.yml` :

```yaml
key: MIS-41
branch: mis-41
base: main
```

- **`key` fait foi** : c'est lui qui relie le fichier à la mission du tracker
  (`MIS-52` ou clé Jira). Le nom du dossier est libre ; quand il manque, le
  panneau le crée à partir de la clé en remplaçant les caractères non
  alphanumériques par des tirets (`MIS-41`, `daedalforge-missions-41`). La
  correspondance est exacte : après le passage à `MIS-n`, une déclaration
  restée sur l'ancienne clé `daedalforge/missions#n` ne correspond plus à la
  mission ; renommer `key` dans le fichier (le dossier peut garder son nom).
- **Pas de session sans les deux** : un dossier absent, ou un champ manquant,
  laisse `branch`/`base` vides ; le volet de détail laisse alors les champs
  vides et désactive « Start a session » plutôt que de supposer une branche.
- **Une erreur se voit** : champ inconnu, clé dupliquée entre deux dossiers,
  YAML invalide ou valeur vide sont signalés dans le panneau, pas avalés. Le
  volet peut réparer une valeur vide ou mal typée en l'enregistrant ; un champ
  inconnu, lui, reste signalé et refuse la réécriture.
- **Une déclaration sans mission affichée n'est pas une erreur** : une mission
  fermée ou assignée à quelqu'un d'autre garde son dossier sans apparaître dans
  le panneau.
- **Le dossier se crée au cadrage**, quand la fiche est validée ; la branche
  elle-même ne s'ouvre qu'à l'exécution, depuis `base`.

**Depuis le panneau** : le volet de détail porte deux champs, « Branch » et
« Base », et un bouton « Save ». L'enregistrement réutilise le dossier qui
déclare déjà la clé, ou le crée (`missions/<nom dérivé de la clé>/`), et
n'écrit que ce `mission.yml`. Le panneau n'édite ni la clé ni le nom du dossier ;
pour une migration de clé, on modifie `key` dans le fichier. Un champ vidé
disparaît du fichier.

**Jamais versionné** : `missions/*/` est ignoré par git. Une déclaration reste
locale au poste — elle n'est ni commitée, ni poussée, ni partagée. Un clone neuf
part donc sans déclaration : on les repose depuis le panneau au premier cadrage.
Le panneau n'écrit que ce fichier, le versionnement n'est pas son affaire.

## Le projet décide du tracker

Chaque projet déclare son dépôt et son tracker dans [`projects.yml`](projects.yml).
Une mission hérite du tracker de son projet : il n'y a pas de choix par mission.
Un projet sans entrée dans `projects.yml` ne peut pas recevoir de mission.

## Gabarit

La fiche d'une mission se crée dans le tracker à partir de
[`gabarit-mission.md`](gabarit-mission.md). Les sections sont les mêmes pour
Jira et GitHub ; seuls les champs natifs de l'outil (statut, assigné, sprint)
diffèrent et ne sont pas dupliqués dans la description.

## Epics

Un epic groupe des missions autour d'un même objectif. Ce n'est pas une mission :
il ne suit pas le parcours cadrage → revue, il ne porte ni branche ni PR, et il
n'occupe pas de ticket.

| Tracker | Forme de l'epic |
|---|---|
| GitHub | **milestone** ; la mission y est rattachée par le champ `milestone` |
| Jira | epic natif ; la mission y est rattachée par le lien d'epic |

Une mission appartient à **un seul** epic. Un epic se décrit par un titre et une
courte description, se ferme quand toutes ses missions sont terminées, et naît
avec au moins une mission. La date d'échéance du milestone reste vide tant qu'il
n'y a pas d'engagement de date : un epic est thématique, pas calendaire.

## Libellés GitHub

Une issue porte **un type** natif et **un état** en libellé. Le type dit la
nature du travail — `Bug` ou `Feature` sur GitHub, `Bug` ou `Story` sur Jira —,
l'état dit où en est la mission. Les deux sont indépendants : une story peut être
en revue, un bug peut être prêt.

| Libellé | Rôle |
|---|---|
| `to-refine` | cadrage non fait ou à refaire |
| `ready` | cadrage validé, prête à exécuter |
| `in-progress` | branche ouverte, exécution en cours |
| `in-review` | PR ouverte, en attente de revue |
| `ready-for-prod` | revue faite, en attente de livraison |
| `priority:urgent` · `priority:high` · `priority:normal` · `priority:low` | priorité, une seule par issue |
| `sp:1` · `sp:2` · `sp:3` · `sp:5` · `sp:8` · `sp:13` | story points, un seul par issue |

Une issue porte **un seul** type natif et **un seul** état. Fermer l'issue est
l'état terminé : il n'y a pas de libellé `done`. Un blocage se dit en commentaire, pas
par un libellé. L'epic n'est pas un libellé : c'est un milestone.


## Lecture

Le panneau lit **plusieurs projets à la fois**, chacun dans son tracker. Un
projet est une source : il se lit seul, avec ses propres identifiants, et son
échec ne touche pas les autres.

- **Indépendance.** Un jeton absent, un quota épuisé, une panne réseau ou des
  droits insuffisants d'un côté ne suspendent pas la lecture des autres projets ;
  l'erreur s'affiche pour le projet concerné, les autres restent lisibles.
- **Aucune hypothèse partagée.** Deux projets ne partagent ni vocabulaire, ni
  pagination, ni cadence de lecture. Ce qui vaut pour l'un n'est pas supposé
  pour l'autre.
- **Identité complète.** Une mission affichée porte toujours son projet et sa
  clé (`MIS-52`, `SOC-1234`). Deux clés identiques dans deux projets
  restent deux missions distinctes.
- **Lecture seule.** Lire un tracker ne modifie rien : ni le tracker, ni le
  dépôt, ni un fichier local.
- **Mes missions seulement.** Chaque lecture est filtrée sur le compte qui
  interroge : l'assigné courant sur GitHub, `assignee = currentUser()` en JQL
  côté Jira. Le compte *à interroger* n'est jamais écrit dans `projects.yml` :
  il vient du jeton qui parle au tracker. Seule l'adresse qui authentifie ce
  jeton y figure (`jira.email`), quand le tracker l'exige — le jeton, lui, reste
  hors du dépôt.

## Correspondance avec le tracker

Le workspace a un **vocabulaire canonique**, le même partout : états `to-refine`,
`ready`, `in-progress`, `in-review`, `ready-for-prod`, `done`, types `bug`,
`story`. Les documents,
les branches et les commits l'emploient ; c'est seulement à la frontière du
tracker qu'une traduction a lieu.

Cette traduction est une donnée, pas une convention : chaque projet la déclare
dans [`projects.yml`](projects.yml), bloc `map`. Une clé canonique sans valeur
dans le tracker se compense par un libellé ; une valeur `null` dit que l'état
n'a pas de représentation propre (la fermeture de l'issue, par exemple).

| Canonique | GitHub (`missions`) | Jira (exemple à trois statuts) |
|---|---|---|
| `to-refine` | label `to-refine` | `To Do` |
| `ready` | label `ready` | `To Do` + libellé `ready` |
| `in-progress` | label `in-progress` | `In Progress` |
| `in-review` | label `in-review` | `In Review` |
| `ready-for-prod` | label `ready-for-prod` | `Ready for prod`, ou les statuts de déploiement du projet (`Local Testing`, `Staging Test`) |
| `done` | fermeture de l'issue | `Done`, `Released` |
| `bug` | type `Bug` | type `Bug` |
| `story` | type `Feature` | type `Story` |
| `urgent` / `high` / `normal` / `low` | label `priority:*` | `Highest` / `High` / `Medium` / `Low` |
| story points | label `sp:N` | champ `story_points_field` (défaut `customfield_10016`) |

Deux conséquences :

- Un projet dont le `map` est incomplet ne peut pas recevoir de mission : on ne
  devine pas où poser un état.
- Deux projets peuvent nommer le même état différemment — c'est le `map` qui
  fait foi, jamais la mémoire de qui travaille.
