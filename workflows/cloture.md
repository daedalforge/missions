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
3. **(session ou panneau) Constater et solder.** Sur le mot explicite du
   demandeur, relire l'état sur le tracker : PR mergée, ticket fermé, branche
   absente. Puis clore le journal (lien du merge, preuves après merge, suites),
   solder la checklist et noter les suites. Aucun geste sur le tracker : il est
   déjà à jour. Si le ticket est encore en `ready-for-prod`, le geste « Close the
   local checkout » du volet ferme le checkout local en un coup, sur preuve que
   le merge est bien sur la base — voir ci-dessous.

**Clôture locale — le geste du panneau.** Une fois la PR mergée et le ticket
encore en `ready-for-prod`, le volet de la mission propose **« Close the local
checkout »**. Le geste vérifie d'abord, sur le
tracker, que le travail est livré ; il ne touche ensuite qu'à la machine :

1. **La preuve.** La route hôte lit l'issue (état `ready-for-prod`, pas de
   conflit de labels) puis les PR dont la tête est la branche de mission. Il faut
   une PR mergée, dont la base est la base déclarée, et dont le merge commit (ou
   la tête) est ancêtre de `origin/<base>`. Un `git fetch origin <base>` précède
   la seconde vérification ; sans preuve, rien n'est supprimé.
2. **Les worktrees.** `git worktree remove` sur chaque worktree qui porte la
   branche, jamais avec `--force` : un worktree sale refuse et le dit.
3. **Le clone.** Il n'est pas supprimé : il passe sur la base
   (`git checkout <base>` puis `git merge --ff-only origin/<base>`).
4. **La branche.** `git branch -D` (les projets squash-mergent : `-d` refuserait
   les commits déjà livrés).
5. **Le machete.** La ligne est retirée du fichier `.git/machete` à la main ; ses
   enfants remontent d'un niveau, annotations et indentation des autres branches
   conservées. Aucun processus `git machete` n'est lancé.
6. **Le journal.** Une section `## <date> — Clôture` est ajoutée à
   `missions/<dossier>/journal.md` (PR, merge commit, gestes, clone, machete).

Le bouton s'arme en deux temps (un clic pour dire ce qu'il va supprimer, un
second pour agir). Chaque refus est un message, pas une suppression partielle :
pas de clone, mission pas en `ready-for-prod`, pas de PR, PR non mergée, PR
mergée vers une autre base, commit absent de la base, worktree sale, commit local
non livré. La branche **distante** reste à supprimer par le demandeur ; le
tracker n'est jamais écrit — le geste ne remplace ni le merge ni la fermeture.

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
- [ ] La branche est supprimée (locale et distante) — la locale par le geste du
      panneau ou à la main, la distante par le demandeur.
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
