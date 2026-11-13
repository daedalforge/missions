# Règle de revue

Une revue juge le diff contre le cadrage de la mission, pas contre les goûts du
relecteur. Elle rend un verdict qui change quelque chose: un constat qui ne
modifie ni la décision, ni le code, ni le cadrage n'est pas un constat.

Ce fichier dit ce qu'une revue contrôle et ce qu'elle ne peut pas refuser. Les
règles de code vivent dans `standards/code.md`, les garde-fous dans
`standards/interdits.md`, et ce qui ne vaut que pour un dépôt dans sa fiche
`standards/repos/<projet>.md`.

## Ce qu'une revue contrôle

### Un critère d'acceptation non tenu bloque

Chaque critère reçoit un verdict dans l'ordre de la fiche: tenu, non tenu, ou non
constatable depuis le diff. Non tenu se localise `fichier:ligne` là où ça manque
ou là où c'est faux. Non constatable nomme la preuve qui manque — un écran à
ouvrir, un appel à passer — et ne se tranche pas en lançant la suite complète.

Un critère ne se reconstitue jamais depuis le titre, l'objectif ou le livrable.
Une section de critères restée vide est une section absente. Un critère sans
preuve est un critère non tenu.

### Chaque changement du diff se rattache à la mission

Quatre catégories: exigence explicite, nécessité technique induite, test ou
contrat qui la prouve, adaptation indispensable. Le rattachement se fait au hunk
quand un fichier mêle plusieurs sujets. Un nom de fichier, une proximité de
domaine ou l'utilité apparente ne suffisent pas.

Hors catégorie: bloquant, localisé. Le code est retiré ou déplacé vers la mission
qui le porte. Une correction découverte en route ne devient pas dans le périmètre
parce qu'elle est facile; elle a sa propre mission, sauf si elle bloque
directement l'exigence en cours. Formatage, régénération de contrat et mise à jour
de dépendance passent seulement s'ils découlent du changement demandé.

### Une violation d'un standard ou d'un interdit bloque

Une violation de `standards/code.md`, de `standards/interdits.md` ou de la fiche
du dépôt prime sur un usage local, même répandu. Elle se localise
`fichier:ligne`, comme un critère non tenu, et nomme la règle violée.

**Raison**: une règle de code qui ne bloque pas en revue n'est vérifiée nulle
part; elle devient une préférence de relecture et se perd au premier désaccord.

### Une preuve annoncée se retrouve dans la PR ou le ticket

La checklist de session n'est pas versionnée: chaque case cochée doit annoncer une
preuve qu'on retrouve dans la PR ou le ticket. Une preuve annoncée et absente est
un critère non tenu. Les tests annoncés se citent par leur sortie, pas par leur nom.

**Raison**: une revue qui croit une preuve sur parole ne vérifie rien; elle
laisse entrer un critère tenu seulement dans le journal.

## Ce qu'une revue ne peut pas refuser

- Un style différent de celui du relecteur, s'il respecte le style du projet et
  `standards/code.md`.
- Une amélioration possible hors périmètre: elle devient un ticket, elle ne bloque
  pas le diff.
- Une préférence qui n'est écrite ni dans le cadrage ni dans les standards.

**Raison**: refuser sur ces trois motifs change le jugement en goût personnel et
ajoute au demandeur un tour de plus. Ce qui n'est pas écrit ne s'oppose pas en
revue; s'il faut une règle, elle s'écrit d'abord dans `standards/`.

## Le verdict

Trois décisions, celles de `workflows/review.md`: **approuvée**, **à reprendre**
(commentaires rattachés à un critère ou à un défaut nommé), **retour au cadrage**
(le désaccord porte sur le périmètre ou l'objectif). Le verdict s'écrit dans le
ticket, le journal et la checklist.

### L'approbation est un verdict de mission, pas une review de PR

L'étape de revue approuve le ticket: elle le passe en `ready-for-prod` et écrit
ses constats dans le journal, la checklist et le ticket. Publier une review sur la
PR — le bouton `Approve` d'un forge, une revue de code d'un tracker — et merger
restent les gestes du demandeur (`standards/interdits.md` #3, #4, #5).

**Raison**: une review publiée engage le demandeur devant son équipe; l'approbation
du ticket, elle, est le verdict que l'étape doit rendre. Séparer les deux garde la
chaîne lisible: la session juge la mission, le demandeur décide de la PR.

**Portée**: toute mission dont l'état est `in-review`. Si le demandeur fait
publier la review, c'est lui qui la publie.
