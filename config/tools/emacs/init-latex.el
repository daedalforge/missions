;;; init-latex.el --- LaTeX: AUCTeX, latexmk, Okular -*- lexical-binding: t; -*-

;; AUCTeX takes the .tex buffers over from the built-in latex-mode:
;; environment insertion (C-c C-e), section folding, \ref navigation and
;; SyncTeX come with it.
(require 'tex-site)

(with-eval-after-load 'tex
  ;; One command builds the PDF. latexmk reruns pdflatex until labels settle,
  ;; runs BibTeX when the .aux asks for it, and writes the .synctex.gz that
  ;; both searches read.
  (add-to-list 'TeX-command-list
               '("latexmk"
                 "latexmk -pdf -synctex=1 -interaction=nonstopmode -file-line-error %t"
                 TeX-run-TeX nil t))
  ;; LaTeX-mode resets the buffer's default to "LaTeX" every time: the hook
  ;; runs after it, so the build command stays latexmk.
  (defun konoha-latex-command-default ()
    (setq TeX-command-default "latexmk"))
  (add-hook 'LaTeX-mode-hook #'konoha-latex-command-default)

  ;; Forward search: the cursor line rides the PDF URL as #src:, which the
  ;; --unique Okular window reads on open.
  (setq TeX-view-program-selection
        (cons '(output-pdf "Okular")
              (assq-delete-all 'output-pdf TeX-view-program-selection)))
  (add-hook 'LaTeX-mode-hook #'TeX-source-correlate-mode))

;; Inverse search: Okular calls emacsclient, whose editor command is set by
;; config/tools/okular/setup.sh, so a server has to be running. Starting it
;; twice is a no-op.
(unless noninteractive
  (server-start))

(provide 'init-latex)
;;; init-latex.el ends here
