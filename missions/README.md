# La mission

Une mission est un travail suivi par **un ticket de tracker**. Sa fiche, son
état et son historique vivent dans le tracker ; le workspace ne garde que ce que
le tracker ne sait pas porter : la branche de la mission et sa base.

## Identité

| Tracker | Forme | Exemple |
|---|---|---|
| Jira | `<RÉFÉRENCE>-<numéro>` | `EX-1541`, `EX-1207` |
| GitHub | `<RÉFÉRENCE>-<numéro>` | `MIS-52` |

La clé est l'identifiant de travail, partout et sans exception : nom de branche,
préfixe de commit, message de PR, liens entre tickets. On ne réinvente pas de
numérotation locale. La référence est déclarée par le **tracker** dans
[`projects.example.yml`](projects.example.yml), recopié localement en
`projects.yml` (ignoré par git) ; sur GitHub, elle préfixe le numéro de
l'issue, dont l'URL reste `…/issues/52`. Deux projets qui travaillent la même
board partagent donc la même référence : c'est elle qui range une clé.

## Deux déclarations : le tracker et le projet

Un **tracker** est ce qui se lit : une board Jira ou un dépôt GitHub. Un
**projet** est ce qui se travaille : un clone sur le poste. Le fichier local
`projects.yml` porte les deux sections, dans cet ordre.

```yaml
trackers:
  - id: soc
    name: Connect board
    reference: SOC
    tracker: jira
    jira: { site: …, email: …, story_points_field: … }
    map: { … }

projects:
  - id: clienthub
    repo: ~/projects/clienthub
  - id: backend
    repo: ~/projects/backend
```

- Le tracker porte la `reference`, le bloc `jira` ou `github`, et la `map` qui
  traduit le vocabulaire canonique. Il est lu **une seule fois**, même si
  plusieurs projets le partagent.
- Le projet porte le `repo` (obligatoire) et, pour Tolgee, ses `translations`.
  Il ne porte **pas** de board : la clé de la mission désigne la board, le
  `project` de son `mission.yml` désigne le dépôt.
- Une `reference` est unique **entre trackers**, jamais entre projets : deux
  projets peuvent la partager. Le panneau refuse deux trackers qui la
  revendiquent.
- L'identité d'une mission est le couple **(dépôt, clé)**. `SOC-1493` déclarée
  par `clienthub` et par `backend` sont deux missions distinctes, avec deux
  dossiers, deux branches et deux worktrees. La même clé deux fois dans le même
  dépôt est une erreur, qui nomme les deux dossiers.
- Un dossier `mission.yml` sans `project` reste **sans dépôt** : aucun projet
  n'est choisi à sa place, même quand la board n'en déclare qu'un. Le volet
  affiche « No repository » et n'ouvre pas de session avant le choix.

`blocked`, `priority` et `points` n'ont besoin que de la clé : la board suffit
et le dépôt n'est pas lu. Les routes qui touchent au checkout (`tolgee`,
`local-close`, `archive`) reçoivent le `project` avec la clé et refusent sans
lui avec `400 project is required` — jamais en choisissant un dépôt.

### Migrer un ancien `projects.yml`

L'ancien schéma gardait `reference`, `tracker` (le type), `github`/`jira` et
`map` sur chaque projet. Le nouveau les déplace dans `trackers:` :

1. recopiez le fichier local (il est ignoré par git) ;
2. créez un tracker par board, avec sa `reference`, son type, ses accès et sa
   `map` ;
3. ne gardez sur chaque projet que `id`, `name`, `repo` et, le cas échéant,
   `translations` ;
4. déclarez le dépôt de chaque mission dans son `mission.yml` (`project:`),
   quand il n'y est pas déjà.

Un fichier resté à l'ancien schéma est refusé avec un message qui nomme la
section `trackers:` manquante, jamais par un panneau vide. Un projet qui garde
`reference`, `map` ou `tracker` est refusé de la même façon, avec le dépôt et le
champ en cause : la board vient de la clé de mission, jamais du dépôt.

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
project: missions
branch: feat/mis-41
base: main
```

Une mission découpée à la revue déclare une **liste ordonnée de paires**,
`branches:`, à la place de `branch`/`base` — les deux formes ne se mélangent
pas :

```yaml
key: MIS-90
project: missions
branches:
  - branch: fix/mis-90-p1
    base: main
  - branch: fix/mis-90-p2
    base: fix/mis-90-p1
  - branch: fix/mis-90
    base: fix/mis-90-p2
```

La première paire donne la **base de mission** (`main` ci-dessus) : c'est elle
que la clôture lit comme base de référence, et chaque partie s'empile sur la
précédente. La branche d'origine reste la dernière partie ; `mission.branch`
et `mission.base` valent la première paire pour le code qui n'a pas besoin de
la liste.

- **`key` fait foi** : c'est lui qui relie le fichier à la mission du tracker
  (`MIS-52` ou clé Jira). Le nom du dossier est libre ; quand il manque, le
  panneau le crée à partir de la clé en remplaçant les caractères non
  alphanumériques par des tirets (`MIS-41`, `daedalforge-missions-41`). La
  correspondance est exacte : après le passage à `MIS-n`, une déclaration
  restée sur l'ancienne clé `daedalforge/missions#n` ne correspond plus à la
  mission ; renommer `key` dans le fichier (le dossier peut garder son nom).
- **`project` nomme le dépôt** : c'est l'id d'un projet de `projects.yml`. Il
  est facultatif, mais sans lui la mission reste « sans dépôt » : aucun projet
  n'est retenu à sa place. Deux dossiers peuvent déclarer la même clé dans deux
  dépôts ; la même clé deux fois dans le même dépôt est une erreur, qui nomme
  les deux dossiers.
- **Pas de session sans les deux** : un dossier absent, ou un champ manquant,
  laisse `branch`/`base` vides ; le volet de détail laisse alors les champs
  vides et désactive « Start a session » plutôt que de supposer une branche.
- **Une seule forme à la fois** : mélanger `branch`/`base` et `branches`, vider
  la liste, répéter une branche, omettre `branch` ou `base` dans une paire, ou
  écrire un champ inconnu est refusé en nommant le champ. Sauver une seule
  paire sur un fichier qui en déclare plusieurs est refusé sans écrire : la
  liste s'écrit par la route `POST missions/api/branches`, jamais à la main.
- **Le volet suit la liste** : à plusieurs paires, il affiche les branches et
  leurs bases (la première marquée « base de mission ») et masque les deux
  champs ; à une paire, l'éditeur reste exactement celui d'avant, et une
  sauvegarde qui ne porte pas `branches` retire la liste.
- **Une erreur se voit** : champ inconnu, clé dupliquée entre deux dossiers,
  YAML invalide ou valeur vide sont signalés dans le panneau, pas avalés. Le
  volet peut réparer une valeur vide ou mal typée en l'enregistrant ; un champ
  inconnu, lui, reste signalé et refuse la réécriture.
- **Une déclaration sans mission affichée n'est pas une erreur** : une mission
  fermée ou assignée à quelqu'un d'autre garde son dossier sans apparaître dans
  le panneau.
- **Le dossier se crée au cadrage**, quand la fiche est validée ; la branche
  elle-même ne s'ouvre qu'à l'exécution, depuis `base`.

**Le worktree de la mission** : la branche ne s'ouvre jamais dans le clone.
Chaque exécution travaille dans `~/projects/<clone>-<CLÉ>` — un enfant direct
de `~/projects`, dérivé du clone et de la clé — et le clone reste sur sa base,
réservé aux tests manuels avant validation. Le panneau nomme ce chemin dans le
prompt d'exécution, dans celui des remontées de PR, dans celui de la session
libre et dans celui de la découpe ; `missions/<dossier>/` et `playbook/`
restent dans le clone, que le panneau lit. Une mission découpée garde le même
worktree : il reste sur la branche d'origine, qui est la dernière partie de la
pile.

### Découper une PR en plusieurs (revue)

Une PR trop grosse pour la revue peut être découpée en plusieurs PR empilées,
mais **seulement à l'étape revue** : le bouton « Split into several PRs » du
volet, désactivé par le même blocker que la session, ouvre une session dédiée
sur `splitSessionPrompt(mission)`. Il n'apparaît que pour une mission à une
paire et disparaît une fois la liste déclarée.

La session retrouve la PR de la branche, lit les commits depuis la base,
propose les bornes et **attend une confirmation explicite** avant d'agir. Elle
crée chaque partie au commit de coupe (`git branch <partie> <commit>`), sans
commit nouveau et sans force-push : la partie 1 part de la base de mission, la
partie k de la partie k-1, et la branche d'origine devient la dernière partie.
Elle pousse les branches, ouvre une PR pour chaque partie précédente (la 1
vers la base de mission, la k vers la k-1), puis retargete la PR d'origine sur
la partie précédente — elle reste la PR de la dernière partie ; elle écrit la
liste `branches:` **par la route** (`POST missions/api/branches`) et
consigne la découpe au journal. Elle ne merge pas, ne ferme rien, ne pose aucun
label, n'approuve pas et n'écrit pas sur `main` : le merge et la fermeture
restent les gestes du demandeur.

La revue lit alors **chaque PR** ; `ready-for-prod` n'est posé que si chacune
est validée, et un refus nomme celle qui manque. Les remontées de revue
corrigent la branche concernée, sans merger ni résoudre les fils.

**Depuis le panneau** : le volet de détail se lit en trois onglets —
**Details** (propriétés et champs ci-dessous), **Journal** et **Checklist** —
et les actions restent en pied de volet, sous les onglets. Elles tiennent en une
seule rangée d'icônes — ouvrir le ticket, vérifier les remontées d'une PR,
découper la PR en plusieurs, démarrer une session libre, fermer le checkout
local, archiver une mission terminée, démarrer la session de l'étape — et
chaque bouton porte son nom dans
une infobulle (`title`) comme dans
son libellé accessible (`aria-label`) : l'icône se reconnaît au survol et au
lecteur d'écran, et la rangée tient sur une ligne. Aucun geste ne fait
exception, destructifs compris : **« Close the local checkout »** est l'icône qui
ouvre la rangée, loin de la session primaire, et son premier clic l'arme — le
dessin devient une coche, le bouton se remplit de la couleur danger et son nom
devient « Confirm — close the local checkout » ; le second clic ferme, et la note
sous le volet dit ce que le geste supprime.
Journal et Checklist prennent la hauteur restante,
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

La ligne **Points** se choisit dans l'échelle du panneau — `0.5, 1, 2, 3, 5,
8, 13` — comme la priorité : le volet envoie `POST missions/api/points` avec la
clé et la taille, l'hôte traduit la taille avec la table du projet, et le
panneau n'a ni jeton ni valeur de tracker. La ligne ne bouge qu'une fois le
tracker d'accord ; un refus laisse l'ancienne taille et affiche l'erreur sous la
ligne. Une mission sans estimation montre une option vide « No points », non
sélectionnable ; une taille hors échelle (`4`, héritée du tracker) reste
offerte en fin de liste, sélectionnée. Choisir la taille déjà affichée n'écrit
rien. Une clé inconnue, une taille hors échelle ou un projet dont la `map` ne
déclare pas de forme native sont refusés avant le tracker, avec leur message.
Poser les points remplace : le champ `Story point` porte un nombre, l'écrire
écrase l'ancienne valeur sans laisser de trace.

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
  `ready-for-prod`, sans conflit d'état) et les PR de la branche : il faut
  une PR mergée vers la base déclarée, et un merge commit (ou la tête) ancêtre
  de `origin/<base>`. Le projet squash-merchant, la branche locale n'est jamais
  ancêtre de la base : la preuve part de `head.sha` de la PR, et
  `git rev-list --first-parent <head.sha>..<branche>` doit être vide ou ne
  contenir que des merges de synchronisation (autres parents sur
  `origin/<base>`). Un `git fetch` précède la seconde vérification. Sans
  preuve, rien n'est supprimé.

  Pour une mission découpée, la preuve se fait **paire par paire** : chaque PR
  doit être mergée vers la base de sa paire, et son merge commit ancêtre de
  `origin/<base de mission>` (la base de la première paire). Un refus nomme la
  paire (`MIS-90 (fix/mis-90-p2 sur fix/mis-90-p1): …`) et ne supprime rien.
- **Deux temps.** Un premier clic annonce ce qui va disparaître, un second
  envoie la clé. Le panneau n'envoie que `{ key }` : chemins, noms et gestes
  sont décidés par l'hôte.
- **Ce qu'il fait.** `git worktree remove` (jamais `--force`, un worktree sale
  refuse) ; le clone passe sur la base par `checkout` puis
  `merge --ff-only origin/<base>` ; `git branch -D` sur chaque branche de la
  liste ; les lignes sont retirées de `.git/machete` à la main, en une seule
  réécriture (enfants remontés, annotations conservées, aucun processus
  `git machete`) ; une section `## <date> — Clôture` est ajoutée au journal,
  avec une ligne `- PR :` et une ligne `- Branche :` par paire.
- **Ce qu'il ne fait pas.** Aucun écrit tracker, aucune branche distante, aucun
  `main` touché. Chaque refus (pas de clone, état, PR, base, commit, worktree
  sale, commit local non livré) est un 409 et un message, sans suppression
  partielle.

### Archiver une mission

Une mission `done` peut être rangée depuis le volet, onglet **Done** :
l'icône **« Archive »**, en tête de la rangée du pied, déplace son dossier sous
`missions/archives/<dossier>/`. Comme la clôture locale, elle se confirme en
deux clics : le premier l'arme — coche, fond plein, nom « Confirm — archive the
mission » — le second envoie. Sous le pied, la note d'une mission `done` nomme
ce geste (« This mission is done: no session. Archive moves the folder to
missions/archives. ») au lieu de la phrase de blocage de session : sur une
mission fermée, l'archive est la seule action possible, et la note doit dire
laquelle. Le clic qui confirme se compte (`mission.archive` dans le relevé).

**Archiver en lot.** La barre de la liste Done porte le même geste sur toutes
les lignes affichées : « Archive N missions », N étant `filtered` — recherche
et filtres compris, jamais une mission qu'un filtre écarte. Le premier clic
arme et dit la destination (`missions/archives/`), le second envoie une seule
requête `POST archive-batch` avec les clés rendues. L'armement porte la
signature de ces clés : un filtre changé, une recherche vidée ou une relecture
silencieuse entre les deux clics font du clic suivant un nouvel armement,
jamais une confirmation à l'aveugle. L'hôte relit une fois la preuve `done` par
projet, puis déplace les dossiers un à un ; un refus ne défait pas les autres
et se dit (« Archived 2 of 3; 1 refused: MIS-… »), les lignes refusées restent
en place, un échec de la route ne retire rien. Le lot se compte au clic
confirmé (`mission.archive.batch`, détail = nombre de clés). Comme l'archive
simple, il ne touche ni le tracker ni `main`.

- **Ce qu'il déplace.** Le dossier entier, avec son nom, son `mission.yml`, son
  journal et sa checklist. Rien n'est supprimé, rien n'est réécrit.
- **Ce qu'il vérifie.** L'hôte relit l'issue fermée dans le tracker et refuse
  (409) tout dossier absent, dont la mission n'est plus `done`, ou dont
  l'archive du même nom contient un fichier différent. Le panneau n'envoie que
  `{ key }` ; le second clic confirme.
- **Une clé re-déclarée.** Une clé archivée peut être redéclarée plus tard
  (même ticket, nouveau dossier) : le dossier neuf se range dans l'archive
  existante au lieu d'être refusé. Un fichier que l'archive tient déjà, octet
  pour octet, est le même fichier — il n'est pas dupliqué — ; un fichier qui
  diffère refuse le geste avec son nom (`missions/archives/<dossier> already
  exists: journal.md differs`) et rien n'a bougé. Un dossier d'archive qui
  n'est pas un dossier est refusé de même.
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

## La board vient de la clé, le dépôt de la mission

`projects.yml` déclare deux choses séparées : les **trackers** (les boards :
référence, accès, `map`) et les **projets** (les dépôts du poste : `repo`,
`translations`). Le gabarit versionné est
[`projects.example.yml`](projects.example.yml).

La board d'une mission vient de sa clé : c'est la référence du tracker qui la
préfixe, la plus longue d'abord. Aucun dépôt ne porte de board, et un dépôt peut
travailler des missions de plusieurs boards.

Le dépôt d'une mission se déclare dans son `mission.yml` (`project:`, l'id d'un
projet). C'est lui qui décide de tout ce qui touche au travail : le clone d'où
part le worktree `~/projects/<clone>-<CLÉ>`, le prompt de session, la PR, la
vérification Tolgee. Changer le `project` d'une mission change donc de dépôt,
pas de board. À la création, le panneau demande les deux : la board (Project)
qui reçoit l'issue, et le dépôt (Repository) qui la travaillera ; le
`mission.yml` du dossier est écrit dans la foulée. Tant qu'aucun dépôt n'est
déclaré, « No repository » s'affiche et « Start a session » reste fermé.

## Gabarit

La fiche d'une mission se crée dans le tracker à partir de
[`gabarit-mission.md`](gabarit-mission.md). Les sections sont les mêmes pour
Jira et GitHub ; seuls les champs natifs de l'outil (statut, assigné, sprint)
diffèrent et ne sont pas dupliqués dans la description. La section
`## Estimation` ne recopie pas le calcul : elle dit la taille retenue, celle que
le tracker porte déjà.

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

## Champs GitHub

Une issue porte **un type** natif et **un état** en champ d'organisation. Le
type dit la nature du travail — `Bug` ou `Feature` sur GitHub, `Bug`, `Story` ou
`Task` sur Jira —, l'état dit où en est la mission. Les deux sont indépendants :
une story peut être en revue, un bug peut être prêt.

| Champ | Rôle |
|---|---|
| `Workflow stage` = `To refine` | cadrage non fait ou à refaire |
| `Workflow stage` = `Ready` | cadrage validé, prête à exécuter |
| `Workflow stage` = `In progress` | branche ouverte, exécution en cours |
| `Workflow stage` = `In review` | PR ouverte, en attente de revue |
| `Workflow stage` = `Ready for prod` | revue faite, en attente de livraison |
| `Priority` = `Urgent` · `High` · `Medium` · `Low` | priorité, une seule par issue |
| `Story point` = `0.5` · `1` · `2` · `3` · `5` · `8` · `13` | story points, une seule valeur par issue |
| label `blocked` | mission bloquée : la raison est en commentaire de l'issue |

Ces trois champs sont propres à l'organisation et partagés par ses dépôts ;
`projects.yml` les nomme dans le bloc `fields` du tracker, et la `map` nomme
leurs options. Le panneau les écrit par ses routes ; une session les écrit par
`node tools/field.mjs` (`state`, `priority`, `points`). Une issue porte **un
seul** type natif et **une seule** option d'état : le choix unique rend deux
états simultanés impossibles — l'ancien conflit de libellés n'existe plus.
Fermer l'issue est l'état terminé : il n'y a pas d'option `Done`. Un blocage se
dit par le label `blocked` **et** sa raison en commentaire : le label dit qu'on
est bloqué, le commentaire dit pourquoi et par quoi. `blocked` n'est pas un état
— il ne remplace jamais l'état en cours, et une mission bloquée garde son état —
il n'empêche pas non plus de démarrer une session : il informe. Le retirer,
c'est débloquer, et cela ne poste rien d'autre. L'epic n'est pas un label :
c'est un milestone.


## Lecture

Le panneau lit **une board par tracker**, pas une board par projet. Deux
projets qui pointent sur le même tracker partagent donc une seule lecture : la
liste ne duplique aucune clé, et chaque ligne est ensuite attribuée au projet
que son dossier déclare.

- **Indépendance.** Un jeton absent, un quota épuisé, une panne réseau ou des
  droits insuffisants d'un côté ne suspendent pas la lecture des autres
  trackers ; l'erreur s'affiche pour le tracker concerné, les autres restent
  lisibles.
- **Aucune hypothèse partagée.** Deux trackers ne partagent ni vocabulaire, ni
  pagination, ni cadence de lecture. Ce qui vaut pour l'un n'est pas supposé
  pour l'autre.
- **Identité complète.** Une mission affichée porte toujours son projet et sa
  clé (`MIS-52`, `EX-1234`). Deux clés identiques dans deux projets restent deux
  missions distinctes ; une clé que nul dossier ne déclare s'affiche **sans
  projet** et garde ses gestes de lecture.
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
dans `projects.yml` (copie locale), bloc `map`. Sur GitHub, elle porte sur les
**champs d'organisation** que déclare le bloc `fields` (`Workflow stage`,
`Priority`, `Story point`) : la `map` nomme alors l'option du champ, jamais un
label, et une valeur `null` dit que l'état n'a pas de représentation propre (la
fermeture de l'issue, par exemple). `blocked` échappe à la table : il ne se
traduit pas, se pose tel quel sur le ticket, et c'est le seul label que la
board garde. L'hôte écrit l'état, la priorité et l'estimation par ses routes,
parce qu'il n'a pas de jeton ; la session les écrit par
`node tools/field.mjs`.

`points` suit la même règle que `priority`, à une différence près : la taille
est un nombre, pas un mot du workflow. C'est l'hôte qui l'écrit — champ
`Story point` sur GitHub, `story_points_field` du projet sur Jira — et il refuse
d'écrire quand la déclaration ne donne pas de forme native. Le panneau ne
l'édite jamais : elle se pose au cadrage.

| Canonique | GitHub (`missions`) | Jira (exemple à trois statuts) |
|---|---|---|
| `to-refine` | champ `Workflow stage` = `To refine` | `To Do` |
| `ready` | champ `Workflow stage` = `Ready` | `To Do` + libellé `ready` |
| `in-progress` | champ `Workflow stage` = `In progress` | `In Progress` |
| `in-review` | champ `Workflow stage` = `In review` | `In Review` |
| `ready-for-prod` | champ `Workflow stage` = `Ready for prod` | `Ready for prod`, ou les statuts de déploiement du projet (`Local Testing`, `Staging Test`) |
| `done` | fermeture de l'issue | `Released` ou `Done` (selon le projet) |
| `bug` | type d'issue `Bug` | type `Bug` |
| `story` | type d'issue `Feature` | type `Story`, `Task` |
| `urgent` / `high` / `normal` / `low` | champ `Priority` = `Urgent` / `High` / `Medium` / `Low` | `Highest` / `High` / `Medium` / `Low` |
| story points | champ `Story point` (nombre) | champ `story_points_field` (défaut `customfield_10016`) |
| bloquée | label `blocked` (le seul label de la board) | label `blocked` |

Jira nomme `Story` et `Task` deux types distincts : le workspace n'en fait
qu'un, la mission `story`. `Epic` et `Sub-task` restent sans traduction — un
epic n'est pas une mission.

Deux conséquences :

- Un projet dont le `map` est incomplet ne peut pas recevoir de mission : on ne
  devine pas où poser un état.
- Deux projets peuvent nommer le même état différemment — c'est le `map` qui
  fait foi, jamais la mémoire de qui travaille.
