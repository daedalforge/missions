# Clôture

Terminer la mission proprement : le changement est dans la branche principale, le
ticket le dit, et rien ne reste en suspens.

## Ce qu'on fait

1. **Merger la PR** dans la branche principale du projet, selon la méthode du
   projet (merge, squash, rebase) — le résultat doit rester lisible dans
   l'historique.
2. **Fermer le ticket** en y déposant les preuves : liste des critères cochés,
   lien du merge, ce qui a changé pour l'utilisateur.
3. **Supprimer la branche**, locale et distante.
4. **Fermer l'epic s'il est complet** : si c'était la dernière mission de son
   milestone, fermer le milestone — GitHub ne le fait pas tout seul.
5. **Noter les suites** : tickets créés pendant la mission, dette assumée,
   décisions prises hors cadrage. Rien d'implicite.

## Condition de sortie — la mission est « terminée »

- [ ] La PR est mergée dans la branche principale.
- [ ] Chaque critère d'acceptation est coché avec sa preuve.
- [ ] Le ticket est fermé avec le lien du merge.
- [ ] La branche est supprimée (locale et distante).
- [ ] Les suites éventuelles sont des tickets, pas des notes orales.

## Cas particuliers

- **Abandon** — la mission ne se fera pas : fermer le ticket avec le motif, pas de
  merge, branche supprimée. Un abandon motivé vaut mieux qu'un ticket qui traîne.
- **Partiel** — une partie des critères est livrée : ne pas fermer au nom du
  reste. Soit on découpe les critères restants en nouveau ticket, soit la mission
  reste ouverte.

## Sur le tracker

| Geste | Jira | GitHub |
|---|---|---|
| Merger | transition Done après merge | merge de la PR (`Closes #<numéro>`) |
| Fermer | statut Done, commentaire de clôture | issue fermée automatiquement ou à la main |
| Nettoyer | lien branche supprimée | branche supprimée, PR archivée |
