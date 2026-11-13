# Manager

## Contexte

- Application React (React 18, TypeScript 5, Vite) avec Material-UI, interface
  d'administration des activités, contrats et clients;
  `repo: ~/projects/Manager`.
- Origine GitHub `Flex-O-SAS/Manager`; la CI est déclenchée au push et son statut
  se constate depuis la plateforme, jamais depuis le poste.
- Gestionnaire de paquets Yarn 4.12; installation par `yarn install`.
- Commandes: `yarn install`, `yarn dev`, `yarn build`, `yarn typescript`
  (`tsc --noEmit`), `yarn lint` (`eslint .`). Les tests se limitent au sous-ensemble
  borné que la fiche demande; `yarn test` (Cypress component) reste réservé à la CI
  (`standards/code.md`). Le README du dépôt et `docs/README.md` (styleguide) font
  foi pour le détail et les variantes; ils ne sont pas recopiés ici.
- Environnement: `.env` préparé depuis `.env.local.dist`, variables dynamiques via
  `window.env` (`public/env.js`). Le README fait foi.
- Le dépôt résout ses textes par le paquet `@tolgee/react`; l'interdit local
  ci-dessous porte sur le CLI, jamais sur la consommation du paquet dans le code.

## Exécution

- `base` : déclarée dans `missions/<dossier>/mission.yml` ; la fiche du dépôt ne la fixe pas.
- Invariants: aucun arrêté hors les conventions ci-dessous.
- Preuves attendues: `yarn typescript`, `yarn lint`, puis les tests bornés que la
  fiche demande — la suite complète reste réservée à la CI (`standards/code.md`).

## Conventions

### Tout réglage qu'un appelant peut vouloir changer devient une prop

Un composant réutilisable expose en prop toute valeur qu'un futur usage pourrait
légitimement ajuster — taille, teinte, texte, comportement —, avec une valeur de
repli qui conserve le rendu actuel. Ne reste figée que la constante qui appartient
à l'identité même du composant et ne varie jamais d'un contexte à l'autre.

**Raison**: la valeur figée force le prochain utilisateur à ouvrir le composant ou
à le dupliquer; le composant perd sa généricité et chaque usage repasse en revue.

**Portée**: composants neufs ou touchés.

### L'absence n'a qu'une écriture: `undefined`

Pour une prop, l'état « absent » s'écrit uniquement `undefined`, marqué par le
`?:`. Celui qui détient une valeur nullable — réponse d'API, état pas encore
chargé — la convertit à l'appel en `?? undefined`. Le suffixe `| null` ne subsiste
que si `null` y veut dire autre chose qu'« absent » et reçoit un traitement
distinct. La contrainte vaut aussi pour les paramètres de fonction ou de hook et
pour l'état local: `value: string | null | undefined` annonce deux absences
qu'aucun code ne distingue, et chacun doit retenir celle qu'il manipule.

**Raison**: deux formes d'absence doublent les branches à raisonner et à tester
(`value == null`, `?? x`, `Boolean(value)` ne se comportent pas pareil), et
laissent un détail du modèle API s'infiltrer dans le contrat du composant.

**Portée**: code neuf ou touché — props, paramètres (fonction et hook), état
local.

### Un bloc d'interface à plusieurs états devient un composant

Chargement, erreur, vide, nominal: dès qu'un morceau d'interface combine plusieurs
de ces situations, il se découpe en un composant dédié qui traite chaque cas par un
`return` anticipé; le rendu parent se borne à le déposer. Une fonction
locale `renderX()` qui fabrique du JSX n'est pas une option: c'est un composant
sans nom. Seul un petit bloc à situation unique peut rester dans le rendu parent.

**Raison**: `renderX()` n'a pas de contrat de props, ne se teste jamais seul, ne
porte aucun état local, et personne ne peut le réutiliser ailleurs.

**Portée**: rendus conditionnels neufs ou touchés.

### Le type des props se nomme `Props`, sauf s'il quitte le fichier

Le type décrivant les props d'un composant s'appelle `Props` — sans préfixe, sans
répéter le nom du composant: le fichier et la déclaration voisine le portent déjà.
Deux cas gardent un nom explicite: le type exporté, qui doit s'identifier au lieu
d'import, et le fichier multi-composants, où un seul déclare `Props` et les autres
restent nommés d'après le leur.

**Raison**: un nom dérivé du composant répète celui du fichier et ajoute un
renommage à chaque renommage du composant.

**Portée**: code neuf ou touché, pas une conversion globale — les deux formes
cohabitent et s'alignent au fil des PR.

### Les états dégradés passent d'abord, le cas nominal reste en dernier

Un composant qui cumule plusieurs états — chargement, erreur, vide, nominal —
les dépêche dans cet ordre, un `return` anticipé par état, et garde la fin pour le
seul cas nominal. Pas de ternaire imbriqué, pas de `&&` en cascade qui fusionnent les états
dans une unique expression. La règle complète celle du découpage en composant:
l'une fixe où ces cas vivent, l'autre leur ordre et leur forme.

**Raison**: un état dégradé oublié se repère dans une liste de `return` lue du haut
vers le bas, jamais dans une expression imbriquée; et dans la forme imbriquée,
chaque état hérite des conditions de tous les précédents, si bien qu'ajouter un cas
force à relire les autres.

**Portée**: code neuf ou touché. Aucun linter ne la contrôle.

### `useEffect` sert aux effets de bord, jamais aux calculs ni à l'initialisation d'état

`useEffect` est cantonné à ce qui sort de React: branchement à une source externe,
horloge, écoute d'événement, avec le nettoyage correspondant. Une valeur dérivable
des props ou de l'état s'obtient pendant le rendu; si elle coûte cher, `useMemo`.
Un `useState` rempli par un `useEffect` de montage n'est pas de l'état: c'est un
calcul qui s'est offert un détour.

**Raison**: l'état posé depuis un effet force un premier rendu avec une valeur
fausse, corrigée au rendu suivant — le composant traverse une situation
intermédiaire que rien ne devrait faire exister. La valeur cesse aussi de dépendre
de ses entrées pour dépendre de l'ordre de déclenchement des effets; et un test
doit attendre un tour de boucle de plus pour voir ce qui pouvait être vrai dès le
premier rendu.

**Portée**: code neuf ou touché. `react-hooks/exhaustive-deps` est coupé dans
`eslint.config.js` et ne couvrirait de toute façon pas ce cas: seule la relecture
le voit.

### Toute image a un texte alternatif qui dit ce qu'elle montre

Chaque `img` et chaque composant d'image reçoit un texte alternatif décrivant son
contenu. Une image purement décorative — elle n'apporte rien que le texte voisin
ne dise déjà — porte un `alt` vide, `alt=""`: un choix assumé, pas un oubli.

**Raison**: sans texte alternatif, l'image n'a pas d'existence pour un lecteur
d'écran, et aucun indice visuel ne le trahit — le manque franchit la relecture
visuelle, les tests et la recette. L'`alt` vide fait partie de la règle: sans lui,
impossible de séparer l'image décorative de l'image oubliée.

**Portée**: code neuf ou touché. `eslint-plugin-jsx-a11y` est absent du dépôt:
aucun garde-fou automatique.

### Les contrats de props s'écrivent en `type`; l'`interface` reste réservée à l'extension

Le contrat d'un composant s'écrit en alias: `type Props = { … }`. L'`interface` ne
garde qu'un cas, la déclaration qui prolonge vraiment un autre contrat —
`interface StatsCircularProps extends CircularProgressProps` —, là où le mot-clé
dit exactement ce qui se produit. Partout ailleurs elle n'ajoute rien et laisse
ouvert ce qui devrait rester fermé.

**Raison**: l'`interface` fusionne — une seconde déclaration homonyme s'ajoute sans
bruit à la première, quand un `type` dupliqué refuse de compiler. Un contrat de
props est fermé par essence: c'est l'inventaire de ce que le composant accepte,
rien ne doit l'augmenter de loin. Le `type` compose en outre avec tout ce que le
dépôt emploie — intersection, union, `Pick`, `Omit`, `ReturnType` — sans changer
de mot-clé en cours de route.

**Portée**: code neuf ou touché, pas une conversion générale; les deux écritures
coexistent et s'alignent PR après PR. Rien ne l'automatise: la règle ESLint idoine
n'est pas activée, et l'activer signalerait le stock entier d'un seul coup.

### Un layout reçoit des slots, pas les props de ses enfants

Un composant réduit à une structure commune accueille ses enfants déjà assemblés,
via des slots `ReactNode` nommés et `children`; il ne déclare aucune prop recopiée
depuis `React.ComponentProps<typeof Child>` pour la refiler à des composants qu'il
connaît. Un seul appelant: la structure reste inline. Plusieurs: la composition
préserve la structure sans coupler les contrats des enfants.

**Raison**: recopier les props d'un enfant rend le layout tributaire de chaque
évolution de cet enfant, et déplace chez le layout un contrat qui appartient à
l'appelant. La composition tient la frontière: le layout gère le conteneur et les
espacements, l'appelant fabrique ses enfants.

**Portée**: composants neufs ou touchés. La règle n'exige pas d'extraire un layout
d'une structure utilisée une seule fois.

### Une saisie en cours n'est jamais écrasée par la donnée rechargée

Un formulaire nourri par une requête remplit ses champs à la première réponse,
puis n'y touche plus tant que l'utilisateur est en train de corriger. Refetch,
invalidation de cache, réponse de validation: rien ne remplace ce qui est en cours
de frappe. Le scénario 422 vérifie trois choses: le message d'erreur du champ, le
formulaire toujours ouvert, les valeurs fraîchement saisies intactes.

**Raison**: une refetch survient sans geste visible — retour de focus, mutation
concurrente, invalidation — et un `reset` sans condition efface précisément la
correction en cours. Se contenter de vérifier `aria-invalid` laisse passer la
perte: l'erreur s'affiche, mais la valeur à corriger a disparu.

**Portée**: formulaires d'édition neufs ou touchés, et leurs tests. Une
réinitialisation explicitement demandée par l'utilisateur reste permise.

### Un Media téléversé est supprimé si la mutation qui le référence échoue

Quand une action commence par pousser un Media puis crée ou modifie l'entité qui
le référence, l'échec de la seconde étape déclenche la suppression compensatoire
du Media. La suppression est tentée quelle que soit l'erreur; si elle échoue à son
tour, elle ne masque pas l'erreur métier d'origine; et une mutation réussie ne
supprime rien.

**Raison**: le téléversement et la mutation métier ne constituent pas une
transaction. Faute de compensation, chaque échec abandonne un asset orphelin,
facturé, qu'aucune entité ne référence; compter sur un nettoyage manuel transforme
une erreur banale en dette de stockage.

**Portée**: chaque flux « upload puis mutation » neuf ou touché. Pas
d'abstraction générique exigée quand un seul appelant existe.

### Une option pilotée par un discriminateur API n'admet que les valeurs listées

Lorsqu'une option de formulaire dépend d'un champ discriminateur venu de l'API,
elle n'est sélectionnable que si sa valeur figure dans la liste explicite des
valeurs métier autorisées. Valeur manquante, inconnue ou pas encore exposée:
exclue. Une fixture qui couvre une option sélectionnable déclare ce discriminateur
noir sur blanc.

**Raison**: un filtre négatif considère `undefined` comme valide. Un backend en
retard peut alors rendre sélectionnable un objet venu d'une catégorie incompatible;
et une fixture qui invente le champ camoufle le défaut de contrat.

**Portée**: sélecteurs et règles d'éligibilité neufs ou touchés. La liste
autorisée ne contient que les valeurs que l'interface supporte réellement.

### Une condition dit ce qu'elle teste, sans double négation

Une condition pose sa question en clair: `items.length > 0`, `value !== undefined`,
ou `Boolean(value)` quand la coercition est vraiment voulue. Le `!` doublé est
banni, et un `!!` enchaîné sur deux valeurs l'est deux fois.

**Raison**: `!!` tait ce qu'il teste — il écarte `''` sur une chaîne, `0` sur un
nombre, et aucun signal sur un tableau, car un tableau vide est déjà vrai. Trois
comportements pour une seule écriture; le lecteur doit retrouver le type pour
savoir lequel joue.

**Portée**: code neuf ou touché. `no-implicit-coercion` n'est pas activé dans
`eslint.config.js`: seule la relecture le voit.

### Le nom d'une variable porte sa valeur, et une condition se lit sans négation

Le nom décrit le contenu, pas le traitement qu'on lui fait subir:
`trimmedPhoneNumber`, jamais `trimmed`. Et quand une condition exprime une
négation, c'est le nom du booléen qui la porte, pas le `if`: on déclare le flag à
la forme négative et on teste `if (bookingKey === null && isTechConnectWelcomrOff)`
sans nier au point de test.

**Raison**: un nom tronqué force à remonter jusqu'à l'affectation pour savoir de
quoi il s'agit, et ce retour se refait à chaque lecture. La négation posée dans le
`if` empile deux inversions mentales dès qu'une seconde condition arrive; le nom
paie ce coût une seule fois, à l'écriture.

**Portée**: code neuf ou touché. Rien ne l'automatise et rien ne le pourra:
c'est un jugement de lecture.

### Un nouveau nom imite la convention locale

Un fichier, un type ou un composant neuf emprunte le style de nommage de ce qui
l'entoure: le fichier voisin dans le dossier, la déclaration précédente dans le
fichier. Quand deux conventions cohabitent, la locale l'emporte; un lot qui en
importe une troisième la justifie dans sa PR.

**Raison**: une convention ne sert que si elle permet de deviner un nom sans le
fouiller, et une exception isolée ruine exactement cela — il ne reste que des
précédents qui se contredisent, et la relecture doit arbitrer à chaque déclaration.

**Portée**: code neuf ou touché. `@typescript-eslint/naming-convention` n'est pas
activé, et ne saurait de toute façon juger la cohérence locale, seul objet de cette
règle.

### Un paramètre de filtre absent ne veut jamais dire « tous »

Quand l'absence d'un paramètre d'URL sert de filtre initial à une liste, l'action
qui enlève ce filtre pose une valeur dédiée à l'état « tous », par exemple
`state=all`. Cette valeur part vers l'API, nourrit le compteur et l'état vide;
l'absence ne subsiste que pour le comportement initial.

**Raison**: une même absence ne peut pas cumuler deux sens — « applique le
défaut », puis « l'utilisateur a retiré le défaut ». Quand liste, compteur et état
vide divergent, un écran peut se croire filtré sans qu'aucun filtre n'ait été posé,
ou rendre son état vide inatteignable.

**Portée**: listes filtrées récentes ou reprises. La valeur explicite est fixée par
le contrat de l'API et demeure stable dans les liens partagés ou rechargés.

### Un test Cypress attend une requête, jamais une durée posée à la main

`cy.get`, `cy.contains`, `cy.get('@alias.all')`: tout sélecteur garde le délai par
défaut de Cypress. Si une assertion dépasse ce délai, le problème est dans le
harnais ou dans le code — on corrige la cause, pas l'horloge. La seule attente
explicite est une requête nommée, `cy.wait('@alias')`; jamais un nombre de
millisecondes sur un sélecteur.

**Raison**: un `timeout` écrit à la main est indiscernable d'un défaut — le test
passe et la cause reste cachée. Le piège constaté: le helper de montage construit
son `QueryClient` avec les défauts de react-query — nouvelles tentatives en
backoff — alors que `app.tsx` pose `retry: () => false`; le test payait un backoff
que l'application n'a jamais.

**Portée**: code neuf ou touché, pas une conversion globale. Un test d'erreur
atteint son état sans attendre le backoff: la forme retenue consiste en un
`QueryClientProvider` imbriqué qui porte `retry: false`, glissé dans le helper de
montage de l'unique spec concernée. Le seul lieu où un délai global se décide est
`cypress.config.ts`, qui n'en fixe aucun: le défaut de Cypress vaut partout.

### Un test n'affirme pas l'ordre des champs

Un test n'atteste jamais lequel de deux champs vient avant l'autre dans le DOM: ni
`compareDocumentPosition`, ni `.children().first()` / `.last()`, ni l'ajout d'un
sélecteur direct dont le seul but serait de dire qu'un champ précède l'autre. Ce qu'un test
peut établir d'un champ: il existe, il porte la valeur ou l'attribut attendu, une
action produit son effet. L'assertion de structure reste légitime quand elle est la
seule façon de vérifier une prop — `splitTitleRow` d'`item-page-header.component.tsx`
ne se constate que par la structure qu'il produit. La frontière: une prop porte une
branche; un tableau de champs n'en porte aucune par son ordre.

**Raison**: l'ordre du DOM n'est pas l'ordre affiché — `order`, `row-reverse`,
`flex-wrap`, le positionnement CSS cassent la correspondance — l'assertion ne
prouve donc pas ce que voit la personne. Elle casse aussi au premier wrapper
interposé, comme toute traversée de balise. Une fois ces deux illusions retirées,
il reste un test qui vérifie que le tableau a été écrit comme il a été écrit: seule
une réécriture peut le faire échouer, jamais une régression.

**Portée**: tests neufs ou touchés. Le dépôt n'en contient plus aucune occurrence.

### Un fichier de test reste léger, et la lourdeur se voit dans le diff

Un fichier de test reste vif. Ce qui l'alourdit se lit dans le diff, sans
chronomètre: une attente explicite là où une condition à atteindre suffit, un jeu
de données sans rapport avec l'exigence du cas, un montage complet répété cas après
cas quand un seul y suffirait, un composant de test qu'on monte sans jamais
l'interroger. Un cas qui doit vraiment durer l'annonce dans son intitulé.

**Raison**: un fichier lent se paie à chaque exécution, par chacun, pour toujours —
et d'abord en CI, seul endroit où la suite tourne. Le seuil de tolérance dérive
tout seul: un fichier allégé puis laissé à la dérive revient au même poids dès la
PR suivante.

**Portée**: tests neufs ou touchés. La règle s'énonce sur des causes visibles dans
le diff, pas sur une durée mesurée: une session n'exécute pas la suite entière du
dépôt (`standards/code.md`); la durée vraie s'observe en CI. Le plafond chiffré de
la règle suivante se mesure, lui, par le script dédié — sur les specs du diff
uniquement, jamais la suite entière.

### Un test décrit un geste utilisateur; la suite n'épouse pas l'exhaustivité

Un test se justifie par une intention utilisateur: le geste décrit est à la portée
d'une personne, et s'il se casse, une personne en subit les conséquences. Un état
transitoire — squelette de chargement, indicateur d'attente, message d'erreur de
lecture — n'a pas de scénario à porter et ne se teste pas. Deux tests qui décrivent
le même chemin avec deux jeux de données n'en font qu'un. La suite ne vise pas tous
les états du produit: elle couvre les gestes d'écriture et ceux qui empêchent une
perte de données; le reste est assumé comme non couvert.

**Raison**: chaque cas d'un fichier de test se paie d'un montage complet de la vue.
Multiplier les cas pour des états au lieu de gestes n'ajoute aucune protection: un
fichier rempli de tests sans scénario propre domine le coût CI de la PR qui
l'introduit, et la règle sur la lenteur ne l'attrape pas, puisque chaque cas y
paraît visible et justifiable dans le diff.

**Portée**: tout fichier de test neuf ou touché. On juge le fichier entier,
jamais les seuls cas ajoutés par la mission: ce qui coûte en CI, c'est le fichier
dans l'état où il part.

### Une spec reste sous 45 s, mesuré avant d'ouvrir la PR

Une spec plafonne à 45 s. La durée se lit dans le rapport d'exécution de la CI, ou
dans l'outil de mesure des specs du workspace quand il est disponible; cet outil
n'appartient pas au dépôt mesuré et ne part jamais en PR. Un second seuil, à trois
fois la médiane du dépôt (4 s), marque les specs lourdes sans bloquer: plusieurs
specs précédaient la règle, et une PR n'a pas à payer une dette qu'elle n'a pas
fabriquée. Dépasser le budget absolu ne se contourne pas en relevant la limite:
cela désigne un test sans scénario; c'est ce test qu'on retire.

**Raison**: une spec lente est invisible dans un diff comme dans une liste de
titres de tests; seule la mesure la montre. Le seuil de 45 s ne signale que les
specs réellement lourdes, sans faux positif.

**Portée**: specs touchées par la PR. Le script jauge les seules specs du diff,
jamais la suite entière: la couvrir revient à la CI.

### `yarn.lock` ne bouge qu'avec une dépendance, et la PR le dit

Une PR ne modifie `yarn.lock` que pour ajouter, retirer ou mettre à jour une
dépendance, et sa description nomme laquelle et pourquoi. Un lockfile chamboulé
par un `yarn install` opportuniste — autre version de Node, résolution refaite,
installation tronquée — est restauré depuis la branche de base avant l'ouverture
de la PR.

**Raison**: quand le lockfile remue sans raison, des versions transitives que nul
n'a choisies ni relues se déplacent — le diff est trop volumineux pour une vraie
lecture, alors il est validé sans l'être. Et il cache au passage l'unique
information que ce fichier est censé exposer: le moment où une dépendance change
pour de vrai.

**Portée**: la règle vise la PR, pas le poste. Refabriquer le lockfile en local
pour débloquer une installation reste libre; ce qui est interdit, c'est qu'il parte
en relecture.

### Rien qui n'existe que pour le poste ou l'essai ne part en PR

Tout ce qui ne sert qu'au confort ou à l'essai de la personne qui écrit reste chez
elle: réglages d'éditeur glissés dans le `.gitignore` du dépôt, page de démo
raccordée au routeur, vue d'essai oubliée derrière un lot. Quand il s'agit d'outillage partagé, on pose
une mission; un écran destiné au produit suit la mission qui le porte.

**Raison**: rien n'appelle ces ajouts, donc rien ne fixe le moment de les retirer,
et ils traversent le lot qui les a fait naître. Une route raccordée au routeur est
accessible en production sitôt la fusion faite: plus un brouillon, une page
expédiée que personne n'a cadrée. Un `.gitignore` garni des réglages d'un éditeur
force un choix d'outil à quiconque clone.

**Portée**: code neuf ou touché.

## Interdits locaux

- Aucune commande Tolgee — `yarn tolgee:pull` ou toute invocation du CLI — depuis
  une session sur ce dépôt: l'interdit global est absolu et ne souffre aucune
  exception locale (`standards/interdits.md` #8).

## Review

- Gates à rejouer: `yarn typescript`, `yarn lint`, puis les tests bornés de la
  fiche; citer la sortie brute.
- Une violation d'une convention ci-dessus est bloquante (`standards/interdits.md`
  #9).
- Faux positifs connus: aucun.
