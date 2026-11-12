;;; init-machete.el --- Vue git machete -*- lexical-binding: t; -*-

;;; Commentary:
;; Vue en lecture seule de la chaîne de branches git machete du dépôt courant.
;; Ouverte depuis le statut Magit par `C-c m'. Le rendu lit
;; `git machete status --color=never': aucune logique de fork point, d'arête ou
;; d'annotation n'est dupliquée.

;;; Code:

(require 'subr-x)
(require 'magit)

(defgroup machete nil
  "Vue de la chaîne de branches git machete."
  :group 'tools)

(defface machete-edge-sync
  '((t :inherit success))
  "Arête à jour: l'enfant descend directement du parent."
  :group 'machete)

(defface machete-edge-out-of-sync
  '((t :inherit error))
  "Arête hors synchronisation: l'enfant n'est pas un descendant direct."
  :group 'machete)

(defface machete-edge-fork-off
  '((t :inherit warning))
  "Arête à jour, mais le fork point diffère du parent."
  :group 'machete)

(defface machete-edge-merged
  '((t :inherit shadow))
  "Arête fusionnée: l'enfant est déjà dans le parent."
  :group 'machete)

(defface machete-branch-current
  '((t :inherit magit-branch-current :weight bold))
  "Branche courante."
  :group 'machete)

(defface machete-annotation
  '((t :inherit shadow))
  "Annotation de branche et état distant."
  :group 'machete)

(defvar-local machete-root nil
  "Racine du dépôt affiché dans le buffer courant.")

(defvar machete--traverse-process nil
  "Processus de traverse en cours, s'il y en a un.")

(defvar machete-view-mode-map
  (let ((map (make-sparse-keymap)))
    (set-keymap-parent map special-mode-map)
    (define-key map (kbd "g") #'machete-refresh)
    (define-key map (kbd "RET") #'machete-checkout-branch)
    (define-key map (kbd "e") #'machete-edit-layout)
    (define-key map (kbd "T") #'machete-traverse)
    (define-key map (kbd "n") #'machete-next-branch)
    (define-key map (kbd "p") #'machete-previous-branch)
    map)
  "Keymap de `machete-view-mode'.")

(defun machete--run (root &rest args)
  "Exécuter git ARGS dans ROOT. Renvoyer (STATUS . SORTIE)."
  (with-temp-buffer
    (let ((default-directory root)
          (status (apply #'process-file "git" nil t nil args)))
      (cons status (buffer-string)))))

(defun machete--toplevel ()
  "Racine du dépôt Git courant, ou une erreur lisible."
  (or (ignore-errors (magit-toplevel))
      (user-error "Buffer hors d'un dépôt Git")))

(defun machete--current-branch (root)
  (string-trim
   (cdr (machete--run root "rev-parse" "--abbrev-ref" "HEAD"))))

(defun machete--branch-at-point ()
  "Nom de branche porté par la propriété de texte au point."
  (or (get-text-property (point) 'machete-branch)
      (get-text-property (max (point-min) (1- (point))) 'machete-branch)))

(defun machete--line-branch-position ()
  "Position du nom de branche sur la ligne courante, ou nil."
  (save-excursion
    (let ((end (line-end-position))
          (pos (line-beginning-position))
          found)
      (while (and (< pos end) (not found))
        (if (get-text-property pos 'machete-branch)
            (setq found pos)
          (setq pos (next-single-property-change pos 'machete-branch nil end))))
      found)))

(defun machete--first-branch-position (&optional name)
  "Position de la première branche, ou de la branche NAME si elle existe."
  (save-excursion
    (goto-char (point-min))
    (let (found first)
      (while (and (not found) (not (eobp)))
        (let ((pos (machete--line-branch-position)))
          (when pos
            (unless first (setq first pos))
            (when (and name
                       (string= (get-text-property pos 'machete-branch) name))
              (setq found pos))))
        (forward-line 1))
      (or found first))))

(defun machete--fontify-line (current)
  "Colorer la ligne courante: arête, branche, annotations."
  (let ((beg (line-beginning-position))
        (end (line-end-position)))
    (when (< beg end)
      (let ((line (buffer-substring-no-properties beg end)))
        (when (string-match
               "\\`\\([ |]*\\)\\([oxm?]-\\)?\\([^ \t]+\\)\\(.*\\)\\'" line)
          (let* ((lead (match-string 1 line))
                 (edge (match-string 2 line))
                 (name (match-string 3 line))
                 (rest (match-string 4 line))
                 (edge-beg (+ beg (length lead)))
                 (name-beg (+ edge-beg (if edge (length edge) 0)))
                 (name-end (+ name-beg (length name))))
            ;; Les lignes de connecteur (|) ne portent pas de branche.
            (unless (string= name "|")
              (let ((face (cond ((string= edge "o-") 'machete-edge-sync)
                                ((string= edge "x-") 'machete-edge-out-of-sync)
                                ((string= edge "?-") 'machete-edge-fork-off)
                                ((string= edge "m-") 'machete-edge-merged))))
                (when face
                  (add-face-text-property edge-beg name-beg face t)))
              (put-text-property name-beg name-end 'machete-branch name)
              (put-text-property name-beg name-end 'mouse-face 'highlight)
              (put-text-property name-beg name-end 'help-echo
                                 (format "RET: checkout %s" name))
              (when (string= name current)
                (add-face-text-property name-beg name-end
                                        'machete-branch-current t))
              (when (and rest (not (string-empty-p rest)))
                (add-face-text-property name-end end
                                        'machete-annotation t)))))))))

(defun machete--render ()
  "Réafficher l'arbre machete du buffer courant."
  (unless machete-root
    (user-error "Buffer sans racine machete"))
  (let* ((current (machete--current-branch machete-root))
         (output (cdr (machete--run machete-root
                                    "machete" "status" "--color=never")))
         (inhibit-read-only t))
    (setq-local header-line-format
                (format " machete  %s  %s "
                        (abbreviate-file-name machete-root) current))
    (erase-buffer)
    (insert output)
    (goto-char (point-min))
    (while (not (eobp))
      (machete--fontify-line current)
      (forward-line 1))
    (let ((pos (machete--first-branch-position current)))
      (when pos
        (goto-char pos)))))

(defun machete--revert (_ignore-auto _noconfirm)
  (machete--render))

(define-derived-mode machete-view-mode special-mode "machete"
  "Mode majeur de la vue git machete."
  (setq-local truncate-lines t)
  (setq-local revert-buffer-function #'machete--revert))

(defun machete--buffer-name (root)
  (format "*machete: %s*" (abbreviate-file-name root)))

(defun machete-status ()
  "Ouvrir la vue git machete du dépôt courant."
  (interactive)
  (let* ((root (machete--toplevel))
         (buffer (get-buffer-create (machete--buffer-name root))))
    (with-current-buffer buffer
      (unless (derived-mode-p 'machete-view-mode)
        (machete-view-mode))
      (setq machete-root root)
      (machete--render))
    (display-buffer buffer '(display-buffer-below-selected
                             (window-height . 0.45)))
    buffer))

(defun machete-refresh ()
  "Rafraîchir la vue."
  (interactive)
  (machete--render))

(defun machete-checkout-branch ()
  "Checkout de la branche sous le point."
  (interactive)
  (let ((branch (machete--branch-at-point)))
    (unless branch
      (user-error "Aucune branche sous le point"))
    (let ((result (machete--run machete-root "checkout" branch)))
      (if (zerop (car result))
          (progn
            (machete--render)
            (when (fboundp 'magit-refresh-all)
              (magit-refresh-all))
            (message "Branche %s" branch))
        (message "Checkout impossible: %s"
                 (string-trim (cdr result)))))))

(defun machete-edit-layout ()
  "Ouvrir le fichier de layout du dépôt."
  (interactive)
  (let* ((result (machete--run machete-root "machete" "file"))
         (file (string-trim (cdr result))))
    (if (and (zerop (car result)) (file-exists-p file))
        (find-file file)
      (user-error "Aucun layout machete dans %s" machete-root))))

(defun machete--traverse-sentinel (process _event)
  (when (memq (process-status process) '(exit signal))
    (setq machete--traverse-process nil)
    (let ((code (process-exit-status process))
          (buffer (process-buffer process)))
      (when (buffer-live-p buffer)
        (with-current-buffer buffer
          (let ((inhibit-read-only t))
            (goto-char (point-max))
            (insert (format "\n[code %s]\n" code)))))
      (dolist (live (buffer-list))
        (when (buffer-live-p live)
          (with-current-buffer live
            (when (and (derived-mode-p 'machete-view-mode)
                       machete-root)
              (machete--render)))))
      (when (fboundp 'magit-refresh-all)
        (magit-refresh-all))
      (message "machete traverse: %s"
               (if (zerop code)
                   "terminé"
                 (format "échec (code %s), voir *machete traverse*" code))))))

(defun machete-traverse ()
  "Traverser toute la chaîne: rebase chaque branche sur son parent.
Le push est désactivé par `machete.traverse.push=false' dans la configuration
git globale; la sortie reste visible dans un buffer dédié."
  (interactive)
  (when (and machete--traverse-process
             (process-live-p machete--traverse-process))
    (user-error "Un traverse est déjà en cours"))
  (unless (y-or-n-p
           (format "Traverse %s (rebase de la chaîne, sans push) ? "
                   (abbreviate-file-name machete-root)))
    (user-error "Traverse annulé"))
  (let ((root machete-root)
        (buffer (get-buffer-create "*machete traverse*")))
    (with-current-buffer buffer
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert (format "$ git machete traverse -W --yes   [%s]\n\n" root))
        (setq default-directory root)
        (setq machete--traverse-process
              (make-process
               :name "machete-traverse"
               :buffer buffer
               :command '("git" "machete" "traverse" "-W" "--yes")
               :noquery t
               :sentinel #'machete--traverse-sentinel))))
    (display-buffer buffer '(display-buffer-below-selected
                             (window-height . 0.35)))
    buffer))

(defun machete--move-branch (direction)
  "Aller à la branche suivante (DIRECTION 1) ou précédente (-1)."
  (let ((start (point))
        (found nil))
    (save-excursion
      (forward-line direction)
      (while (and (not found) (not (bobp)) (not (eobp)))
        (let ((pos (machete--line-branch-position)))
          (if pos
              (setq found pos)
            (forward-line direction)))))
    (if found
        (goto-char found)
      (goto-char start))))

(defun machete-next-branch ()
  "Aller à la branche suivante."
  (interactive)
  (machete--move-branch 1))

(defun machete-previous-branch ()
  "Aller à la branche précédente."
  (interactive)
  (machete--move-branch -1))

(define-key magit-status-mode-map (kbd "C-c m") #'machete-status)

(provide 'init-machete)
;;; init-machete.el ends here
