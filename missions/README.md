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

Six états, dans cet ordre : **à cadrer**, **prête**, **en cours**, **en revue**,
**prête à partir**, **terminée**. Ils sont décrits dans
[`../workflows/README.md`](../workflows/README.md), qui porte aussi leur
correspondance Jira et GitHub.

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
| Journal de mission (récit de la session) | `missions/<dossier>/journal.md` | Non — local, ignoré par git |
| Checklist de mission (gestes à vérifier) | `missions/<dossier>/checklist.md` | Non — local, ignoré par git |
| Dossier archivé | `missions/archives/<dossier>/` | Non — local, ignoré par git |
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
Elles sont **déclarées**, jamais déduites : le panneau les lit dans le dépôt et
n'interroge ni git ni gitmachete. Tant qu'aucune branche n'est déclarée, il
préremplit le champ avec le nom conventionnel — `<type>/<clé>` en minuscules,
`fix/` pour un bug, `epic/` pour un epic, `feat/` sinon — mais ne l'enregistre
pas : seule la valeur déclarée après Save fait foi.

Chaque mission exécutable a **un dossier** sous `missions/`, avec un
`mission.yml` :

```yaml
key: MIS-41
branch: feat/mis-41
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

**Depuis le panneau** : le volet de détail se lit en trois onglets —
**Details** (propriétés et champs ci-dessous), **Journal** et **Checklist** —
et les actions (ouvrir le ticket, fermer le checkout local, démarrer une
session) restent en pied de volet, sous les onglets. Journal et Checklist prennent la hauteur restante,
du trait des onglets à la note de session ou à l'avertissement de blocage
quand ils sont là, aux actions sinon : c'est leur contenu qui défile, pas le
volet. Details garde le défilement du volet. L'onglet Details porte deux
champs, « Branch » et
« Base », et un bouton « Save ». L'enregistrement réutilise le dossier qui
déclare déjà la clé, ou le crée (`missions/<nom dérivé de la clé>/`), et
n'écrit que ce `mission.yml`. Le panneau n'édite ni la clé ni le nom du dossier ;
pour une migration de clé, on modifie `key` dans le fichier. Un champ vidé
disparaît du fichier.

La ligne **Priority** s'édite sur place : c'est un `<select>` natif des quatre
mots du workflow. Choisir une valeur
l'envoie aussitôt à la route de l'hôte (`POST missions/api/priority`), qui
traduit le mot canonique avec la table du projet ; le panneau n'a pas de jeton
et ne connaît jamais la valeur du tracker. L'affichage ne bouge qu'une fois le
tracker d'accord : un refus laisse l'ancienne priorité en place et affiche
l'erreur sous la ligne. Une mission sans priorité montre une option vide non
sélectionnable, jamais un faux niveau.

**Jamais versionné** : `missions/*/` est ignoré par git. Une déclaration reste
locale au poste — elle n'est ni commitée, ni poussée, ni partagée. Un clone neuf
part donc sans déclaration : on les repose depuis le panneau au premier cadrage.
Le panneau n'écrit que ce fichier, le versionnement n'est pas son affaire.

### Fermer le checkout local

Quand la mission est en `ready-for-prod` et que sa PR est mergée, le volet
propose **« Close the local checkout »**. C'est le seul geste du panneau qui
supprime une branche ; il ne remplace ni le merge ni la fermeture du ticket,
qui restent ceux du demandeur.

- **Il vérifie avant d'agir.** L'hôte relit l'issue (encore en
  `ready-for-prod`, sans conflit de labels) et les PR de la branche : il faut
  une PR mergée vers la base déclarée, et un merge commit (ou la tête) ancêtre
  de `origin/<base>`. Le projet squash-merchant, la branche locale n'est jamais
  ancêtre de la base : la preuve part de `head.sha` de la PR, et
  `git rev-list --first-parent <head.sha>..<branche>` doit être vide ou ne
  contenir que des merges de synchronisation (autres parents sur
  `origin/<base>`). Un `git fetch` précède la seconde vérification. Sans
  preuve, rien n'est supprimé.
- **Deux temps.** Un premier clic annonce ce qui va disparaître, un second
  envoie la clé. Le panneau n'envoie que `{ key }` : chemins, noms et gestes
  sont décidés par l'hôte.
- **Ce qu'il fait.** `git worktree remove` (jamais `--force`, un worktree sale
  refuse) ; le clone passe sur la base par `checkout` puis
  `merge --ff-only origin/<base>` ; `git branch -D` ; la ligne est retirée de
  `.git/machete` à la main (enfants remontés, annotations conservées, aucun
  processus `git machete`) ; une section `## <date> — Clôture` est ajoutée au
  journal avec la PR et les gestes.
- **Ce qu'il ne fait pas.** Aucun écrit tracker, aucune branche distante, aucun
  `main` touché. Chaque refus (pas de clone, état, PR, base, commit, worktree
  sale, commit local non livré) est un 409 et un message, sans suppression
  partielle.

### Archiver une mission

Une mission `done` peut être rangée depuis le volet, onglet **Done** : le bouton
**« Archive »** déplace son dossier sous `missions/archives/<dossier>/`.

- **Ce qu'il déplace.** Le dossier entier, avec son nom, son `mission.yml`, son
  journal et sa checklist. Rien n'est supprimé, rien n'est réécrit.
- **Ce qu'il vérifie.** L'hôte relit l'issue fermée dans le tracker et refuse
  (409) tout dossier absent, déjà archivé ou dont la mission n'est plus `done`.
  Le panneau n'envoie que `{ key }` ; le second clic confirme.
- **Ce qu'il ne fait pas.** Aucun écrit tracker, aucune branche, aucun commit,
  aucun `main` touché. Le geste ne remplace ni le merge ni la fermeture.
- **Après.** Le dossier n'étant plus sous `missions/`, la mission quitte
  l'onglet Done. Pour la ressortir, `mv missions/archives/<dossier> missions/`.

## Journal de mission

Chaque mission tient son récit dans `missions/<dossier>/journal.md`, à côté de
`mission.yml` : ce que la session a lu, décidé et prouvé — pas ce qu'elle a
l'intention de faire.

- **Il ne remplace pas la fiche.** L'état, les décisions opposables et les
  preuves de clôture restent dans le ticket. Le journal est le carnet de bord
  local ; un clone neuf ne le porte pas.
- **Forme.** Un titre `# Journal — <clé>`, puis une section par étape :
  `## <date> — Cadrage`, `— Exécution`, `— Revue`, `— Clôture`. On ajoute, on ne
  réécrit pas.
- **Quand.** Ouvert au cadrage (demande verbatim, lectures, état relevé,
  hypothèses, points ouverts, plan), puis complété à chaque étape : changements
  et preuves à l'exécution, décision et critères vérifiés à la revue, merge et
  suites à la clôture.
- **Qui.** L'agent de la session écrit ; le panneau lit. Le volet l'affiche
  dans l'onglet **Journal**, en texte, avec sa date, sur la hauteur restante
  du volet, et ne le modifie pas.
- **Jamais versionné.** `missions/*/` reste ignoré par git, comme
  `mission.yml` : le journal ne se commit pas et ne se partage pas.

## Checklist de mission

Chaque mission tient sa feuille de vérification dans
`missions/<dossier>/checklist.md`, à côté de `mission.yml` : les gestes concrets
à exécuter et leur preuve, cochés au fil de l'exécution. Elle ne remplace pas
les critères d'acceptation, qui restent dans le ticket ; elle dit comment on les
vérifie.

- **Forme.** Du markdown : un titre `# Checklist — <clé>`, puis une section par
  étape ou par thème (`## Cadrage`, `## Exécution`…), et un geste par case :
  `- [ ]` à faire, `- [x]` fait, la preuve sur la même ligne
  (`— *test* : npm test`, `— *relevé* : …`). Le marqueur `- [~]` de l'ancien
  système reste lu comme « non exercé ». Les checklists reprises de l'ancien
  système gardent leur titre d'origine (`# Checklist manuelle — SLV-114`) : la
  forme ci-dessus est celle des checklists écrites par l'agent au cadrage.
- **Quand.** Ouverte au cadrage avec les gestes du plan, cochée à l'exécution au
  fur et à mesure, revue avec les preuves de la PR, soldée à la clôture : une
  case restée ouverte est une suite nommée, pas un oubli.
- **Qui.** L'agent écrit, le panneau lit : le volet l'affiche dans l'onglet
  **Checklist** — compteur `cochées/total`, sections et cases, sur la hauteur
  restante du volet — sans jamais modifier le fichier.
- **Ce n'est pas une preuve.** Les preuves opposables vivent dans le ticket et
  la PR ; la checklist est le carnet de vérification local de la session.
- **Jamais versionné.** `missions/*/` reste ignoré par git, comme `mission.yml`
  et le journal : la checklist ne se commit pas et ne se partage pas.

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
nature du travail — `Bug` ou `Feature` sur GitHub, `Bug`, `Story` ou `Task` sur
Jira —, l'état dit où en est la mission. Les deux sont indépendants : une story
peut être en revue, un bug peut être prêt.

| Libellé | Rôle |
|---|---|
| `to-refine` | cadrage non fait ou à refaire |
| `ready` | cadrage validé, prête à exécuter |
| `in-progress` | branche ouverte, exécution en cours |
| `in-review` | PR ouverte, en attente de revue |
| `ready-for-prod` | revue faite, en attente de livraison |
| `priority:urgent` · `priority:high` · `priority:normal` · `priority:low` | priorité, une seule par issue |
| `sp:1` · `sp:2` · `sp:3` · `sp:5` · `sp:8` · `sp:13` | story points, un seul par issue |
| `blocked` | mission bloquée : la raison est en commentaire de l'issue |

Une issue porte **un seul** type natif et **un seul** état. Deux libellés d'état ne
s'arbitrent pas : l'état devient indéterminé, le panneau le signale en erreur et la
session de la mission reste bloquée jusqu'à ce qu'il n'en reste qu'un. Changer
d'état, c'est poser le nouveau libellé en retirant l'ancien. Fermer l'issue est
l'état terminé : il n'y a pas de libellé `done`. Un blocage se dit par le libellé
`blocked` **et** sa raison en commentaire : le libellé dit qu'on est bloqué, le
commentaire dit pourquoi et par quoi. `blocked` n'est pas un état — il ne
remplace jamais l'état en cours, et une mission bloquée garde son état — il
n'empêche pas non plus de démarrer une session : il informe. Le retirer, c'est
débloquer, et cela ne poste rien d'autre. L'epic n'est pas un libellé : c'est un
milestone.


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
dans [`projects.yml`](projects.yml), bloc `map`. Deux champs échappent à la
table parce qu'ils s'écrivent : `blocked` ne se traduit pas, il se pose tel
quel sur le ticket ; `priority` se traduit, mais c'est l'hôte qui choisit la
valeur du projet. Le panneau écrit les deux par la route de l'hôte, parce
qu'il n'a pas de jeton. Une clé canonique sans valeur
dans le tracker se compense par un libellé ; une valeur `null` dit que l'état
n'a pas de représentation propre (la fermeture de l'issue, par exemple).

| Canonique | GitHub (`missions`) | Jira (exemple à trois statuts) |
|---|---|---|
| `to-refine` | label `to-refine` | `To Do` |
| `ready` | label `ready` | `To Do` + libellé `ready` |
| `in-progress` | label `in-progress` | `In Progress` |
| `in-review` | label `in-review` | `In Review` |
| `ready-for-prod` | label `ready-for-prod` | `Ready for prod`, ou les statuts de déploiement du projet (`Local Testing`, `Staging Test`) |
| `done` | fermeture de l'issue | `Released` (Manager), `Done` (Connect) |
| `bug` | type `Bug` | type `Bug` |
| `story` | type `Feature` | type `Story`, `Task` |
| `urgent` / `high` / `normal` / `low` | label `priority:*` | `Highest` / `High` / `Medium` / `Low` |
| story points | label `sp:N` | champ `story_points_field` (défaut `customfield_10016`) |

Jira nomme `Story` et `Task` deux types distincts : le workspace n'en fait
qu'un, la mission `story`. `Epic` et `Sub-task` restent sans traduction — un
epic n'est pas une mission.

Deux conséquences :

- Un projet dont le `map` est incomplet ne peut pas recevoir de mission : on ne
  devine pas où poser un état.
- Deux projets peuvent nommer le même état différemment — c'est le `map` qui
  fait foi, jamais la mémoire de qui travaille.
