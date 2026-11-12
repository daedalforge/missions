;;; naruto-dark-theme.el --- Thème Konoha sombre et sobre -*- lexical-binding: t; -*-

;;; Commentary:

;; Thème local de Konoha: surfaces neutres sombres, orange réservé à la
;; hiérarchie, vert/bleu/ambre pour la syntaxe, rouge pour les erreurs.
;;
;; Le fond `default` est défini pour une frame graphique seulement. En
;; terminal, `init-ui.el` remet le fond à `unspecified-bg` pour laisser
;; voir le fond transparent de Ghostty (#101217 à 75%).
;;
;; Aucun paquet externe: seules les faces d'Emacs, de Magit et de
;; markdown-mode sont stylées.

;;; Code:

(deftheme naruto-dark
  "Thème sombre Konoha: orange hiérarchique, syntaxe sobre.")

(let ((class '((class color) (min-colors 89)))
      ;; Surfaces
      (bg "#101217")
      (bg-alt "#171C26")
      (surface "#232833")
      (surface-2 "#1A1F28")
      (region-bg "#22304A")
      (secondary-bg "#2A2438")
      (hl-bg "#171C26")
      ;; Texte
      (fg "#C9D1D9")
      (fg-dim "#AAB6C2")
      (muted "#74818E")
      (comment "#7F8C99")
      (doc "#8FB07A")
      ;; Accents
      (orange "#E8842C")
      (orange-bright "#F0943F")
      (green "#98C379")
      (green-bright "#B8D9A0")
      (blue "#7FB4CA")
      (blue-dim "#6A93A8")
      (cyan "#7FD5C0")
      (amber "#E0AF68")
      (amber-bright "#F0C888")
      (amber-dark "#4A3520")
      (red "#E06C75")
      (red-dark "#3A1D21")
      ;; Diffs Magit
      (diff-add "#14261A")
      (diff-add-hl "#1B3322")
      (diff-del "#2A1619")
      (diff-del-hl "#3A1D21")
      (diff-ctx "#141920")
      (diff-ctx-hl "#1E2530")
      (hunk-bg "#1B2430")
      (hunk-hl "#25303F")
      ;; Blocs markdown
      (code-bg "#161B22")
      (inline-bg "#1A211D")
      (paren-bg "#1E3A24"))

  (custom-theme-set-faces
   'naruto-dark

   ;; --- Base ------------------------------------------------------------
   `(default ((,class (:background ,bg :foreground ,fg))))
   `(cursor ((,class (:background ,orange :foreground ,bg))))
   `(region ((,class (:background ,region-bg :foreground ,fg))))
   `(secondary-selection ((,class (:background ,secondary-bg :foreground ,fg))))
   `(hl-line ((,class (:background ,hl-bg))))
   `(fringe ((,class (:background ,bg :foreground ,muted))))
   `(vertical-border ((,class (:foreground ,surface-2))))
   `(window-divider ((,class (:foreground ,surface-2))))
   `(window-divider-first-pixel ((,class (:foreground ,surface-2))))
   `(window-divider-last-pixel ((,class (:foreground ,surface-2))))
   `(mode-line ((,class (:background ,surface :foreground ,fg :box nil))))
   `(mode-line-inactive ((,class (:background ,surface-2 :foreground ,muted :box nil))))
   `(mode-line-buffer-id ((,class (:foreground ,orange :weight bold))))
   `(mode-line-emphasis ((,class (:foreground ,orange-bright :weight bold))))
   `(header-line ((,class (:background ,surface-2 :foreground ,fg :box nil))))
   `(minibuffer-prompt ((,class (:foreground ,orange :weight bold))))
   `(line-number ((,class (:foreground ,muted :background unspecified))))
   `(line-number-current-line ((,class (:foreground ,fg :background unspecified :weight bold))))
   `(isearch ((,class (:background ,orange :foreground ,bg :weight bold))))
   `(isearch-fail ((,class (:background ,red :foreground ,bg))))
   `(lazy-highlight ((,class (:background ,amber-dark :foreground ,amber-bright))))
   `(match ((,class (:background ,amber-dark :foreground ,amber-bright))))
   `(show-paren-match ((,class (:background ,paren-bg :foreground ,green-bright :weight bold))))
   `(show-paren-mismatch ((,class (:background ,red :foreground ,bg :weight bold))))
   `(shadow ((,class (:foreground ,muted))))
   `(link ((,class (:foreground ,blue :underline t))))
   `(link-visited ((,class (:foreground ,blue-dim :underline t))))
   `(error ((,class (:foreground ,red :weight bold))))
   `(warning ((,class (:foreground ,amber :weight bold))))
   `(success ((,class (:foreground ,green :weight bold))))
   `(escape-glyph ((,class (:foreground ,orange))))
   `(nobreak-space ((,class (:foreground ,amber :underline t))))
   `(trailing-whitespace ((,class (:background ,red-dark))))

   ;; --- Complétion ------------------------------------------------------
   `(highlight ((,class (:background ,surface :foreground ,fg))))
   `(icomplete-selected-match ((,class (:background ,surface :foreground ,orange-bright :weight bold))))
   `(icomplete-vertical-selected-prefix-indicator-face ((,class (:foreground ,orange :weight bold))))
   `(icomplete-vertical-unselected-prefix-indicator-face ((,class (:foreground ,muted :weight normal))))
   `(completions-common-part ((,class (:foreground ,orange))))
   `(completions-first-difference ((,class (:foreground ,amber-bright :weight bold))))
   `(completions-highlight ((,class (:background ,surface-2 :foreground ,fg))))
   `(completions-annotations ((,class (:foreground ,muted))))

   ;; --- Syntaxe ---------------------------------------------------------
   `(font-lock-comment-face ((,class (:foreground ,comment))))
   `(font-lock-comment-delimiter-face ((,class (:foreground ,comment))))
   `(font-lock-doc-face ((,class (:foreground ,doc))))
   `(font-lock-string-face ((,class (:foreground ,green))))
   `(font-lock-keyword-face ((,class (:foreground ,orange))))
   `(font-lock-builtin-face ((,class (:foreground ,cyan))))
   `(font-lock-function-name-face ((,class (:foreground ,blue))))
   `(font-lock-variable-name-face ((,class (:foreground ,fg))))
   `(font-lock-type-face ((,class (:foreground ,amber))))
   `(font-lock-constant-face ((,class (:foreground ,amber))))
   `(font-lock-number-face ((,class (:foreground ,amber))))
   `(font-lock-preprocessor-face ((,class (:foreground ,cyan))))
   `(font-lock-regexp-face ((,class (:foreground ,amber))))
   `(font-lock-regexp-grouping-backslash ((,class (:foreground ,amber :weight bold))))
   `(font-lock-regexp-grouping-construct ((,class (:foreground ,amber :weight bold))))
   `(font-lock-negation-char-face ((,class (:foreground ,red))))
   `(font-lock-operator-face ((,class (:foreground ,fg-dim))))
   `(font-lock-property-name-face ((,class (:foreground ,blue))))
   `(font-lock-property-use-face ((,class (:foreground ,blue-dim))))
   `(font-lock-bracket-face ((,class (:foreground ,fg-dim))))
   `(font-lock-delimiter-face ((,class (:foreground ,fg-dim))))
   `(font-lock-escape-face ((,class (:foreground ,cyan))))
   `(font-lock-warning-face ((,class (:foreground ,amber :weight bold))))

   ;; --- Magit -----------------------------------------------------------
   `(magit-section-heading ((,class (:foreground ,orange :weight bold))))
   `(magit-section-heading-selection ((,class (:foreground ,orange-bright :weight bold))))
   `(magit-section-highlight ((,class (:background ,bg-alt))))
   `(magit-section-secondary-heading ((,class (:foreground ,amber :weight bold))))
   `(magit-section-child-count ((,class (:foreground ,muted))))
   `(magit-branch-local ((,class (:foreground ,green))))
   `(magit-branch-remote ((,class (:foreground ,blue))))
   `(magit-branch-current ((,class (:foreground ,orange :weight bold))))
   `(magit-branch-upstream ((,class (:foreground ,cyan))))
   `(magit-tag ((,class (:foreground ,amber))))
   `(magit-hash ((,class (:foreground ,comment))))
   `(magit-dimmed ((,class (:foreground ,muted))))
   `(magit-diff-added ((,class (:background ,diff-add :foreground ,green))))
   `(magit-diff-added-highlight ((,class (:background ,diff-add-hl :foreground ,green-bright))))
   `(magit-diff-removed ((,class (:background ,diff-del :foreground ,red))))
   `(magit-diff-removed-highlight ((,class (:background ,diff-del-hl :foreground ,red))))
   `(magit-diff-context ((,class (:background ,diff-ctx :foreground ,fg-dim))))
   `(magit-diff-context-highlight ((,class (:background ,diff-ctx-hl :foreground ,fg))))
   `(magit-diff-hunk-heading ((,class (:background ,hunk-bg :foreground ,blue))))
   `(magit-diff-hunk-heading-highlight ((,class (:background ,hunk-hl :foreground ,blue :weight bold))))
   `(magit-diff-lines-heading ((,class (:background ,hunk-bg :foreground ,amber))))
   `(magit-diffstat-added ((,class (:foreground ,green))))
   `(magit-diffstat-removed ((,class (:foreground ,red))))
   `(magit-log-author ((,class (:foreground ,blue))))
   `(magit-log-date ((,class (:foreground ,comment))))
   `(magit-log-graph ((,class (:foreground ,amber))))
   `(magit-process-ok ((,class (:foreground ,green))))
   `(magit-process-ng ((,class (:foreground ,red :weight bold))))
   `(magit-signature-good ((,class (:foreground ,green))))
   `(magit-signature-bad ((,class (:foreground ,red :weight bold))))
   `(magit-signature-untrusted ((,class (:foreground ,amber))))
   `(magit-keyword ((,class (:foreground ,orange))))
   `(magit-keyword-squash ((,class (:foreground ,orange-bright :weight bold))))

   ;; --- Markdown --------------------------------------------------------
   `(markdown-header-face ((,class (:foreground ,orange :weight bold))))
   `(markdown-header-face-1 ((,class (:foreground ,orange-bright :weight bold))))
   `(markdown-header-face-2 ((,class (:foreground ,orange :weight bold))))
   `(markdown-header-face-3 ((,class (:foreground ,amber :weight bold))))
   `(markdown-header-face-4 ((,class (:foreground ,blue :weight bold))))
   `(markdown-header-face-5 ((,class (:foreground ,cyan :weight bold))))
   `(markdown-header-face-6 ((,class (:foreground ,comment :weight bold))))
   `(markdown-bold-face ((,class (:foreground ,fg :weight bold))))
   `(markdown-italic-face ((,class (:foreground ,fg :slant italic))))
   `(markdown-link-face ((,class (:foreground ,blue :underline t))))
   `(markdown-url-face ((,class (:foreground ,blue-dim :underline t))))
   `(markdown-code-face ((,class (:background ,code-bg))))
   `(markdown-inline-code-face ((,class (:background ,inline-bg :foreground ,green))))
   `(markdown-pre-face ((,class (:background ,code-bg :foreground ,green))))
   `(markdown-markup-face ((,class (:foreground ,muted))))
   `(markdown-list-face ((,class (:foreground ,orange))))
   `(markdown-blockquote-face ((,class (:foreground ,fg-dim :slant italic))))
   `(markdown-table-face ((,class (:foreground ,fg-dim))))))

(provide-theme 'naruto-dark)

;;; naruto-dark-theme.el ends here
