# clienthub

Page de dépôt : les gates, les règles et les pièges de clienthub.

## Avant d'agir
- Lire la fiche du dépôt et le playbook source daté.

## Les gestes, dans l'ordre
1. `fvm use`
2. `fvm flutter pub get`
3. `fvm flutter analyze --fatal-warnings`
4. `fvm flutter test`

## Pièges observés
- Un build sans `--flavor standard|flexo` échoue (2026-11-23).

## Preuve de sortie
- La CI `lint-n-test` est verte.

## Les règles
- C03 : pas de `if` imbriqué.
- T01 : voir échouer le test sans le correctif.

## La fiche du dépôt
- Dépôt : `clienthub`.
