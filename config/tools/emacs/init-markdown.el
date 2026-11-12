;;; init-markdown.el --- Markdown -*- lexical-binding: t; -*-

(require 'markdown-mode)

;; Preview inside the buffer: markup hidden, text styled, no browser.
;; Off by default so the markers stay visible while editing.
(define-key markdown-mode-map (kbd "C-c m p") #'markdown-toggle-markup-hiding)

(provide 'init-markdown)
;;; init-markdown.el ends here
