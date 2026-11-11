# Clôture

Terminer la mission proprement, à deux mains : la session prépare la livraison et
s'arrête ; le demandeur merge, ferme le ticket et supprime la branche ; la session
constate et solde le journal et la checklist.

## Ce qu'on fait

1. **(session) Préparer la livraison.** Vérifier que la PR est approuvée et que
   chaque critère d'acceptation porte sa preuve, puis laisser le ticket en
   `ready-for-prod` — c'est l'état d'entrée de cette étape. La session s'arrête
   ici : elle ne merge pas, elle ne ferme pas le ticket, elle ne supprime pas la
   branche.
2. **(demandeur) Merger et livrer.** Merger la PR dans la branche principale
   selon la méthode du projet (merge, squash ou rebase — le résultat doit rester
   lisible), fermer le ticket en y déposant les preuves : critères cochés, lien
   du merge, ce qui a changé pour l'utilisateur. Supprimer la branche, locale et
   distante. Si c'était la dernière mission de son milestone, fermer le
   milestone — GitHub ne le fait pas tout seul.
3. **(session) Constater et solder.** Sur le mot explicite du demandeur, relire
   l'état sur le tracker : PR mergée, ticket fermé, branche absente. Puis clore
   le journal (lien du merge, preuves après merge, suites), solder la checklist
   et noter les suites. Aucun geste sur le tracker : il est déjà à jour.

## Garde-fous

Ces interdits valent pour toutes les missions du workspace, dans tous les
projets, même si le demandeur les demande explicitement :

- **Ne jamais merger une PR** — ni merge, ni squash, ni rebase, ni par la CLI,
  ni par l'API, ni par l'interface. Le merge est le geste du demandeur.
- **Ne jamais écrire sur `main`** — pas de commit, pas de push direct, pas de
  « petit correctif ».
- **Ne jamais forcer** — pas de force-push, pas de rebase d'une branche
  partagée, pas de réécriture de `main`.

Si le demandeur demande un de ces gestes, la réponse est non : « c'est interdit,
c'est vous qui mergez ». Le ruleset `main` refuse déjà le push direct, le
force-push et la suppression de `main` ; il autorise en revanche le merge d'une
PR, et GitHub ne distingue pas la session du demandeur (même compte). Le
garde-fou est donc dans le workflow, dans le test du modèle et dans le prompt de
session du panneau — pas dans les droits du tracker.

## Condition de sortie — la mission est « terminée »

- [ ] La PR est mergée dans la branche principale — par le demandeur.
- [ ] Chaque critère d'acceptation est coché avec sa preuve.
- [ ] Le ticket est fermé avec le lien du merge.
- [ ] La branche est supprimée (locale et distante).
- [ ] Les suites éventuelles sont des tickets, pas des notes orales.
- [ ] Le journal porte la clôture (merge, preuves, suites).
- [ ] La checklist est soldée (cases cochées ou suites nommées).

## Cas particuliers

- **Abandon** — la mission ne se fera pas : le demandeur ferme le ticket avec le
  motif, sans merge, et supprime la branche. Un abandon motivé vaut mieux qu'un
  ticket qui traîne.
- **Partiel** — une partie des critères est livrée : on ne ferme pas au nom du
  reste. Soit on découpe les critères restants en nouveau ticket, soit la mission
  reste ouverte.
- **Session interrompue avant le merge** — la livraison reste en `ready-for-prod`
  et la branche reste en place : la reprise repart de la PR, sans rien merger.

## Sur le tracker

| Geste | Qui | Jira | GitHub |
|---|---|---|---|
| Préparer | session | vérifier la PR et les preuves | PR approuvée, ticket en `ready-for-prod` |
| Merger | demandeur | transition `Released` (Manager) ou `Done` (Connect) après merge | merge de la PR (`Closes #<numéro>`) |
| Fermer | demandeur | statut `Released` (Manager) ou `Done` (Connect), commentaire de clôture | issue fermée automatiquement ou à la main |
| Constater | session | relire l'état, sans rien changer | PR mergée, issue fermée, branche absente |
| Nettoyer | demandeur | lien branche supprimée | branche supprimée, PR archivée |
