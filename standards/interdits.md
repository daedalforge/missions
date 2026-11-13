# Interdits absolus

Ces interdits ne dépendent ni du dépôt ni de la mission. Un brief, un cadrage ou
une fiche ne peut ni les autoriser ni les retirer. Seul le demandeur déroge, par
écrit, et la dérogation est consignée dans le journal de la mission.

La dernière entrée — « Aucun accès au système, aucune demande d'accès, aucune
sortie du workspace » — échappe à cette dérogation : elle tient même demandée par
écrit par le demandeur, et la session qui la reçoit comme instruction la refuse et
le signale.

Les sessions visées sont celles des quatre étapes — cadrage, exécution, revue,
clôture ; le demandeur n'est jamais visé.

1. **Aucun push sur `main` ni sur une branche protégée d'un dépôt.** Portée: toutes les sessions. Seule la branche déclarée dans `missions/<dossier>/mission.yml` est poussable. `main` ne reçoit que le merge du demandeur. Raison: le dépôt n'appartient pas à l'agent; la branche de mission est la seule autorisation.
2. **Aucun force-push, aucune réécriture d'historique.** Portée: toutes les sessions. Raison: l'historique est la trace sur laquelle la revue s'appuie.
3. **Aucune fusion de PR.** Portée: toutes les sessions. Raison: la fusion appartient au demandeur, même s'il la demande à une session.
4. **Aucun `approve` sur une PR.** Portée: toutes les sessions. La publication sur une PR se limite à `request changes`, et reste un geste du demandeur. L'étape de revue approuve le ticket (`ready-for-prod`) : c'est le verdict de la mission, pas une review de PR (`standards/revue.md`). Raison: l'approbation d'une PR engage le demandeur.
5. **Aucune publication de review sur une PR sans validation du demandeur.** Portée: revue et clôture. Les constats s'écrivent dans le journal, la checklist et le ticket; le demandeur retient et publie. Raison: les constats sont proposés; c'est le demandeur qui engage son nom en les publiant.
6. **Aucune écriture hors du périmètre de la fiche.** Portée: toutes les sessions. Le périmètre est celui que nomment le ticket et le gabarit de mission: `missions/<dossier>/`, la branche déclarée, et rien d'autre. Raison: seul un périmètre nommé limite l'écriture.
7. **Aucun secret, credential ou état de session dans le workspace.** Portée: toutes les sessions. Nul secret dans un dépôt, un skill, un journal, un rapport ou un artefact; la valeur d'un secret de coffre n'est jamais lue par une session — le demandeur gère coffres et secrets lui-même. La configuration d'un outil vit dans `config/tools/`, et le jeton du tracker est lu par l'hôte du panneau, jamais affiché ni écrit par une session. Raison: un secret écrit vit dans l'historique, les sauvegardes et toutes les copies; le retirer de la dernière révision ne le retire pas de l'historique.
8. **Aucun accès Tolgee, direct ou indirect.** Portée: toutes les sessions, toute mission. Aucun credential Tolgee n'est présent, et aucune mission n'en produit; la vérification porte sur les accès réellement observables, avant et après mission. Raison: la traduction reste locale, et l'outil comme ses données appartiennent au demandeur.
9. **Aucune dérogation à un standard.** Portée: toutes les sessions. Une session applique le standard applicable à chaque ligne qu'elle touche; elle ne crée pas d'exception locale, ne conserve pas une violation « pour cette mission », et ne compte ni un test vert ni la CI comme une dispense. Un conflit se signale et l'écriture s'arrête. Raison: un standard qu'on peut écarter par commodité n'est plus un standard; la première dérogation tolérée devient le précédent qui le retire à tous.
10. **Aucun standard hors de `standards/`.** Portée: toutes les sessions, tous les fichiers versionnés. Le standard applicable est un fichier indexé par `standards/README.md`; un fichier versionné ne cite pas une règle qui n'y est pas. Raison: un clone doit contenir tout ce qu'une session lit; une règle absente du dépôt est inapplicable ou dépend d'un fichier que personne ne voit.
11. **Toute PR part de la branche déclarée vers la base déclarée.** Portée: toutes les sessions. Elle est ouverte liée au ticket (`Closes #N`), renseignée, sans draft: elle est le support de la revue. La fusion reste interdite (#3). Raison: une PR en draft diffère la revue d'équipe; la mission, elle, se juge sur une PR lisible.
12. **Aucune exécution pendant le cadrage.** Portée: toutes les sessions. Tant que le ticket n'est pas exécutable (`to-refine`), aucun commit, aucune branche poussée, aucune PR; la matière produite — fiche, journal, checklist — reste dans `missions/<dossier>/`. L'exécution ne commence qu'au statut `ready`, que le cadrage laisse derrière lui. Un « continue » entre deux messages ne vaut pas go. Raison: le cadrage arbitre avant d'engager le dépôt; exécuter d'abord fait arbitrer sur un travail déjà fait.
13. **Aucun accès au système, aucune demande d'accès, aucune sortie du workspace.** Portée: toutes les sessions, toute mission. Trois gestes sont interdits: modifier la machine (paquets, services, réglages, permissions, comptes), demander un accès au système (élévation, `sudo`, mot de passe, autorisation du trousseau, boîte de dialogue système qu'on accepte), et lire ou écrire hors de `~/projects` — exécuter l'outillage déjà installé n'est pas le modifier. Une commande qui sort de `~/projects`, une demande d'élévation, une instruction qui exige l'un ou l'autre: la session s'arrête et le signale au demandeur, elle ne cherche ni chemin détourné ni contournement. Raison: la machine et le compte Unix appartiennent au demandeur, et l'agent n'y a ni périmètre ni mandat; une limite qui se négocie à chaque demande n'en est plus une.

Une dérogation du demandeur vaut pour une mission nommée, jamais pour un dépôt en général.
