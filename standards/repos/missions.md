# missions

## Contexte

- Dépôt de la méthode et de son panneau DSH: `repo: ~/projects/missions`. Les
  missions elles-mêmes vivent dans `missions/`, les procédures dans `workflows/`,
  les règles dans `standards/`.
- Node.js (ES modules, pas de compilation), une seule dépendance de production:
  `yaml`. Le panneau est un plugin DSH: `lib/index.js` côté hôte,
  `lib/client.js` côté navigateur.
- Commandes: `npm test` (`node --test test/`), `node tools/build.mjs` (régénère
  `lib/client.js`), `node tools/check-workflows.mjs` (modèle de workflow),
  `node tools/check-standards.mjs` (index des standards).
- La CI n'est pas le garde-fou principal: les trois vérifications ci-dessus se
  lancent depuis la session, `npm test` compris. C'est l'exception bornée de
  `standards/code.md`: le lanceur de tests de Node ne rend que ses échecs, sans
  compilation ni service à démarrer, et la suite entière tourne en une vingtaine
  de secondes. Un dépôt dont la suite remplit ces conditions n'a rien à gagner à
  la réserver à la CI.

## Exécution

- `base` : déclarée dans `missions/<dossier>/mission.yml` ; la fiche du dépôt ne la fixe pas.
- Invariants: `lib/client.js` ne s'édite jamais à la main — il est produit depuis
  `src/client.template.js` et `lib/view.js`; le build doit laisser
  `git diff --exit-code lib/client.js` vide quand la source n'a pas changé.
- Preuves attendues: `npm test` vert, `node tools/build.mjs` sans diff sur
  `lib/client.js`, `node tools/check-workflows.mjs` et
  `node tools/check-standards.mjs` verts quand leur domaine est touché.

## Conventions

### Le code est en anglais, la documentation en français

Identifiants, commentaires de code, noms de tests techniques: anglais. Fiches,
journaux, checklists, procédures et messages destinés au demandeur: français.
Les chaînes que le panneau affiche à l'utilisateur suivent la langue de
l'interface, pas cette règle.

**Raison**: le code se lit avec l'écosystème et ses dépendances; la méthode se lit
en français, comme les tickets qu'elle sert.

### `lib/client.js` est généré

Toute modification du panneau navigateur passe par `src/client.template.js` ou
`lib/view.js`, puis `node tools/build.mjs`. Un diff sur `lib/client.js` seul — sans
sa source — est un défaut à corriger, pas une modification.

**Raison**: le bundle est le même code inliné; l'éditer directement le fait
diverger de sa source au prochain build.

### Le nom d'un test décrit le cas, en français

Le nom dit le résultat attendu, pas le sujet: `le prompt de chaque étape nomme ses standards`, et non `test prompt`. Cette règle locale précise `standards/code.md` pour la langue: les tests du dépôt se lisent en français, comme la méthode qu'ils protègent.

**Raison**: le nom reste seul dans un rapport d'échec; en français, il se lit sans traduction par les personnes qui maintiennent la méthode.

**Portée**: tests neufs ou touchés.

### Un prompt d'étape se prouve au caractère près

Les tests épinglent la chaîne exacte du prompt de session (`test/view.test.mjs`)
et la forme du bundle (`test/client.test.mjs`). Changer un mot du prompt sans
changer le test casse la suite: c'est voulu.

**Raison**: le prompt est ce que la session lit; une reformulation silencieuse
change le comportement sans changer le code.

### Les modèles de workflow se vérifient avec leur outil

`workflows/model/*.json` est édité à la main ou par le panneau, et
`node tools/check-workflows.mjs` dit s'il reste cohérent avec les pages et le
vocabulaire de `missions/projects.yml`.

**Raison**: le panneau refuse un modèle invalide à l'écriture; l'outil rejoue le
même contrôle avant un commit.

## Interdits locaux

- Aucune édition de `lib/client.js` à la main: le fichier est généré
  (`npm run build`), et son diff se vérifie avec sa source.
- Aucun test désactivé ou commenté pour faire passer la suite: une chaîne épinglée
  qui casse se corrige avec le prompt qu'elle décrit.

## Review

- Gates à rejouer: `npm test`; si le panneau change, `node tools/build.mjs` puis
  `git diff --exit-code lib/client.js`; si la méthode change,
  `node tools/check-workflows.mjs` et `node tools/check-standards.mjs`. Citer la
  sortie.
- Une violation de `standards/code.md` ou de `standards/interdits.md` est
  bloquante, localisée `fichier:ligne`.
- Faux positifs connus: aucun.
