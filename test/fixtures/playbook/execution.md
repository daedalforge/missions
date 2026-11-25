# Exécution

Entrée : ready → Sortie : in-review

Document : workflows/execution.md

## Avant d'agir
- Vérifier le ticket et la branche.

## Les gestes, dans l'ordre
1. Premier geste.
2. Second geste, qui cite [le document](../workflows/execution.md).

```sh
node tools/check-playbook.mjs
```

> Une citation qui rappelle le contrat.

- Geste de remplissage 1.
- Geste de remplissage 2.
- Geste de remplissage 3.
- Geste de remplissage 4.
- Geste de remplissage 5.
- Geste de remplissage 6.
- Geste de remplissage 7.
- Geste de remplissage 8.
- Geste de remplissage 9.
- Geste de remplissage 10.
- Geste de remplissage 11.
- Geste de remplissage 12.
- Geste de remplissage 13.
- Geste de remplissage 14.
- Geste de remplissage 15.
- Geste de remplissage 16.
- Geste de remplissage 17.
- Geste de remplissage 18.
- Geste de remplissage 19.
- Geste de remplissage 20.
- Geste de remplissage 21.
- Geste de remplissage 22.
- Geste de remplissage 23.
- Geste de remplissage 24.
- Geste de remplissage 25.
- Geste de remplissage 26.
- Geste de remplissage 27.
- Geste de remplissage 28.
- Geste de remplissage 29.
- Geste de remplissage 30.
- Geste de remplissage 31.
- Geste de remplissage 32.
- Geste de remplissage 33.
- Geste de remplissage 34.
- Geste de remplissage 35.
- Geste de remplissage 36.
- Geste de remplissage 37.
- Geste de remplissage 38.
- Geste de remplissage 39.
- Geste de remplissage 40.
- Geste de remplissage 41.
- Geste de remplissage 42.
- Geste de remplissage 43.
- Geste de remplissage 44.
- Geste de remplissage 45.
- Geste de remplissage 46.
- Geste de remplissage 47.
- Geste de remplissage 48.
- Geste de remplissage 49.
- Geste de remplissage 50.
- Geste de remplissage 51.
- Geste de remplissage 52.
- Geste de remplissage 53.
- Geste de remplissage 54.
- Geste de remplissage 55.
- Geste de remplissage 56.
- Geste de remplissage 57.
- Geste de remplissage 58.
- Geste de remplissage 59.
- Geste de remplissage 60.
- Geste de remplissage 61.
- Geste de remplissage 62.
- Geste de remplissage 63.
- Geste de remplissage 64.
- Geste de remplissage 65.
- Geste de remplissage 66.
- Geste de remplissage 67.
- Geste de remplissage 68.
- Geste de remplissage 69.
- Geste de remplissage 70.
- Geste de remplissage 71.
- Geste de remplissage 72.
- Geste de remplissage 73.
- Geste de remplissage 74.
- Geste de remplissage 75.
- Geste de remplissage 76.
- Geste de remplissage 77.
- Geste de remplissage 78.
- Geste de remplissage 79.
- Geste de remplissage 80.
- Geste de remplissage 81.
- Geste de remplissage 82.
- Geste de remplissage 83.
- Geste de remplissage 84.
- Geste de remplissage 85.
- Geste de remplissage 86.
- Geste de remplissage 87.
- Geste de remplissage 88.
- Geste de remplissage 89.
- Geste de remplissage 90.

## Pièges observés
- Piège connu, **en gras** et en *italique*.

## Preuve de sortie
- Preuve attendue, citée par [`workflows/execution.md`](../workflows/execution.md).

## Les règles
- Règle de l’étape.

### Conventions `manager` (React / TypeScript)

- **Un composant ne retourne jamais `undefined`** : la condition qui l'écarte
  se calcule chez le parent. *Raison : un trou passe inaperçu.*

## La fiche du dépôt
| Dépôt | Commandes | Gates et pièges |
| --- | --- | --- |
| `missions` | `npm test`, `node tools/build.mjs`, `node tools/check-workflows.mjs`, `node tools/check-playbook.mjs` | `lib/client.js` généré (diff vide après build) ; prompt épinglé au caractère près ; `node tools/check-playbook.mjs` quand le playbook change |
| `manager` | `yarn install`, `yarn typescript` (`tsc --noEmit`), `yarn lint` | `yarn test` (Cypress component) reste à la CI ; `.env` préparé depuis `.env.local.dist` ; `yarn.lock` ne bouge qu'avec une dépendance ; textes par le paquet `@tolgee/react`, jamais le CLI |
| `connect` | `composer install`, `APP_ENV=testing composer test:parallel` | les tests bornés de la fiche, avec `APP_ENV=testing` ; les tests existants ne portent pas de Given / When / Then, le code neuf suit la règle |
| `clienthub` | `fvm flutter pub get`, `fvm flutter analyze --fatal-warnings`, `fvm flutter test` | `playbook/clienthub.md` : gates, pièges datés, écarts ; tests bornés ; SDK généré ; tokens du design system ; paquet `tolgee` |
| `backend` | `composer install`, `composer test:unit`, `composer test:functional`, `composer phpstan:analyse`, `composer phpcs:analyse`, `composer phpmd:analyse` | tests ciblés et analyseurs ; la suite complète reste à la CI |
| `core-service` | `symfony composer install`, `symfony composer test:db:setup`, `symfony php bin/phpunit`, `symfony composer test:db:drop` | base de test dédiée ; tests bornés de la fiche |
| `marketplace-service` | `composer install`, `composer test:db:setup`, `php bin/phpunit <chemin>` (env `test`), `composer test:db:drop` | `test:all` et `test:coverage` restent à la CI ; base `_test` ; les snapshots `tests/Schema/*.json` ne se régénèrent ni ne se committent ; une migration Casbin pose et retire chaque règle isolément |
| `ticketing-service` | `symfony composer install`, `symfony composer test:db:setup`, `symfony php bin/phpunit`, `symfony composer test:db:drop` | base de test dédiée ; tests bornés de la fiche |
