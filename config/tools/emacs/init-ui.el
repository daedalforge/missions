;;; init-ui.el --- Appearance -*- lexical-binding: t; -*-

(setq inhibit-startup-screen t)
(setq initial-scratch-message nil)

(when (fboundp 'menu-bar-mode) (menu-bar-mode -1))
(when (fboundp 'tool-bar-mode) (tool-bar-mode -1))
(when (fboundp 'scroll-bar-mode) (scroll-bar-mode -1))

(column-number-mode 1)
(size-indication-mode 1)
(line-number-mode 1)

;; Thème local: le fichier vit dans konoha, à côté de ce module.
(require 'hl-line)
;; fido-vertical définit ses faces dans icomplete: elles doivent exister
;; avant le chargement du thème.
(require 'icomplete)
(add-to-list 'custom-theme-load-path
             (expand-file-name "themes"
                               (file-name-directory (locate-library "init-ui"))))

;; Ghostty est translucide: un fond explicite peindrait chaque cellule.
;; On garde le fond pour les frames graphiques, pas pour le terminal.
(defun naruto-dark-keep-tty-transparency (&rest _)
  "Laisser le fond du terminal visible en TTY."
  (unless (display-graphic-p)
    (set-face-background 'default "unspecified-bg")))

(when (boundp 'enable-theme-functions)
  (add-hook 'enable-theme-functions #'naruto-dark-keep-tty-transparency))

(load-theme 'naruto-dark t)
(naruto-dark-keep-tty-transparency)

(setq ring-bell-function 'ignore)
(setq visible-bell nil)

(provide 'init-ui)
;;; init-ui.el ends here
