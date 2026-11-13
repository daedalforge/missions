# Conventions de code

Règles valables dans tous les dépôts — ceux d'une mission comme ce dépôt. Elles
s'appliquent au code qu'on écrit ou qu'on modifie; elles n'ouvrent aucune reprise
massive.

Une règle qui n'est pas ici n'existe pas: un précédent local ne fait pas
convention, et une pratique non écrite ne s'oppose pas en revue. La session lit les
fichiers que `standards/README.md` donne pour son étape. Les interdits globaux
priment; aucune dérogation locale n'est admise (`standards/interdits.md` #9).

Les règles de revue ont leur propre fichier: `standards/revue.md`.

## Simplicité

### Entre deux solutions équivalentes, garder celle qui crée le moins de fichiers

La comparaison ne vaut qu'à qualité égale. Une rubrique qui exige un fichier —
composant dédié, test, requête d'API — l'emporte et ne se compte pas. Un fichier
de 900 lignes n'est pas plus simple que trois fichiers justes.

**Raison**: un fichier se paie à l'import, au rangement et à la recherche, pas à
la frappe. Ce coût arrive plus tard, quand plus personne ne se souvient du choix.
Le nombre de fichiers est aussi le seul indice de simplicité qu'une revue
constate sans discussion.

**Portée**: le choix de la solution. Aucune fusion de l'existant n'en découle.

## Réutilisation

### Vérifier ce qui existe déjà avant d'écrire local

Avant un utilitaire, un hook, un provider ou un composant de module, chercher
dans les espaces partagés du dépôt et dans les contextes montés au-dessus de la
vue. Si la fonctionnalité existe, l'utiliser, même si le branchement demande un
wrapper, un paramètre de plus ou une valeur par défaut. Une copie locale n'est
légitime que si le global est inutilisable; la raison va dans la PR. Le plus
souvent, étendre le global est le bon geste.

**Raison**: chaque copie crée un endroit de plus à corriger et à vérifier. Elle
est plus rapide à écrire sur le moment, et c'est exactement ce qui la rend
coûteuse: la règle finit en trois versions divergentes.

### Épuiser le langage, le framework et les dépendances déclarées avant le code maison

Ordre de recherche: bibliothèque standard, fonctionnalité native du framework ou
de la plateforme, puis dépendances du manifeste. Le code maison ne vient
qu'après. Une dépendance nouvelle se justifie dans la PR par son nom et par ce
qui manquait.

Bornes: une dépendance seulement transitive ne compte pas; une API dépréciée ou
un détournement de fonction native ne l'emporte pas sur trois lignes claires.

**Raison**: refaire l'existant, c'est maintenir du code pour un comportement déjà
corrigé ailleurs. Une dépendance de plus, à l'inverse, ajoute une surface de mise
à jour et de sécurité pour tout le dépôt.

**Portée**: code neuf ou touché. La règle prolonge la précédente: le dépôt
d'abord, l'existant fourni ensuite, le code maison en dernier.

## Lisibilité

### Un branchement s'écrit sur plusieurs lignes, entre accolades

`if (x) return;` se réécrit avec le corps à la ligne et des accolades. La forme
vaut pour `if`, `else if`, `else` et les boucles, quel que soit le langage.

**Raison**: la marge gauche doit montrer où sont les branches. Une ligne unique
se lit comme une instruction ordinaire. Sans accolades, une instruction ajoutée
plus tard sort de la branche sans aucun signal, et le diff mélange changement de
forme et changement de comportement.

**Portée**: code neuf ou touché. Là où un linter le permet, la règle s'outille.

### Une valeur choisie se nomme

Un nombre ou une chaîne qui résulte d'une décision — taille par défaut, seuil,
durée, décalage, paramètre d'URL — devient une constante nommée près de son
usage. Restent en littéral les bornes `0`, `1`, `-1`, et les valeurs qu'un
paramètre nommé décrit déjà.

**Raison**: un littéral ne dit ni d'où il vient ni pourquoi il vaut ça. Le
lecteur n'ose pas y toucher, alors il le recopie, et les copies divergent.

**Portée**: code neuf ou touché. Pas de reprise du stock: le tri serait arbitraire.

### Les types namespacés s'importent ; les classes globales suivent le formateur

En PHP, un type d'un namespace — `App\…`, `Symfony\…`, `Doctrine\…` — s'importe
par un `use` et se nomme court dans les signatures. Les classes du namespace
global — `\DateTimeInterface`, `\DateTimeImmutable`, `\DateTimeZone`, `\Override`,
`\Attribute`, les exceptions standard — suivent le formateur du dépôt: là où le
preset `@Symfony` de PHP CS Fixer s'applique, il pose
`global_namespace_import.import_classes = false`, donc elles restent qualifiées —
un import est retiré par le formateur et fait échouer le contrôle de style de la
CI; là où le preset ne s'applique pas (`@PSR12` seul), l'import est admis et
l'usage du dépôt tranche.

**Raison**: une signature courte se lit d'un coup, et un type qualifié dit d'où il
vient sans ouvrir la liste des imports. La frontière entre les deux formes n'est
pas une préférence de relecture: elle se vérifie dans la configuration du
formateur, seule autorité outillée. Demander l'inverse de ce qu'il applique
produit un aller-retour et une CI rouge pour un changement qu'il annule.

**Portée**: code PHP neuf ou touché; pas de reprise du stock.

## Commentaires

### Pas de commentaire, sauf les marqueurs d'un test

Aucun commentaire explicatif, aucun TODO, aucun code laissé en commentaire,
aucune bannière. Ce que le commentaire voulait dire se porte par un nom, une
extraction ou un type. Seule forme admise: `// Given` / `// When` / `// Then`
dans le corps d'un test.

Trois objets ne sont pas visés : le docblock dont l'analyse statique lit le
typage, la directive destinée à l'outillage — `@SuppressWarnings`,
`eslint-disable`, `@ts-expect-error`, `@codeCoverageIgnore` —, et le commentaire
de documentation que l'outillage du langage lit et publie, quand il documente
l'API publique. Ce dernier porte un contrat : ce que l'élément fait, quelles
erreurs il rend, dans quels cas il panique. Rien de plus. En Swift : `///` sur
les déclarations publiques, lu par DocC ; le compilateur ne l'impose pas, mais
le retirer retire le contrat publié au lieu d'alléger le fichier.

**Raison**: rien ne vérifie un commentaire. Il devient faux à la première
modification, sans bruit, et le lecteur se retrouve devant deux intentions
contradictoires. C'est aussi le moyen le plus court d'éviter le vrai geste:
nommer, extraire, typer.

**Portée**: production et tests.

## Tests

### La suite complète ne se lance depuis une session que si son coût est borné

Une session exécute les tests que la fiche du dépôt lui nomme, l'analyse statique
et le formateur. Une suite dont la sortie d'échec n'est pas bornée — compilation,
services à démarrer, e2e — n'entre pas dans ces tests: elle appartient à la CI, au
push. Une suite dont la sortie reste de quelques lignes fait partie des gates de
session, et la fiche du dépôt le dit.

**Raison**: un run vert rend quelques centaines d'octets; le même run en échec
rend des mégaoctets pour une cause unique, parfois environnementale. La dépense
n'est pas bornable avant d'être engagée. Quand elle l'est — un lanceur de tests
qui ne rend que ses échecs, sans compilation ni service à démarrer —, refuser la
suite n'achète rien: elle laisse passer une régression que la CI découvrira sur
une pile de branches.

**Portée**: quelle suite la session lance se lit dans la fiche du dépôt, jamais
dans le ticket. `standards/repos/missions.md` déclare `npm test` comme gate:
le lanceur de Node ne rend que ses échecs, et ce dépôt n'a ni compilation ni
service. Les fiches produit gardent la règle générale: leurs suites ne sont pas
bornées.

### Cypress: sélection par `data-cy`, assertion sur attribut

- Sélectionner par `data-cy`, jamais par un texte affiché ni par une balise.
- Assertionner sur un attribut dédié — `data-cy-value` —, jamais sur le texte
  rendu. Une donnée à prouver s'expose en attribut.
- Ne pas descendre vers une balise après un `data-cy` correct: pas de
  `.find('input')` ni de `.find('button')`. L'attribut se pose sur l'élément
  réellement interrogé — pour un champ MUI, dans `inputProps` / `slotProps`.

Si l'attribut manque, il s'ajoute dans la même PR que le test.

Exception étroite: quand la balise ou le texte *est* la preuve — un `button` dans
un `h3` pour le RGAA, l'absence de tout autre `button`, un contenu qui doit être
exactement le libellé — le sélecteur structurel reste. Le nom du test dit alors
ce qu'il prouve.

**Raison**: un libellé change légitimement et casse le test sans régression. Une
structure DOM change dès qu'un composant est remplacé, et casse d'un coup toutes
les traversées. Le `data-cy` est le contrat stable entre l'interface et le test.

**Portée**: code neuf ou touché, pas une conversion du dépôt.

### Un test de navigation monte la vraie vue et lit une donnée qu'elle a chargée

Pas de composant factice écrit par le test. La preuve doit s'appuyer sur une valeur
que la page de destination a elle-même récupérée — l'entité réclamée, l'identifiant
inscrit dans son formulaire —, pas sur la présence du factice. Un stub n'est toléré
que si le test contrôle l'URL émise et si le stub la consomme pour l'afficher.

**Raison**: un tel test peut passer alors que la page de destination est cassée, ne
charge rien ou perd l'identifiant reçu; il ne couvre que le routage et laisse croire
à une vérification complète. Le faux sentiment de sécurité coûte plus cher que pas
de test du tout.

### Le nom d'un test décrit le résultat attendu

Le nom porte le *Then*, pas le sujet. `should return null when the mission has no
tag`, et non `formatPhone` ni `test du cas vide`. Dans un dépôt non anglophone, le
nom se donne dans la langue du dépôt ; la fiche du dépôt en donne la forme.

**Raison**: dans un rapport d'échec, le corps du test n'apparaît pas; seul le nom
reste. Un nom qui décrit le comportement dit ce qui est cassé sans ouvrir le
fichier, et la suite se lit comme une spécification.

**Portée**: tests neufs ou touchés.

### Le corps d'un test suit Given / When / Then

Trois blocs commentés: contexte de départ, action testée, assertions. Un test qui
enchaîne plusieurs cycles se découpe en plusieurs tests.

**Raison**: quand les trois temps ne sont pas séparés, on ne sait plus ce qui
prépare, ce qui agit et ce qui vérifie; le lecteur doit refaire le découpage.

**Portée**: tests neufs ou touchés.
