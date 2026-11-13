# marketplace-service

> Projet non déclaré dans `missions/projects.yml` à ce jour : la fiche est prête pour une mission à venir ; `node tools/check-standards.mjs` ne vérifie que les projets déclarés.

## Contexte

- Service Catalog API: l'API du catalogue marketplace — services et items par provider,
  en CRUD. Symfony `7.4`, API Platform `4`, Doctrine ORM `3`, PHP `>=8.3`, Composer;
  `repo: ~/projects/marketplace-service`. Paquets internes résolus via le dépôt Repman.
- Origine GitHub `Flex-O-SAS/marketplace-service`; la CI est déclenchée au push et son
  statut se constate depuis la plateforme, jamais depuis le poste.
- Commandes: `composer install`; `composer test:db:setup` et `composer test:db:drop`
  (base de test); `composer test:all` et `composer test:coverage` (suites complètes,
  réservées à la CI); les tests bornés passent par `php bin/phpunit <chemin>` en
  environnement `test`. Le README du dépôt fait foi pour le détail et les variantes;
  il n'est pas recopié ici.
- Le dépôt repose sur Gedmo (suppression logique), Casbin (autorisations) et les
  migrations Doctrine; les conventions ci-dessous en portent les cas limites.

## Exécution

- `base` : déclarée dans `missions/<dossier>/mission.yml` ; la fiche du dépôt ne la fixe pas.
- Invariants: aucun arrêté hors les conventions ci-dessous.
- Preuves attendues: les tests bornés que la fiche demande, via
  `php bin/phpunit <chemin>` en environnement `test`, sur la base au suffixe `_test` —
  la suite complète reste interdite en session (`standards/code.md`).
- Les snapshots `tests/Schema/*.json` ne se régénèrent ni ne se committent dans les
  missions — convention dédiée ci-dessous.

## Conventions

### Une migration Casbin pose et retire chaque règle isolément

Une migration Casbin n'écrit jamais en lot. Chaque règle — policy ou grouping
policy — entre ou sort par un appel dédié: `addPolicy`, `addGroupingPolicy`,
`removePolicy`, `removeGroupingPolicy`. `addPolicies`, `addGroupingPolicies`,
`removePolicies` et `removeGroupingPolicies` sont interdits: une entrée déjà
présente fait tout échouer, y compris les suivantes.

**Raison**: la base peut porter des entrées déposées par une reprise, un rollback
ou un ancien passage partiel. Un lot avorté laisse alors la policy HTTP active
sans rôle pour la porter, ou l'inverse: le déploiement semble fini, l'autorisation
manque. Écrire règle par règle rend chaque appel idempotent et l'écart observable.

**Portée**: toute migration du dépôt qui écrit dans Casbin. Les migrations déjà
jouées ne sont pas reprises.

### L'unicité soft-delete trace la même frontière en validation et en index

Une valeur unique peut-elle être reprise après la suppression logique de son
porteur? Alors la validation et l'index SQL doivent tracer la même frontière. Si
Gedmo retire les lignes supprimées du contrôle, la colonne qui marque la
suppression entre dans l'index, pour que celui-ci admette la reprise.

**Raison**: des frontières différentes font accepter une création que la base
rejette à l'insertion: un 500 sort sur un cas métier autorisé, et le contrat
dépend de la couche qui répond en dernier. Validation et index doivent s'accorder
sur chaque ligne.

**Portée**: toute entité du dépôt en soft-delete Gedmo dont l'unicité ne concerne
que les lignes actives. Code neuf ou touché; un index historique qui ne change pas
de contrat n'est pas refait.

### Un libellé persisté se nomme par son rôle, pas par une langue

Un champ de libellé se nomme par ce qu'il fait, pas par la langue de son contenu:
`label` ou `defaultLabel`, jamais `frenchLabel` ni `libelleFr`. Que la valeur soit
française ou anglaise regarde la donnée, pas la colonne.

**Raison**: un nom de champ survit à ce qu'il range. À la première seconde langue,
`frenchLabel` doit être renommé partout ou doublé d'un `englishLabel`
contradictoire — et une colonne migrée ne se renomme qu'au prix d'une migration de
plus. Un nom fonctionnel absorbe l'ajout: `defaultLabel` reste juste dans toutes
les langues.

**Portée**: code neuf ou touché. Aucune occurrence actuelle: la règle bloque une
régression, elle n'ouvre pas de reprise.

### Un callback `PreFlush` d'entité n'écrit rien

Un callback d'entité `PreFlush` est interdit: la normalisation ou l'effet de bord
d'une écriture se pose en `PrePersist` / `PreUpdate`, ou s'invoque directement dans
le processor concerné.

**Raison**: `PreFlush` se déclenche pour chaque instance de la classe présente dans
l'identity map, pas seulement celle qu'on écrit.

**Portée**: code neuf ou touché.

### Une condition sur une collection joint l'entité cible

Sur une relation vers une entité soft-deletable, bannir `IS EMPTY`, `MEMBER OF` et
`SIZE()`. À la place, un `EXISTS` / `NOT EXISTS` qui joint l'entité cible: c'est ce
qui fait entrer les filtres Doctrine en jeu.

**Raison**: ces trois opérateurs DQL ne voient que la table de liaison, où les
filtres ne s'appliquent pas.

**Portée**: code neuf ou touché.

### Un invariant multi-entités se vérifie sous verrou dans toutes ses écritures

Un invariant inter-entités se contrôle sous verrou dans toute opération qui
l'écrit, la création y comprise. Chacune ouvre une transaction, pose des verrous
sur les lignes des deux côtés, puis revérifie après écriture et avant commit. Ordre
de pose identique partout: les entités du côté partagé d'abord, triées par
identifiant, l'entité écrite ensuite.

**Raison**: sans cela, une opération non verrouillée peut écrire en parallèle et
casser l'invariant — une fenêtre qui n'existe qu'en concurrence, hors de portée des
tests. Deux ordres contraires sur les mêmes lignes font un deadlock: MySQL tue une
transaction et l'API répond 500.

**Portée**: code neuf ou touché.

### Find-or-create: capter `UniqueConstraintViolationException` à l'écriture

Une opération find-or-create rattrape `UniqueConstraintViolationException` au
moment de l'écriture. L'échec ferme l'EntityManager; on le réinitialise, on relit
la ligne qui a gagné et on la renvoie. Si aucune ligne n'explique la violation, la
relancer.

**Raison**: deux appels simultanés franchissent la recherche ensemble et le second
tombe sur l'index unique en 500 — encore une fenêtre que seul l'accès concurrent
ouvre. Pas de verrou pessimiste possible: rien à verrouiller avant la création. Un
verrou de table sérialise tout, un `INSERT … ON DUPLICATE KEY` écrit en SQL hors
Doctrine et hors processor. La contrainte existe déjà en base: la laisser arbitrer
ne coûte rien au chemin nominal.

**Portée**: code neuf ou touché.

### Pas de sérialisation multiple de relations to-many sur une collection

Par défaut, une collection ne sérialise pas plusieurs relations to-many à la fois.
Si le détail d'une fiche les demande, elles passent par un groupe de lecture dédié,
ouvert sur l'opération item ou sur un endpoint de détail explicite. Exposer une
relation unique, ou une collection métier spécialisée, reste permis quand le
contrat et le volume le justifient.

**Raison**: plusieurs collections sérialisées ensemble poussent API Platform à les
charger en bloc: le nombre de lignes hydratées suit le produit des relations, pas
celui des ressources. Les fixtures courtes masquent l'effet; sans pagination ou sur
des données réelles, le coût mémoire et base explose. Le groupe de détail garde le
modèle et son API sans payer ce prix sur le catalogue.

**Portée**: code neuf ou touché, ressources API Platform du dépôt. Un endpoint
spécialisé, ou une simple relation to-many, reste permis.

### Un compteur de relation se calcule en SQL

Un compteur exposé sur une collection — nombre d'éléments liés — se calcule en
SQL: un `GROUP BY` sur les identifiants de la page rend le compte (`COUNT` ou
`SUM(CASE …)`), avec jointure sur l'entité cible. Interdit d'hydrater la
relation pour compter en PHP.

**Raison**: compter une collection hydratée fait payer le nombre de liaisons, pas
le nombre de ressources: un tag de 200 prestations en charge 200. `EXTRA_LAZY`
calcule en SQL, certes, mais au prix d'une requête par ressource, sans filtre
possible; une colonne dénormalisée est un double état à synchroniser.
Joindre l'entité cible plutôt que la table de liaison fait appliquer les filtres
Doctrine (cf. la convention sur `EXISTS`).

**Portée**: code neuf ou touché. Un chemin d'écriture qui ne rend qu'une ressource
peut compter sa collection déjà chargée.

### Une collection consommée en entier par un front déclare la pagination client

Quand un front lit une collection entière (`pagination=false`), l'opération déclare
`paginationClientEnabled: true` et `paginationMaximumItemsPerPage: 500`.

**Raison**: faute de `paginationClientEnabled`, API Platform ignore
`pagination=false` en silence et coupe à la première page de 30: l'API renvoie
une collection en apparence valide, le front croit tout voir, et l'écart
n'apparaît nulle part. Le
plafond ne borne que `itemsPerPage` quand le client pagine; une réponse non paginée
n'est pas bornée, `pagination=false` la libère entièrement. But: jamais de
troncature silencieuse d'une demande « tout », pas la garantie qu'une collection
qui grossit reste bon marché.

**Portée**: code neuf ou touché. Ne vise pas les collections qu'aucun front ne
demande en totalité: y ouvrir `pagination=false` livrerait une liste non bornée à
personne.

### L'index d'un `propertyPath` suit le payload reçu

L'index que porte une violation sur un élément de collection se lit dans le payload
reçu, pas dans la collection dénormalisée de l'entité.

**Raison**: l'adder et le remover gardent les éléments existants et ajoutent les
nouveaux au bout: dès que la collection n'est pas vide à l'origine, l'ordre de
l'entité s'écarte de celui du payload.

**Portée**: code neuf ou touché.

### Une relation sérialisée porte la sécurité de lecture de sa cible

Si une ressource limite sa lecture, toute propriété d'une autre ressource qui la
montre — IRI comprise — reprend la même condition via `#[ApiProperty(security: …)]`.

**Raison**: la sécurité d'une opération s'arrête à ses endpoints. Une relation
exposée ailleurs contournerait la restriction en silence.

**Portée**: code neuf ou touché; poser une nouvelle restriction sur une ressource
oblige à passer en revue les relations qui la montrent.

### Une relation d'écriture qui pointe une ressource existante déclare `writableLink: false`

Une relation d'écriture qui sert uniquement à pointer une ressource existante —
entité ou DTO d'entrée — porte `#[ApiProperty(writableLink: false)]`. Un objet
imbriqué y répond 400 au lieu d'être dénormalisé.

**Raison**: sans lui, un objet imbriqué passe dès qu'un champ de la cible figure
dans le groupe d'écriture de l'opération. La cible est alors modifiée hors de ses
opérations propres — sans groupes de validation, sans sécurité — et ce que seule la
base interdit échoue en 500 au flush. Ôter ces champs du groupe d'écriture ne
clôt rien: ces groupes se partagent entre ressources, et le premier champ ajouté
rouvre la porte.

**Portée**: code neuf ou touché. Hors du champ: une relation dont l'opération
attend précisément l'écriture imbriquée.

### Les tests bornés tournent localement sur la base `_test` dédiée

Les tests demandés par la fiche s'exécutent en environnement `test`, uniquement sur
la base au suffixe `_test` — jamais la base de développement. La préparer avec
`composer test:db:setup` si besoin. Les suites complètes (`composer test:all`,
`composer test:coverage`) relèvent de la CI au push, pas de la session
(`standards/code.md`). Sortie PHPUnit redirigée vers un fichier; seul le rapport se
lit après coup.

Chaque test ajouté ou modifié: relever sa durée dans le rapport PHPUnit et la
comparer au reste du dépôt. Un écart nettement au-dessus de la moyenne s'explique,
et se réduit quand il vient du test plutôt que du comportement couvert.

**Raison**: les tests API valident les changements sans exposer les données de
développement. La sortie verbeuse de PHPUnit ne sert qu'après coup: le rapport
donne échecs et total d'assertions à coût de contexte maîtrisé. Un test lent pèse
sur chaque validation locale et sur la CI; le temps fait partie de son contrat de
qualité.

**Portée**: ce dépôt uniquement.

### Un test de migration joue `up()` et vérifie ce qui survit

Un test de migration joue `up()` sur un schéma représentatif et vérifie le SQL
planifié, gardes incluses. Un test de nettoyage contrôle en plus qu'une ligne hors
périmètre demeure intacte.

**Raison**: rejouer une constante SQL ne couvre pas les gardes de `up()`, et un
rejeu idempotent passe par construction: une condition trop large échappe aux deux.

**Portée**: toute migration du dépôt, neuve ou reprise, qui porte des gardes ou
touche des données.

### Les snapshots `tests/Schema` n'appartiennent pas aux missions

Un mission touchant une ressource API Platform ou ses groupes de sérialisation
laisse les snapshots `tests/Schema/*.json` tranquilles: ni régénération ni commit,
et pas de data set dans `SchemaSmokeTest` pour ses opérations. La preuve du contrat
passe par un test d'intégration: appeler l'opération, affirmer ce que la réponse
renvoie (code de statut, corps, violations) et ce qui est relu en base.

**Raison**: ces snapshots ne voient ni un champ en trop ni une valeur fausse.
Régénérer ne contrôle aucun contenu: le fichier est réécrit tel quel, un snapshot
faux peut donc rester vert, et seul un diff manuel le révèle. Il faut aussi les
resynchroniser à chaque évolution des routes, sans rien
pour le garantir: la régénération réécrit tout l'arbre, et une branche promène
vingt fichiers dont trois la concernent. La revue s'y noie. Un test d'intégration
échoue dès que la valeur obtenue diffère de l'attendue.

**Portée**: ce dépôt. Les snapshots `tests/Schema` et `SchemaSmokeTest` subsistent
pour les opérations déjà couvertes; ils ne sont plus rattachés aux missions neuves
ou reprises. Pour les missions en cours, le basculement avance mission par mission.

## Interdits locaux

- Aucun.

## Review

- Gates à rejouer: les tests bornés de la fiche, sur la base `_test` dédiée; citer
  la sortie brute (le rapport PHPUnit).
- Une violation d'une convention ci-dessus est bloquante (`standards/interdits.md`
  #9).
- Faux positifs connus: aucun.
