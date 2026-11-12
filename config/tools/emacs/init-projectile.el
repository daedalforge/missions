;;; init-projectile.el --- Project navigation -*- lexical-binding: t; -*-

(require 'projectile)

;; The list is these two roots: konoha itself, and every project under ~/projects.
(setq projectile-project-search-path '(("~/projects/konoha" . 0) ("~/projects" . 1)))

;; Projects under the search path are discovered on the first switch; projects
;; that no longer exist are dropped at the same time. Nothing is written inside
;; the repositories themselves.
(setq projectile-auto-discover-projects t)
(setq projectile-auto-cleanup-known-projects t)

;; Visiting a buffer outside the roots must not extend the list.
(setq projectile-track-known-projects-automatically nil)

;; Projectile 3.x binds no key of its own; give it the traditional prefix.
(define-key projectile-mode-map (kbd "C-c p") 'projectile-command-map)

(projectile-mode 1)

;; Mission state is kept out of git on purpose (workspace rule 10), and alien
;; indexing asks git for the file list, so mission files never appear in
;; projectile.  The choice follows the project, not the current buffer: C-c p f
;; is usually pressed from somewhere else, and a buffer-local setting would not
;; follow.  Every other project keeps git as the authority.
(defun konoha--index-natively (project-files project-root)
  (if (and project-root
           (string= (directory-file-name (file-truename project-root))
                    (directory-file-name
                     (file-truename (expand-file-name "~/projects/konoha")))))
      (let ((projectile-indexing-method 'native))
        (funcall project-files project-root))
    (funcall project-files project-root)))

(unless (advice-member-p #'konoha--index-natively 'projectile-project-files)
  (advice-add 'projectile-project-files :around #'konoha--index-natively))

(provide 'init-projectile)
;;; init-projectile.el ends here
