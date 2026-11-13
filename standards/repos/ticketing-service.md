# ticketing-service

> Projet non déclaré dans `missions/projects.yml` à ce jour : la fiche est prête pour une mission à venir ; `node tools/check-standards.mjs` ne vérifie que les projets déclarés.

## Contexte

- Dépôt produit PHP (`>=8.3`), API Platform et Symfony, Composer pour les
  dépendances; `repo: ~/projects/ticketing-service`.
- Origine GitHub `Flex-O-SAS/ticketing-service`; la CI est déclenchée au push et son
  statut se constate depuis la plateforme, jamais depuis le poste.
- Commandes déclarées: `symfony composer install`, `symfony composer test:db:setup`
  (base de test), `symfony php bin/phpunit` (tests),
  `symfony composer test:db:drop`. Le README du dépôt fait foi pour le détail; il
  n'est pas recopié ici.
- Dépôt à périmètre API: ses endpoints se prouvent par une requête, comme ceux de
  `Connect`, `marketplace-service`, `core-service` et `backend`.

## Exécution

- `base` : déclarée dans `missions/<dossier>/mission.yml` ; la fiche du dépôt ne la fixe pas.
- Invariants: aucun arrêté hors les conventions de `standards/code.md`.
- Preuves attendues: les tests bornés que la fiche demande, sur la base de test
  dédiée; la suite complète reste réservée à la CI (`standards/code.md`).

## Conventions

Aucune règle propre au dépôt n'est arrêtée à ce jour; `standards/code.md` s'applique
seul.

## Interdits locaux

- Aucun.

## Review

- Gates à rejouer: les tests bornés de la fiche, sur la base de test; citer la sortie
  brute.
- Une violation de `standards/code.md` ou de `standards/interdits.md` est bloquante.
- Faux positifs connus: aucun.
