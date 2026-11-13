# Le playbook

Une session sait **quoi** faire par `workflows/`, **comment** et **sous quelles
règles** par ce dossier. Chaque page porte la recette de son étape, ses règles et
la fiche des dépôts. Le prompt de session nomme une page ; la session la lit et
la suit au lieu de la redériver.

Le playbook est la seule autorité : une session cite une page d'ici, jamais un
fichier de konoha, et l'ancien dossier n'est plus lu.

## Index

| Page | Étape | Ce qu'elle porte |
| --- | --- | --- |
| `playbook/cadrage.md` | to-refine → ready | lire un ticket, écrire la fiche, proposer branche et base |
| `playbook/execution.md` | ready → in-review | brancher, coder, tester, pousser, ouvrir la PR |
| `playbook/revue.md` | in-review → ready-for-prod | relire la PR, vérifier les CA, poser la décision |
| `playbook/cloture.md` | ready-for-prod → done | constater le merge et solder le dossier |
| `playbook/workspace.md` | — | gestes transverses, checkout, les treize interdits |

## Le contrat de lecture

Une session ne recopie pas une page : le prompt du panneau nomme la page de son
étape, et elle la lit. Le prompt reste la source ; `node tools/check-playbook.mjs`
vérifie que ce contrat, le prompt et les pages ne divergent pas.

| Étape | Page lue |
| --- | --- |
| cadrage | `playbook/cadrage.md` |
| exécution | `playbook/execution.md` |
| revue | `playbook/revue.md` |
| clôture | `playbook/cloture.md` |

La page de l'étape porte aussi les règles et la fiche des dépôts : il n'y a pas
de lecture séparée à faire. `playbook/workspace.md` se lit en plus, à toute
étape, pour les treize interdits.

## La forme d'une page

Chaque page porte, dans cet ordre, six sections :

1. `## Avant d'agir`
2. `## Les gestes, dans l'ordre`
3. `## Pièges observés`
4. `## Preuve de sortie`
5. `## Les règles`
6. `## La fiche du dépôt`

Une page d'étape ajoute en tête la ligne `Entrée : <état> → Sortie : <état>` et
le lien vers son document `workflows/<document>.md`. Une page tient en 200
lignes ; `node tools/check-playbook.mjs` échoue au-delà, ou si une section, la
ligne d'état, le document d'étape ou un dépôt de la fiche manque.

`## Les règles` ouvre sur les quatre interdits communs (push sur `main`,
force-push, merge, `Approve`), puis les règles de l'étape, puis renvoie vers
`workspace.md#les-règles` pour les treize. La fiche nomme les huit dépôts :
`missions`, `manager`, `connect`, `clienthub`, `backend`, `core-service`,
`marketplace-service`, `ticketing-service`.

## La frontière

- `workflows/` dit **quoi** faire : états, gestes, preuves. Le décor est
  partagé.
- `playbook/` dit **comment**, **sous quelles règles** et **dans quel dépôt** :
  recette de l'étape, règles, fiche de dépôt.
- `missions/` porte le dossier d'une mission donnée, ignoré par git.

Une page ne recopie pas `workflows/` : elle le cite. Un état, un label, un geste
du décor se corrigent dans `workflows/` et la page suit ; une règle vit dans le
playbook et nulle part ailleurs.

## Ajouter une page

1. Écrire la page au gabarit des six sections, avec ses règles et sa fiche.
2. L'indexer dans la table ci-dessus si c'est une page neuve.
3. Si une étape doit la lire, l'ajouter au contrat de lecture **et** à
   `PLAYBOOK_STEP_FILES` dans `lib/view.js`.
4. Relancer `node tools/check-playbook.mjs` et `npm test` : une page absente de
   l'index, un contrat qui diverge du prompt, une section manquante ou une fiche
   incomplète échouent.

## La reprise de l'ancien système (retiré)

Les règles venaient de l'ancien système konoha, où elles étaient maintenues pour
son orchestrateur : un roster de rôles, un tracker Jira, une branche nommée dans
la fiche, des worktrees de mission. La reprise garde les règles et retire — ou
adapte — ce qui suppose cet orchestrateur ; l'écart est écrit à chaque fois.

### Les 15 fichiers de konoha

| Fichier de konoha | Devenir ici | Décision | Écart et raison |
| --- | --- | --- | --- |
| `code.md` | `playbook/execution.md#les-règles` + `playbook/revue.md#les-règles` | adapté | La section « Revue » reste dans `revue.md` ; les autres règles vivent dans `execution.md`, avec leur raison. |
| `interdits.md` | `playbook/workspace.md#les-règles` | adapté | Les 13 entrées sont reprises une par une, sans renumérotation. |
| `roles.md` | — | retiré | Le roster `orchestrator` / `implementer` / `reviewer` est l'architecture de konoha ; les étapes du ticket portent ces mandats. |
| `communication.md` | — | retiré | La topologie en étoile et le protocole brief / rapport décrivent un orchestrateur qui n'existe pas ici. |
| `types.md` | — | retiré | Les trois types de mission et les clés de frontmatter de konoha ne sont pas celles de `missions/projects.yml`. |
| `bruno.md` | — | retiré | Les collections Bruno sont un artefact de l'ancien flux ; la mission de ce dépôt n'en décrit pas. |
| `workspace.md` | — | retiré | Règles propres à konoha (`~/projects/worktrees`, squash à la clôture) ; branche et base sont déclarées dans `missions/<dossier>/mission.yml`. |
| `repos/Manager.md` | `playbook/execution.md#la-fiche-du-dépôt` | adapté | Fiche renommée en minuscules (`~/projects/Manager` → `manager`) ; base déclarée dans `mission.yml`. |
| `repos/Connect.md` | `playbook/execution.md#la-fiche-du-dépôt` | conservé | Même renommage ; même remplacement de `base_branch`. |
| `repos/backend.md` | `playbook/execution.md#la-fiche-du-dépôt` | conservé | Marquée « non déclaré ». |
| `repos/clienthub.md` | `playbook/execution.md#la-fiche-du-dépôt` | adapté | Marquée « non déclaré ». |
| `repos/core-service.md` | `playbook/execution.md#la-fiche-du-dépôt` | conservé | Marquée « non déclaré ». |
| `repos/marketplace-service.md` | `playbook/execution.md#la-fiche-du-dépôt` | adapté | Marquée « non déclaré ». |
| `repos/ticketing-service.md` | `playbook/execution.md#la-fiche-du-dépôt` | conservé | Marquée « non déclaré ». |
| `repos/.keepignore` | — | retiré | Les fiches sont versionnées : plus de dossier local à garder vide. |

Deux fiches ont été créées à la reprise : `playbook/revue.md` (la revue tenait
en deux règles dans `code.md` ; elle a désormais sa page) et la fiche
`missions` dans `execution.md` (ce dépôt n'en avait pas).

### Les 12 fichiers retirés et leur destination

| Fichier retiré | Destination |
| --- | --- |
| `standards/README.md` | [`playbook/README.md#le-contrat-de-lecture`](#le-contrat-de-lecture) et cette section |
| `standards/code.md` | `playbook/execution.md#les-règles` |
| `standards/revue.md` | `playbook/revue.md#les-règles` |
| `standards/interdits.md` | `playbook/workspace.md#les-règles` |
| `standards/repos/missions.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/manager.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/connect.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/backend.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/clienthub.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/core-service.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/marketplace-service.md` | `playbook/execution.md#la-fiche-du-dépôt` |
| `standards/repos/ticketing-service.md` | `playbook/execution.md#la-fiche-du-dépôt` |

### Les 13 interdits, un par un

| N° | Interdit de konoha | Décision | Écart et raison |
| --- | --- | --- | --- |
| 1 | Aucun push sur `main` ou une branche protégée. | adapté | La branche garde son rôle, mais elle est déclarée dans `missions/<dossier>/mission.yml` ; la poussée sur `main` reste interdite. |
| 2 | Aucun force-push, aucune réécriture d'un historique publié. | conservé | La PR est relue sur son historique. |
| 3 | Aucune fusion de PR. | conservé | Le merge est le geste du demandeur, même s'il le demande. |
| 4 | Aucun `approve` ; une revue se limite à `request changes`. | adapté | L'étape de revue approuve le ticket (`ready-for-prod`) et écrit ses constats ; publier un `Approve` sur la PR reste interdit. |
| 5 | Aucune publication de review sans validation du principal. | adapté | Les constats s'écrivent dans le journal, la checklist et le ticket, que le demandeur lit. |
| 6 | Aucune écriture hors du périmètre du brief ou de la fiche. | adapté | Le brief est remplacé par le périmètre nommé du ticket : `missions/<dossier>/`, la branche déclarée, et rien d'autre. |
| 7 | Aucun secret ni credential dans le workspace ; exceptions : jeton Atlassian et `.env.gpg` de bruno. | adapté | Les exceptions disparaissent avec l'outillage de konoha ; la configuration d'un outil vit dans `config/tools/`. |
| 8 | Aucun accès Tolgee. | conservé | Les textes passent par le paquet du dépôt, jamais par le CLI. |
| 9 | Aucune dérogation à un standard. | conservé | Une règle qui n'est pas écrite n'existe pas, et une dérogation non écrite n'est pas une dérogation. |
| 10 | Aucun renvoi à un standard non versionné. | adapté | Les règles sont versionnées dans le playbook ; un fichier versionné ne cite pas une règle absente. |
| 11 | Toute PR produit est ouverte en draft. | adapté | Le draft est retiré : la PR est le support de la revue, liée et prête. |
| 12 | Aucune exécution pendant le cadrage sans go nommé. | adapté | Le go nommé devient l'état du ticket : le cadrage écrit sur `to-refine`, l'exécution ne commence qu'à `ready`. |
| 13 | Aucun accès système, aucune demande d'accès, aucune sortie du home ; non dérogeable. | adapté | Le home devient le workspace `~/projects` ; l'interdit reste non dérogeable. |
