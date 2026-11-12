#!/usr/bin/env bash
# Démarrage Emacs en batch, module par module.
#
# Rend une ligne par module, dans l'ordre canonique :
#   ui: chargé
#   markdown: non chargé (désactivé)
#   latex : tex-site introuvable
#
# Un module en échec n'interrompt pas le démarrage : le script sort 0 tant que
# le démarrage lui-même a eu lieu. Un échec du démarrage sort avec son code.

set -u

config_dir=$(cd "$(dirname "$0")/.." && pwd)
emacs=${EMACS:-emacs}

if ! command -v "$emacs" >/dev/null 2>&1; then
    echo "startup: Emacs introuvable ($emacs)" >&2
    exit 1
fi

report=$("$emacs" --batch -Q \
    -l "$config_dir/early-init.el" \
    --eval "(progn (require 'package) (package-initialize))" \
    -l "$config_dir/init.el" \
    --eval '(dolist (entry emacs-plugin-status)
              (princ (format "%s|%s\n" (car entry) (cdr entry))))')
status=$?

if [ "$status" -ne 0 ]; then
    echo "startup: le démarrage d'Emacs a échoué (code $status)" >&2
    exit "$status"
fi

if [ -z "$report" ]; then
    echo "startup: aucun module rapporté (init.el chargé ?)" >&2
    exit 1
fi

while IFS='|' read -r module state; do
    name=${module#init-}
    case "$state" in
        "chargé") printf '%s: chargé\n' "$name" ;;
        "non chargé (désactivé)") printf '%s: non chargé (désactivé)\n' "$name" ;;
        *) printf '%s : %s\n' "$name" "$state" ;;
    esac
done <<< "$report"
