;;; init-crypto.el --- Transparent .gpg decryption -*- lexical-binding: t; -*-

;; Transparent decryption is auto-encryption-mode's job, on by default in Emacs
;; 31.1; this file fixes the settings that default leaves open.

;; New files encrypt to the saas-office key with no selection dialog:
;; epa-file-write-region only skips the dialog when a buffer-local recipient is
;; set or when epa-file-select-keys is neither t nor nil.
(setq epa-file-encrypt-to '("D30570ACE67C64AE9E1112FA0E983ECE80B2879A"))
(setq epa-file-select-keys 'silent)

;; The passphrase is typed in the minibuffer, not in a pinentry-mac window.
(setq epg-pinentry-mode 'loopback)

(provide 'init-crypto)
;;; init-crypto.el ends here
