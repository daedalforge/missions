;;; early-init.el --- Konoha early configuration -*- lexical-binding: t; -*-

;; UI before the first frame.
(setq inhibit-startup-screen t)
(setq initial-scratch-message nil)
(when (fboundp 'menu-bar-mode) (menu-bar-mode -1))
(when (fboundp 'tool-bar-mode) (tool-bar-mode -1))
(when (fboundp 'scroll-bar-mode) (scroll-bar-mode -1))

;; Startup: defer garbage collection.
(setq gc-cons-threshold most-positive-fixnum)

;; Package archives: GNU and NonGNU ELPA only.
(setq package-archives '(("gnu" . "https://elpa.gnu.org/packages/")
                         ("nongnu" . "https://elpa.nongnu.org/nongnu/")))

;; Custom settings live in ~/.emacs.d, not in this repository.
(setq custom-file (expand-file-name "custom.el" user-emacs-directory))

(provide 'early-init)
;;; early-init.el ends here
