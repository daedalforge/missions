# Workspace missions

L'épine dorsale du workspace tient en deux dossiers versionnés — ce qu'est une
mission (`missions/`) et comment elle avance (`workflows/`) — plus un dossier
local, `playbook/`, qui dit comment on la joue. Le code et les outils du plugin
s'y accrochent ; la configuration et le playbook restent sur le poste.

## Installation

Le plugin n'est pas publié sur npm : il s'installe depuis ce dépôt dans un
profil DSH.

```sh
dsh plugin --profile desktop add github:daedalforge/missions
```

Remplacer `desktop` par le profil utilisé (`web`, `tui`, ...). Au premier
démarrage, le panneau n'a encore aucun projet. La déclaration vit hors du
paquet, dans `$DSH_HOME/missions/projects.yml` (`~/.dsh` par défaut) :

```sh
mkdir -p "${DSH_HOME:-$HOME/.dsh}/missions"
curl -fsSL https://raw.githubusercontent.com/daedalforge/missions/main/missions/projects.example.yml \
  -o "${DSH_HOME:-$HOME/.dsh}/missions/projects.yml"
```

Puis adapter le fichier aux dépôts et trackers du poste. Le playbook local se
place dans `$DSH_HOME/playbook/` ; aucun des deux n'est nécessaire pour lancer
le panneau.

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
n'est pas le workflow mais le **tracker** : une mission d'un projet Jira s'ouvre
sur Jira, une mission d'un projet GitHub s'ouvre sur GitHub. Le projet, son dépôt
et son tracker sont déclarés sur chaque poste dans
`$DSH_HOME/missions/projects.yml` (ou `missions/projects.yml` dans un clone),
une copie locale et ignorée par git de
[`missions/projects.example.yml`](missions/projects.example.yml).

## Les trois piliers

- [`missions/`](missions/README.md) — la mission : son identité, ses états, où
  elle vit, le gabarit qui la décrit, et le tableau des projets.
- [`workflows/`](workflows/README.md) — le parcours : une page par étape, plus
  la table de correspondance entre états du workflow et états du tracker.
- `playbook/` (local au poste, ignoré par git) — le mode d'emploi par étape :
  la recette, les règles (code, revue, interdits) et la fiche du dépôt. Son
  contrat de lecture dit quelle page chaque étape lit ; le prompt de session
  nomme cette page, et la session la suit au lieu de redériver la recette. Ses
  pages sont propres à une équipe ou à une entreprise, donc elles ne sont pas
  versionnées.

`workflows/` dit **quoi** faire et garde les états ; `playbook/` dit **comment**,
**sous quelles règles** et **dans quel dépôt**. Une page de playbook ne recopie
pas `workflows/`, elle le cite.

## Ce qui reste sur le poste (hors dépôt)

Le dépôt ne versionne que le code et la méthode générique. Trois choses vivent
uniquement sur le poste, parce qu'elles nomment des projets, une équipe ou une
identité :

- `$DSH_HOME/missions/projects.yml` — la déclaration des dépôts et trackers du
  poste. Copier `missions/projects.example.yml` à cet emplacement, puis
  l'adapter. Le fichier est ignoré par git ; le panneau le lit au démarrage.
- `$DSH_HOME/missions/pins.yml` — les missions épinglées de ce poste, écrites
  par la punaise du volet. Le fichier est ignoré par git : une épingle range la
  liste pour soi, elle ne se partage pas. Le panneau le crée au premier geste ;
  absent, le fichier vaut « rien d'épinglé ».
- `$DSH_HOME/playbook/` — les pages de méthode propres à une équipe ou à une
  entreprise. Le panneau les lit sur le poste ; elles ne partent pas avec le
  clone.
- `config/` — les dotfiles Emacs et Ghostty, `config/links-home.yml` et
  l'empreinte GPG utilisée pour chiffrer les fichiers `.gpg`. Rien de tout cela
  n'est nécessaire au plugin.

Pour retrouver ces réglages sur un autre poste, copier les trois depuis le
poste d'origine (ou depuis un dépôt privé de dotfiles), puis :

1. `cp missions/projects.example.yml "${DSH_HOME:-$HOME/.dsh}/missions/projects.yml"`
   et adapter les projets ;
2. copier `playbook/` dans `${DSH_HOME:-$HOME/.dsh}/playbook/` ;
3. copier `config/`, puis `node tools/link-config.mjs --check` pour voir les
   liens à poser et `--apply` pour les poser. Dans
   `config/tools/emacs/init-crypto.el`, remplacer l'empreinte par la sienne :
   `epa-file-encrypt-to` ne contient qu'une clé **publique**, jamais la clé
   privée, qui reste dans `~/.gnupg`.

`node tools/link-config.mjs` lit `config/links-home.yml` par défaut ; l'option
`--manifest <fichier>` permet d'en éprouver un autre.

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
Sa **pastille** affiche le nombre de ces missions closes déclarées : ce compte
se lit au montage, sur sa propre route, sans ouvrir l'onglet ni transporter les
lignes — la lecture close qu'il paie est celle de Done, partagée quand l'onglet
s'ouvre, et les lignes restent demandées à l'ouverture. Avant cette première
réponse, la pastille porte l'icône de refresh animée du thème, pas un zéro.

Depuis cet onglet, une mission close peut être **archivée** : son dossier passe
sous `missions/archives/<dossier>/`, rien n'est supprimé et le tracker n'est pas
modifié — la mission quitte Done et reste sur le disque.

Done affiche ces closes avec l'arbre des missions : le même champ de recherche
(`aria-label` « Done outline »), les mêmes filtres Type, Épic, Projet,
Priorité, Clear et Missing, les mêmes ancres de checklist, le même volet et le
même clavier. Seul le statut est figé — aucune barre d'états, aucun select — et
le pied de liste compte les lignes closes (`N done`).

L'onglet **Missions** est une liste plate : les missions ouvertes, une par
ligne, à gauche de son volet droit. L'épic n'est plus un niveau de l'arbre mais
une colonne : chaque ligne montre la clé courte de son épic (`MIS-2`), ou une
cellule vide quand la mission n'en a pas. Le titre de l'épic n'est plus
cherchable — une requête par nom d'épic ne déplie plus rien — mais la clé
reste lisible en tête de ligne. Chaque ligne nomme sa priorité : le repère de
trois barres, lu par le lecteur d'écran (« Priority: High », « No priority »
sans niveau), garde sa forme. Elle porte aussi ses story points en texte
(« 5 pts », « 1 pt », rien quand le tracker n'en donne pas),
entre le repère de priorité et la clé de la mission. L'ordre de la liste
est fixe : priorité décroissante, puis story points croissants, puis clé
de la mission. Une mission bloquée ferme la liste : elle passe après toutes
les missions actionnables, quels que soient sa priorité et ses points. Elle
l'est par le label `blocked` — dont la raison reste un commentaire du ticket —
ou par une dépendance Jira : un lien `Blocks` entrant vers une mission qui
n'a pas encore atteint la revue. Entre missions bloquées, celle dont la raison
nomme la clé d'une autre, ou qui porte cette clé en dépendance, attend que
celle-ci passe d'abord ; la contrainte se propage, et un cycle garde l'ordre
de base. La punaise d'une mission la fait passer devant toutes les autres,
sans changer cet ordre : épingler ne réordonne pas les épinglées entre elles,
et une requête garde ses épinglées en tête. Une seule exception va contre
l'épingle : une mission bloquée ne passe jamais devant son bloqueur visible,
même épinglée. Pendant le défilement de la liste, les épinglées tiennent
le haut : elles restent visibles au-dessus des lignes qui passent dessous,
détachées du reste par une règle et un peu d'air. Au repos, la
liste et le volet vide partagent la largeur : le volet annonce ce qu'une
mission ouvrira, comme celui de Done. Ce volet est monté dans les cinq onglets
du panneau — seul l'onglet qui le remplit change ; la liste, elle, garde sa
grille à une colonne.
Le champ de recherche **est** la barre de la liste — `⌘K` l'ouvre, `↑` `↓`
promènent le surlignage, `Entrée` ouvre la fiche, `Échap` referme le volet puis
vide la requête, sans quitter la liste. Les filtres (Type, Epic, Project, Priorité,
Clear, Missing) vivent dans cette colonne, sous le champ et au-dessus de
la bande d'états ; Type, Epic et Project s'ouvrent sur une liste de cases à
cocher — cocher plusieurs valeurs les réunit en OU dans la dimension, les
dimensions restant combinées en ET — et la barre du dessus ne garde que le
libellé Outline et Refresh. Un même matcher répond sur la clé (`206`
trouve `MIS-206`), le titre et la ligne de checklist — une mission trouvée par sa
checklist montre au plus deux ancres puis `+N`, avec son compte
`checklist 3 / 5`. Le compte du champ
nomme **une** famille (`1 of 12`, `2 actions`) : il n'est jamais additionné à
un compte de lot. La bande d'états remplace le select Statut et garde les
comptes du portefeuille pendant toute requête. Un clic sur une ligne, ou
`Entrée` sur la ligne surlignée, ouvre la fiche **dans le volet droit de
l'onglet** : le volet de Done, la même largeur, la même fiche — la liste garde
la place qu'elle occupe et le volet prend la sienne. `×` ou `Échap` referment
la fiche ; le volet reste en place, vide, à sa largeur, et la liste ne reprend
pas la place. `Échap` ne vide la requête qu'une fois le volet fermé. Déplacer
le surlignage ne change pas la fiche ouverte, et la sélection survit au
changement d'onglet : revenir sur Missions rouvre la fiche,
un volet fermé le reste. La fiche **lit et
écrit** au même endroit — ses onglets, sa déclaration de branche, sa priorité,
son blocage et sa punaise restent ses seuls gestes ; surligner une action de
déclaration la laisse telle quelle. La punaise est le premier bouton du pied du
volet : elle ne dépend ni de l'état ni de la déclaration de la mission, et son
propre refus (un `pins.yml` cassé) laisse l'affichage en place en le disant.

Une ligne de mission fait 38 px et un filet sépare deux missions voisines,
jamais avant la première ni après la dernière. Sous 900 px, le volet garde la
largeur de celui de Done (`max-width: 46 %`) et la liste prend le reste : rien
ne déborde horizontalement. Les lignes de checklist viennent de
`GET missions/api/checklist-index`, mémorisé trente secondes (`?refresh=1` le
paie à nouveau) : une lecture disque par ouverture de panneau, pas une par
frappe. Les gestes comptent `search.q` (palier de longueur), `search.family`,
`preview.kind` (`mission` seulement), `mission.open` avec son `from` (`row`) et
`mission.pin` (`pin` ou `unpin`). **Done** monte le même arbre, avec son
propre champ et ses propres filtres : un seul chemin de liste pour les deux
onglets.

Le **Dashboard** ajoute deux sections à son périmètre. **Repositories**
croise les missions ouvertes avec le scan des dépôts — la route
`missions/api/repositories/summary`, mémorisée cinq minutes
(`SUMMARY_TTL_MS`) et partagée entre appels simultanés — en deux cartes :
*Branches to push* (une branche de mission que le scan porte, jamais poussée
ou en avance sur son amont) et *Checkouts to fix* (un dépôt illisible, en
retard ou sale, une raison par ligne, la plus grave). **Done** relit ce que
l'onglet Done a déjà ramené : les trois closes les plus récemment mises à
jour, et celles dont la branche déclarée vit encore dans un worktree du scan.
Le résumé des dépôts ne se relit qu'à l'ouverture du Dashboard et à son tick,
quand c'est l'onglet ouvert et la page visible, jamais avec `?refresh=1` : le
bouton **Retry** est le seul à forcer. Un scan en échec garde les lignes et
nomme l'échec, jamais un zéro.

Le **Dashboard** garde son volet droit, vide : le digest, ses quatre cartes et
ses sections occupent la largeur restante, et chaque ligne ouvre la mission dans
l'onglet Missions, sa fiche complète. Le volet ne s'y remplit jamais — pas même
quand une mission est choisie ailleurs. Done et Repositories gardent leur volet,
comme avant : la fiche de la mission close ou celle du dépôt choisi, et
l'invitation quand rien n'est choisi.

Un projet peut déclarer ses **traductions** dans sa copie locale de
`missions/projects.yml` — `translations.locales`,
`translations.languageFile`, `translations.reference`. Le volet d'une mission de
ce projet gagne alors un bouton **Tolgee import** : il lit le contenu de la
branche (`git show <branche>:<fichier>`) pour les fichiers que son diff change,
relève les clés `t()` qu'ils utilisent et écrit
`missions/<dossier>/import-tolgee.xliff` avec celles qui manquent ou sont vides
dans au moins une locale déclarée. Les clés sans valeur dans la locale de
référence sont listées à part, jamais dans le fichier ; Tolgee n'est jamais appelé, l'import du fichier
reste un geste manuel.

## Les thèmes

Le panneau propose deux thèmes, choisis dans le sélecteur **Theme** et retenus
dans la session (`missions.theme`) : **Default** et **Naruto**. Un thème n'a pas
sa propre copie de la mise en page : le thème illustré porte la peau
`data-skin="paper"` et n'apporte que ses tokens `--skin-*` et ses rares
variantes de décor. Naruto affiche la photo du village, le portrait de Konoha,
le kicker « Konoha · mission log » et la marque 忍, en clair comme en sombre. Le
thème par défaut garde le panneau sobre du host ; une valeur stockée inconnue,
comme l'ancien identifiant `noel`, retombe sur Default.

## La barre et Settings

La barre porte cinq onglets — **Dashboard**, **Missions**, **Done**,
**Repositories**, **Settings** — chacun devant son icône : un trait géométrique
dans le thème par défaut, un motif manga dans le thème manga. Le libellé reste
le nom accessible ; l'icône n'est qu'un repère (16 px, `currentColor`). Les
pastilles de compte restent sur Missions, Done et Repositories. Tant qu'un
compte n'est pas prouvé, la pastille porte l'icône de refresh du thème, animée,
à la place du nombre ; le chiffre la remplace à la première réponse entière,
sans requête de plus.

La pastille de **Missions** se comporte de même : elle attend la première
réponse de la liste ouverte pour publier son compte. Un zéro n'est donc publié
que si la liste a répondu — un premier échec ou une première réponse partielle
laisse la pastille en attente, et une relecture ultérieure garde le chiffre déjà
prouvé au lieu de ramener le loader ou de repasser par zéro.

**Repositories** ne montre par défaut que les clones de la racine du workspace :
un worktree est un second checkout d'un dépôt déjà listé, et l'en-tête continue
de le compter même quand sa ligne est cachée. Un interrupteur **Show worktrees**
dans l'en-tête de la liste les isole : activé, la liste ne garde que les
worktrees non principaux, aucun clone. Le choix ne vit que la session —
`missions.repositories.worktrees` dans `sessionStorage` — si bien que revenir
sur l'onglet le retrouve et que fermer la fenêtre l'oublie. Une racine qui ne
porte que des worktrees le dit, au lieu de paraître vide ; activé sans worktree,
l'interrupteur le dit aussi et reste à portée pour rendre les clones.

Entre l'en-tête et la liste, quand le genre affiché a des lignes, la barre de
**Repositories** cherche dans le nom, la branche affichée et le sujet du dernier
commit — jamais dans le chemin — et son filtre **State** garde les lignes qui
répondent à l'un des quatre états : **Clean**, **Dirty**, **Detached**,
**Unreadable**. Les états se recouvrent (un dépôt détaché et sale répond aux
deux), la recherche et les états se combinent, et le tout s'applique au genre
que le switch montre : l'en-tête et les pastilles, eux, restent les comptes du
scan. Quand aucune ligne ne répond, la liste le dit et un bouton efface la
barre. Le choix ne vit que la session — `missions.repositories.filters` dans
`sessionStorage` — et une barre vide n'y laisse aucune clé.

**Settings** range les trois vues qui ne lisent ni le tracker ni la liste des
missions ouvertes : **Usage**, puis **Workflows**, puis **Playbook**, dans une
navigation verticale à gauche. La section ouverte est la seule montée ; Usage
est le défaut. Le volet droit reste monté, vide, et ne reçoit aucune note de
section. Le panneau de Settings est un conteneur (`container-type:
inline-size`) : sous 560 px de large, Workflows et Playbook passent à une
colonne et les pages du Playbook se replient en ligne, si bien qu'un panneau
étroit dans une large fenêtre ne déborde pas. Aucune clé de stockage nouvelle :
`missions.tab` range la section
(`usage`, `workflows`, `playbook`) tant que Settings est ouvert, si bien qu'une
session restée sur l'un de ces anciens onglets rouvre Settings sur cette
section ; une valeur inconnue retombe sur le Dashboard. La section Playbook
ouvre la page retenue par `missions.playbook-page` — la première tant que rien
n'est rangé — et ne touche jamais l'index : elle liste les cinq pages, lit leur
texte, l'édite et l'enregistre, le serveur refusant toute écriture que
`node tools/check-playbook.mjs` ne valide pas. Quitter une page au brouillon
demande confirmation, et un fichier changé sous l'éditeur est refusé plutôt
qu'écrasé. Sous Settings, pas de bandeau tracker, et le rafraîchissement
périodique ne relit jamais la liste des missions ouvertes.

## Le relevé d'usage

Le panneau tient sa propre comptabilité : chaque geste — un onglet, un filtre,
un tiroir, une session — incrémente un compteur local. Un geste = un `POST
missions/api/usage`, jamais attendu et jamais bloquant : si le relevé échoue, le
clic qu'il comptait se fait quand même. Rien ne sort de la machine : le fichier
est `$DSH_HOME/storages/dsh-missions/usage.json`, écrit en une fois (dossier,
fichier temporaire, `rename`), avec au plus 32 détails distincts de 64 caractères
par geste.

La section **Usage** de **Settings** lit ce fichier par
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
