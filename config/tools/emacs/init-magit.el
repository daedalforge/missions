;;; init-magit.el --- Magit -*- lexical-binding: t; -*-

(require 'magit)

;; Word-level refinement only for the hunk at point: keeps large diffs fast.
(setq magit-diff-refine-hunk t)

(provide 'init-magit)
;;; init-magit.el ends here
