# dsh-missions

Vue **Missions** dans la barre latérale de DeepSeek Harness : les missions konoha non
terminées, en trois colonnes — la liste groupée par statut, la fiche de la mission
avec ses quatre onglets, et la colonne de contexte de la mission en cours de lecture.

Le panneau porte aussi la **vue Performance** (semaine, mois, Timeline et bilan du
jour) et la **vue Workflows** (les sept parcours de konoha en graphes de gestes
éditables), quatrième et cinquième entrées de la rangée de vues en tête du panneau :
les trois lectures partagent la même entrée de barre latérale, le même socle de
lecture des sessions et des missions, et le même plugin. Chaque fiche ouvre ce
panneau dans son onglet `Performance`, sur la mission lue.

## Préfixes d'identifiant par poste

Un poste = un jeu de missions, local (`missions/*` est gitignoré). Le préfixe
d'un poste, sa séquence et la règle de numérotation sont ceux de la règle 7 de
`standards/workspace.md` ; cet écran n'en tient aucune copie.

Le panneau n'impose aucun format (`id` du frontmatter, à défaut le nom du
dossier) : le préfixe fait foi. Garder `id:` égal au nom du dossier — le
pré-remplissage de session écrit `missions/<id>/mission.md`.

## Ce que ça fait

- Entrée « Missions » permanente, en tête de la barre latérale, avant « Veille ».
- Page centrale : une **liste étroite à gauche** (392 px), la **fiche au centre**, la
  **colonne de contexte à droite** (336 px), à l'échelle de l'écran de référence
  3 440 × 1 440. En dessous de 1 280 px de large, la colonne de contexte s'efface ;
  la liste et la fiche restent.
- Au-dessus des filtres, un **champ de recherche** fouille l'identifiant, le titre,
  **toutes les valeurs du frontmatter** (PR, branche et base, points, catégorie,
  chaîne, file, épic, listes `repos` et `bruno`…) et **le corps de `mission.md`** ;
  le journal et la checklist restent dehors. Il ignore la casse et les accents, et
  plusieurs mots se combinent en ET, chacun pouvant tomber dans un champ différent —
  `gpg` ramène ABC-104 par son titre, `1184` ramène ABC-102 par son corps. La
  recherche se compose avec les quatre filtres en intersection ; `Échap` ou la croix
  l'efface et efface sa mémoire. Elle est mémorisée localement
  (`dsh-missions:search`) et rejouée à l'ouverture, champ rempli et liste déjà
  filtrée. L'hôte envoie le texte cherchable
  de chaque fiche dans `/missions/api/list` (≈ 400 Ko pour ~100 fiches ouvertes,
  lisibles sur place) : aucune route, aucun index, aucune lecture supplémentaire.
- Le panneau s'ouvre sur le **dernier état connu**, peint depuis le stockage local
  (clé `dsh-missions:snapshot`) avant toute requête, puis la liste se rafraîchit en
  tâche de fond sans écran de chargement. Sur un poste qui n'a encore rien vu, la
  ligne « Chargement des missions… » reste affichée et le contenu arrive d'un bloc.
- La liste porte **quatre filtres en bouton** — `Statut`, `Priorité`, `Epic`, `Session` —
  qui se combinent en intersection ; le périmètre s'affiche dans le sous-titre
  (`66 ouvertes · N affichées · 91 clôturées`). `Session` propose `Toutes`,
  `Session active` (une session rattachée existe, qu'elle tourne ou soit arrêtée) et
  `Sans session` (aucune mention de journal ni session utilisable) ; il lit l'index
  des sessions déjà chargé, sans route nouvelle. Un seul filtre est ouvert à la fois :
  ses valeurs se déploient sous la rangée, en flux, et poussent la liste. Un clic
  extérieur ou `Échap` referme. Les cinq filtres — recherche et quatre boutons —
  sont mémorisés localement (`dsh-missions:search`, `dsh-missions:status-filter`,
  `dsh-missions:priority-filter`, `dsh-missions:epic-filter`,
  `dsh-missions:session-filter`) : le panneau se rouvre sur les mêmes filtres,
  recherche remplie et liste filtrée, et la `File d’exécution` retrouve les siens en
  revenant. Ramener un filtre à « Toutes », ou effacer la recherche, efface sa clé.
  Une valeur mémorisée que les missions ne proposent plus (un statut sans mission, un
  epic retiré) reste affichée et appliquée : la liste affiche zéro mission jusqu'à ce
  qu'on la remette à « Toutes ».
- La liste se lit par **groupes de statut**, dans l'ordre du parcours : `En cours`,
  `En review`, `En peer review`, `En attente de validation`, `En attente d'exécution`,
  `En cadrage`. Un groupe vide ne s'affiche pas. Dans chaque groupe, les missions sont
  triées par priorité (`Urgent`, `Important`, `Un jour`, sans priorité), puis dans
  l'ordre naturel des identifiants.
- Une ligne de la liste : identifiant monospace, dépôt quand il change, pastille de
  priorité, point vert quand la session de la mission tourne, et le titre sur deux
  lignes au plus. La ligne sélectionnée porte un filet de 2 px à gauche et une teinte
  de fond.
- La **fiche** occupe la colonne centrale : une barre (`←` de retour, identifiant de la
  mission), le titre, puis quatre onglets toujours présents — `Fiche`, `Journal`,
  `Checklist`, `Performance`. Un
  onglet sans fichier le dit (« Cette mission n'a pas de checklist. ») au lieu de
  disparaître : la barre ne bouge pas d'une mission à l'autre.
- Le corps des onglets passe par le **lecteur markdown de l'application**
  (`MarkdownText` de `@deepseek-ai/dsh-client-ui-primitives`), celui des documents et
  des conversations : tableaux, listes imbriquées, blocs de code, citations, cases à
  cocher en lecture. Le frontmatter et le premier titre du fichier ne sont pas rendus.
  Le corps est monté à 760 px pour rester lisible sur un écran large.
- La **colonne de contexte** donne six cartes : `Prochaine action` (statut et
  priorité — c'est là qu'ils se changent), `Session` (session liée, son
  état, sa dernière activité, et le bouton de session), `Dépôt` (dépôt, type, epic),
  `Frontmatter` (les faits du gabarit, en lecture seule : points du produit,
  catégorie, branche et base de branche, PR en lien, chaîne et file, création,
  dépôts et timebox du poc, Bruno — une clé absente s'affiche `—`),
  `Dépendances` (`Bloque` et `Bloquée par`, avec la cause `chaîne` que le plan
  dérive déjà) et `Livrable` (fiche, journal et checklist,
  présents ou absents). Le bouton de session
  fait l'action en un clic : sur une mission qui a déjà une session, il l'ouvre ; sur une
  mission sans session, il en crée une et pré-remplit le composeur (`Mission <id> —
  <titre>` puis le chemin de la fiche `~/konoha/missions/<id>/mission.md`), sans
  rien envoyer. Le workspace suit
  le type de la mission : une mission produit l'ouvre dans la racine produit (`~/projects`
  par défaut, réglage `productWorkspaceRoot`), où vit son worktree
  `~/projects/worktrees/<repo>-<id>` ; un conteneur et un POC l'ouvrent dans le workspace
  qui porte `missions/` (konoha), celui dont le panneau lit les journaux. Quand la racine
  produit n'est pas ouverte, la carte rend `Le workspace ~/projects n'est pas ouvert.` et
  n'ouvre rien d'autre : pas de repli sur konoha. Le workspace des missions, lui, ne se
  remplace pas non plus : s'il manque, la carte nomme `~/konoha` et n'ouvre rien — une
  session qui ne peut pas écrire `missions/<id>/` n'a pas lieu d'être.
- Les actions du registre vivent dans la colonne de contexte, plus dans la liste : la
  carte `Prochaine action` porte la **priorité** (menu `Priorité`) et, pour une mission
  produit, le **statut** (menu du parcours produit, en lecture seule sur un conteneur ou
  un poc) ; les deux écrivent dans le frontmatter de la mission. L'action de **session**
  vit dans la carte `Session`. La barre de méta de la fiche ne porte que des jetons en
  lecture ; la liste garde les filtres, les pastilles et la navigation.
- Le panneau est **transparent**, adouci : la liste et la fiche posent la surface de
  carte du thème (`--dsw-alias-bg-layer-2`), opaque, avec bord de 1 px et coins arrondis ;
  la colonne de contexte reste nue et laisse voir le papier peint. Seules les surfaces
  qui portent du texte (pastilles, cartes, menus) posent un fond.
- Source de vérité : le frontmatter `status` / `epic` de `~/konoha/missions/*/mission.md`.
  Les dossiers de `missions/archives/` ne sont pas listés, leur nombre est rappelé en
  pied de liste.
- Sous cette ligne des clôturées, un bouton **« Nouvelle mission »** déploie les trois
  types du standard — `Produit`, `Conteneur`, `POC` — chacun avec sa nature en une
  ligne : clé Jira et dépôt produit, identifiant konoha et `~/konoha`, `POC-NN` avec
  hypothèse et timebox. Le choix ouvre une session dans le workspace des missions —
  le cadrage écrit `missions/<id>/mission.md` et son journal, quel que soit le type —
  avec une amorce propre au type : la session demande l'intention en une phrase si
  elle manque, fixe l'identifiant (la clé Jira demandée pour un produit, le prochain
  rang libre pour un conteneur ou un POC), écrit `missions/<id>/mission.md` au gabarit
  `templates/mission-<type>.md` (`status: draft`) et son `journal.md`, puis rend la
  main avec la fiche et ses points ouverts, **sans rien exécuter** — ni branche, ni
  fichier hors `missions/<id>/`. La mission rejoint le groupe « En cadrage » par le
  scan des journaux, sans passer par la route de lien.
- Rafraîchissement au retour de focus et bouton « Rafraîchir ».

### Priorité

Le frontmatter des missions accepte une clé `priority:` :

```yaml
priority: urgent        # urgent | important | un jour (ou vide = non défini)
```

Valeurs reconnues (insensibles à la casse et aux accents) : `urgent` / `p0`,
`important` / `p1`, `un jour` / `à faire un jour` / `someday` / `p2`. `normal` et
`none` valent « sans priorité », explicitement. Toute autre valeur est ignorée
(mission « sans priorité »). La pastille de priorité de la fiche écrit la clé
`priority:` dans `missions/<ID>/mission.md` (insérée après `status:`, remplacée, ou
retirée pour `Aucune`).

### Statuts

Le frontmatter `status:` suit un axe de six états, dans cet ordre de lecture :

| `status:` | Libellé | Sens |
| --- | --- | --- |
| `active` | En cours | l'exécution est engagée |
| `in_review` | En review | la review de l'agent tourne (PR en draft) |
| `in_peer_review` | En peer review | la mission attend la review des collègues |
| `awaiting_validation` | En attente de validation | l'exécution est finie, la validation du principal est attendue |
| `ready` | En attente d'exécution | le cadrage est validé, l'exécution n'est pas lancée |
| `draft` | En cadrage | la fiche se construit |

Le parcours de chaque type — et l'écrivain de ses transitions — est celui de
`standards/types.md` : le produit a son axe propre, conteneur et poc partagent
`draft` → `ready` → `active` → `awaiting_validation` → `done`.

Le menu de statut n'est proposé que sur une fiche produit : il propose `draft`,
`ready`, `active`, `in_review` et `in_peer_review`. Pour un conteneur ou un poc, la
pastille est en lecture seule — l'orchestrateur écrit les transitions du parcours. Un
type absent ou inconnu n'ouvre pas de menu. `done`, `archived` et `abandoned` ne
figurent jamais dans la liste.

### File d'exécution

Le bouton `File d’exécution` de l'en-tête (avec le nombre de missions en file) ouvre
l'écran de la file, et `Échap` ou `← Missions` revient à la liste en gardant filtres
et sélection. Le bouton `Ordonnancer` de cet écran ouvre l'ordonnancement.

- **Deux panneaux.** À gauche, les fiches prêtes sans rang, groupées par statut et
  passées aux filtres Statut, Priorité et Epic — la file ne porte que l'attente
  d'exécution, donc tout ce qu'elle reçoit est prêt. À droite, la file dans l'ordre :
  rang, mission, dépôt, priorité, croix de retrait ; une fiche qui attend sa devancière
  porte `attend <ID>`.
- **Glisser-déposer.** Glisser une fiche vers la file l'ajoute en fin ; glisser une
  ligne de la file sur une autre la réordonne ; la glisser sur la liste (ou cliquer sa
  croix) la retire. Chaque geste écrit l'ordre complet, donc les rangs restent contigus
  de 1 à N. Seules les fiches prêtes entrent dans la file : une fiche partie en
  exécution ou en review, re-cadrée ou abandonnée en sort, les suivantes remontent.
- **Ce que l'écran dit.** Le rang ordonne la file ; il ne dit pas qui part.
  L'ordonnancement calcule ce qui peut partir maintenant, en parallèle, et la file
  ne porte que l'attente d'exécution : une fiche partie, en revue ou en attente de
  validation n'y attend pas son tour.
- **Ce qu'il écrit.** Le rang dans la clé `queue:` du frontmatter de chaque fiche ;
  l'ordre survit au rechargement puisqu'il vit dans les fiches, pas dans le panneau.
  L'écran n'écrit rien aux journaux — les actes sont ceux de l'ordonnancement.
- **Ce qu'il ne fait pas.** Il n'ouvre et ne ferme aucune mission : c'est
  `Valider l’exécution` qui ouvre la première vague (`workflows/queue.md`).

### Ordonnancement

Le bouton `Ordonnancer` ouvre la vue du plan, calculée sur l'ensemble des missions
ouvertes (file comprise) :

- **Le diagramme.** Les vagues en colonnes (`Maintenant`, `Ensuite`, `En attente`),
  les dépôts en lignes, une arête pointillée par blocage. Un nœud porte son état :
  exécutable maintenant (vert), bloquée par une autre mission (orange), en cours
  (bleu). Cliquer un nœud remplit le détail : dépôt,
  rang dans la file, priorité, ce qu'elle bloque et par quoi elle est bloquée, avec la
  cause (`suite`).
- **Ce qui est bloquant.** Une mission dont la devancière n'a pas livré son travail, et
  rien d'autre : deux missions du même dépôt peuvent partir ensemble, chacune dans son
  worktree. Les vagues se déduisent des blocages : la vague 1 est ce qui peut partir
  maintenant.
- **`Valider l’exécution`.** Fige le plan — un bloc `Plan validé` est ajouté au journal
  de chaque mission de la vague 1 — passe ces missions en `active` et lance chacune,
  dans la limite des **sessions en cours** (5 par défaut, réglable) :
  la session rattachée est arrêtée si un tour y court puis archivée, une session est
  créée dans le workspace du type de chaque mission — la racine produit pour un produit,
  le workspace des missions pour les autres —, liée (`~/.dsh/missions/links.json`), et le
  go lui est **envoyé** aussitôt ; l'amorce nomme la fiche et la méthode par leur chemin
  dans konoha (`~/konoha/missions/<id>/mission.md`, `~/konoha/workflows/missions.md`),
  pour rester juste dans une session produit enracinée dans `~/projects` — les outils de
  lecture développent le tilde. Le clic est l'autorisation : aucun go supplémentaire n'est
  demandé. Le panneau reste sur la vue du plan, aucune session n'est mise au premier
  plan ; le bandeau rend le résultat mission par mission — session lancée, session
  précédente archivée, échec. Un échec n'arrête pas les autres lancements.
- **Le plafond de sessions.** Avant d'ouvrir quoi que ce soit, le panneau compte les
  sessions DSH en cours des deux racines de mission, konoha et la racine produit (une
  session dont un tour court), et n'ouvre que
  les missions qui tiennent sous le plafond, dans l'ordre de la vague. Les suivantes
  restent dans la file ; le bandeau dit combien sont reportées. Plafond atteint,
  l'hôte n'est pas appelé : le bandeau le dit et invite à libérer une session puis à
  revalider. Le compteur `n/N sessions en cours` s'affiche sous le titre de la file et
  de l'ordonnancement, avec le nombre de sessions en cours hors missions.
- **`Réordonnancer`.** Recalcule le plan depuis l'état réel des fiches.

### Vue Performance

La quatrième vue du panneau (bouton `Performance` de la rangée de vues, à côté de
`Liste`, `File d’exécution`, `Ordonnancement`) monte la page Performance de ABC-78/80 :
semaine et mois, Timeline des missions et des sessions, et page `Bilan du jour`. La
page garde ses routes (`/performance/panel`, `/performance/timeline`,
`/performance/bilan`), sa feuille de style et ses scripts ; le panneau ne fait que
l'accueillir dans une iframe.

- **Une seule entrée de barre latérale.** `Missions` porte les deux lectures. Il n'y a
  plus d'entrée `Performance` : la page est atteinte par la rangée de vues, ou par
  l'onglet `Performance` d'une fiche (`/performance/panel?mission=<ID>`).
- **Lecture seule, comme avant.** La page mesure (missions, journaux, git, Jira,
  sessions, ledger du cost-meter) et n'écrit rien dans les fiches, journaux, dépôts ou
  Jira. Sa seule écriture reste le brouillon du bilan
  (`~/.dsh/storages/dsh-performance/bilan/<AAAA-MM-JJ>.json`) et son cache de lecture
  (`~/.dsh/storages/dsh-performance/cache/sessions.json`).
- **Les mêmes racines.** La page lit les missions et les sessions par le socle commun
  (`lib/sessions.js`, `lib/missions.js`) : une seule règle pour trouver, normaliser et
  rattacher les sessions, un seul parseur de journal et de review. Les racines et les
  sources restent réglables dans `~/.dsh/storages/dsh-performance/config.json` (voir
  `sources` : git, gh, jira, subagents).
- **Ce qu'elle ne fait pas.** Elle ne modifie pas les réglages du panneau Missions et
  n'ouvre aucune session : lancer, arrêter, archiver restent des actes de la vue
  Missions.

### Vue Workflows

La cinquième vue du panneau (bouton `Workflows` de la rangée de vues, à côté de
`Performance`) rend les sept workflows du workspace — `cadrage`, `cloture`,
`enchainement`, `execution`, `missions`, `queue`, `review` — comme des graphes de
gestes, et les édite.

- **Le modèle est le fichier.** Un JSON par workflow dans `workflows/model/`, clés
  `workflow`, `title`, `document`, `nodes` et `edges` ; un nœud porte `id`, `section`,
  `writer`, `condition`, `artifact`, `gate`, `status`, un arc `from`, `to`, `when`.
  Les positions ne sont pas stockées : le graphe est un SVG en couches calculées côté
  client (aucune coordonnée dans le fichier).
- **Éditer, c'est réécrire après validation.** Le brouillon reste local jusqu'au
  bouton `Enregistrer` ; le serveur valide le modèle (clés connues, identifiants
  uniques, arcs sur des gestes existants, statuts de `standards/types.md`) et refuse
  en 400 en nommant les écarts. Un enregistrement ne modifie jamais le document
  Markdown : la carte d'écarts signale les sections du document sans geste.
- **Le même socle que la ligne de commande.** Le contrôle de concordance est
  `scripts/check.mjs`, la validation seule `scripts/validate.mjs` ; les deux lisent le
  worktree qui contient `workflows/model/` s'il y en a un, sinon `~/konoha`.
- **Chargé à la demande.** Le client de la vue est un chunk (`lib/client.workflows.js`)
  que le panneau charge au premier clic sur `Workflows` : ouvrir Missions ne coûte pas
  le graphe.

### Réglages

Le panneau expose une page de réglages dans Réglages → Plugins → `@daedalforge/dsh-missions`
(page du bundle, et page de la ligne `missions`), enregistrée dans le patch du profil
sous l'entrée `missions` :

| clé | défaut | rôle |
| --- | --- | --- |
| `maxRunningSessions` | `5` | sessions en cours autorisées à la validation de la file (1 à 50) |

La valeur est lue à chaque requête : un réglage modifié s'applique à la validation
suivante sans redémarrer. `Rétablir le défaut` retire la clé du patch. Réglé hors du
panneau, le même plafond existe dans le fichier du profil
(`config: { maxRunningSessions: 5 }` sous l'entrée `missions`).

### Comment une session est rattachée à une mission

Trois sources, fusionnées côté hôte :

1. **Lien explicite** créé par l'action de session (`~/.dsh/missions/links.json`).
2. **Références de contenu** : les journaux de session
   (`~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd`) sont décompressés et scannés
   à la recherche de `missions/<ID>/`.
3. Les identifiants sont normalisés (`session-<uuid>` et `<uuid>` désignent la même
   session).

Le scan est **incrémental** : chaque journal est mémorisé en mémoire de l'hôte avec sa
taille et sa date de modification, et n'est relu que s'il a changé. Le panneau demande
toujours un scan frais (`GET /missions/api/sessions?refresh=1`) ; sans `refresh=1`, la
réponse est servie depuis un cache de 5 minutes.

Les sessions **archivées** sont écartées (`global.archivedSessionIds` dans
`~/.dsh/storages/workspace.json`). Une session appartient à **une seule** mission ; une
session déjà attribuée est ignorée pour les autres. Score : lien explicite (1000) >
titre contenant l'identifiant (400) > mentions plafonnées à 300. Une session **vide**
(journal sans `user/message` ni `assistant/message`) est traitée comme absente : la
carte propose de l'ouvrir plutôt que d'en créer une seconde.

Au lancement de la vague 1, seule une session rattachée **par lien explicite ou par
titre** est archivée : une session qui ne fait que mentionner la mission dans son
journal n'y touche pas. L'hôte refuse d'archiver une session dont un tour est en
cours ; le lancement demande donc l'arrêt de ce tour (`stopActivity`) en même temps
que l'archivage — le clic sur `Valider l’exécution` en tient lieu d'autorisation. Si
l'archivage échoue, la mission n'est pas lancée et l'échec s'affiche, pour ne pas
doubler un travail déjà en cours.

### Fiche de mission

`GET /missions/api/mission?id=<ID>` renvoie `{ id, title, file, source, journal,
checklist }`, où `journal` et `checklist` valent `{ exists, source, mtimeMs }`. Le
`source` était publié sous la clé `text` dans les versions précédentes ; le client lit
les deux. `?part=journal` ou `?part=checklist` réduit la réponse à la partie demandée.

La fiche se lit sur quatre onglets : `Fiche` (`mission.md`), `Journal` (`journal.md`),
`Checklist` (`checklist-manuelle.md`) et `Performance` (la page `/performance/panel`
cadrée sur la mission, dans une iframe). Les trois premiers sont relus à chaque
activation de leur onglet ; le quatrième recharge la page Performance. `Échap` ferme
les menus ouverts, puis la fiche.

## Installation

Le paquet est installé depuis npm dans les profils `desktop` et `web`
(`config/tools/dsh/profile*/package.json`, entrée `@daedalforge/dsh-missions` : `"0.16.0"`).
`config/tools/dsh/install.sh --check` signale une référence cassée. Pour développer le
plugin, lier le clone (`"@daedalforge/dsh-missions": "link:../../../projects/missions"`).

Le client et les routes sont servis depuis le dossier source lié par le profil. Un
rechargement de la fenêtre (Cmd+R) suffit pour un changement de client seul ; une route
nouvelle demande le redémarrage complet de l'app.

## Développement

```sh
node --test test/                       # liste, recherche, fiche, journal, checklist, sessions, file, plan,
                                        # lancement, archives, Jira et Timeline de la vue Performance,
                                        # modèles et contrôle de concordance des workflows,
                                        # rendu du panneau avec des hooks factices
node scripts/validate.mjs --root ~/konoha  # valide les modèles seuls, sans contrôle de concordance
node scripts/check.mjs --root ~/konoha     # contrôle de concordance : modèles, documents, statuts
```

Hors du workspace, `--root` désigne la racine qui porte `workflows/model` (par exemple
`--root ~/konoha`). Les tests des workflows et des modèles lisent le workspace
(`DSH_WORKSPACE`, `~/konoha` par défaut).

`test/render.test.mjs` monte `MissionsPanel` sans DOM (hooks factices, services vides) :
il attrape les erreurs de portée qu'un test de source ne voit pas, comme une fonction du
module masquée par une constante locale. Les tests de la vue Performance sont dans les
mêmes `test/*.mjs` (`archives`, `jira`, `timeline-jira`) et importent
`../lib/performance/*.js`. Le script
`scripts/sync-jira-dates.mjs` lit `../lib/performance/jira.js` et
`../lib/missions.js`.

Boucle de test sans toucher au profil desktop :

```sh
dsh web --port 5599 --no-open           # le profil web doit avoir le plugin
```

`dsh plugin --profile web add file:$PWD` ne rafraîchit pas la copie installée (pnpm
hardlinke depuis le store) : pour itérer, lier la source directement —
`rm -rf ~/.dsh/profiles/web/node_modules/@daedalforge/dsh-missions && ln -s "$PWD" ~/.dsh/profiles/web/node_modules/@daedalforge/dsh-missions`.

## API

`GET /missions/api/list` (même origine, GET seulement) renvoie la liste des missions :

```json
{
  "ok": true,
  "value": {
    "root": "/Users/…/konoha/missions",
    "displayRoot": "~/konoha/missions",
    "generatedAt": "2026-10-30T19:05:00.000Z",
    "archived": 91,
    "epics": [{ "key": "UV-483", "title": "…", "status": "active", "jira": "…" }],
    "missions": [{ "id": "ABC-75", "title": "…", "status": "active", "epic": "", "repo": "~/konoha", "type": "conteneur", "priority": "important", "dir": "ABC-75", "search": "ABC-75 la liste des missions…" }],
    "sessions": { "workspacePath": "/Users/…/konoha", "productWorkspacePath": "/Users/…/projects", "productWorkspacePaths": ["/Users/…/projects"], "productWorkspaceLabel": "~/projects" },
    "plan": { "executable": ["ABC-75"], "waiting": [], "blockedBy": {}, "blocks": {}, "nodes": [] },
    "limits": { "maxRunningSessions": 5 }
  }
}
```

Le scan de `missions/`, des épics et des journaux est mémorisé tant que la signature
du dossier ne change pas : mtime et taille de chaque `mission.md` et `journal.md`,
compte de `missions/archives/`, `epics/*/epic.md`, `workflows/queue.md`.
`?refresh=1` force un scan neuf.

`GET /missions/api/sessions` renvoie `{ byMission: { "<ID>": ["<uuid>", …] }, scanned, cached }`.

`
`POST /missions/api/link` avec `{ "missionId": "ABC-75", "sessionId": "session-<uuid>" }`
enregistre un lien explicite.

`POST /missions/api/priority` avec `{ "missionId": "ABC-75", "priority": "urgent" }`
(`""` retire la priorité) réécrit le frontmatter et renvoie
`{ ok: true, value: { missionId, priority, changed } }`.

`POST /missions/api/queue` avec `{ "ids": ["UV-1184", "XYZ-1491"] }` écrit l'ordre de
la file : rangs contigus à partir de 1 et `queue:` retiré des fiches qui sortent.
Renvoie `{ ok: true, value: { ids, added, removed } }` ; refuse (`400`, code
`queue-failed`) un corps sans `ids`, un identifiant inconnu, un doublon ou une fiche
hors de la file (ni `ready` ni `active`) ; `[]` vide la file.

`POST /missions/api/plan` avec `{ "ids": ["UV-1184", "XYZ-1491"] }` valide la première
vague : chaque mission citée doit être exécutable maintenant. Le plan est figé — bloc
`Plan validé` au journal de chaque mission ouverte —, les missions passent en `active`
et le corps renvoie `{ ok: true, value: { opened: [...], plan } }`. Refuse (`400`, code
`plan-failed`) une mission qui n'est pas exécutable. Le plan courant est joint à
`GET /missions/api/list` sous `plan`.

`POST /missions/api/status` avec `{ "missionId": "ABC-75", "status": "awaiting_validation" }`
réécrit la ligne `status:` du frontmatter — seuls `active`, `in_review`,
`in_peer_review`, `awaiting_validation`, `ready` et `draft` sont acceptés — et renvoie
`{ ok: true, value: { missionId, status, changed } }`.

La vue Workflows sert trois routes sous le même préfixe : `GET
/missions/api/workflows/list` (les sept modèles avec leurs écarts), `GET
/missions/api/workflows/model?workflow=<id>` (le texte du fichier), `POST
/missions/api/workflows/model` avec `{ "workflow": "cadrage", "model": { … } }`
(réécrit après validation, 400 avec `error.errors` si le modèle est refusé) et `POST
/missions/api/workflows/check` (le rapport de concordance complet).

La vue Performance sert ses propres routes sous le même préfixe, telles quelles :
`GET /performance/panel` (page semaine/mois, `?mission=<ID>` pour cadrer une fiche),
`GET /performance/timeline`, `GET /performance/bilan`, `GET /performance/panel.css`,
`GET /performance/panel.js`, `GET /performance/bilan.js`, `GET /performance/source` et
`GET /performance/api/*`. Elles ne passent pas par `/missions/api` et gardent leurs
réglages dans `~/.dsh/storages/dsh-performance/config.json`.

Les chemins sont réglables par le patch du profil :

```yaml
- insert:
    - id: missions
      name: '@daedalforge/dsh-missions'
      config:
        missionsRoot: ~/konoha/missions
        sessionsRoot: ~/.dsh/sessions
        linksFile: ~/.dsh/missions/links.json
        workspaceRoot: ~/konoha
        productWorkspaceRoot: ~/projects
```
