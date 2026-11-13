# Standards

Les règles que les sessions appliquent pour écrire et relire le code. Elles vivent
dans ce dépôt, versionnées avec la méthode, pour qu'un clone contienne tout ce
qu'une session doit lire.

Ce dossier remplace les standards de l'ancien système. Il est la seule autorité :
une session cite un fichier d'ici, jamais un fichier de konoha, et l'ancien dossier
n'est plus lu. La [reprise de l'ancien système](#la-reprise-de-lancien-système) dit,
fichier par fichier, ce qui a été conservé, adapté ou retiré — et pourquoi ; le même
tableau existe pour les 13 interdits.

## Le contrat de lecture

Une session ne recopie pas les standards : le prompt du panneau nomme les fichiers
de son étape, et elle les lit. Ce tableau est le contrat — pour chaque étape, les
fichiers qu'elle lit.

| Étape | Fichiers |
| --- | --- |
| cadrage | `standards/README.md`, `standards/repos/<projet>.md` |
| exécution | `standards/code.md`, `standards/interdits.md`, `standards/repos/<projet>.md` |
| revue | `standards/revue.md`, `standards/code.md`, `standards/interdits.md`, `standards/repos/<projet>.md` |
| clôture | `standards/interdits.md`, `standards/revue.md` |

`<projet>` est le dernier segment du chemin du dépôt, en minuscules. Le dépôt d'une
mission est déclaré dans [`missions/projects.yml`](../missions/projects.yml) :
`~/projects/Manager` donne `manager`, `~/projects/missions` donne `missions`. Le
chemin de la fiche se déduit ainsi du dépôt lui-même, sans table de correspondance
à tenir. Un projet sans dépôt déclaré n'a pas de fiche : le prompt omet la ligne de
la fiche au lieu de nommer un fichier qui n'existe pas.

Cinq fiches n'ont pas de projet déclaré à ce jour — `backend`, `clienthub`,
`core-service`, `marketplace-service`, `ticketing-service` : elles restent, marquées
« non déclaré » en tête, prêtes pour une mission à venir. L'outil ne vérifie que les
projets déclarés.

## L'index

Le dossier ne contient que ces fichiers. Un fichier présent mais absent de cette
table, un fichier de cette table absent du disque, ou une fiche de dépôt manquante
pour un projet déclaré font échouer `node tools/check-standards.mjs`.

| Fichier | Ce qu'il porte |
| --- | --- |
| `standards/README.md` | cet index, le contrat de lecture, la reprise de l'ancien système |
| `standards/code.md` | les conventions de code, communes à tous les dépôts |
| `standards/revue.md` | ce qu'une revue contrôle, ce qu'elle peut refuser |
| `standards/interdits.md` | les 13 interdits globaux |
| `standards/repos/missions.md` | ce dépôt : outillage, build, tests, doc |
| `standards/repos/manager.md` | l'application React (Manager) |
| `standards/repos/connect.md` | le dépôt PHP Connect |
| `standards/repos/backend.md` | le backend historique (non déclaré) |
| `standards/repos/clienthub.md` | l'application Flutter (non déclaré) |
| `standards/repos/core-service.md` | le service core (non déclaré) |
| `standards/repos/marketplace-service.md` | le service marketplace (non déclaré) |
| `standards/repos/ticketing-service.md` | le service ticketing (non déclaré) |

## Ajouter un standard

1. Écrire la règle dans le fichier qui la porte — `standards/code.md` pour une
   convention de code, `standards/interdits.md` pour un garde-fou, `standards/revue.md`
   pour un critère de relecture, une fiche `standards/repos/` pour ce qui ne vaut que
   dans un dépôt — avec sa raison et sa portée, comme les règles existantes.
2. L'indexer dans la table ci-dessus si c'est un fichier neuf.
3. Si une étape doit le lire, l'ajouter au [contrat de
   lecture](#le-contrat-de-lecture) **et** à `STANDARDS_STEP_FILES` dans
   `lib/view.js`.
4. Relancer `node tools/check-standards.mjs` et `npm test` : un fichier absent de
   l'index, un contrat qui diverge du prompt ou une fiche manquante échouent.

## La reprise de l'ancien système

Les standards venaient de l'ancien système konoha, où ils étaient maintenus pour son
orchestrateur : un roster de rôles, un tracker Jira, une branche nommée dans la
fiche, des worktrees de mission. La reprise garde les règles et retire — ou adapte —
ce qui suppose cet orchestrateur ; l'écart est écrit à chaque fois.

| Fichier de konoha | Devenir ici | Décision | Écart et raison |
| --- | --- | --- | --- |
| `code.md` | `standards/code.md` + `standards/revue.md` | adapté | La section « Revue » sort dans son propre fichier : la revue a désormais sa fiche d'étape, et `standards/revue.md` grandit avec elle. Les autres règles sont conservées ; l'intro nomme les fichiers de l'étape au lieu de dire « une session charge ce fichier, rien de plus », et le nom de test ne présuppose plus l'anglais (la fiche du dépôt donne la langue). |
| `interdits.md` | `standards/interdits.md` | adapté | Les 13 entrées sont reprises une par une, sans renumérotation (tableau ci-dessous). Les références `#9` et `#8` des fiches de dépôt restent donc justes. L'en-tête sur le roster et la dérogation du principal est reformulé pour le demandeur de la mission. |
| `roles.md` | — | retiré | Le roster `orchestrator` / `implementer` / `reviewer` et la séparation exécution / jugement sont l'architecture de konoha ; dans missions, les étapes du ticket et le demandeur portent ces mandats. Rien à reprendre sans redire le flux d'états, qui est hors périmètre. |
| `communication.md` | — | retiré | La topologie en étoile, l'anglais du canal Conversation et le protocole brief / rapport décrivent la communication avec un orchestrateur qui n'existe pas ici. |
| `types.md` | — | retiré | Les trois types de mission, les gabarits et les clés de frontmatter de konoha ne sont pas ceux de `missions/projects.yml` ni du gabarit de mission. |
| `bruno.md` | — | retiré | Les collections Bruno sont un artefact de l'ancien flux ; la mission de ce dépôt n'en décrit pas. |
| `workspace.md` | — | retiré | Règles propres à konoha (`~/projects/worktrees`, squash à la clôture, archives locales) ; la branche et la base d'une mission sont déclarées dans `missions/<dossier>/mission.yml` et la PR part du clone. |
| `repos/Manager.md` | `standards/repos/manager.md` | conservé | Fiche renommée en minuscules pour suivre le nom du dépôt (`~/projects/Manager` → `manager`). `base_branch` remplacé par « la base est déclarée dans `mission.yml` ». |
| `repos/Connect.md` | `standards/repos/connect.md` | conservé | Même renommage ; même remplacement de `base_branch`. |
| `repos/backend.md` | `standards/repos/backend.md` | conservé | `base_branch` remplacé ; marquée « non déclaré » car le projet n'est pas dans `missions/projects.yml`. |
| `repos/clienthub.md` | `standards/repos/clienthub.md` | adapté | `base_branch` remplacé, renvoi `#10` corrigé en `#9` ; marquée « non déclaré ». |
| `repos/core-service.md` | `standards/repos/core-service.md` | conservé | `base_branch` remplacé ; marquée « non déclaré ». |
| `repos/marketplace-service.md` | `standards/repos/marketplace-service.md` | adapté | `base_branch` remplacé, renvoi `#10` corrigé en `#9` ; marquée « non déclaré ». |
| `repos/ticketing-service.md` | `standards/repos/ticketing-service.md` | conservé | `base_branch` remplacé ; marquée « non déclaré ». |
| `repos/.keepignore` | — | retiré | Les fiches sont versionnées ici : plus de dossier local à garder vide. |
| — | `standards/revue.md` | créé | La revue de konoha tenait en deux règles dans `code.md` ; elle a maintenant sa fiche d'étape, et les trois critères de refus de `workflows/review.md` y sont repris. |
| — | `standards/repos/missions.md` | créé | Ce dépôt n'avait pas de fiche ; il en a une pour son outillage et ses conventions. |

### Les 13 interdits, un par un

| N° | Interdit de konoha | Décision | Écart et raison |
| --- | --- | --- | --- |
| 1 | Aucun push sur `main` ou une branche protégée ; seule la branche nommée par la fiche est poussable. | adapté | La branche garde son rôle, mais elle est déclarée dans `missions/<dossier>/mission.yml` et non par un orchestrateur. La poussée sur `main` reste interdite, sans exception. |
| 2 | Aucun force-push, aucune réécriture d'un historique publié. | conservé | Aucun écart : la PR est relue sur son historique, un rebase réécrit ce que le relecteur a lu. |
| 3 | Aucune fusion de PR. | conservé | Aucun écart : le merge est le geste du demandeur, même s'il le demande à une session. |
| 4 | Aucun `approve` ; une revue se limite à `request changes`. | adapté | L'interdit visait l'approbation d'une PR, qui engage le demandeur. Dans la mission, l'étape de revue approuve le ticket (`ready-for-prod`) et écrit ses constats : c'est le verdict de l'étape, pas une review de PR. Publier un `Approve` sur la PR reste interdit. |
| 5 | Aucune publication de review sans validation du principal. | adapté | Les constats s'écrivent dans le journal, la checklist et le ticket, que le demandeur lit. Rien n'est publié sur la PR ; la publication reste son geste. |
| 6 | Aucune écriture hors du périmètre du brief ou de la fiche. | adapté | Le brief est remplacé par le périmètre nommé du ticket et du gabarit : `missions/<dossier>/`, la branche déclarée, et rien d'autre. |
| 7 | Aucun secret ni credential dans le workspace ; exceptions : jeton Atlassian et `.env.gpg` de bruno. | adapté | L'interdit reste, mais ses deux exceptions disparaissent avec l'outillage de konoha. La configuration d'un outil vit dans `config/tools/` ; le jeton du tracker est lu par l'hôte du panneau, jamais écrit par une session. |
| 8 | Aucun accès Tolgee. | conservé | Aucun écart : les textes passent par le paquet du dépôt, jamais par le CLI, et les fiches le rappellent en local. |
| 9 | Aucune dérogation à un standard. | conservé | Aucun écart : une règle qui n'est pas ici n'existe pas, et une dérogation non écrite n'est pas une dérogation. |
| 10 | Aucun renvoi à un standard non versionné. | adapté | La règle prenait acte des fiches locales de konoha. Ici les standards sont versionnés dans ce dossier : le renvoi à un standard non versionné reste interdit, et les fiches de dépôt vivent dans `standards/repos/`. |
| 11 | Toute PR produit est ouverte en draft. | adapté | Le draft est retiré : la PR ouverte est le support de la revue, et le gabarit d'exécution la veut liée et prête. Elle vise la base déclarée dans `mission.yml`. |
| 12 | Aucune exécution pendant le cadrage sans go nommé. | adapté | Le go nommé de konoha devient l'état du ticket : le cadrage écrit sur `to-refine`, l'exécution ne commence qu'à `ready`. Aucun état `active` n'existe ici. |
| 13 | Aucun accès système, aucune demande d'accès, aucune sortie du home ; non dérogeable. | adapté | Le home de konoha devient le workspace `~/projects` : la session écrit sous sa racine de travail et ce que son bac à sable autorise, rien d'autre. L'interdit reste non dérogeable. |
