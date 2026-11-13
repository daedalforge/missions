# clienthub

> Projet non déclaré dans `missions/projects.yml` à ce jour : la fiche est prête pour une mission à venir ; `node tools/check-standards.mjs` ne vérifie que les projets déclarés.

## Contexte

- Application Flutter (Dart `>=3.9`, Flutter `>=3.38`) pour iOS, Android et Web;
  `repo: ~/projects/clienthub`.
- Origine GitHub `Flex-O-SAS/clienthub`; la CI est déclenchée au push et son statut
  se constate depuis la plateforme, jamais depuis le poste.
- Commandes: `fvm flutter pub get`, `fvm flutter analyze`, `fvm flutter test`. Le
  README du dépôt fait foi pour le détail et les variantes; il n'est pas recopié ici.
- Le dépôt résout ses textes par le paquet `tolgee` — la règle de traduction
  ci-dessous porte sur le code, jamais sur un accès à l'outil.

## Exécution

- `base` : déclarée dans `missions/<dossier>/mission.yml` ; la fiche du dépôt ne la fixe pas.
- Invariants: aucun arrêté hors les conventions ci-dessous.
- Preuves attendues: `fvm flutter analyze` borné, et les tests bornés que la fiche
  demande — la suite complète reste interdite (`standards/code.md`).

## Conventions

### Un widget générique reçoit en paramètres tout ce qu'un appelant peut vouloir changer

Toute valeur qu'un appelant peut légitimement ajuster — taille, couleur, libellé,
comportement — entre dans le constructeur, avec un défaut qui conserve le rendu
actuel. Seul reste figé ce qui définit l'identité du widget et ne doit jamais varier.

**Raison**: une valeur figée oblige l'usage suivant à modifier le widget ou à le
copier; le widget perd sa généralité et chaque variante repasse en revue.

**Portée**: widgets neufs ou touchés.

### Un bloc conditionnel devient un widget, pas une méthode `_buildX()`

Chargement, erreur, vide, cas nominal: chaque état sort par un `return` anticipé
dans un widget dédié, que l'appelant insère dans son arbre. Une méthode `_buildX()`
qui rend un `Widget` est un widget sans nom: pas de constructeur, pas de test isolé,
pas d'état propre, et la reconstruction remonte à l'ancêtre. Un bloc à un seul cas
et quelques lignes reste inline.

**Raison**: sans découpage, Flutter reconstruit tout le widget englobant au lieu du
seul sous-arbre concerné, et le bloc ne peut être ni nommé ni testé seul.

**Portée**: tout rendu conditionnel neuf ou touché.

### Un texte visible passe par Tolgee

Toute chaîne montrée à l'écran — bouton, titre, erreur, aide — se résout par
`t(...)` ou `context.t(...)`. Un littéral ne reste que s'il n'est pas du texte:
donnée déjà formatée, identifiant technique, valeur de debug.

**Raison**: un libellé figé sort de la traduction sans alerte. Il s'affiche juste
dans la langue du développeur, passe le build, les tests et la relecture, et
n'apparaît qu'auprès d'un utilisateur d'une autre langue.

**Portée**: code neuf ou touché. Cette règle ne demande aucun accès à Tolgee, qui
reste interdit (`standards/interdits.md`).

### Une valeur de style vient d'un token

Couleurs, espacements, rayons, durées, tailles de police: le widget les lit dans
`lib/core/design_system/tokens/design_tokens.dart`. Une valeur absente s'y ajoute
dans la même PR que le widget. Un token se nomme par sa valeur dans le système, pas
par l'écran qui l'utilise.

**Raison**: une valeur posée dans un widget ne suit pas la charte quand elle change
et reste en arrière sans signal. Un token nommé d'après son écran ne peut plus servir
ailleurs sans mentir sur son nom.

**Portée**: code neuf ou touché.

### Un test doit pouvoir échouer

Avant l'assertion, se demander ce qui la ferait rougir. Si la réponse est « rien » —
mock posé par le test, valeur écrite par le test, objet monté sans être interrogé —,
le test se réécrit ou disparaît. Un test généré passe par cette question avant la PR.

**Raison**: un test incapable d'échouer verdit, occupe la couverture et laisse
croire que le comportement est couvert alors que rien ne le vérifie.

**Portée**: tests neufs ou touchés.

### Un appel d'API interne passe par le SDK généré

Si l'endpoint est dans le SDK, la source de données l'appelle par le SDK. Un client
manuel ne se justifie que pour un endpoint absent du SDK, et la bonne réponse est
alors de le générer; l'exception se motive dans la PR.

**Raison**: un client manuel recopie chemin, corps et types, et ne bouge pas quand le
contrat change; la rupture apparaît à l'exécution, chez l'utilisateur. Le SDK la
transforme en erreur de compilation.

**Portée**: code neuf ou touché.

## Interdits locaux

- Aucune commande Tolgee (`pull`, `push` ou autre) depuis une session sur ce dépôt —
  l'interdit global est absolu et ne souffre aucune exception locale
  (`standards/interdits.md` #8).

## Review

- Gates à rejouer: `fvm flutter analyze`, puis les tests bornés de la fiche; citer la
  sortie brute.
- Une violation d'une convention ci-dessus est bloquante (`standards/interdits.md`
  #9).
- Faux positifs connus: aucun.
