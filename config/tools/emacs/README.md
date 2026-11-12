# Configuration Emacs

Source de vérité de la configuration Emacs, dans `missions`. Les fichiers réels
sont des liens:

- `~/.emacs.d/early-init.el` → `config/tools/emacs/early-init.el`
- `~/.emacs.d/init.el` → `config/tools/emacs/init.el`

Les modules `init-*.el` sont chargés depuis ce dossier via `load-path`, dans
l'ordre décidé par le fichier propre au système (voir ci-dessous).
`backups`, l'auto-save et `custom.el` restent dans `~/.emacs.d` et ne sont pas
versionnés.

## Le fichier du système

`system.yml` dit, pour chaque plugin, s'il est **installé** et s'il est **chargé
au démarrage**. Il est propre au poste et n'est jamais versionné: le dépôt ne
contient que `system.example.yml`, son gabarit commenté, que `setup.mjs` copie
en `system.yml` au premier lancement.

```yaml
plugins:
  ui:         { load: true }
  editing:    { load: true }
  crypto:     { load: true }
  markdown:   { load: true,  install: true }
  latex:      { load: false, install: false }
  completion: { load: true }
  projectile: { load: true,  install: true }
  magit:      { load: true,  install: true }
  machete:    { load: true }
```

Un plugin est le module `init-<nom>.el`. `load` décide de son chargement,
`install` du paquet Emacs qu'il lui faut — quand il en a un:

| Plugin | Module | Paquet |
| --- | --- | --- |
| ui | `init-ui.el` | — |
| editing | `init-editing.el` | — |
| crypto | `init-crypto.el` | — |
| markdown | `init-markdown.el` | `markdown-mode` |
| latex | `init-latex.el` | `auctex` |
| completion | `init-completion.el` | — |
| projectile | `init-projectile.el` | `projectile` |
| magit | `init-magit.el` | `magit` |
| machete | `init-machete.el` | — (magit) |

`install` n'est accepté que pour les quatre plugins qui portent un paquet; les
cinq autres sont natifs et le refusent. Le fichier est **validé, échec fermé**:
un plugin inconnu, un plugin retiré ou une valeur non booléenne fait sortir
`setup.mjs` en non-zéro, sans rien générer.

`setup.mjs` matérialise le YAML dans `system-plugins.el`, gitignoré lui aussi:

```elisp
(setq emacs-plugins '(init-ui init-editing init-crypto init-markdown
                      init-completion init-projectile init-magit init-machete))
```

`init.el` charge cette liste, s'il existe; sinon il avertit et charge les neuf
modules, si bien qu'un clone neuf démarre comme avant. **Le YAML n'est pas lu
au démarrage**: changer `system.yml` demande de relancer `node setup.mjs`.

Ce que le fichier ne décide pas: la version des paquets (`~/.emacs.d/elpa`
reste local), l'empreinte GPG d'`init-crypto.el`, ni les chemins de
`projectile-project-search-path`. Ces valeurs restent dans leurs modules.

Un module qui échoue à se charger — paquet absent avec `install: false` —
avertit et n'interrompt plus le démarrage: les autres modules se chargent, et
`test/startup.sh` dit lequel manque et pourquoi.

## Paquets

Quatre paquets externes, tous assumés explicitement:

- **Magit** 4.7.1, interface Git, depuis NonGNU ELPA.
- **markdown-mode** 2.8, mode et preview markdown, depuis NonGNU ELPA. Sans dépendance.
- **Projectile** 3.4.0, navigation par projet, depuis NonGNU ELPA. Sans dépendance.
- **AUCTeX** 14.2.0, mode LaTeX, depuis GNU ELPA. Sans dépendance.

C'est `system.yml` qui décide lesquels sont installés (`install: true`) et
lesquels sont chargés (`load: true`) ; `setup.mjs` n'installe que ceux qui
demandent `install: true`.
La version, elle, reste locale: `~/.emacs.d/elpa` n'est pas versionné.

Les archives GNU et NonGNU ELPA sont déclarées dans `early-init.el`.

Magit dépend de `magit-section`, `with-editor`, `cond-let` et `llama`, installés
avec lui. `transient` et `compat` sont fournis par Emacs 31.1.

`~/.emacs.d/elpa` contient les paquets et l'état de `package.el`; il n'est pas versionné.

## Projets

Projectile est activé au démarrage. La liste des projets est définie par
`init-projectile.el`, pas par un fichier dans les dépôts:

- `~/projects/konoha`, à sa racine;
- tous les dépôts de `~/projects`, un niveau en dessous.

Les projets sont découverts à la première commande de bascule, et ceux qui
n'existent plus sont retirés au même moment. Ouvrir un fichier hors de ces deux
racines n'ajoute rien à la liste. L'état vit dans
`~/.emacs.d/projectile-bookmarks.eld`, hors dépôt.

`C-c p p` change de projet et `C-c p f` ouvre un fichier du projet. Depuis sa
version 3, Projectile ne lie aucun raccourci par défaut: le préfixe `C-c p` est
lié explicitement. `C-x p` (project.el) reste disponible et inchangé.

## Thème

Thème local `naruto-dark`, dans `themes/naruto-dark-theme.el`, chargé par
`init-ui.el`. Aucun paquet externe.

- surfaces neutres sombres, orange pour la hiérarchie, vert/bleu/ambre pour la
  syntaxe, rouge pour les erreurs;
- faces d'Emacs, de Magit et de markdown-mode stylées dans le même fichier;
- complétion fido (`C-c p f`, `C-c p p`) et buffer `*Completions*`: sélection
  sur fond `surface` en `orange-bright`, indicateur orange, correspondances en
  orange et ambre;
- en terminal, le fond reste celui de Ghostty: `default` est remis à
  `unspecified-bg` après chaque activation, ce qui préserve la transparence du
  terminal (`background-opacity = 0.75`);
- retour arrière immédiat: `M-x load-theme RET modus-vivendi RET`.

## Git machete

Vue locale de la chaîne de branches, dans `init-machete.el`, sans paquet
externe: elle lit `git machete status --color=never` et ne réimplémente ni
fork point ni annotation.

- `C-c m` depuis le statut Magit ouvre la vue du dépôt courant;
- `RET` checkout la branche sous le point, `g` rafraîchit, `e` ouvre
  `.git/machete`, `T` traverse toute la chaîne après confirmation, `n`/`p`
  passent d'une branche à l'autre.

Le traverse s'exécute dans `*machete traverse*` et ne pousse pas: la
configuration git globale porte `machete.traverse.push=false`. Un dépôt sans
layout affiche le message de `git machete status`; la vue ne crée rien.

## LaTeX

`init-latex.el` confie les `.tex` à AUCTeX: insertion d'environnements
(`C-c C-e`), repli par section, navigation des `\ref`, et SyncTeX dans les deux
sens. `latexmk` est la seule commande de compilation; Okular lit le PDF.
Sans AUCTeX, `latex: {load: false}` dans `system.yml` désactive le module au
lieu de faire échouer le démarrage.

- `C-c C-c` lance `latexmk -pdf -synctex=1 -interaction=nonstopmode
  -file-line-error`: il relance pdflatex autant de fois que nécessaire, lance
  BibTeX quand le `.aux` le demande, et écrit le `.synctex.gz` que les deux
  recherches lisent. Une erreur arrive dans le buffer de sortie avec
  `fichier:ligne`;
- `C-c C-v` ouvre le PDF dans Okular (fenêtre unique) et place la page sur le
  curseur, par le `#src:` de SyncTeX;
- **Maj+clic** dans Okular ramène à la ligne d'Emacs: Okular lance `emacsclient
  +ligne:colonne fichier`, d'où le serveur démarré par le module à l'ouverture
  de session. Le réglage d'Okular est posé par
  `~/projects/konoha/config/tools/okular/setup.sh`, resté dans l'ancien système
  et à lancer à la main: l'installation ci-dessous ne s'en occupe pas.
  Conditions silencieuses quand elles manquent: l'outil **Browse** actif, et
  **Num Lock éteint** (voir `config/tools/okular/README.md`);
- rien n'est retiré d'AUCTeX: `C-c C-e`, `M-x TeX-fold-mode`, le menu LaTeX et
  les raccourcis habituels restent en place.

## Fermeture

`C-x C-c` quitte sans confirmation quand aucun buffer n'est modifié. Aucun
`confirm-kill-emacs` n'est posé: la sortie propose seulement d'enregistrer les
buffers modifiés, puis, si l'enregistrement est refusé, demande « Modified
buffers exist; exit anyway? ». Un processus actif (comint, compilation) demande
encore: `confirm-kill-processes` reste à son défaut.

## Fichiers chiffrés

`init-crypto.el`, chargé par `init.el` après `init-editing.el`, fixe les deux
réglages que les défauts d'Emacs laissent ouverts. Le déchiffrement transparent
n'est pas un réglage: il vient d'`auto-encryption-mode`, actif par défaut en
31.1, qui associe `epa-file` aux fichiers `.gpg` — ouvrir un `.gpg` montre le
clair, enregistrer le re-chiffre aux destinataires du fichier.

- `epa-file-encrypt-to`: un fichier neuf enregistré en `.gpg` part vers
  `D30570ACE67C64AE9E1112FA0E983ECE80B2879A` (Stéphane Lucien-Vauthier,
  `<stephane.lucien-vauthier@saas-office.com>`, sous-clé de chiffrement
  `4889E8B8BCD2E8AABCDF2AA662896C2DAEBBDAD7`).
- `epa-file-select-keys` à `'silent`: supprime la boîte de sélection des
  destinataires à l'enregistrement d'un fichier neuf; laissée à `nil`, elle
  s'ouvre même quand `epa-file-encrypt-to` est posé (`epa-file.el`,
  `epa-file-write-region`).
- `epg-pinentry-mode` à `'loopback`: la phrase se saisit dans le minibuffer;
  `pinentry-mac` reste le pinentry du reste du poste.

Un fichier ouvert puis enregistré garde les destinataires du fichier: `epa-file`
relit ses paquets, rien à ré-encrypter à la main. La phrase n'est demandée
qu'une fois par fenêtre de cache de `gpg-agent` (`default-cache-ttl 3600`,
`max-cache-ttl 7200` dans `~/.gnupg/gpg-agent.conf`). Les fichiers symétriques
(`gpg -c`) restent hors réglage: la phrase est demandée à chaque ouverture et à
chaque enregistrement, et rien ne reste en mémoire d'Emacs
(`epa-file-cache-passphrase-for-symmetric-encryption` reste `nil`).

### Réparer un trousseau bloqué

Symptôme: dans Emacs, `Decryption failed` avec `No secret key: <keyid>`; en
ligne de commande, `gpg --list-keys` répète `database_open ... waiting for lock
(held by <pid>)` et n'aboutit pas. Le trousseau n'est pas perdu: un verrou du
keybox désigne un processus mort.

```sh
ls -la ~/.gnupg/public-keys.d/        # pubring.db.lock et son jumeau « .#lk… »
gpgconf --kill keyboxd
rm ~/.gnupg/public-keys.d/pubring.db.lock ~/.gnupg/public-keys.d/.#lk0x*
gpg --list-keys                       # répond en moins d'une seconde
```

Le keybox redémarre au premier appel; il n'y a rien d'autre à relancer. Vérifier
ensuite dans `emacs -nw`: `C-x C-f ~/.authinfo.gpg` montre le clair et demande la
phrase une fois.

## Installation

Depuis la racine de `missions`:

```sh
pnpm install                        # une fois : la dépendance `yaml` de setup.mjs
node config/tools/emacs/setup.mjs   # valide system.yml, installe, pose les liens
bash config/tools/emacs/test/startup.sh  # vérifie module par module
```

`setup.mjs` crée `system.yml` depuis `system.example.yml` au premier lancement,
installe les paquets marqués `install: true`, écrit `system-plugins.el` et pose
les deux liens de `~/.emacs.d`. Il refuse d'écraser un `early-init.el` ou un
`init.el` qui ne serait pas déjà un lien. Options: `--check` (valider sans
rien écrire), `--skip-install`, `--skip-links`.

Vérifier ensuite `emacs -nw config/tools/emacs/test/smoke.tex`: `C-c C-c` doit
produire `smoke.pdf` et `smoke.synctex.gz` dans le même dossier, `C-c C-v`
ouvrir la page dans Okular, et Maj+clic dans Okular revenir sur `\section{Smoke
test}`. Pour `C-c C-v`, le lanceur Okular vit dans `config/tools/okular/` de
l'ancien système, non repris ici.

## Usage

`C-x g` ouvre le statut Magit du dépôt courant.

Les fichiers `.tex` s'ouvrent en `LaTeX-mode`: `C-c C-c` compile, `C-c C-v`
ouvre le PDF dans Okular, et Maj+clic dans Okular revient à la ligne.

Les fichiers `.md` et `.markdown` s'ouvrent en `markdown-mode`. `C-c m p`
bascule la preview dans le buffer: les marqueurs d'emphase, de code inline et
d'URL sont masqués, titres, listes, tables et blocs de code restent stylés.
Les `#` de titres et les `|` de tables restent visibles; aucun navigateur.
La preview est désactivée par défaut pour garder les marqueurs visibles à
l'édition; le raccourci natif équivalent est `C-c C-x RET`.
