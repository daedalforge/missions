window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  factory(require) {
    const React = require('react')
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { Panel, PanelHead, PanelButton, PanelStat, PanelTabs, PanelToolbar } = require('dsh-theme-konoha/client')
    const exports = {}

    const API_URL = 'missions/api/list'
    const SESSIONS_URL = 'missions/api/sessions'
    const LINK_URL = 'missions/api/link'
    const MISSION_URL = 'missions/api/mission'
    const PRIORITY_URL = 'missions/api/priority'
    const STATUS_URL = 'missions/api/status'
    const QUEUE_URL = 'missions/api/queue'
    const PLAN_URL = 'missions/api/plan'
    const DEFAULT_RUNNING_LIMIT = 5
    const MIN_RUNNING_LIMIT = 1
    const MAX_RUNNING_LIMIT = 50
    const CONFIG_PKG = '@daedalforge/dsh-missions'
    const CONFIG_ENTRY = 'missions'
    const STATUS_ORDER = ['active', 'in_review', 'in_peer_review', 'awaiting_validation', 'ready', 'draft']
    const STATUS_LABEL = {
      active: 'En cours',
      in_review: 'En review',
      in_peer_review: 'En peer review',
      awaiting_validation: 'En attente de validation',
      ready: 'En attente d’exécution',
      draft: 'En cadrage',
    }
    const STATUS_PATHS = {
      conteneur: ['draft', 'ready', 'active', 'awaiting_validation'],
      maitrise: ['draft', 'ready', 'active', 'awaiting_validation'],
      poc: ['draft', 'ready', 'active', 'awaiting_validation'],
      produit: ['draft', 'ready', 'active', 'in_review', 'in_peer_review'],
    }
    const STATUS_EDITABLE_TYPES = new Set(['produit'])
    const PRIORITY_CHOICES = [
      { value: 'urgent', label: 'Urgent' },
      { value: 'important', label: 'Important' },
      { value: 'un_jour', label: 'Un jour' },
      { value: '', label: 'Aucune' },
    ]
    const PRIORITY_LABEL = { urgent: 'Urgent', important: 'Important', un_jour: 'Un jour' }
    const MARKDOWN_LABELS = {
      code: {
        copyLabel: 'Copier',
        copiedLabel: 'Copié',
        toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Retour à la ligne', unwrapLabel: 'Couper les lignes' },
      },
      footnotes: 'Notes',
    }
    const SHEET_TABS = [
      { key: 'fiche', label: 'Fiche' },
      { key: 'journal', label: 'Journal' },
      { key: 'checklist', label: 'Checklist' },
      { key: 'performance', label: 'Performance' },
    ]
    const FILTERS = [
      { key: '', label: 'Toutes' },
      { key: 'urgent', label: 'Urgent' },
      { key: 'important', label: 'Important' },
      { key: 'un_jour', label: 'Un jour' },
      { key: 'none', label: 'Sans priorité' },
    ]
    const EPIC_FILTER_KEY = 'dsh-missions:epic-filter'
    const STATUS_FILTER_KEY = 'dsh-missions:status-filter'
    const PRIORITY_FILTER_KEY = 'dsh-missions:priority-filter'
    const SESSION_FILTER_KEY = 'dsh-missions:session-filter'
    const SEARCH_KEY = 'dsh-missions:search'
    const SNAPSHOT_KEY = 'dsh-missions:snapshot'
    const SESSIONS_KEY = 'dsh-missions:sessions'
    const NO_EPIC = 'none'
    const SESSION_FILTERS = [
      { key: '', label: 'Toutes' },
      { key: 'active', label: 'Session active' },
      { key: 'none', label: 'Sans session' },
    ]
    const NEW_MISSION_TYPES = [
      { key: 'produit', label: 'Produit', hint: 'Clé Jira · dépôt produit · review' },
      { key: 'conteneur', label: 'Conteneur', hint: 'Identifiant konoha · ~/konoha · tests manuels' },
      { key: 'poc', label: 'POC', hint: 'POC-NN · hypothèse bornée · timebox' },
    ]
    const NEW_MISSION_IDS = {
      produit: 'la clé Jira du ticket que le principal a créé (format FC-124), et s’il ne l’a pas encore, demande-la',
      conteneur: 'le prochain rang libre du préfixe du dépôt, max + 1 sur `missions/` et `missions/archives` (format FC-124)',
      poc: 'POC-NN, le prochain rang libre',
    }
    const NEW_MISSION_FIELDS = {
      produit:
        'Le principal crée le ticket Jira avant : renseigne `repo`, `base_branch`, `branch_name` et `category` avec lui ; pas de `created`.',
      conteneur: 'Renseigne `repo: ~/konoha` et `created` à la date du jour ; rien de plus que le gabarit.',
      poc: 'Demande l’hypothèse réfutable et la timebox ; renseigne `repos` et `created`.',
    }
    const NEXT_STEP = {
      draft: 'Valider le cadrage',
      ready: 'Lancer l’exécution',
      active: 'Mener l’unité en cours',
      in_review: 'Lancer la review',
      in_peer_review: 'Attendre la peer review',
      awaiting_validation: 'Recueillir la validation',
    }

    const TONE = {
      active: '#2f9e44',
      review: '#1971c2',
      peer: '#0c8599',
      waiting: '#d6336c',
      ready: '#7048e8',
      urgent: '#e03131',
      important: '#f08c00',
    }

    const SHELL_FALLBACK = {
      text: '#1d2129',
      surface: '#ffffff',
    }

    const CSS = `
.dsh-missions {
  --dm-text: var(--dsw-alias-label-primary, ${SHELL_FALLBACK.text});
  --dm-muted: color-mix(in srgb, var(--dm-text) 78%, transparent);
  --dm-faint: color-mix(in srgb, var(--dm-text) 62%, transparent);
  --dm-border: color-mix(in srgb, var(--dm-text) 13%, transparent);
  --dm-border-strong: color-mix(in srgb, var(--dm-text) 24%, transparent);
  --dm-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dm-text) 6%, transparent));
  --dm-surface: var(--dsw-alias-bg-base, ${SHELL_FALLBACK.surface});
  --dm-surface-tint: var(--dsw-specific-menu, var(--dm-surface));
  --dm-active: color-mix(in srgb, ${TONE.active} 72%, var(--dm-text));
  --dm-review: color-mix(in srgb, ${TONE.review} 72%, var(--dm-text));
  --dm-peer: color-mix(in srgb, ${TONE.peer} 72%, var(--dm-text));
  --dm-waiting: color-mix(in srgb, ${TONE.waiting} 72%, var(--dm-text));
  --dm-ready: color-mix(in srgb, ${TONE.ready} 72%, var(--dm-text));
  --dm-urgent: color-mix(in srgb, ${TONE.urgent} 78%, var(--dm-text));
  --dm-important: color-mix(in srgb, ${TONE.important} 78%, var(--dm-text));
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: transparent;
  color: var(--dm-text);
  font-size: 13px;
  line-height: 1.45;
}
.dsh-missions * { box-sizing: border-box; }
.dm-split {
  display: grid;
  grid-template-columns: 392px minmax(0, 1fr) 336px;
  gap: 22px;
  flex: 1;
  min-height: 0;
  margin-top: 4px;
  padding: 4px var(--dsh-panel-pad-x) 20px;
}
.dm-col { min-height: 0; }
.dm-col-list {
  display: flex; flex-direction: column; min-height: 0; padding: 12px 14px;
  border: 1px solid var(--dm-border); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dm-surface));
}
.dm-col-detail {
  display: flex; flex-direction: column; min-height: 0; overflow: auto; padding: 14px 18px;
  border: 1px solid var(--dm-border); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dm-surface));
}
.dm-col-ctx { display: flex; flex-direction: column; gap: 10px; border-left: 1px solid var(--dm-border); padding-left: 16px; overflow: auto; }
.dm-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 2px; }
.dm-search { position: relative; margin: 8px 0 0; }
.dm-search-input {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 12px;
  padding: 6px 26px 6px 9px; border: 1px solid var(--dm-border); border-radius: 6px;
  background: transparent; color: var(--dm-text);
}
.dm-search-input::placeholder { color: var(--dm-muted); }
.dm-search-input:focus-visible { outline: 2px solid var(--dm-border-strong); outline-offset: 1px; }
.dm-search-clear {
  position: absolute; right: 3px; top: 50%; transform: translateY(-50%);
  border: 0; background: transparent; color: var(--dm-muted); font: inherit; font-size: 14px;
  line-height: 1; padding: 2px 5px; border-radius: 4px; cursor: pointer;
}
.dm-search-clear:hover { background: var(--dm-hover); color: var(--dm-text); }
.dm-filter-list {
  display: flex; flex-direction: column; gap: 1px; margin: 6px 0 2px; padding: 4px;
  border: 1px solid var(--dm-border); border-radius: 8px; background: color-mix(in srgb, var(--dm-text) 4%, transparent);
}
.dm-fmenu { position: relative; }
.dm-fbtn {
  border: 1px solid var(--dm-border); background: transparent; color: var(--dm-muted);
  font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 6px;
}
.dm-fbtn:hover, .dm-fbtn[aria-expanded="true"] { background: var(--dm-hover); color: var(--dm-text); }
.dm-fbtn:focus-visible { outline: 2px solid var(--dm-border-strong); outline-offset: 1px; }
.dm-fbtn-value { color: var(--dm-text); font-weight: 600; }
.dm-fmenu-menu {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 30; min-width: 176px; max-height: 320px; overflow: auto;
  background: var(--dm-surface); border: 1px solid var(--dm-border-strong); border-radius: 8px; padding: 4px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); display: flex; flex-direction: column; gap: 1px;
  backdrop-filter: blur(18px) saturate(140%);
}
.dm-fmenu-item {
  border: 0; background: transparent; font: inherit; font-size: 12px; text-align: left;
  padding: 5px 9px; border-radius: 5px; cursor: pointer; color: var(--dm-muted); white-space: nowrap;
}
.dm-fmenu-item:hover { background: var(--dm-hover); color: var(--dm-text); }
.dm-fmenu-item[aria-checked="true"] { color: var(--dm-text); font-weight: 600; }
.dm-fmenu-sep { height: 1px; margin: 4px 2px; background: var(--dm-border); }
.dm-mlist { flex: 1; min-height: 0; overflow: auto; margin-top: 4px; padding-right: 4px; }
.dm-mgroup {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 12px 0 3px; font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dm-faint);
}
.dm-mgroup:first-child { margin-top: 4px; }
.dm-mgroup-count { color: var(--dm-faint); font-variant-numeric: tabular-nums; }
.dm-mitem {
  position: relative; display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 11px 8px;
  border: 0; border-left: 2px solid transparent; border-radius: 5px; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.dm-mitem + .dm-mitem::before {
  content: ''; position: absolute; left: 8px; right: 8px; top: 0; height: 1px;
  background: color-mix(in srgb, var(--dm-text) 9%, transparent);
}
.dm-mitem:hover { background: color-mix(in srgb, var(--dm-text) 5%, transparent); }
.dm-mitem:focus-visible { outline: 2px solid var(--dm-border-strong); outline-offset: -2px; }
.dm-mitem-on { background: color-mix(in srgb, var(--dm-active) 12%, transparent); border-left-color: var(--dm-active); }
.dm-l1 { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--dm-faint); min-width: 0; }
.dm-mid { color: var(--dm-muted); font-variant-numeric: tabular-nums; }
.dm-repo { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-marks { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.dm-flag {
  border: 1px solid var(--dm-border); border-radius: 999px; padding: 0 6px;
  font-size: 10px; line-height: 1.5; color: var(--dm-muted);
}
.dm-flag[data-priority="urgent"] { color: var(--dm-urgent); border-color: color-mix(in srgb, var(--dm-urgent) 40%, transparent); }
.dm-flag[data-priority="important"] { color: var(--dm-important); border-color: color-mix(in srgb, var(--dm-important) 40%, transparent); }
.dm-l2 {
  font-size: 12.5px; color: var(--dm-text); line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.dm-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dm-faint); flex: none; }
.dm-dot[data-status="active"] { background: var(--dm-active); }
.dm-dot[data-status="in_review"] { background: var(--dm-review); }
.dm-dot[data-status="in_peer_review"] { background: var(--dm-peer); }
.dm-dot[data-status="awaiting_validation"] { background: var(--dm-waiting); }
.dm-dot[data-status="ready"] { background: var(--dm-ready); }
.dm-dot[data-status="draft"] { background: color-mix(in srgb, var(--dm-text) 30%, transparent); }
.dm-run { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--dm-active); flex: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--dm-active) 18%, transparent); }
.dm-empty { margin: auto; padding: 40px 24px; text-align: center; color: var(--dm-faint); font-size: 13px; }
.dm-foot { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dm-border); color: var(--dm-faint); font-size: 11px; }
.dm-foot code { font-size: 11px; }
.dm-notice { margin: 6px 0 0; color: var(--dm-urgent); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.dm-list-foot { margin-top: 8px; }
.dm-newmission { display: flex; flex-direction: column; gap: 6px; }
.dm-nm-btn {
  display: flex; align-items: center; gap: 7px;
  border: 1px solid var(--dm-border-strong); background: transparent; color: var(--dm-text);
  font: inherit; font-size: 12px; font-weight: 600; padding: 7px 10px; border-radius: 6px;
  cursor: pointer; text-align: left;
}
.dm-nm-btn:hover, .dm-nm-btn[aria-expanded="true"] { background: var(--dm-hover); }
.dm-nm-btn:focus-visible { outline: 2px solid var(--dm-border-strong); outline-offset: 1px; }
.dm-nm-btn:disabled { opacity: 0.6; cursor: progress; }
.dm-nm-plus { color: var(--dm-faint); font-weight: 400; }
.dm-nm-list {
  display: flex; flex-direction: column; gap: 1px; padding: 4px;
  border: 1px solid var(--dm-border); border-radius: 8px;
  background: color-mix(in srgb, var(--dm-text) 4%, transparent);
}
.dm-nm-item {
  display: flex; flex-direction: column; gap: 1px; text-align: left;
  border: 0; background: transparent; color: var(--dm-text); font: inherit;
  padding: 6px 8px; border-radius: 5px; cursor: pointer;
}
.dm-nm-item:hover { background: var(--dm-hover); }
.dm-nm-item:focus-visible { outline: 2px solid var(--dm-border-strong); outline-offset: 1px; }
.dm-nm-label { font-size: 12.5px; font-weight: 600; }
.dm-nm-hint { font-size: 11px; font-weight: 400; color: var(--dm-faint); }
.dm-sheet { display: flex; flex-direction: column; gap: 10px; padding-bottom: 16px; min-height: 0; }
.dm-sheet-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dm-sheet-back {
  border: 1px solid var(--dm-border); background: transparent; color: var(--dm-text);
  font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
}
.dm-sheet-back:hover { background: var(--dm-hover); }
.dm-sheet-id { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--dm-faint); }
.dm-chip {
  border: 1px solid var(--dm-border); border-radius: 999px; padding: 1px 7px;
  font-size: 10px; color: var(--dm-faint); background: transparent; font-family: inherit; line-height: 1.7;
}
.dm-chip-btn { cursor: pointer; color: var(--dm-text); display: inline-flex; align-items: center; gap: 5px; }
.dm-chip-btn:hover { background: var(--dm-hover); }
.dm-chip-btn:focus-visible { outline: 2px solid var(--dm-border-strong); outline-offset: 1px; }
.dm-ctx-btn { font-size: 11.5px; padding: 2px 8px; font-weight: 600; color: var(--dm-text); }
.dm-ctx-btn[data-status] { color: var(--dm-text); }
.dm-ctx-menu { position: relative; display: flex; flex-direction: column; gap: 6px; }
.dm-ctx-list { display: flex; flex-direction: column; gap: 1px; margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--dm-border); }
.dm-ctx-list .dm-fmenu-item { font-size: 11.5px; padding: 4px 7px; white-space: normal; }
.dm-caret { color: var(--dm-faint); font-size: 9px; }
.dm-sheet-live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dm-active); }
.dm-sheet-title { margin: 0; font-size: 20px; line-height: 1.35; font-weight: 650; }
.dm-sheet-body { max-width: 760px; min-width: 0; }
.dm-sheet-body--wide { max-width: none; }
.dm-sheet-frame { display: block; width: 100%; height: min(74vh, 980px); border: 1px solid var(--dm-border); border-radius: 6px; background: var(--dm-surface); }
.dm-pframe {
  flex: 1; min-height: 0; width: calc(100% - 2 * var(--dsh-panel-pad-x, 24px));
  margin: 0 var(--dsh-panel-pad-x, 24px) var(--dsh-panel-pad-x, 24px);
  display: block; border: 1px solid var(--dm-border); border-radius: 6px; background: var(--dm-surface);
}
.dm-sheet-body h2 { font-size: 15px; margin: 20px 0 8px; }
.dm-sheet-note { margin: 0; color: var(--dm-faint); font-size: 13px; }
.dm-ctxcard {
  border: 1px solid var(--dm-border); position: relative;
  border-radius: 6px; padding: 10px 12px;
  background: color-mix(in srgb, var(--dm-text) 2%, transparent);
}
.dm-ctxcard:focus-within { z-index: 50; }
.dm-ctxcard h5 {
  margin: 0 0 7px; font-size: 10px; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--dm-faint); font-weight: 600;
}
.dm-ctxrow { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11.5px; color: var(--dm-muted); padding: 3px 0; }
.dm-ctxrow > b { color: var(--dm-text); font-weight: 600; text-align: right; display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.dm-ctx-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-ctx-link { color: var(--dm-active); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-ctx-link:hover { text-decoration: underline; }
.dm-ctx-wrap { white-space: normal; overflow-wrap: anywhere; }
.dm-ctx-action { margin-top: 8px; }
.dm-ctx-action .dm-fbtn { padding: 4px 9px; font-size: 11.5px; }
@media (max-width: 1280px) {
  .dm-split { grid-template-columns: 320px minmax(0, 1fr); }
  .dm-col-ctx { display: none; }
}
.dm-qview {
  display: grid; grid-template-columns: 460px minmax(0, 1fr); gap: 22px;
  flex: 1; min-height: 0; padding: 14px var(--dsh-panel-pad-x) 20px;
}
.dm-qcol {
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  border: 1px solid var(--dm-border); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dm-surface));
}
.dm-qhead { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; }
.dm-qtitle { margin: 0; font-size: 13px; font-weight: 600; }
.dm-qcount {
  min-width: 18px; padding: 0 6px; border: 1px solid var(--dm-border); border-radius: 9px;
  background: var(--dm-hover); font-size: 10.5px; line-height: 16px; text-align: center; color: var(--dm-text);
}
.dm-qhint { margin-left: auto; font-size: 11px; color: var(--dm-faint); }
.dm-qwait { margin-left: 8px; font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dm-faint); }
.dm-qcol .dm-filters { margin: 0; padding: 0 14px 10px; }
.dm-qcol-source .dm-mlist { flex: 1; min-height: 0; overflow: auto; padding: 0 6px 10px 10px; }
.dm-qcol-source .dm-foot { margin: 0; padding: 10px 14px; border-top: 1px solid var(--dm-border); }
.dm-qcols {
  display: grid; grid-template-columns: 30px minmax(0, 1fr) 150px 110px 34px; gap: 10px;
  padding: 2px 25px 6px; font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dm-faint);
}
.dm-qlist { display: flex; flex-direction: column; gap: 2px; flex: 1; min-height: 0; overflow: auto; padding: 2px 14px 12px; }
.dm-qrow {
  display: grid; grid-template-columns: 30px minmax(0, 1fr) 150px 110px 34px; gap: 10px;
  align-items: center; padding: 7px 10px; border: 1px solid var(--dm-border); border-radius: 6px;
  background: var(--dm-hover);
}
.dm-qrow.dm-first { background: rgba(245, 137, 58, 0.1); border-color: rgba(245, 137, 58, 0.38); }
.dm-qrow.dm-over { border-color: #f5893a; }
.dm-qrow.dm-dragging { opacity: 0.45; }
.dm-qrank { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dm-faint); }
.dm-qbody { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dm-ql1 { display: flex; align-items: center; gap: 8px; font-size: 10.5px; color: var(--dm-faint); }
.dm-ql2 { font-size: 12.5px; color: var(--dm-text); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-qdepot { font-size: 11.5px; color: var(--dm-muted); }
.dm-qprio { display: flex; align-items: center; }
.dm-qtag {
  justify-self: start; padding: 1px 8px; border: 1px solid rgba(245, 137, 58, 0.45); border-radius: 9px;
  font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: #f5893a;
}
.dm-qdel {
  width: 24px; height: 24px; border: 1px solid var(--dm-border); border-radius: 4px;
  background: transparent; color: var(--dm-muted); font: inherit; cursor: pointer;
}
.dm-qdel:hover { border-color: #f5893a; color: #f5893a; }
.dm-qempty { margin: 14px; padding: 16px 14px; border: 1px dashed var(--dm-border); border-radius: 8px; font-size: 12px; color: var(--dm-faint); text-align: center; }
.dm-qnote { margin: 0 14px 14px; padding-top: 10px; border-top: 1px solid var(--dm-border); font-size: 11.5px; color: var(--dm-muted); line-height: 1.4; }
.dm-qin {
  padding: 1px 6px; border: 1px solid rgba(112, 72, 232, 0.45); border-radius: 3px;
  font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase; color: #7048e8;
}
.dm-mitem-drag { cursor: grab; }
.dm-qblk {
  padding: 1px 6px; border: 1px solid rgba(112, 72, 232, 0.45); border-radius: 3px;
  font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase; color: #7048e8;
}
.dm-mitem-blk { box-shadow: inset 2px 0 0 rgba(112, 72, 232, 0.55); }
.dm-plan { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 18px; flex: 1; min-height: 0; margin-top: 14px; padding: 0 var(--dsh-panel-pad-x) 20px; }
.dm-planvis { min-width: 0; min-height: 0; overflow: auto; border: 1px solid var(--dm-border); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); padding: 10px 14px 16px; }
.dm-planlegend { display: flex; gap: 18px; align-items: center; padding: 2px 2px 10px; font-size: 11px; color: var(--dm-muted); }
.dm-legend { display: inline-flex; align-items: center; gap: 6px; }
.dm-legend::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--dm-faint); }
.dm-legend[data-state="runnable"]::before { background: #2f9e44; }
.dm-legend[data-state="blocked"]::before { background: #f5893a; }
.dm-planroot { position: relative; }
.dm-planroot svg { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
.dm-planroot path { fill: none; stroke: rgba(120, 120, 130, 0.45); stroke-width: 1.2; stroke-dasharray: 4 5; }
.dm-plancol { position: absolute; font-size: 9.5px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dm-faint); }
.dm-planrepo { position: absolute; left: 0; width: 140px; text-align: right; font-size: 11.5px; color: var(--dm-muted); }
.dm-plannode {
  position: absolute; display: flex; flex-direction: column; gap: 3px; align-items: stretch; text-align: left;
  padding: 7px 10px; border: 1px solid var(--dm-border); border-radius: 7px; background: var(--dm-hover);
  color: var(--dm-text); font: inherit; cursor: pointer;
}
.dm-plannode[data-state="runnable"] { border-color: rgba(47, 158, 68, 0.55); }
.dm-plannode[data-state="blocked"] { border-color: rgba(245, 137, 58, 0.5); }
.dm-plannode[data-state="running"] { border-color: rgba(28, 126, 214, 0.55); }
.dm-plannode.on { box-shadow: 0 0 0 1px var(--dm-border-strong); }
.dm-planl1 { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--dm-faint); }
.dm-planstate { margin-left: auto; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; }
.dm-plannode[data-state="runnable"] .dm-planstate { color: #2f9e44; }
.dm-plannode[data-state="blocked"] .dm-planstate { color: #f5893a; }
.dm-plannode[data-state="running"] .dm-planstate { color: #1c7ed6; }
.dm-plantitle { font-size: 12px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-plandetail { display: flex; flex-direction: column; gap: 12px; min-height: 0; overflow: auto; }
.dm-plancard { border: 1px solid var(--dm-border); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); padding: 12px 14px; }
.dm-plancard h3 { margin: 0 0 8px; font-size: 12.5px; font-weight: 600; }
.dm-planrow { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; font-size: 11.5px; color: var(--dm-muted); padding: 3px 0; }
.dm-planrow b { color: var(--dm-text); font-weight: 600; }
.dm-planbanner { margin: 6px 0 0; padding: 8px 12px; border: 1px solid rgba(47, 158, 68, 0.5); border-radius: 8px; background: rgba(47, 158, 68, 0.12); font-size: 12px; color: var(--dm-text); }
.dm-planbanner-head { margin: 0; font-weight: 600; }
.dm-planline { margin: 4px 0 0; font-size: 11.5px; color: var(--dm-muted); }
.dm-planline[data-error='true'] { color: var(--dm-urgent); }
.dm-plannote { margin: 0; font-size: 11.5px; color: var(--dm-muted); line-height: 1.45; }
.dm-planbanner-note { margin: 4px 0 0; font-size: 11.5px; color: var(--dm-muted); }
.dm-planbanner-note[data-blocked='true'] { color: var(--dm-urgent); }
.dm-cfg { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.dm-cfg-intro { margin: 0; color: var(--dm-muted); font-size: 12.5px; }
.dm-cfg-field { display: flex; flex-direction: column; gap: 4px; }
.dm-cfg-label { font-size: 12.5px; color: var(--dm-text); }
.dm-cfg-input { width: 120px; padding: 6px 8px; border: 1px solid var(--dm-border); border-radius: 6px; background: transparent; color: var(--dm-text); font: inherit; }
.dm-cfg-hint { color: var(--dm-faint); font-size: 11.5px; }
.dm-cfg-actions { display: flex; align-items: center; gap: 10px; }
.dm-cfg-msg { color: var(--dm-muted); font-size: 12px; }
@media (max-width: 1280px) {
  .dm-qview { grid-template-columns: 380px minmax(0, 1fr); }
}
`

    function sessionLabel(session) {
      return session.displayTitle || session.title || 'Session sans titre'
    }

    function sessionDate(value) {
      if (!value) return ''
      try {
        return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
      } catch {
        return ''
      }
    }

    function sessionAge(value) {
      const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0
      if (!Number.isFinite(at) || at <= 0) return ''
      const delta = Date.now() - at
      if (delta < 60_000) return 'à l’instant'
      const minutes = Math.round(delta / 60_000)
      if (minutes < 60) return `il y a ${minutes} min`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `il y a ${hours} h`
      const days = Math.round(hours / 24)
      if (days < 30) return `il y a ${days} j`
      return sessionDate(at)
    }

    function formatTime(value) {
      if (!value) return ''
      try {
        return new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function countLabel(count, singular, plural) {
      return `${count} ${count > 1 ? plural : singular}`
    }

    function planBannerHead(entries, blocked = '') {
      if (blocked === 'limit') return 'Plafond de sessions atteint'
      const rows = Array.isArray(entries) ? entries : []
      if (rows.length === 0) return 'Plan validé · aucune mission à ouvrir'
      const launched = rows.filter((entry) => !entry.error).length
      const failed = rows.length - launched
      const launchLabel = countLabel(launched, 'mission lancée', 'missions lancées')
      return failed === 0 ? `Plan validé · ${launchLabel}` : `Plan validé · ${launchLabel} · ${countLabel(failed, 'échec', 'échecs')}`
    }

    function bareSessionId(value) {
      return typeof value === 'string' && value.startsWith('session-') ? value.slice('session-'.length) : value
    }

    function runningRows(rows, sessionIds) {
      const seen = new Set()
      const list = []
      if (!rows || typeof rows.values !== 'function') {
        return list
      }
      const scoped = sessionIds instanceof Set && sessionIds.size > 0 ? sessionIds : null
      for (const row of rows.values()) {
        if (!row || typeof row.id !== 'string' || row.running !== true) {
          continue
        }
        if (row.parentId || row.origin === 'subagent') {
          continue
        }
        if (scoped && !scoped.has(row.id) && !scoped.has(`session-${row.id}`)) {
          continue
        }
        if (seen.has(row.id)) {
          continue
        }
        seen.add(row.id)
        list.push(row)
      }
      return list
    }

    function effectiveLimit(snapshot, fallback) {
      if (!snapshot || snapshot.status === 'loading') {
        return fallback
      }
      const raw = Number(snapshot.value?.maxRunningSessions)
      if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_RUNNING_LIMIT
      }
      return Math.min(MAX_RUNNING_LIMIT, Math.max(MIN_RUNNING_LIMIT, Math.trunc(raw)))
    }

    function panelConfigForm(services) {
      try {
        const forms = services?.getService?.('configForms')
        const form = forms?.get?.(CONFIG_ENTRY)
        return form && typeof form.getSnapshot === 'function' ? form : null
      } catch {
        return null
      }
    }

    function useConfigLimit(services, fallback) {
      const form = React.useMemo(() => panelConfigForm(services), [services])
      const subscribe = React.useCallback((listener) => (form ? form.subscribe(listener) : () => {}), [form])
      const snapshotOf = React.useCallback(() => (form ? form.getSnapshot() : null), [form])
      const snapshot = React.useSyncExternalStore(subscribe, snapshotOf, snapshotOf)
      return effectiveLimit(snapshot, fallback)
    }

    function sessionBudget(executable, running, limit) {
      const total = Math.max(MIN_RUNNING_LIMIT, Number(limit) || DEFAULT_RUNNING_LIMIT)
      const used = Math.max(0, Number(running) || 0)
      const free = Math.max(0, total - used)
      const ids = Array.isArray(executable) ? executable : []
      return { total, used, free, open: ids.slice(0, free), deferred: ids.slice(free) }
    }

    function sessionsCounter(running, limit, outside) {
      const base = `${running}/${limit} sessions en cours`
      return outside > 0 ? `${base} · dont ${outside} hors missions` : base
    }

    function planLimitNote(banner) {
      const total = banner?.limit ?? DEFAULT_RUNNING_LIMIT
      const used = banner?.running ?? 0
      const deferred = banner?.deferred ?? 0
      if (banner?.blocked === 'limit') {
        return `${used}/${total} sessions en cours · ${countLabel(deferred, 'mission reportée', 'missions reportées')} · libérez une session puis revalidez.`
      }
      if (deferred > 0) {
        return `${used}/${total} sessions au départ · ${countLabel(deferred, 'mission reportée', 'missions reportées')}`
      }
      return ''
    }

    function methodRoots(data) {
      const root =
        typeof data?.displayRoot === 'string' && data.displayRoot.trim()
          ? normalizePath(data.displayRoot)
          : '~/konoha/missions'
      const cut = root.lastIndexOf('/')
      return { fiche: root, repo: cut > 0 ? root.slice(0, cut) : root }
    }

    function missionPrompt(mission, data) {
      const title = mission.title ? ` — ${mission.title}` : ''
      const roots = methodRoots(data)
      return `Mission ${mission.id}${title}\n\nFiche : ${roots.fiche}/${mission.id}/mission.md`
    }

    function goPrompt(mission, data) {
      const roots = methodRoots(data)
      const note = `Le plan d’exécution est validé : la mission est autorisée à partir. Exécute-la maintenant — lis la fiche et son journal, puis mène-la selon \`${roots.repo}/workflows/missions.md\` jusqu’à l’état « en attente de validation ». Aucun go supplémentaire n’est attendu.`
      return `${missionPrompt(mission, data)}\n\n${note}`
    }

    function newMissionPrompt(type) {
      const entry = NEW_MISSION_TYPES.find((candidate) => candidate.key === type) ?? NEW_MISSION_TYPES[1]
      return [
        `Nouvelle mission ${entry.label} — le cadrage commence maintenant.`,
        '',
        `Le principal a choisi « ${entry.label} » dans le panneau Missions et aucune fiche n’existe encore. Travaille dans ce workspace (~/konoha), au contrat de \`standards/types.md\` et de \`workflows/cadrage.md\`, et suis le gabarit \`templates/mission-${entry.key}.md\` sans écart de forme.`,
        '',
        '1. Si l’intention n’est pas déjà dite, demande-la en une phrase — pas d’interview.',
        `2. Identifiant : ${NEW_MISSION_IDS[entry.key]}. ${NEW_MISSION_FIELDS[entry.key]}`,
        '3. Écris `missions/<id>/mission.md` en recopiant le gabarit : frontmatter complet, sections du gabarit dans l’ordre, `status: draft`, aucune section ajoutée ni retirée.',
        '4. Écris `missions/<id>/journal.md` : demande verbatim, identifiant et son calcul, lectures, état relevé, hypothèses, points ouverts.',
        '5. Rends la main : propose la fiche et au plus trois points ouverts, un par un, avec recommandation. La mission reste en `draft`.',
        '6. N’exécute rien : aucune branche, aucun fichier hors `missions/<id>/`, aucun go. L’exécution attend le go nommé du principal après validation.',
      ].join('\n')
    }

    function repoLabel(repo) {
      if (!repo) return ''
      const parts = String(repo).replace(/[\\/]+$/, '').split('/')
      return parts[parts.length - 1] || ''
    }

    function statusLabel(status) {
      return STATUS_LABEL[status] ?? (status ? status.replace(/_/g, ' ') : 'Autre')
    }

    function nextStep(mission) {
      return NEXT_STEP[mission?.status] ?? 'Statut à préciser'
    }

    function orderStatuses(statuses) {
      const known = STATUS_ORDER.filter((status) => statuses.includes(status))
      const extra = statuses.filter((status) => !STATUS_ORDER.includes(status)).sort()
      return [...known, ...extra]
    }

    function canChangeStatus(type) {
      return STATUS_EDITABLE_TYPES.has(String(type ?? '').trim())
    }

    function statusChoices(type) {
      return canChangeStatus(type) ? STATUS_PATHS[String(type ?? '').trim()] : []
    }

    function priorityLabel(priority) {
      return PRIORITY_LABEL[priority] ?? ''
    }

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function noop() {}

    async function savePriority(missionId, priority) {
      const response = await fetch(new URL(PRIORITY_URL, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ missionId, priority }),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || !body || body.ok !== true) {
        throw new Error(body?.error?.message || `HTTP ${response.status}`)
      }
      return body.value
    }

    async function saveStatus(missionId, status) {
      const response = await fetch(new URL(STATUS_URL, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ missionId, status }),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || !body || body.ok !== true) {
        throw new Error(body?.error?.message || `HTTP ${response.status}`)
      }
      return body.value
    }

    function filterMissions(missions, filter, epic, session, hasSession) {
      let list = missions
      if (filter === 'none') list = list.filter((mission) => !mission.priority)
      else if (filter) list = list.filter((mission) => mission.priority === filter)
      if (epic === NO_EPIC) list = list.filter((mission) => !mission.epic)
      else if (epic) list = list.filter((mission) => mission.epic === epic)
      if (session === 'active') list = list.filter((mission) => (typeof hasSession === 'function' ? hasSession(mission) === true : true))
      else if (session === 'none') list = list.filter((mission) => (typeof hasSession === 'function' ? hasSession(mission) !== true : true))
      return list
    }

    function normalizeQuery(value) {
      return String(value ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
    }

    function searchTokens(query) {
      const text = normalizeQuery(query).trim()
      return text ? text.split(/\s+/).filter(Boolean) : []
    }

    function matchesQuery(mission, tokens) {
      if (!tokens.length) return true
      const text = mission && typeof mission.search === 'string' ? mission.search : ''
      return tokens.every((token) => text.includes(token))
    }

    function searchMissions(missions, query) {
      const tokens = searchTokens(query)
      if (!tokens.length) return missions
      return missions.filter((mission) => matchesQuery(mission, tokens))
    }

    function epicOptions(missions) {
      const keys = new Set()
      let without = false
      for (const mission of missions) {
        if (mission.epic) keys.add(mission.epic)
        else without = true
      }
      const sorted = [...keys].sort((left, right) => String(left).localeCompare(String(right), 'fr'))
      const options = [{ key: '', label: 'Toutes' }]
      for (const key of sorted) options.push({ key, label: key })
      if (without) options.push({ key: NO_EPIC, label: 'Sans epic' })
      return options
    }

    function withStoredValue(options, value, label) {
      if (!value || options.some((entry) => entry.key === value)) return options
      return [...options, { key: value, label }]
    }

    function emptyNotice(filter, epic, query, session) {
      const term = String(query ?? '').trim()
      if (term) {
        if (filter || epic || session) return `Aucune mission ne correspond à « ${term} » avec ces filtres.`
        return `Aucune mission ne correspond à « ${term} ».`
      }
      if (session === 'active' && !filter && !epic) return 'Aucune mission ouverte avec une session.'
      if (session === 'none' && !filter && !epic) return 'Toutes les missions ont une session.'
      if (session && (filter || epic)) return 'Aucune mission avec ces filtres.'
      if (epic === NO_EPIC && !filter) return 'Toutes les missions ont un epic.'
      if (epic && filter) return 'Aucune mission pour cette priorité et cet epic.'
      if (epic) return 'Aucune mission ouverte sur cet epic.'
      if (filter === 'none') return 'Toutes les missions ont une priorité.'
      if (filter) return 'Aucune mission avec cette priorité.'
      return 'Aucune mission ouverte.'
    }

    const PRIORITY_RANK = { urgent: 0, important: 1, un_jour: 2 }

    function priorityRank(priority) {
      const rank = PRIORITY_RANK[priority]
      return rank === undefined ? 3 : rank
    }

    function statusRank(status) {
      const rank = STATUS_ORDER.indexOf(status)
      return rank === -1 ? STATUS_ORDER.length : rank
    }

    function naturalKey(value) {
      return String(value).replace(/\d+/g, (digits) => digits.padStart(6, '0'))
    }

    function sortMissions(missions) {
      return [...missions].sort(
        (left, right) =>
          priorityRank(left.priority) - priorityRank(right.priority) ||
          statusRank(left.status) - statusRank(right.status) ||
          naturalKey(left.id).localeCompare(naturalKey(right.id)),
      )
    }

    const FILE_STATUS = new Set(['ready'])

    function queueFile(missions) {
      return missions
        .filter((mission) => mission.queue > 0 && FILE_STATUS.has(mission.status))
        .sort((left, right) => left.queue - right.queue)
    }

    function queueCandidates(missions) {
      return missions.filter((mission) => FILE_STATUS.has(mission.status) && !(mission.queue > 0))
    }

    function groupMissions(missions) {
      return orderStatuses(missions.map((mission) => mission.status))
        .map((status) => ({ status, missions: sortMissions(missions.filter((mission) => mission.status === status)) }))
        .filter((group) => group.missions.length > 0)
    }

    function statusFilterOptions(missions) {
      const counts = statusCounts(missions)
      const present = orderStatuses(Object.keys(counts)).filter((status) => counts[status] > 0)
      return [{ key: '', label: 'Toutes' }, ...present.map((status) => ({ key: status, label: statusLabel(status) }))]
    }
    function statusCounts(missions) {
      const counts = {}
      for (const mission of missions) counts[mission.status] = (counts[mission.status] ?? 0) + 1
      return counts
    }

    function partInfo(part) {
      if (!part) return { exists: false, text: '' }
      if (typeof part === 'string') return { exists: part.trim().length > 0, text: part }
      const text = typeof part.text === 'string' ? part.text : typeof part.source === 'string' ? part.source : ''
      return { exists: part.exists !== false && (part.exists === true || text.trim().length > 0), text }
    }

    function normalizePath(value) {
      return typeof value === 'string' ? value.replace(/[\\/]+$/, '') : ''
    }

    function candidatePaths(declared, single) {
      const list = Array.isArray(declared) ? declared : [single]
      const targets = new Set()
      for (const path of list) {
        const normalized = normalizePath(path)
        if (normalized) {
          targets.add(normalized)
        }
      }
      return targets
    }

    function workspaceAt(snapshot, targets) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : []
      if (targets.size === 0) {
        return null
      }
      return items.find((item) => targets.has(normalizePath(item.path))) ?? null
    }

    function missionsWorkspace(snapshot, data) {
      return workspaceAt(
        snapshot,
        candidatePaths(data?.sessions?.workspacePaths, data?.sessions?.workspacePath),
      )
    }

    function productWorkspace(snapshot, data) {
      return workspaceAt(
        snapshot,
        candidatePaths(data?.sessions?.productWorkspacePaths, data?.sessions?.productWorkspacePath),
      )
    }

    function executionWorkspace(snapshot, data, type) {
      if (type === 'produit') {
        return productWorkspace(snapshot, data)
      }
      return missionsWorkspace(snapshot, data)
    }

    function unionSessionIds(workspaces) {
      const ids = new Set()
      for (const item of Array.isArray(workspaces) ? workspaces : []) {
        for (const id of Array.isArray(item?.sessionIds) ? item.sessionIds : []) ids.add(id)
      }
      return ids
    }

    function missingWorkspaceMessage(type, data) {
      const sessions = data?.sessions
      const produit = type === 'produit'
      const label = produit ? sessions?.productWorkspaceLabel : sessions?.workspaceLabel
      const fallback = produit ? '~/projects' : '~/konoha'
      return `Le workspace ${label || fallback} n’est pas ouvert.`
    }

    function readFilterValue(key) {
      try {
        return window.localStorage.getItem(key) || ''
      } catch {
        return ''
      }
    }

    function storeFilterValue(key, value) {
      try {
        if (value) window.localStorage.setItem(key, value)
        else window.localStorage.removeItem(key)
      } catch {}
    }

    function useStoredFilter(key) {
      const [value, setValue] = React.useState(() => readFilterValue(key))
      React.useEffect(() => storeFilterValue(key, value), [key, value])
      return [value, setValue]
    }

    function missionStorage() {
      try {
        return window.localStorage
      } catch {
        return null
      }
    }

    function readStored(storage, key) {
      try {
        const raw = storage?.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    }

    function writeStored(storage, key, value) {
      try {
        storage?.setItem(key, JSON.stringify(value))
      } catch {
      }
    }

    function storedSnapshot(storage) {
      const stored = readStored(storage, SNAPSHOT_KEY)
      return stored && stored.data && typeof stored.at === 'number' ? stored : null
    }

    function initialState(storage) {
      const stored = storedSnapshot(storage)
      return { phase: stored ? 'refreshing' : 'loading', data: stored ? stored.data : null, error: '' }
    }

    function panelNotice(state) {
      if (!state.error) return ''
      return state.data
        ? `Revalidation impossible : ${state.error} — affichage du dernier état connu`
        : `Lecture impossible : ${state.error}`
    }

    /** Sessions connues de l'app, indexées par identifiant complet et sans préfixe. */
    function useSessionRows(services) {
      const store = services?.getService?.('sessions')?.list
      const subscribe = React.useCallback((notify) => (store ? store.subscribe(notify) : () => {}), [store])
      const read = React.useCallback(() => (store ? store.getSnapshot() : null), [store])
      const snapshot = React.useSyncExternalStore(subscribe, read, () => null)
      return React.useMemo(() => {
        const map = new Map()
        if (!snapshot) return map
        const rows = snapshot.byId instanceof Map ? [...snapshot.byId.values()] : Object.values(snapshot.byId ?? {})
        for (const row of rows) {
          if (!row || typeof row.id !== 'string' || row.parentSessionId) continue
          map.set(row.id, row)
          map.set(`session-${row.id}`, row)
        }
        return map
      }, [snapshot])
    }

    /** Missions -> identifiants de sessions, calculé côté hôte (liens + journaux). */
    function useSessionIndex(stamp, refreshKey) {
      const [index, setIndex] = React.useState(() => readStored(missionStorage(), SESSIONS_KEY)?.value ?? {})
      React.useEffect(() => {
        let cancelled = false
        const url = new URL(SESSIONS_URL, document.baseURI)
        url.searchParams.set('refresh', '1')
        fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then((response) => response.json())
          .then((body) => {
            if (cancelled || !body || body.ok !== true) return
            const value = body.value?.byMission ?? {}
            setIndex(value)
            writeStored(missionStorage(), SESSIONS_KEY, { at: Date.now(), value })
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [stamp, refreshKey])
      return index
    }

    function useMissions() {
      const [state, setState] = React.useState(() => initialState(missionStorage()))
      const [epoch, setEpoch] = React.useState(0)
      const bumpSessions = React.useCallback(() => setEpoch((value) => value + 1), [])
      const load = React.useCallback(async () => {
        setState((current) => ({ phase: current.data ? 'refreshing' : 'loading', data: current.data, error: '' }))
        try {
          const response = await fetch(new URL(API_URL, document.baseURI), { headers: { accept: 'application/json' }, cache: 'no-store' })
          let body = null
          try {
            body = await response.json()
          } catch {
            body = null
          }
          if (!response.ok || !body || body.ok !== true) {
            const reason = body?.error?.message || `HTTP ${response.status}`
            throw new Error(reason)
          }
          writeStored(missionStorage(), SNAPSHOT_KEY, { at: Date.now(), data: body.value })
          setState({ phase: 'ready', data: body.value, error: '' })
        } catch (error) {
          setState((current) => ({ phase: 'error', data: current.data, error: errorMessage(error) }))
        }
      }, [])
      const reload = React.useCallback(() => {
        bumpSessions()
        load()
      }, [bumpSessions, load])
      React.useEffect(() => {
        load()
      }, [load])
      React.useEffect(() => {
        const refreshOnReturn = () => {
          if (document.visibilityState === 'visible') reload()
        }
        window.addEventListener('focus', refreshOnReturn)
        document.addEventListener('visibilitychange', refreshOnReturn)
        return () => {
          window.removeEventListener('focus', refreshOnReturn)
          document.removeEventListener('visibilitychange', refreshOnReturn)
        }
      }, [reload])
      return { bumpSessions, epoch, load, reload, state }
    }

    function MissionsGlyph({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 4.5, y: 4, width: 15, height: 16, rx: 2.5 }),
        h('path', { d: 'M8.5 9.5h5.5M8.5 13h7.5M8.5 16.5h5' }),
      )
    }

    function sessionControl(sessions) {
      const usable = sessions.filter((session) => session.blank !== true)
      const blank = usable.length === 0 && sessions.length > 0
      const top = usable[0] ?? null
      const direct = top !== null && (usable.length === 1 || top.explicit === true || top.titleMatch === true)
      return { usable, blank, top, mode: top === null ? 'new' : direct ? 'open' : 'multi' }
    }

    /** Session rattachée que le panneau ouvrirait : lien explicite, sinon titre ; jamais une simple mention. */
    function attachedSessionId(sessions) {
      const rows = Array.isArray(sessions) ? sessions : []
      const usable = rows.filter((session) => session && session.blank !== true)
      const explicit = usable.find((session) => session.explicit === true)
      if (explicit) return explicit.sessionId ?? explicit.id ?? ''
      const titled = usable.find((session) => session.titleMatch === true)
      return titled ? titled.sessionId ?? titled.id ?? '' : ''
    }

    function FilterMenu({ label, value, options, open, onToggle }) {
      const current = options.find((entry) => entry.key === value) ?? options[0]
      return h(
        'button',
        {
          type: 'button',
          className: 'dm-fbtn',
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => onToggle(!open),
        },
        `${label} · `,
        h('span', { className: 'dm-fbtn-value' }, current?.label ?? 'Toutes'),
      )
    }

    function FilterList({ options, value, onPick }) {
      return h(
        'div',
        { className: 'dm-filter-list', role: 'menu' },
        options.map((entry) =>
          h(
            'button',
            {
              key: entry.key || 'all',
              type: 'button',
              className: 'dm-fmenu-item',
              role: 'menuitemradio',
              'aria-checked': entry.key === value ? 'true' : 'false',
              onClick: () => onPick(entry.key),
            },
            entry.label,
          ),
        ),
      )
    }

    function NewMissionMenu({ open, busy, onToggle, onPick }) {
      return h(
        'div',
        { className: 'dm-newmission' },
        h(
          'button',
          {
            type: 'button',
            className: 'dm-nm-btn',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            disabled: busy === true,
            onClick: () => onToggle(!open),
          },
          busy === true
            ? 'Ouverture de la session…'
            : [h('span', { key: 'plus', className: 'dm-nm-plus', 'aria-hidden': 'true' }, '+'), 'Nouvelle mission'],
        ),
        open
          ? h(
              'div',
              { className: 'dm-nm-list', role: 'menu', 'aria-label': 'Type de mission' },
              NEW_MISSION_TYPES.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.key,
                    type: 'button',
                    className: 'dm-nm-item',
                    role: 'menuitem',
                    onClick: () => onPick(entry.key),
                  },
                  h('span', { className: 'dm-nm-label' }, entry.label),
                  h('span', { className: 'dm-nm-hint' }, entry.hint),
                ),
              ),
            )
          : null,
      )
    }

    function MissionListFooter({ archived, root, open, busy, onToggle, onPick }) {
      return h(
        'div',
        { className: 'dm-list-foot' },
        h(
          'p',
          { className: 'dm-foot' },
          `${archived ?? 0} clôturées dans `,
          h('code', {}, `${root ?? '~/konoha/missions'}/archives`),
        ),
        h(NewMissionMenu, { open, busy, onToggle, onPick }),
      )
    }

    function SessionAction({ sessions, busy, onNew, onOpen, label }) {
      const top = sessionControl(sessions).top
      return h(
        'div',
        { className: 'dm-fmenu' },
        h(
          'button',
          {
            type: 'button',
            className: 'dm-fbtn',
            title: top ? 'Aller à la session de cette mission' : 'Créer une session sur cette mission',
            disabled: busy,
            onClick: () => (top ? onOpen(top) : onNew()),
          },
          label || (top ? 'Ouvrir la session' : 'Lier une session'),
        ),
      )
    }

    function MissionItem({ mission, selected, session, queued, blocker, draggable, onDragStart, onDragEnd, onSelect }) {
      const repo = repoLabel(mission.repo)
      return h(
        'button',
        {
          type: 'button',
          className: `dm-mitem${selected ? ' dm-mitem-on' : ''}${draggable ? ' dm-mitem-drag' : ''}${blocker ? ' dm-mitem-blk' : ''}`,
          'data-status': mission.status,
          'aria-current': selected ? 'true' : undefined,
          title: mission.title || mission.id,
          onClick: () => onSelect(mission),
          draggable: draggable ? 'true' : undefined,
          onDragStart: draggable ? onDragStart : undefined,
          onDragEnd: draggable ? onDragEnd : undefined,
        },
        h(
          'span',
          { className: 'dm-l1' },
          h('span', { className: 'dm-mid' }, mission.id),
          repo ? h('span', { className: 'dm-repo' }, repo) : null,
          h(
            'span',
            { className: 'dm-marks' },
            mission.priority
              ? h('span', { className: 'dm-flag', 'data-priority': mission.priority }, priorityLabel(mission.priority))
              : null,
            queued ? h('span', { className: 'dm-qin' }, 'en file') : null,
            blocker ? h('span', { className: 'dm-qblk' }, `par ${blocker}`) : null,
            session?.running === true ? h('span', { className: 'dm-run', 'aria-hidden': 'true' }) : null,
            h('span', { className: 'dm-dot', 'data-status': mission.status }),
          ),
        ),
        h('span', { className: 'dm-l2' }, mission.title || '—'),
      )
    }

    function MissionList({ groups, selectedId, sessionsFor, queuedIds, blockers, dragMode, onDragStart, onDragEnd, onSelect }) {
      return h(
        'div',
        { className: 'dm-mlist', role: 'list' },
        groups.map((group) =>
          h(
            'div',
            { key: group.status, className: 'dm-mgroup-block' },
            h(
              'div',
              { className: 'dm-mgroup' },
              h('span', {}, group.label ?? statusLabel(group.status)),
              h('span', { className: 'dm-mgroup-count' }, String(group.missions.length)),
            ),
            group.missions.map((mission) =>
              h(MissionItem, {
                key: mission.id,
                mission,
                selected: mission.id === selectedId,
                session: sessionsFor(mission.id)[0] ?? null,
                queued: queuedIds?.has(mission.id) === true,
                blocker: blockers?.[mission.id],
                draggable: dragMode === true,
                onDragStart: onDragStart ? onDragStart(mission) : undefined,
                onDragEnd,
                onSelect,
              }),
            ),
          ),
        ),
      )
    }

    const FACT_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
    const FACT_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/
    const CAUSE_LABELS = { suite: 'chaîne' }

    function unquote(value) {
      const text = String(value ?? '')
      if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') return text.slice(1, -1)
      return text
    }

    function readFacts(source) {
      const fields = {}
      const text = String(source ?? '').replace(/^\ufeff/, '')
      const match = FACT_BLOCK.exec(text)
      if (!match) return fields
      let listKey = ''
      for (const line of match[1].split(/\r?\n/)) {
        if (!line.trim()) {
          listKey = ''
          continue
        }
        if (/^\s/.test(line)) {
          if (!listKey) continue
          const item = unquote(line.trim().replace(/^-\s*/, '').trim())
          if (item) fields[listKey].push(item)
          continue
        }
        const separator = line.indexOf(':')
        if (separator <= 0) continue
        const key = line.slice(0, separator).trim()
        if (!FACT_KEY.test(key)) continue
        const raw = line.slice(separator + 1).trim()
        listKey = ''
        if (!raw) {
          fields[key] = []
          listKey = key
          continue
        }
        fields[key] = unquote(raw)
      }
      return fields
    }

    function factText(facts, key) {
      const value = facts[key]
      if (Array.isArray(value)) return value.join(', ')
      return String(value ?? '').trim()
    }

    function factList(facts, key) {
      const value = facts[key]
      if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean)
      const text = String(value ?? '').trim()
      if (!text || text === '[]') return []
      const inline = /^\[(.*)\]$/.exec(text)
      if (inline) return inline[1].split(',').map((entry) => entry.trim()).filter(Boolean)
      return [text]
    }

    function factRows(type, facts) {
      const rows = []
      const add = (label, value) => rows.push({ label, value: value || '—' })
      if (type === 'produit') {
        add('Story points', factText(facts, 'story_points'))
        add('Catégorie', factText(facts, 'category'))
        add('Branche', factText(facts, 'branch_name'))
        add('Base de branche', factText(facts, 'base_branch'))
        const pr = factText(facts, 'pr')
        rows.push({ label: 'PR', value: pr || '—', href: /^https?:\/\//.test(pr) ? pr : '' })
        add('Chaîne', factText(facts, 'suite'))
        add('File', factText(facts, 'queue'))
      } else if (type === 'poc') {
        add('Dépôts', factList(facts, 'repos').join(', '))
        add('Timebox', factText(facts, 'timebox'))
        add('Création', factText(facts, 'created'))
      } else {
        add('Création', factText(facts, 'created'))
        add('Chaîne', factText(facts, 'suite'))
        add('File', factText(facts, 'queue'))
      }
      add('Bruno', factList(facts, 'bruno').join(', '))
      return rows
    }

    function planLinks(plan, missionId) {
      const blocks = []
      const blockedBy = []
      for (const [blockedId, blockers] of Object.entries(plan?.blockedBy ?? {})) {
        for (const entry of Array.isArray(blockers) ? blockers : []) {
          const cause = CAUSE_LABELS[entry.cause] ?? entry.cause
          if (entry.id === missionId) blocks.push({ id: blockedId, text: `${blockedId} (${cause})` })
          if (blockedId === missionId) blockedBy.push({ id: entry.id, text: `${entry.id} (${cause})` })
        }
      }
      const order = (list) => list.sort((left, right) => naturalKey(left.id).localeCompare(naturalKey(right.id)))
      return { blocks: order(blocks), blockedBy: order(blockedBy) }
    }

    function factValue(row) {
      if (row.href) {
        return h('a', { className: 'dm-ctx-link', href: row.href, target: '_blank', rel: 'noreferrer', title: row.value }, row.value)
      }
      return h('b', { className: 'dm-ctx-ellipsis', title: row.value === '—' ? undefined : row.value }, row.value)
    }

    function linkText(list) {
      return list.map((link) => link.text).join(', ') || '—'
    }

    function ContextCard({ title, children }) {
      return h('section', { className: 'dm-ctxcard' }, h('h5', {}, title), children)
    }

    function ContextRow({ label, children }) {
      return h('div', { className: 'dm-ctxrow' }, h('span', {}, label), children ?? h('b', {}, '—'))
    }

    function ContextColumn({
      mission,
      sessions,
      sheet,
      plan = null,
      busy,
      onNew,
      onPickSession,
      priorityMenuOpen = false,
      statusMenuOpen = false,
      onPriorityMenu = noop,
      onStatusMenu = noop,
      onPickPriority = noop,
      onPickStatus = noop,
    }) {
      const top = sessionControl(sessions).top
      const statuses = statusChoices(mission.type)
      const facts = readFacts(sheet?.source)
      const factColumns = factRows(mission.type, facts)
      const links = planLinks(plan, mission.id)
      return h(
        'aside',
        { className: 'dm-col dm-col-ctx', 'aria-label': 'Contexte de la mission' },
        h(
          ContextCard,
          { title: 'Prochaine action' },
          h(
            ContextRow,
            { label: 'Statut' },
            statuses.length
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dm-chip dm-chip-btn dm-ctx-btn',
                    'data-status': mission.status,
                    'aria-haspopup': 'menu',
                    'aria-expanded': statusMenuOpen ? 'true' : 'false',
                    disabled: busy,
                    onClick: () => onStatusMenu(!statusMenuOpen),
                  },
                  h('span', { className: 'dm-dot', 'data-status': mission.status, 'aria-hidden': 'true' }),
                  statusLabel(mission.status),
                  h('span', { className: 'dm-caret', 'aria-hidden': 'true' }, '▾'),
                )
              : h(
                  'b',
                  {},
                  h('span', { className: 'dm-dot', 'data-status': mission.status, 'aria-hidden': 'true' }),
                  statusLabel(mission.status),
                ),
          ),
          h(
            ContextRow,
            { label: 'Priorité' },
            h(
              'button',
              {
                type: 'button',
                className: 'dm-chip dm-chip-btn dm-ctx-btn',
                'aria-haspopup': 'menu',
                'aria-expanded': priorityMenuOpen ? 'true' : 'false',
                disabled: busy,
                onClick: () => onPriorityMenu(!priorityMenuOpen),
              },
              priorityLabel(mission.priority) || '—',
              h('span', { className: 'dm-caret', 'aria-hidden': 'true' }, '▾'),
            ),
          ),
          statusMenuOpen && statuses.length
            ? h(
                'div',
                { className: 'dm-ctx-list', role: 'menu' },
                statuses.map((status) =>
                  h(
                    'button',
                    {
                      key: status,
                      type: 'button',
                      className: 'dm-fmenu-item',
                      role: 'menuitemradio',
                      'aria-checked': status === mission.status ? 'true' : 'false',
                      onClick: () => onPickStatus(status),
                    },
                    statusLabel(status),
                  ),
                ),
              )
            : null,
          priorityMenuOpen
            ? h(
                'div',
                { className: 'dm-ctx-list', role: 'menu' },
                PRIORITY_CHOICES.map((choice) =>
                  h(
                    'button',
                    {
                      key: choice.value || 'none',
                      type: 'button',
                      className: 'dm-fmenu-item',
                      role: 'menuitemradio',
                      'aria-checked': (mission.priority || '') === choice.value ? 'true' : 'false',
                      onClick: () => onPickPriority(choice.value),
                    },
                    choice.label,
                  ),
                ),
              )
            : null,
        ),
        h(
          ContextCard,
          { title: 'Session' },
          h(
            ContextRow,
            { label: 'Titre' },
            h('b', { className: 'dm-ctx-ellipsis', title: top ? sessionLabel(top) : undefined }, top ? sessionLabel(top) : 'Aucune session liée'),
          ),
          top ? h(ContextRow, { label: 'État' }, h('b', {}, top.running ? 'en cours' : 'au repos')) : null,
          top ? h(ContextRow, { label: 'Dernière activité' }, h('b', {}, sessionAge(top.updatedAt) || '—')) : null,
          h(
            'div',
            { className: 'dm-ctx-action' },
            h(SessionAction, {
              sessions,
              busy,
              label: top ? 'Ouvrir la session' : 'Lier une session',
              onNew: () => onNew(mission),
              onOpen: onPickSession,
            }),
          ),
        ),
        h(
          ContextCard,
          { title: 'Dépôt' },
          h(ContextRow, { label: 'Dépôt' }, h('b', {}, repoLabel(mission.repo) || '—')),
          h(ContextRow, { label: 'Type' }, h('b', {}, mission.type || '—')),
          mission.epic ? h(ContextRow, { label: 'Epic' }, h('b', {}, mission.epic)) : null,
        ),
        h(
          ContextCard,
          { title: 'Frontmatter' },
          factColumns.map((row, index) => h(ContextRow, { key: `fact-${index}`, label: row.label }, factValue(row))),
        ),
        h(
          ContextCard,
          { title: 'Dépendances' },
          h(ContextRow, { label: 'Bloque' }, h('b', { className: 'dm-ctx-wrap' }, linkText(links.blocks))),
          h(ContextRow, { label: 'Bloquée par' }, h('b', { className: 'dm-ctx-wrap' }, linkText(links.blockedBy))),
        ),
        h(
          ContextCard,
          { title: 'Livrable' },
          h(ContextRow, { label: 'Fiche' }, h('b', { className: 'dm-ctx-ellipsis' }, `missions/${mission.id}`)),
          h(ContextRow, { label: 'Journal' }, h('b', {}, partInfo(sheet?.journal).exists ? 'présent' : 'absent')),
          h(ContextRow, { label: 'Checklist' }, h('b', {}, partInfo(sheet?.checklist).exists ? 'présente' : 'absente')),
        ),
      )
    }

    function sheetMarkdown(text) {
      return h(MarkdownText, { text: text ?? '', labels: MARKDOWN_LABELS })
    }

    function stripSheetHeader(source) {
      let text = String(source ?? '')
      text = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      text = text.replace(/^\s*#\s+.*\r?\n?/, '')
      return text
    }

    function partBlocks(part, label) {
      const info = partInfo(part)
      if (!info.exists) return h('p', { className: 'dm-sheet-note' }, `Cette mission n’a pas de ${label}.`)
      if (!info.text.trim()) return h('p', { className: 'dm-sheet-note' }, 'Chargement…')
      const body = label === 'journal' ? info.text : stripSheetHeader(info.text)
      if (!body.trim()) return null
      return sheetMarkdown(body)
    }

    function MissionSheet({ mission, sheet, sessions = [], tab = 'fiche', busy = false, onSelectTab = noop, onClose = noop }) {
      if (!mission || !sheet) return null
      const running = sessionControl(sessions).top?.running === true
      const tabs = SHEET_TABS
      return h(
        'section',
        { className: 'dm-sheet', 'aria-label': `Mission ${mission.id}` },
        h(
          'div',
          { className: 'dm-sheet-bar' },
          h('button', { type: 'button', className: 'dm-sheet-back', onClick: onClose, 'aria-label': 'Revenir à la liste' }, '←'),
          h('span', { className: 'dm-sheet-id' }, mission.id),
          running ? h('span', { className: 'dm-sheet-live' }, h('span', { className: 'dm-run', 'aria-hidden': 'true' }), 'séance en cours') : null,
        ),
        h('h2', { className: 'dm-sheet-title' }, mission.title || '—'),
        h(PanelTabs, {
          flush: true,
          active: tab,
          tabs: SHEET_TABS.map((entry) => ({ id: entry.key, label: entry.label })),
          onSelect: onSelectTab,
        }),
        h(
          'div',
          { className: tab === 'performance' ? 'dm-sheet-body dm-sheet-body--wide' : 'dm-sheet-body', role: 'tabpanel' },
          tab === 'performance'
            ? h('iframe', {
                className: 'dm-sheet-frame',
                src: `/performance/panel?mission=${encodeURIComponent(mission.id)}`,
                title: `Performance — ${mission.id}`,
              })
            : tab === 'journal'
              ? partBlocks(sheet.journal, 'journal')
              : tab === 'checklist'
                ? partBlocks(sheet.checklist, 'checklist')
                : sheetMarkdown(stripSheetHeader(sheet.source)),
        ),
      )
    }

    function WorkflowsView(props) {
      const [Chunk, setChunk] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        require
          .async('./client.workflows.js')
          .then((module) => {
            if (alive) setChunk(() => module.WorkflowsPanel)
          })
          .catch((error) => {
            if (alive) setFailure(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [])
      if (failure) {
        return h(
          Panel,
          null,
          h(PanelHead, { title: 'Workflows' }),
          props.tabs,
          h('p', { className: 'dm-sheet-note' }, failure),
        )
      }
      if (!Chunk) {
        return h(
          Panel,
          null,
          h(PanelHead, { title: 'Workflows' }),
          props.tabs,
          h('p', { className: 'dm-sheet-note' }, 'Chargement de la vue Workflows…'),
        )
      }
      return h(Chunk, { tabs: props.tabs })
    }

    function MissionsPanel({ services }) {
      const { state, epoch, load, reload, bumpSessions } = useMissions()
      const index = useSessionIndex(state.data?.generatedAt ?? 0, epoch)
      const rows = useSessionRows(services)
      const [busy, setBusy] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [priorityMenu, setPriorityMenu] = React.useState(false)
      const [statusMenu, setStatusMenu] = React.useState(false)
      const [priorityError, setPriorityError] = React.useState('')
      const [statusError, setStatusError] = React.useState('')
      const [sessionError, setSessionError] = React.useState('')
      const [filter, setFilter] = useStoredFilter(PRIORITY_FILTER_KEY)
      const [epicFilter, setEpicFilter] = useStoredFilter(EPIC_FILTER_KEY)
      const [query, setQuery] = useStoredFilter(SEARCH_KEY)
      const [filterMenu, setFilterMenu] = React.useState(false)
      const [epicMenu, setEpicMenu] = React.useState(false)
      const [sessionMenu, setSessionMenu] = React.useState(false)
      const [statusFilter, setStatusFilter] = useStoredFilter(STATUS_FILTER_KEY)
      const [sessionFilter, setSessionFilter] = useStoredFilter(SESSION_FILTER_KEY)
      const [selectedId, setSelectedId] = React.useState('')
      const [sheet, setSheet] = React.useState(null)
      const [tab, setTab] = React.useState('fiche')
      const [view, setView] = React.useState('list')
      const [queueBusy, setQueueBusy] = React.useState(false)
      const [queueError, setQueueError] = React.useState('')
      const [planBanner, setPlanBanner] = React.useState(null)
      const [planBusy, setPlanBusy] = React.useState(false)
      const [planSelect, setPlanSelect] = React.useState('')
      const [newMissionOpen, setNewMissionOpen] = React.useState(false)
      const [newMissionBusy, setNewMissionBusy] = React.useState(false)
      const [draggingId, setDraggingId] = React.useState('')
      const [dropIndex, setDropIndex] = React.useState(-1)
      const dragOrigin = React.useRef(null)

      const sessionsFor = React.useCallback(
        (missionId) => {
          const entries = (Array.isArray(index[missionId]) ? index[missionId] : []).map((entry) => ({
            ...entry,
            id: entry.id ?? entry.sessionId,
          }))
          return entries.map((entry) => {
            const row = rows.get(entry.id) ?? rows.get(`session-${entry.id}`) ?? null
            if (!row) return entry
            return { ...entry, displayTitle: row.displayTitle || entry.displayTitle, running: row.running }
          })
        },
        [index, rows],
      )

      const missionHasSession = React.useCallback(
        (mission) => sessionControl(sessionsFor(mission.id)).usable.length > 0,
        [sessionsFor],
      )

      const closeSheet = React.useCallback(() => {
        setSheet(null)
        setSelectedId('')
        setPriorityMenu(false)
        setStatusMenu(false)
      }, [])

      const openMissionFile = React.useCallback(async (mission) => {
        setSelectedId(mission.id)
        setTab('fiche')
        setPriorityMenu(false)
        setStatusMenu(false)
        setSheet({ id: mission.id, mission, phase: 'loading' })
        setBusy(true)
        try {
          const url = new URL(MISSION_URL, document.baseURI)
          url.searchParams.set('id', mission.id)
          const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          let body = null
          try {
            body = await response.json()
          } catch {
            body = null
          }
          if (!response.ok || !body || body.ok !== true) {
            throw new Error(body?.error?.message || `HTTP ${response.status}`)
          }
          setSheet({
            id: mission.id,
            mission,
            phase: 'ready',
            source: body.value.source ?? '',
            journal: partInfo(body.value.journal),
            checklist: partInfo(body.value.checklist),
          })
        } catch (error) {
          setSheet({ id: mission.id, mission, phase: 'error', error: errorMessage(error) })
        } finally {
          setBusy(false)
        }
      }, [])

      const selectTab = React.useCallback((key) => {
        setTab(key)
      }, [])

      const pickPriority = React.useCallback(
        async (priority) => {
          setPriorityMenu(false)
          if (!sheet) return
          setSaving(true)
          setPriorityError('')
          try {
            await savePriority(sheet.id, priority)
            load()
          } catch (error) {
            setPriorityError(errorMessage(error))
          } finally {
            setSaving(false)
          }
        },
        [load, sheet],
      )

      const pickStatus = React.useCallback(
        async (status) => {
          setStatusMenu(false)
          if (!sheet) return
          setSaving(true)
          setStatusError('')
          try {
            await saveStatus(sheet.id, status)
            load()
          } catch (error) {
            setStatusError(errorMessage(error))
          } finally {
            setSaving(false)
          }
        },
        [load, sheet],
      )

      const openLinkedSession = React.useCallback(
        async (session) => {
          const sessionId = session?.sessionId ?? session?.id
          try {
            await fetch(new URL(LINK_URL, document.baseURI), {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ missionId: sheet?.id, sessionId }),
            })
          } catch {
            /* le lien est un confort : l'ouverture reste utile */
          }
          const ui = services?.getService?.('uiWorkspace')
          try {
            ui?.openSession?.(sessionId)
          } catch {
            /* l'ouverture est un confort */
          }
          bumpSessions()
        },
        [bumpSessions, services, sheet],
      )

      const startSession = React.useCallback(
        async (mission) => {
          const ui = services?.getService?.('uiWorkspace')
          if (!ui) {
            setSessionError('Service uiWorkspace indisponible dans cet écran.')
            return
          }
          setBusy(true)
          setSessionError('')
          try {
            const workspaces = services?.getService?.('workspaces')
            const workspace = executionWorkspace(workspaces?.list?.getSnapshot?.(), state.data, mission.type)
            if (!workspace) {
              throw new Error(missingWorkspaceMessage(mission.type, state.data))
            }
            const linked = await ui.connectWorkspace(workspace.workspaceId)
            if (linked) {
              await fetch(new URL(LINK_URL, document.baseURI), {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ missionId: mission.id, sessionId: linked }),
              })
              bumpSessions()
            }
            ui.startSession(workspace.workspaceId, { prompt: missionPrompt(mission, state.data) })
          } catch (error) {
            setSessionError(errorMessage(error))
          } finally {
            setBusy(false)
          }
        },
        [bumpSessions, services, state.data],
      )

      const startNewMission = React.useCallback(
        async (type) => {
          const ui = services?.getService?.('uiWorkspace')
          if (!ui) {
            setSessionError('Service uiWorkspace indisponible dans cet écran.')
            return
          }
          setNewMissionBusy(true)
          setSessionError('')
          try {
            const workspaces = services?.getService?.('workspaces')
            const workspace = missionsWorkspace(workspaces?.list?.getSnapshot?.(), state.data)
            if (!workspace) {
              throw new Error(missingWorkspaceMessage('missions', state.data))
            }
            await ui.connectWorkspace(workspace.workspaceId)
            ui.startSession(workspace.workspaceId, { prompt: newMissionPrompt(type) })
            setNewMissionOpen(false)
            bumpSessions()
          } catch (error) {
            setSessionError(errorMessage(error))
          } finally {
            setNewMissionBusy(false)
          }
        },
        [bumpSessions, services, state.data],
      )

      const linked = React.useMemo(() => {
        if (!sheet) return { usable: [], top: null }
        return sessionControl(sessionsFor(sheet.id))
      }, [sheet, sessionsFor])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          setPriorityMenu(false)
          setStatusMenu(false)
          setFilterMenu(false)
          setEpicMenu(false)
          setNewMissionOpen(false)
          setSessionMenu(false)
          if (view === 'plan') setView('queue')
          else if (view === 'queue') setView('list')
          else if (view === 'workflows') setView('list')
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [view])

      const data = state.data
      const missions = data?.missions ?? []
      const searched = searchMissions(missions, query)
      const filtered = filterMissions(searched, filter, epicFilter, sessionFilter, missionHasSession)
      const visible = statusFilter ? filtered.filter((mission) => mission.status === statusFilter) : filtered
      const statusOptions = statusFilterOptions(filtered)
      const groups = groupMissions(visible)
      const queuePool = filterMissions(queueCandidates(missions), filter, epicFilter)
      const queueVisible = statusFilter ? queuePool.filter((mission) => mission.status === statusFilter) : queuePool
      const queueGroups = groupMissions(queueVisible)
      const current = sheet ? missions.find((mission) => mission.id === sheet.id) ?? sheet.mission : null
      const queued = queueFile(missions)
      const queuedIds = new Set(queued.map((mission) => mission.id))
      const plan = data?.plan ?? null
      const planNodes = Array.isArray(plan?.nodes) ? plan.nodes : []
      const planStates = new Map(planNodes.map((node) => [node.id, node.state]))
      const missionById = new Map(missions.map((mission) => [mission.id, mission]))
      const workspace = React.useMemo(
        () => missionsWorkspace(services?.getService?.('workspaces')?.list?.getSnapshot?.(), data),
        [services, data],
      )
      const productRoot = React.useMemo(
        () => productWorkspace(services?.getService?.('workspaces')?.list?.getSnapshot?.(), data),
        [services, data],
      )
      const workspaceSessionIds = React.useMemo(
        () => unionSessionIds([workspace, productRoot]),
        [workspace, productRoot],
      )
      const running = React.useMemo(() => runningRows(rows, workspaceSessionIds), [rows, workspaceSessionIds])
      const runningCount = running.length
      const runningLimit = useConfigLimit(services, Number(data?.limits?.maxRunningSessions) || DEFAULT_RUNNING_LIMIT)
      const budget = sessionBudget(plan?.executable, runningCount, runningLimit)
      const missionSessionIds = React.useMemo(() => {
        const ids = new Set()
        for (const entries of Object.values(index)) {
          for (const entry of Array.isArray(entries) ? entries : []) {
            const id = bareSessionId(entry.sessionId ?? entry.id)
            if (id) ids.add(id)
          }
        }
        return ids
      }, [index])
      const outsideRunning = running.filter((row) => !missionSessionIds.has(bareSessionId(row.id))).length
      const fileBlocked = {}
      for (const node of planNodes) {
        const blocker = (plan?.blockedBy?.[node.id] ?? []).find((entry) => queuedIds.has(entry.id))
        if (blocker) fileBlocked[node.id] = blocker.id
      }
      if (state.phase === 'loading' && !data) {
        return h(
          'div',
          { className: 'dsh-missions' },
          h(Panel, null, h('p', { className: 'dm-sheet-note' }, 'Chargement des missions…')),
        )
      }

      const saveQueue = async (ids) => {
        setQueueError('')
        setQueueBusy(true)
        try {
          const response = await fetch(new URL(QUEUE_URL, document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ids }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
          await load()
        } catch (error) {
          setQueueError(errorMessage(error))
        } finally {
          setQueueBusy(false)
        }
      }

      const dropOnQueue = (index) => {
        const origin = dragOrigin.current
        dragOrigin.current = null
        setDraggingId('')
        setDropIndex(-1)
        if (!origin) return
        const before = queued.map((mission) => mission.id)
        const ids = before.filter((id) => id !== origin.id)
        ids.splice(Math.max(0, Math.min(index, ids.length)), 0, origin.id)
        if (ids.join('|') === before.join('|')) return
        saveQueue(ids)
      }

      const dropOnSource = () => {
        const origin = dragOrigin.current
        dragOrigin.current = null
        setDraggingId('')
        setDropIndex(-1)
        if (!origin || origin.from !== 'queue') return
        saveQueue(queued.map((mission) => mission.id).filter((id) => id !== origin.id))
      }

      const removeFromQueue = (missionId) => saveQueue(queued.map((mission) => mission.id).filter((id) => id !== missionId))

      const startDrag = (from, missionId) => (event) => {
        dragOrigin.current = { from, id: missionId }
        setDraggingId(missionId)
        if (!event.dataTransfer) return
        event.dataTransfer.effectAllowed = 'move'
        try {
          event.dataTransfer.setData('text/plain', missionId)
        } catch {}
      }

      const endDrag = () => {
        dragOrigin.current = null
        setDraggingId('')
        setDropIndex(-1)
      }

      const renderFilters = (statusChoices, withSession = false) => {
        const statuses = withStoredValue(statusChoices, statusFilter, statusLabel(statusFilter))
        const epics = withStoredValue(epicOptions(missions), epicFilter, epicFilter === NO_EPIC ? 'Sans epic' : epicFilter)
        return [
        h(
          'div',
          { className: 'dm-filters', key: 'filters' },
          h(FilterMenu, {
            key: 'status',
            label: 'Statut',
            value: statusFilter,
            options: statuses,
            open: statusMenu,
            onToggle: (next) => {
              setStatusMenu(next)
              if (next) {
                setFilterMenu(false)
                setEpicMenu(false)
                setSessionMenu(false)
              }
            },
          }),
          h(FilterMenu, {
            key: 'filter',
            label: 'Priorité',
            value: filter,
            options: FILTERS,
            open: filterMenu,
            onToggle: (next) => {
              setFilterMenu(next)
              if (next) {
                setEpicMenu(false)
                setStatusMenu(false)
                setSessionMenu(false)
              }
            },
          }),
          h(FilterMenu, {
            key: 'epic',
            label: 'Epic',
            value: epicFilter,
            options: epics,
            open: epicMenu,
            onToggle: (next) => {
              setEpicMenu(next)
              if (next) {
                setFilterMenu(false)
                setStatusMenu(false)
                setSessionMenu(false)
              }
            },
          }),
          withSession
            ? h(FilterMenu, {
                key: 'session',
                label: 'Session',
                value: sessionFilter,
                options: SESSION_FILTERS,
                open: sessionMenu,
                onToggle: (next) => {
                  setSessionMenu(next)
                  if (next) {
                    setFilterMenu(false)
                    setEpicMenu(false)
                    setStatusMenu(false)
                  }
                },
              })
            : null,
        ),
        statusMenu
          ? h(FilterList, {
              key: 'status-list',
              options: statuses,
              value: statusFilter,
              onPick: (value) => {
                setStatusFilter(value)
                setStatusMenu(false)
              },
            })
          : filterMenu
            ? h(FilterList, {
                key: 'filter-list',
                options: FILTERS,
                value: filter,
                onPick: (value) => {
                  setFilter(value)
                  setFilterMenu(false)
                },
              })
            : epicMenu
              ? h(FilterList, {
                  key: 'epic-list',
                  options: epics,
                  value: epicFilter,
                  onPick: (value) => {
                    setEpicFilter(value)
                    setEpicMenu(false)
                  },
                })
              : withSession && sessionMenu
                ? h(FilterList, {
                    key: 'session-list',
                    options: SESSION_FILTERS,
                    value: sessionFilter,
                    onPick: (value) => {
                      setSessionFilter(value)
                      setSessionMenu(false)
                    },
                  })
                : null,
        ]
      }

      const searchBlock = h(
        'div',
        { className: 'dm-search' },
        h('input', {
          type: 'text',
          className: 'dm-search-input',
          value: query,
          placeholder: 'Rechercher dans les missions',
          'aria-label': 'Rechercher dans les missions',
          spellCheck: false,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') setQuery('')
          },
        }),
        query
          ? h(
              'button',
              {
                type: 'button',
                className: 'dm-search-clear',
                title: 'Effacer la recherche',
                'aria-label': 'Effacer la recherche',
                onClick: () => setQuery(''),
              },
              '×',
            )
          : null,
      )

      const filtersBlock = renderFilters(statusOptions, true)

      const vueTabs = (actif) =>
        h(PanelTabs, {
          active: actif,
          tabs: [
            { id: 'list', label: 'Missions' },
            { id: 'queue', label: `File d’exécution${queued.length ? ` (${queued.length})` : ''}` },
            { id: 'plan', label: 'Ordonnancement' },
            { id: 'performance', label: 'Performance' },
            { id: 'workflows', label: 'Workflows' },
          ],
          onSelect: (cle) => {
            if (cle === 'plan') setPlanBanner(null)
            setView(cle)
          },
        })

      if (view === 'workflows') {
        return h(
          'div',
          { className: 'dsh-missions' },
          h(WorkflowsView, { tabs: vueTabs('workflows') }),
        )
      }

      if (view === 'queue') {
        return h(
          'div',
          { className: 'dsh-missions' },
          h(Panel, null,
            h(PanelHead, {
              title: 'File d’exécution',
              sub: [
                queued.length
                  ? `${countLabel(queued.length, 'mission', 'missions')} rangées · l’ordonnancement décide de ce qui peut partir`
                  : 'aucun rang tenu · donnez un rang à une mission prête pour ordonner la file',
                ` · ${sessionsCounter(runningCount, runningLimit, outsideRunning)}`,
              ],
              actions: [
                h(PanelStat, { children: sessionAge(data?.generatedAt) }),
                h(PanelButton, { onClick: reload, disabled: queueBusy, children: 'Rafraîchir' }),
              ],
              children: queueError ? h('p', { className: 'dm-notice', role: 'alert' }, queueError) : null,
            }),
            vueTabs('queue'),
            h(PanelToolbar, null,
              h(PanelButton, { onClick: () => { setPlanBanner(null); setView('plan') }, disabled: queueBusy, children: 'Ordonnancer' })),
            h(
              'div',
              { className: 'dm-qview' },
              h(
                'div',
                {
                  className: 'dm-qcol dm-qcol-source',
                  onDragOver: (event) => event.preventDefault(),
                  onDrop: (event) => {
                    event.preventDefault()
                    dropOnSource()
                  },
                },
                h(
                  'div',
                  { className: 'dm-qhead' },
                  h('h2', { className: 'dm-qtitle' }, 'Hors rang'),
                  h('span', { className: 'dm-qcount' }, String(queueVisible.length)),
                  h('span', { className: 'dm-qhint' }, 'prêtes sans rang · glissez-les dans « En file » pour les ordonner'),
                ),
                renderFilters(statusFilterOptions(queueVisible)),
                queueVisible.length === 0
                  ? h(
                      'p',
                      { className: 'dm-sheet-note dm-empty-list' },
                      filter || epicFilter
                        ? 'Aucune mission prête hors rang pour ce filtre.'
                        : 'Toutes les missions prêtes tiennent un rang — l’ordre se lit à droite.',
                    )
                  : h(MissionList, {
                      groups: queueGroups,
                      selectedId: '',
                      sessionsFor,
                      onSelect: () => {},
                      queuedIds,
                      blockers: fileBlocked,
                      dragMode: true,
                      onDragStart: (mission) => startDrag('source', mission.id),
                      onDragEnd: endDrag,
                    }),
                h(
                  'p',
                  { className: 'dm-foot' },
                  `${data?.archived ?? 0} clôturées dans `,
                  h('code', {}, `${data?.displayRoot ?? '~/konoha/missions'}/archives`),
                ),
              ),
              h(
                'div',
                {
                  className: 'dm-qcol dm-qcol-queue',
                  onDragOver: (event) => event.preventDefault(),
                  onDrop: (event) => {
                    event.preventDefault()
                    dropOnQueue(queued.length)
                  },
                },
                h(
                  'div',
                  { className: 'dm-qhead' },
                  h('h2', { className: 'dm-qtitle' }, 'En file'),
                  h('span', { className: 'dm-qcount' }, String(queued.length)),
                  h('span', { className: 'dm-qhint' }, 'ordre des rangs · une fiche en revue ou en validation attend un acte, pas son tour'),
                ),
                h(
                  'div',
                  { className: 'dm-qcols' },
                  h('span', {}, 'Rang'),
                  h('span', {}, 'Mission'),
                  h('span', {}, 'Dépôt'),
                  h('span', {}, 'Priorité'),
                  h('span', {}, ''),
                ),
                queued.length === 0
                  ? h('p', { className: 'dm-qempty' }, 'Aucun rang tenu — glissez une mission prête ici pour ordonner la file.')
                  : h(
                      'div',
                      { className: 'dm-qlist', role: 'list' },
                      queued.map((mission, position) =>
                        h(
                          'div',
                          {
                            key: mission.id,
                            role: 'listitem',
                            className: `dm-qrow${position === 0 ? ' dm-first' : ''}${draggingId === mission.id ? ' dm-dragging' : ''}${dropIndex === position ? ' dm-over' : ''}`,
                            draggable: 'true',
                            onDragStart: startDrag('queue', mission.id),
                            onDragEnd: endDrag,
                            onDragOver: (event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              const rect = event.currentTarget.getBoundingClientRect()
                              setDropIndex(position + (event.clientY - rect.top > rect.height / 2 ? 1 : 0))
                            },
                            onDrop: (event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              const rect = event.currentTarget.getBoundingClientRect()
                              dropOnQueue(position + (event.clientY - rect.top > rect.height / 2 ? 1 : 0))
                            },
                          },
                          h('span', { className: 'dm-qrank' }, String(position + 1).padStart(2, '0')),
                          h(
                            'span',
                            { className: 'dm-qbody' },
                            h(
                              'span',
                              { className: 'dm-ql1' },
                              h('span', { className: 'dm-mid' }, mission.id),
                              mission.repo ? h('span', { className: 'dm-repo' }, repoLabel(mission.repo)) : null,
                            ),
                            h('span', { className: 'dm-ql2' }, mission.title || '—'),
                            fileBlocked[mission.id] && planStates.get(mission.id) === 'blocked'
                              ? h('span', { className: 'dm-qwait' }, `attend ${fileBlocked[mission.id]}`)
                              : null,
                          ),
                          h('span', { className: 'dm-qdepot' }, repoLabel(mission.repo) || '—'),
                          h(
                            'span',
                            { className: 'dm-qprio' },
                            mission.priority
                              ? h('span', { className: 'dm-flag', 'data-priority': mission.priority }, priorityLabel(mission.priority))
                              : null,
                          ),
                          h(
                            'button',
                            { type: 'button', className: 'dm-qdel', title: 'Retirer de la file', onClick: () => removeFromQueue(mission.id) },
                            '×',
                          ),
                        ),
                      ),
                    ),
                h(
                  'p',
                  { className: 'dm-qnote' },
                  'Le rang ordonne la file ; il ne dit pas qui part. Valider l’exécution ouvre, dans la limite des sessions libres, une session par fiche prête de la file dont la devancière n’attend plus rien, et y envoie aussitôt le go. Seules les fiches prêtes attendent leur tour : une fiche partie, en revue ou en attente de validation quitte la file — elle n’attend plus un tour mais un acte. Une clôture recalcule la suite.',
                ),
              ),
            ),
          ),
        )
      }

      const launchMission = async (mission, workspace) => {
        const entry = { id: mission.id, sessionId: '', archived: '', error: '' }
        try {
          if (!workspace) {
            throw new Error(missingWorkspaceMessage(mission.type, data))
          }
          const sessions = services?.getService?.('sessions')
          if (!sessions?.create || !sessions?.using) throw new Error('Service sessions indisponible dans cet écran.')
          const attached = attachedSessionId(sessionsFor(mission.id))
          if (attached) {
            const ui = services?.getService?.('uiWorkspace')
            if (!ui?.archiveSession) throw new Error('Service uiWorkspace indisponible : session existante non archivée.')
            await ui.archiveSession(attached, { stopActivity: true })
            entry.archived = attached
          }
          const sessionId = await sessions.create({ workspaceId: workspace.workspaceId })
          entry.sessionId = sessionId
          await fetch(new URL(LINK_URL, document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ missionId: mission.id, sessionId }),
          })
          const sent = await sessions.using(sessionId, { source: 'missions' }, async (reference) => {
            const opened = reference.binding.session.getSnapshot()
            if (opened.openState !== 'open') {
              throw opened.openError ?? new Error(`La session de ${mission.id} ne s’est pas ouverte.`)
            }
            return reference.binding.session.prompt([{ type: 'text', text: goPrompt(mission, data) }], 'queue')
          })
          if (!sent?.ok) throw new Error(sent?.error?.message || 'Envoi du go refusé par la session.')
          bumpSessions()
        } catch (error) {
          entry.error = errorMessage(error)
        }
        return entry
      }

      const validatePlan = async () => {
        if (!plan) return
        setQueueError('')
        setPlanBanner(null)
        const openable = budget.open
        if (openable.length === 0) {
          setPlanBanner({
            entries: [],
            limit: runningLimit,
            running: runningCount,
            deferred: plan.executable?.length ?? 0,
            blocked: 'limit',
          })
          return
        }
        setPlanBusy(true)
        try {
          const response = await fetch(new URL(PLAN_URL, document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ ids: openable }),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || !body?.ok) throw new Error(body?.error?.message || `HTTP ${response.status}`)
          const opened = Array.isArray(body.value?.opened) ? body.value.opened : []
          const entries = []
          const banner = { entries, limit: runningLimit, running: runningCount, deferred: budget.deferred.length }
          for (const id of opened) {
            const mission = missions.find((item) => item.id === id) ?? { id }
            const target = executionWorkspace(services?.getService?.('workspaces')?.list?.getSnapshot?.(), data, mission.type)
            entries.push(await launchMission(mission, target))
            setPlanBanner({ ...banner, entries: [...entries] })
          }
          if (opened.length === 0) setPlanBanner({ ...banner, entries: [] })
          await load()
        } catch (error) {
          setQueueError(errorMessage(error))
        } finally {
          setPlanBusy(false)
        }
      }

      const planStateLabel = {
        runnable: 'exécutable maintenant',
        blocked: 'bloquée',
        running: 'en cours',
      }

      if (view === 'plan') {
        const nodes = Array.isArray(plan?.nodes) ? plan.nodes : []
        const PLAN_LABELW = 150
        const PLAN_COLW = 610
        const PLAN_GAP = 22
        const PLAN_BOXW = 548
        const PLAN_BOXH = 54
        const PLAN_START = 72
        const nodeMission = (id) => missionById.get(id) ?? null
        const columnOf = (node) => {
          if (node.state === 'runnable') return 0
          if (node.state === 'blocked') return node.wave === 2 ? 1 : 2
          return 2
        }
        const repos = []
        for (const node of nodes) {
          const repo = nodeMission(node.id)?.repo ?? ''
          if (!repos.includes(repo)) repos.push(repo)
        }
        const rowsByRepo = repos.map((repo) => nodes.filter((node) => (nodeMission(node.id)?.repo ?? '') === repo))
        const rowHeights = rowsByRepo.map((list) => {
          const counts = [0, 1, 2].map((column) => list.filter((node) => columnOf(node) === column).length)
          return Math.max(1, ...counts) * (PLAN_BOXH + 16) + 20
        })
        const rowTop = []
        let cursor = PLAN_START
        for (const height of rowHeights) {
          rowTop.push(cursor)
          cursor += height
        }
        const width = PLAN_LABELW + 3 * PLAN_COLW + 2 * PLAN_GAP + 20
        const height = cursor + 8
        const xOf = (column) => PLAN_LABELW + column * (PLAN_COLW + PLAN_GAP) + 8
        const positions = new Map()
        rowsByRepo.forEach((list, row) => {
          const seen = [0, 0, 0]
          for (const node of list) {
            const column = columnOf(node)
            positions.set(node.id, { x: xOf(column), y: rowTop[row] + 10 + seen[column] * (PLAN_BOXH + 16) })
            seen[column] += 1
          }
        })
        const edges = []
        for (const node of nodes) {
          for (const entry of plan?.blockedBy?.[node.id] ?? []) {
            const from = positions.get(entry.id)
            const to = positions.get(node.id)
            if (from && to) edges.push({ key: `${entry.id}->${node.id}`, from, to })
          }
        }
        const selectedNode = nodes.find((node) => node.id === planSelect) ?? nodes[0] ?? null
        const selectedMission = selectedNode ? nodeMission(selectedNode.id) : null
        const blockers = selectedNode ? plan?.blockedBy?.[selectedNode.id] ?? [] : []
        const blocked = selectedNode ? plan?.blocks?.[selectedNode.id] ?? [] : []
        const titleOf = (id) => nodeMission(id)?.title ?? id
        return h(
          'div',
          { className: 'dsh-missions' },
          h(Panel, null,
            h(PanelHead, {
              title: 'Ordonnancement',
              sub: `${countLabel(queued.length, 'mission', 'missions')} en file · ${plan?.executable?.length ?? 0} exécutables maintenant · ${sessionsCounter(runningCount, runningLimit, outsideRunning)} · la validation ouvre la première vague dans la limite des sessions libres`,
              children: [
                planBanner
                  ? h(
                      'div',
                      { className: 'dm-planbanner', role: 'status' },
                      h('p', { className: 'dm-planbanner-head' }, planBannerHead(planBanner.entries, planBanner.blocked)),
                      planLimitNote(planBanner)
                        ? h(
                            'p',
                            { className: 'dm-planbanner-note', 'data-blocked': planBanner.blocked === 'limit' ? 'true' : undefined },
                            planLimitNote(planBanner),
                          )
                        : null,
                      planBanner.entries.map((entry) =>
                        h(
                          'p',
                          { className: 'dm-planline', 'data-error': entry.error ? 'true' : undefined },
                          entry.error
                            ? `${entry.id} · non lancée · ${entry.error}`
                            : `${entry.id} · session lancée${entry.archived ? ' · session précédente archivée' : ''}`,
                        ),
                      ),
                    )
                  : null,
                queueError ? h('p', { className: 'dm-notice', role: 'alert' }, queueError) : null,
              ],
              actions: [
                h(PanelStat, { children: sessionAge(data?.generatedAt) }),
                h(PanelButton, { onClick: reload, disabled: planBusy || queueBusy, children: 'Rafraîchir' }),
              ],
            }),
            vueTabs('plan'),
            h(PanelToolbar, null,
              h(PanelButton, { onClick: reload, disabled: planBusy || queueBusy, children: 'Réordonnancer' }),
              h(PanelButton, {
                primary: true,
                onClick: validatePlan,
                disabled: planBusy || queueBusy || !(plan?.executable?.length),
                children: planBusy ? 'Validation…' : 'Valider l’exécution',
              })),
            h(
              'div',
              { className: 'dm-plan' },
              h(
                'div',
                { className: 'dm-planvis' },
                h(
                  'div',
                  { className: 'dm-planlegend' },
                  h('span', { className: 'dm-legend', 'data-state': 'runnable' }, 'exécutable maintenant'),
                  h('span', { className: 'dm-legend', 'data-state': 'blocked' }, 'bloquée par une autre mission'),
                ),
                h(
                  'div',
                  { className: 'dm-planroot', style: { width: `${width}px`, height: `${height}px` } },
                  ['Dépôt', 'Maintenant', 'Ensuite', 'En attente'].map((label, index) =>
                    h(
                      'span',
                      {
                        key: label,
                        className: 'dm-plancol',
                        style: { left: index === 0 ? '0px' : `${xOf(index - 1)}px`, top: '22px' },
                      },
                      label,
                    ),
                  ),
                  h(
                    'svg',
                    { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' },
                    edges.map((edge) =>
                      h('path', {
                        key: edge.key,
                        d: `M ${edge.from.x + PLAN_BOXW} ${edge.from.y + PLAN_BOXH / 2} C ${edge.from.x + PLAN_BOXW + 46} ${edge.from.y + PLAN_BOXH / 2}, ${edge.to.x - 46} ${edge.to.y + PLAN_BOXH / 2}, ${edge.to.x} ${edge.to.y + PLAN_BOXH / 2}`,
                      }),
                    ),
                  ),
                  repos.map((repo, row) =>
                    h(
                      'span',
                      { key: `repo-${repo || row}`, className: 'dm-planrepo', style: { top: `${rowTop[row] + 24}px` } },
                      repoLabel(repo) || '—',
                    ),
                  ),
                  nodes.map((node) => {
                    const position = positions.get(node.id)
                    if (!position) return null
                    const mission = nodeMission(node.id) ?? { id: node.id, title: '' }
                    return h(
                      'button',
                      {
                        key: node.id,
                        type: 'button',
                        className: `dm-plannode${planSelect === node.id ? ' on' : ''}`,
                        'data-state': node.state,
                        style: {
                          left: `${position.x}px`,
                          top: `${position.y}px`,
                          width: `${PLAN_BOXW}px`,
                          height: `${PLAN_BOXH}px`,
                        },
                        onClick: () => setPlanSelect(node.id),
                      },
                      h(
                        'span',
                        { className: 'dm-planl1' },
                        h('span', { className: 'dm-mid' }, mission.id),
                        mission.priority
                          ? h('span', { className: 'dm-flag', 'data-priority': mission.priority }, priorityLabel(mission.priority))
                          : null,
                        h('span', { className: 'dm-planstate' }, planStateLabel[node.state] ?? node.state),
                      ),
                      h('span', { className: 'dm-plantitle' }, mission.title || '—'),
                    )
                  }),
                ),
              ),
              h(
                'div',
                { className: 'dm-plandetail' },
                h(
                  'div',
                  { className: 'dm-plancard' },
                  h('h3', {}, 'Détail'),
                  selectedNode
                    ? h(
                        'div',
                        {},
                        h('p', { className: 'dm-planrow' }, h('b', {}, 'État'), planStateLabel[selectedNode.state] ?? selectedNode.state),
                        h(
                          'p',
                          { className: 'dm-planrow' },
                          h('b', {}, 'Mission'),
                          `${selectedMission?.id ?? selectedNode.id} — ${selectedMission?.title ?? ''}`,
                        ),
                        h('p', { className: 'dm-planrow' }, h('b', {}, 'Dépôt'), repoLabel(selectedMission?.repo) || '—'),
                        h(
                          'p',
                          { className: 'dm-planrow' },
                          h('b', {}, 'Rang dans la file'),
                          selectedMission?.queue ? String(selectedMission.queue).padStart(2, '0') : '—',
                        ),
                        h(
                          'p',
                          { className: 'dm-planrow' },
                          h('b', {}, 'Bloque'),
                          blocked.length ? blocked.map((id) => titleOf(id)).join(' · ') : 'Aucune mission',
                        ),
                        h(
                          'p',
                          { className: 'dm-planrow' },
                          h('b', {}, 'Bloquée par'),
                          blockers.length
                            ? blockers.map((entry) => `${titleOf(entry.id)} (${CAUSE_LABELS[entry.cause] ?? entry.cause})`).join(' · ')
                            : 'Aucune mission — peut partir maintenant',
                        ),
                      )
                    : h('p', { className: 'dm-plannote' }, 'Aucune mission en file.'),
                ),
                h(
                  'div',
                  { className: 'dm-plancard' },
                  h('h3', {}, 'Ce que fait « Valider l’exécution »'),
                  h(
                    'p',
                    { className: 'dm-plannote' },
                    'Ouvre la première vague dans la limite des sessions libres : une session par mission exécutable, sans nouveau go. Les missions reportées restent en file ; le plan est figé au journal des missions ouvertes, et une clôture recalcule la suite.',
                  ),
                ),
              ),
            ),
          ),
        )
      }

      if (view === 'performance') {
        return h(
          'div',
          { className: 'dsh-missions' },
          h(Panel, null,
            h(PanelHead, {
              title: 'Performance',
              sub: 'semaine, mois, Timeline et bilan du jour · lecture seule des missions, sessions, git et Jira',
              actions: [
                h(PanelStat, { children: sessionAge(data?.generatedAt) }),
                h(PanelButton, { onClick: reload, disabled: busy, children: 'Rafraîchir' }),
              ],
            }),
            vueTabs('performance'),
            h('iframe', {
              className: 'dm-pframe',
              src: '/performance/panel',
              title: 'Performance — semaine, mois, Timeline et bilan du jour',
            }),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsh-missions' },
        h(Panel, null,
          h(PanelHead, {
            title: 'Missions',
            sub: `${missions.length} ouvertes · ${visible.length} affichées · ${data?.archived ?? 0} clôturées`,
            children: [
              priorityError || statusError || sessionError
                ? h('p', { className: 'dm-notice', role: 'alert' }, priorityError || statusError || sessionError)
                : null,
              state.error ? h('p', { className: 'dm-notice', role: 'alert' }, panelNotice(state)) : null,
            ],
            actions: [
              h(PanelStat, { children: sessionAge(data?.generatedAt) }),
              h(PanelButton, { onClick: reload, disabled: busy, children: 'Rafraîchir' }),
            ],
          }),
          vueTabs('list'),
          h(
            'div',
            { className: 'dm-split' },
            h(
              'div',
              { className: 'dm-col dm-col-list' },
              searchBlock,
              ...filtersBlock,
              visible.length === 0
                ? h('p', { className: 'dm-sheet-note dm-empty-list' }, emptyNotice(filter, epicFilter, query, sessionFilter))
                : h(MissionList, { groups, selectedId, sessionsFor, onSelect: openMissionFile }),
              h(MissionListFooter, {
                archived: data?.archived,
                root: data?.displayRoot,
                open: newMissionOpen,
                busy: newMissionBusy,
                onToggle: setNewMissionOpen,
                onPick: startNewMission,
              }),
            ),
            h(
              'div',
              { className: 'dm-col dm-col-detail' },
              sheet
                ? sheet.phase === 'error'
                  ? h(
                      'div',
                      { className: 'dm-empty' },
                      h('p', { className: 'dm-sheet-note' }, `Fiche indisponible : ${sheet.error}`),
                      h(PanelButton, { onClick: () => openMissionFile(sheet.mission), children: 'Réessayer' }),
                    )
                  : h(MissionSheet, {
                      mission: current,
                      sheet,
                      sessions: sessionsFor(sheet.id),
                      tab,
                      busy: saving,
                      onSelectTab: selectTab,
                      onClose: closeSheet,
                    })
                : h(
                    'p',
                    { className: 'dm-empty' },
                    visible.length === 0
                      ? 'Aucune mission à afficher avec ces filtres.'
                      : `${countLabel(visible.length, 'mission', 'missions')} — sélectionne une mission pour lire sa fiche, son journal et sa checklist.`,
                  ),
            ),
            current
              ? h(ContextColumn, {
                  mission: current,
                  sessions: sessionsFor(current.id),
                  sheet,
                  plan: state.data?.plan ?? null,
                  busy,
                  onNew: startSession,
                  onPickSession: openLinkedSession,
                  priorityMenuOpen: priorityMenu,
                  statusMenuOpen: statusMenu,
                  onPriorityMenu: (next) => {
                    setPriorityMenu(next)
                    if (next) setStatusMenu(false)
                  },
                  onStatusMenu: (next) => {
                    setStatusMenu(next)
                    if (next) setPriorityMenu(false)
                  },
                  onPickPriority: pickPriority,
                  onPickStatus: pickStatus,
                })
              : h('aside', { className: 'dm-col dm-col-ctx' }),
          ),
        ),
      )
    }

    function formFor(ctx) {
      try {
        const forms = ctx?.get?.('configForms')
        const form = forms?.get?.(CONFIG_ENTRY)
        return form && typeof form.getSnapshot === 'function' ? form : null
      } catch {
        return null
      }
    }

    function ReglagesPanel(props) {
      const form = React.useMemo(() => formFor(props.ctx), [props.ctx])
      const subscribe = React.useCallback((listener) => (form ? form.subscribe(listener) : () => {}), [form])
      const snapshotOf = React.useCallback(() => (form ? form.getSnapshot() : null), [form])
      const snapshot = React.useSyncExternalStore(subscribe, snapshotOf, snapshotOf)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const value = snapshot?.value?.maxRunningSessions

      React.useEffect(() => {
        if (!snapshot || snapshot.status === 'loading') {
          return
        }
        setDraft((current) => current ?? (value === undefined || value === null ? '' : String(value)))
      }, [snapshot, value])

      if (props.view === 'summary') {
        return h('span', {}, `Réglages du panneau Missions : la validation ouvre au plus ${value ?? DEFAULT_RUNNING_LIMIT} sessions en cours.`)
      }

      const disabled = busy || !form || snapshot?.writable === false

      const save = async () => {
        if (!form) {
          return
        }
        const raw = String(draft ?? '').trim()
        if (raw === '') {
          setMessage(`Saisir un nombre entier entre ${MIN_RUNNING_LIMIT} et ${MAX_RUNNING_LIMIT}.`)
          return
        }
        const limit = Number(raw)
        if (!Number.isInteger(limit) || limit < MIN_RUNNING_LIMIT || limit > MAX_RUNNING_LIMIT) {
          setMessage(`Saisir un nombre entier entre ${MIN_RUNNING_LIMIT} et ${MAX_RUNNING_LIMIT}.`)
          return
        }
        if (String(limit) === String(value ?? '')) {
          setMessage('Aucun changement.')
          return
        }
        setBusy(true)
        setMessage('')
        try {
          const ok = await form.mutate([{ op: 'set', path: ['maxRunningSessions'], value: limit }])
          setMessage(ok ? 'Limite enregistrée.' : 'Écriture refusée ; rechargez la page.')
        } catch (error) {
          setMessage(error?.message ?? 'Écriture impossible.')
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        if (!form) {
          return
        }
        setBusy(true)
        setMessage('')
        try {
          const ok = await form.mutate([{ op: 'unset', path: ['maxRunningSessions'] }])
          if (ok) {
            setDraft(null)
          }
          setMessage(ok ? 'Défaut rétabli.' : 'Écriture refusée ; rechargez la page.')
        } catch (error) {
          setMessage(error?.message ?? 'Écriture impossible.')
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dm-cfg' },
        h(
          'p',
          { className: 'dm-cfg-intro' },
          'Combien de sessions la validation de la file peut ouvrir en même temps. Enregistré dans le patch du profil, sous l’entrée « missions ».',
        ),
        form ? null : h('p', { className: 'dm-cfg-hint' }, 'Les formulaires de configuration ne sont pas disponibles dans cette installation.'),
        h(
          'label',
          { className: 'dm-cfg-field' },
          h('span', { className: 'dm-cfg-label' }, 'Sessions en cours par validation'),
          h('input', {
            className: 'dm-cfg-input',
            type: 'number',
            min: MIN_RUNNING_LIMIT,
            max: MAX_RUNNING_LIMIT,
            step: 1,
            disabled,
            value: draft ?? '',
            onChange: (event) => setDraft(event.target.value),
          }),
          h(
            'span',
            { className: 'dm-cfg-hint' },
            `Les missions au-delà de ${value ?? DEFAULT_RUNNING_LIMIT} sessions restent dans la file et repartent à la validation suivante.`,
          ),
        ),
        h(
          'div',
          { className: 'dm-cfg-actions' },
          h(PanelButton, { primary: true, disabled, onClick: save, children: busy ? 'Enregistrement…' : 'Enregistrer' }),
          h(PanelButton, { disabled, onClick: reset, children: 'Rétablir le défaut' }),
          message ? h('span', { className: 'dm-cfg-msg' }, message) : null,
        ),
      )
    }

    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-missions'
        style.textContent = CSS
        document.head.append(style)
        return () => style.remove()
      })
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'missions',
            order: -20,
            label: 'Missions',
          },
          MissionsGlyph,
        ),
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'missions',
            inject: () => ({
              services: {
                getService: (name) => ctx.get(name),
              },
            }),
          },
          MissionsPanel,
        ),
      )
      for (const seat of [
        { name: 'plugins.bundle.config', key: CONFIG_PKG },
        { name: 'plugins.row.config', key: `${CONFIG_PKG}#${CONFIG_ENTRY}` },
      ]) {
        ctx.slots.inject(seat.name, () => ctx.slots.register({ ...seat, inject: () => ({ ctx }) }, ReglagesPanel))
      }
    }

    exports.inject = ['slots']
    exports.sortMissions = sortMissions
    exports.STATUS_ORDER = STATUS_ORDER
    exports.STATUS_LABEL = STATUS_LABEL
    exports.SHEET_TABS = SHEET_TABS
    exports.canChangeStatus = canChangeStatus
    exports.statusChoices = statusChoices
    exports.statusLabel = statusLabel
    exports.statusFilterOptions = statusFilterOptions
    exports.queueCandidates = queueCandidates
    exports.queueFile = queueFile
    exports.priorityLabel = priorityLabel
    exports.missionPrompt = missionPrompt
    exports.goPrompt = goPrompt
    exports.newMissionPrompt = newMissionPrompt
    exports.newMissionTypes = NEW_MISSION_TYPES
    exports.NewMissionMenu = NewMissionMenu
    exports.MissionListFooter = MissionListFooter
    exports.planBannerHead = planBannerHead
    exports.effectiveLimit = effectiveLimit
    exports.bareSessionId = bareSessionId
    exports.runningRows = runningRows
    exports.sessionBudget = sessionBudget
    exports.sessionsCounter = sessionsCounter
    exports.planLimitNote = planLimitNote
    exports.ReglagesPanel = ReglagesPanel
    exports.attachedSessionId = attachedSessionId
    exports.nextStep = nextStep
    exports.sessionControl = sessionControl
    exports.groupMissions = groupMissions
    exports.filterMissions = filterMissions
    exports.searchMissions = searchMissions
    exports.searchTokens = searchTokens
    exports.matchesQuery = matchesQuery
    exports.normalizeQuery = normalizeQuery
    exports.epicOptions = epicOptions
    exports.readFilterValue = readFilterValue
    exports.storeFilterValue = storeFilterValue
    exports.withStoredValue = withStoredValue
    exports.FILTER_MEMORY_KEYS = {
      search: SEARCH_KEY,
      status: STATUS_FILTER_KEY,
      priority: PRIORITY_FILTER_KEY,
      epic: EPIC_FILTER_KEY,
      session: SESSION_FILTER_KEY,
    }
    exports.emptyNotice = emptyNotice
    exports.FilterMenu = FilterMenu
    exports.FilterList = FilterList
    exports.partInfo = partInfo
    exports.readFacts = readFacts
    exports.MissionItem = MissionItem
    exports.MissionList = MissionList
    exports.ContextColumn = ContextColumn
    exports.missionsWorkspace = missionsWorkspace
    exports.productWorkspace = productWorkspace
    exports.executionWorkspace = executionWorkspace
    exports.missingWorkspaceMessage = missingWorkspaceMessage
    exports.unionSessionIds = unionSessionIds
    exports.MissionSheet = MissionSheet
    exports.MissionsPanel = MissionsPanel
    exports.MissionsGlyph = MissionsGlyph
    exports.readStored = readStored
    exports.writeStored = writeStored
    exports.storedSnapshot = storedSnapshot
    exports.initialState = initialState
    exports.panelNotice = panelNotice

    return exports
  },
})
