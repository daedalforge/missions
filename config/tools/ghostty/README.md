# Configuration Ghostty

Source de vérité de la configuration Ghostty (1.4.0 constatée sur le poste), en
trois fichiers :

- `config` — le **socle commun** (thème, police, fenêtre, intégration shell,
  raccourcis `h/j/k/l`) ; il est inclus par les deux autres et n'est jamais lié
  directement ;
- `config-linux` — réglages propres à Linux, lié à `~/.config/ghostty/config` ;
- `config-darwin` — réglages propres à macOS (`macos-option-as-alt`, liaisons en
  flèches), lié à `~/Library/Application Support/com.mitchellh.ghostty/config`.

Les liens sont déclarés dans `config/links-home.yml` (source, cible réelle,
plateforme) et posés par `node tools/link-config.mjs --apply`.

## Pourquoi deux fichiers

Ghostty n'a pas de syntaxe conditionnelle : la seule façon de varier par OS est
de lier un fichier différent, et de faire inclure le socle via `config-file`.
Les deux variantes commencent donc par :

```ini
config-file = ~/projects/missions/config/tools/ghostty/config
```

Le chemin est absolu à dessein : une inclusion relative est résolue depuis le
fichier **réel** (le dépôt), pas depuis le lien, et une inclusion manquante est
**silencieuse** — Ghostty ne signale rien et applique seulement les valeurs du
fichier lié. D'où la vérification ci-dessous : contrôler que le thème arrive
bien, pas seulement que `+validate-config` passe.

**Déplacer le clone casse l'inclusion sans bruit.** Le dépôt doit rester dans
`~/projects/missions` ; sinon, corriger cette ligne dans `config-linux` et
`config-darwin`, puis rejouer la pose.

## Le lien traverse l'arbre de travail

Le lien de `$HOME` vise un fichier du dépôt, et Ghostty lit ce fichier **réel** :
le socle inclus vient donc de l'arbre de travail courant. Toute extraction —
changement de branche, worktree — qui ne porte pas `config/tools/ghostty/` coupe
la configuration : le lien reste en place, sa cible disparaît, et Ghostty
retombe sur ses défauts **sans erreur**. Ni le lien pendant ni l'inclusion
introuvable ne font échouer `+validate-config` ; seul le rendu (ou
`+show-config`) le dit.

Constaté le 2026-11-12 : le clone partagé était sur `feat/mis-135` (issue de
`fedb8f6`, antérieure à cette mission). `readlink` rendait bien
`…/missions/config/tools/ghostty/config-darwin`, mais la cible n'existait pas et
`+show-config` ne rendait plus ni `config-file`, ni `font-family`, ni
`background` : le poste tournait sur les valeurs par défaut de Ghostty.

```sh
# la vérification qui compte : le socle est bien chargé
~/Applications/Ghostty.app/Contents/MacOS/ghostty +show-config | grep '^font-family ='
# une ligne = chargé ; aucune ligne = l'arbre courant ne porte pas la config

# remise en état : se placer sur une extraction qui porte les fichiers
git checkout main                     # après le merge de la mission
node tools/link-config.mjs --check    # 0 : le lien est bon
```

`--check` compare le lien à sa source ; il ne lit pas la cible. C'est
`+show-config` qui prouve que Ghostty charge le socle.

Si ce mode de panne gêne, la parade est un **checkout stable dédié** — un
worktree qui ne change jamais de branche, sur lequel le lien peut s'appuyer :
l'arbre partagé peut alors changer de branche sans couper le terminal.

## Chargement

Ghostty lit les fichiers dans cet ordre, les suivants écrasant les précédents :

1. `$XDG_CONFIG_HOME/ghostty/config.ghostty`, puis `.../config`
   (`XDG_CONFIG_HOME` vaut `~/.config` par défaut) ;
2. sur macOS, `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`,
   puis `.../config`.

Un seul fichier doit exister. L'ancienne config XDG
`~/.config/ghostty/config.ghostty` (Catppuccin, keybinds d'une syntaxe
abandonnée) était encore chargée en premier : elle a été retirée du poste, avec
une sauvegarde hors dépôt. `font-family` étant une liste, deux fichiers
produiraient deux entrées ; `ghostty +show-config` doit n'en afficher qu'une.

## Police

`font-family` nomme une police, il ne l'installe pas : si elle manque, Ghostty
retombe sur sa police par défaut sans le dire. Sur Arch/Manjaro :
`sudo pacman -S ttf-jetbrains-mono-nerd` ; ailleurs, l'archive `JetBrainsMono`
des Nerd Fonts décompressée dans `~/.local/share/fonts/` puis `fc-cache -f`.
Vérification : `ghostty +list-fonts | grep 'JetBrainsMono Nerd Font Mono'` doit
répondre.

## Contenu

- socle : thème Naruto (fond `#101217` à 75 % d'opacité, orange Konoha
  dominant, palette ANSI harmonisée avec btop et K9s) ; police JetBrainsMono
  Nerd Font Mono, taille 12, `font-thicken = true` ; intégration shell zsh ;
  keybinds des splits en `h/j/k/l` (`cmd+shift+h/j/k/l` pour naviguer,
  `cmd+ctrl+shift+h/j/k/l` pour créer, `cmd+alt+shift+h/j/k/l` pour
  redimensionner) ; `ctrl+tab` libéré pour qu'Emacs le reçoive ;
- macOS seul (`config-darwin`) : `macos-option-as-alt = left`, et les variantes
  en flèches (`cmd+shift+←→↑↓` navigation, `cmd+ctrl+flèches`
  redimensionnement). Elles sont absentes du chargement Linux à dessein : KWin
  y intercepte `Super+Shift+←/→` (« fenêtre vers l'écran voisin ») et
  `Super+Ctrl+flèches` (bureaux virtuels), les liaisons n'arriveraient jamais
  à Ghostty.

## Rechargement

`cmd+shift+,` recharge la configuration. Certaines options ne s'appliquent
qu'aux nouveaux terminaux ; en cas de doute, relancer Ghostty.

## Vérification

Le binaire n'est pas dans le `PATH` sur le poste : l'appeler par son chemin.

```sh
G=~/Applications/Ghostty.app/Contents/MacOS/ghostty
$G +validate-config              # sort en 0 ; suit les inclusions
$G +show-config | grep -E '^(config-file|font-family|background|background-opacity) ='
$G +list-keybinds | grep -c 'super+shift+arrow'   # 4 sous macOS, 0 sous Linux
```

`config-file` doit afficher le socle de ce dépôt
(`~/projects/missions/config/tools/ghostty/config`) et `font-family`
n'apparaître qu'une fois : c'est la preuve que l'inclusion est bien suivie.
`+validate-config` seul ne suffit pas, une inclusion manquante ne produit aucune
erreur ; il écrit par ailleurs `error: SentryInitFailed` sur stderr (télémétrie,
pas configuration), le critère porte sur le code de sortie.

## Pose des liens

```sh
node tools/link-config.mjs            # --check (défaut) : ne touche rien, sort en 1 en dérive
node tools/link-config.mjs --apply    # pose les liens de la plateforme du poste
node tools/link-config.mjs --apply --platform linux --home /tmp/essai   # éprouve la pose ailleurs
```

- `--platform` vaut le système du poste (`darwin`, `linux`) ; `--home` vaut
  `$HOME` et sert à éprouver la pose dans un dossier temporaire.
- Un fichier régulier à la place d'une cible n'est jamais écrasé : la commande
  sort en 1 et le laisse intact ; `--force` le remplace. Un dossier, lui, n'est
  jamais remplacé.
- Codes de sortie : `0` tout est en place, `1` un lien manque ou dérive, `2`
  usage ou manifeste invalide.

Les liens sont posés en absolu vers le dépôt : un lien recréé à la main doit
pointer la source réelle, pas une copie. Le socle n'est jamais lié, seules les
variantes le sont.
