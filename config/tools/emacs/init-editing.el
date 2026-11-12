;;; init-editing.el --- Editing defaults -*- lexical-binding: t; -*-

(setq-default indent-tabs-mode nil)
(setq-default tab-width 4)
(setq-default fill-column 100)
(setq sentence-end-double-space nil)
(setq require-final-newline t)

(setq backup-directory-alist
      `(("." . ,(expand-file-name "backups" user-emacs-directory))))
(setq auto-save-file-name-transforms
      `((".*" ,(expand-file-name "auto-save/" user-emacs-directory) t)))

(delete-selection-mode 1)
(electric-pair-mode 1)
(show-paren-mode 1)
(global-auto-revert-mode 1)
(save-place-mode 1)
(savehist-mode 1)
(recentf-mode 1)

(setq history-length 1000)
(setq recentf-max-saved-items 200)
(setq uniquify-buffer-name-style 'forward)
;; confirm-kill-emacs stays nil: quitting already prompts for modified buffers.
(setq use-short-answers t)

(provide 'init-editing)
;;; init-editing.el ends here
