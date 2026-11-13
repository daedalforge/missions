# Workspace — les gestes transverses

Ce qui ne dépend pas d'une étape : quel checkout, quel dépôt, quels gestes sont
permis. La session libre et celle des remontées de PR lisent cette page.

## Avant d'agir

- Se placer : `pwd` doit être sous `~/projects` ; jamais `/`, jamais hors du
  workspace (interdit 13).
- Choisir le checkout : `git worktree list` — le dépôt `missions` peut être sur
  la branche d'une autre session (MIS-163).
- Lire `AGENTS.md` du workspace, puis la fiche du dépôt dans la page de
  l'étape (`playbook/<étape>.md`, section `## La fiche du dépôt`).

## Les gestes, dans l'ordre

1. **Travailler dans un worktree dédié** quand une autre session tient le
   checkout principal :
   `git worktree add <chemin> -b <branche> origin/<base>`.
2. **Vérifier la branche avant tout commit** :
   `git rev-parse --abbrev-ref HEAD` et `git status --short`.
3. **Lire le ticket au CLI**, avec `-R` : `~/projects` n'est pas un dépôt, `gh`
   ne peut pas deviner le dépôt.
4. **Un ticket = une branche = une PR** : ne pas réutiliser la branche d'une
   autre mission.
5. **Écrire les métadonnées** de la PR : assigné, type, label d'état, jalon —
   les mêmes que le ticket.
6. **Tenir le journal et la checklist** dans `missions/<dossier>/` : ils sont
   ignorés par git et restent sur le poste.
7. **S'arrêter au bon moment** : merge, fermeture, suppression de branche sont
   des gestes du demandeur.

## Pièges observés

- Le checkout principal change de branche sous les pieds : vérifier `HEAD`
  avant chaque commit (MIS-163).
- `gh` sans `-R` échoue depuis `~/projects` : `fatal: not a git repository`.
- `missions/*/` est ignoré : un journal commité n'arrive jamais dans la PR.
- `lib/client.js` est généré : relancer `node tools/build.mjs` après tout
  changement de `lib/view.js` ou du template.
- Le prompt de session est épinglé : toute ligne ajoutée exige de mettre à jour
  `test/view.test.mjs`.

## Preuve de sortie

- Le checkout utilisé est nommé (`git worktree list`), sur la bonne branche.
- La branche est poussée, la PR liée au ticket par `Closes #N`.
- Le journal et la checklist sont à jour, avec leurs preuves.
- Aucune écriture sur `main`, aucun merge, aucune suppression de branche.

## Les règles

Les treize interdits valent pour toutes les sessions, tous les dépôts, toutes
les missions. Un brief, un cadrage ou une fiche ne peut ni les autoriser ni les
retirer ; seul le demandeur déroge par écrit, et la dérogation est consignée
dans le journal. Le treizième échappe à cette dérogation.

1. **Aucun push sur `main` ni sur une branche protégée.** Toutes les sessions.
   Seule la branche déclarée dans `missions/<dossier>/mission.yml` est poussable ;
   `main` ne reçoit que le merge du demandeur. *Raison : le dépôt n'appartient
   pas à l'agent ; la branche de mission est la seule autorisation.*
2. **Aucun force-push, aucune réécriture d'historique.** Toutes les sessions.
   *Raison : l'historique est la trace sur laquelle la revue s'appuie.*
3. **Aucun merge de PR.** Toutes les sessions, même demandé par écrit.
   *Raison : la fusion appartient au demandeur.*
4. **Aucun `Approve` sur une PR.** Toutes les sessions ; publier sur une PR se
   limite à `request changes` et reste un geste du demandeur. L'étape de revue
   approuve le ticket (`ready-for-prod`), pas la PR. *Raison : l'approbation
   d'une PR engage le demandeur.*
5. **Aucune publication de review sans validation du demandeur.** Revue et
   clôture. Les constats s'écrivent dans le journal, la checklist et le ticket.
6. **Aucune écriture hors du périmètre de la fiche.** Toutes les sessions. Le
   périmètre est `missions/<dossier>/`, la branche déclarée, et rien d'autre.
   *Raison : seul un périmètre nommé limite l'écriture.*
7. **Aucun secret, credential ou état de session dans le workspace.** Nul secret
   dans un dépôt, un skill, un journal ou un artefact ; la configuration d'un
   outil vit dans `config/tools/`, le jeton du tracker est lu par l'hôte du
   panneau. *Raison : un secret écrit vit dans l'historique et toutes ses copies.*
8. **Aucun accès Tolgee, direct ou indirect.** Aucun credential Tolgee n'est
   présent, aucune mission n'en produit ; la traduction reste locale.
9. **Aucune dérogation à une règle du playbook.** La session applique la règle à
   chaque ligne qu'elle touche ; un conflit se signale et l'écriture s'arrête.
   *Raison : une règle qu'on peut écarter par commodité n'en est plus une.*
10. **Aucune règle hors du playbook.** Toute règle applicable est écrite dans
    une page du playbook ; un fichier versionné ne cite pas une règle absente.
    *Raison : un clone doit contenir tout ce qu'une session lit.*
11. **Toute PR part de la branche déclarée vers la base déclarée.** Elle est
    ouverte liée au ticket (`Closes #N`), renseignée, sans draft ; la fusion
    reste interdite (#3).
12. **Aucune exécution pendant le cadrage.** Tant que le ticket est `to-refine`,
    aucun commit, aucune branche poussée, aucune PR ; l'exécution commence à
    `ready`. Un « continue » entre deux messages ne vaut pas go.
13. **Aucun accès au système, aucune demande d'accès, aucune sortie du
    workspace.** Ne pas modifier la machine (paquets, services, réglages,
    permissions, comptes), ne pas demander d'élévation ou de mot de passe, ne
    pas lire ni écrire hors de `~/projects` — exécuter l'outillage installé
    n'est pas le modifier. Une commande qui sort, une demande d'élévation : la
    session s'arrête et le signale. *Non dérogeable.*

## La fiche du dépôt

La base n'est pas fixée ici : elle est déclarée dans
`missions/<dossier>/mission.yml`. Les cinq dépôts sans projet déclaré sont
marqués « non déclaré ».

| Dépôt | Clone | Tracker |
| --- | --- | --- |
| `missions` | `~/projects/missions` | GitHub (`daedalforge/missions`) |
| `manager` | `~/projects/Manager` | Jira (`saas-office.atlassian.net`, SO) |
| `connect` | `~/projects/Connect` | Jira (`saas-office.atlassian.net`, SOC) |
| `clienthub` | `~/projects/clienthub` | non déclaré |
| `backend` | `~/projects/backend` | non déclaré |
| `core-service` | `~/projects/core-service` | non déclaré |
| `marketplace-service` | `~/projects/marketplace-service` | non déclaré |
| `ticketing-service` | `~/projects/ticketing-service` | non déclaré |
