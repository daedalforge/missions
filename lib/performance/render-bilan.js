import { esc } from './render-common.js'
import { registryMarkdown } from './bilan.js'

const CAUSES = ['moi', 'tiers', 'dépendance', 'spec']

function figure(label, value, hint = '') {
  return `<div class="billfig"><span class="billfig-l">${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<span class="billfig-h">${esc(hint)}</span>` : ''}</div>`
}

function euros(value) {
  return `${(Number(value) || 0).toFixed(2).replace('.', ',')} $`
}

function inflightRow(row) {
  const depend = row.depend?.length ? `attend ${esc(row.depend.join(', '))}` : '—'
  return `<tr><td><a href="${esc(row.href)}">${esc(row.id)}</a></td><td>${esc(row.title)}</td><td>${esc(row.status)}</td><td>${row.days == null ? '—' : `${row.days} j`}</td><td>${depend}</td></tr>`
}

function blockerRow(blocker) {
  const options = CAUSES.map((cause) => `<option value="${esc(cause)}"${cause === blocker.cause ? ' selected' : ''}>${esc(cause)}</option>`).join('')
  return `<tr data-blocker="${esc(blocker.id)}">
    <td>${esc(blocker.id)}</td>
    <td><span class="btitle">${esc(blocker.title)}</span><span class="bmeta">${esc(blocker.status)}${blocker.days == null ? '' : ` · ${blocker.days} j`}</span></td>
    <td><select data-field="cause">${options}</select></td>
    <td><input data-field="action" value="${esc(blocker.action)}"></td>
    <td><input data-field="due" type="date" value="${esc(blocker.due)}"></td>
    <td><input data-field="owner" value="${esc(blocker.owner)}"></td>
  </tr>`
}

export function renderBilan(day) {
  const blockers = day.blockers.length
    ? `<table class="btable"><thead><tr><th>Mission</th><th>État</th><th>Cause</th><th>Action</th><th>Échéance</th><th>Propriétaire</th></tr></thead><tbody>${day.blockers.map(blockerRow).join('')}</tbody></table>`
    : `<p class="pnote">Aucun blocage détecté : l'attente n'est pas mesurable ou il n'y en a pas.</p>`
  const inflight = day.inflight.length
    ? `<table class="btable"><thead><tr><th>Mission</th><th>Titre</th><th>État</th><th>Dans l'état</th><th>Attend</th></tr></thead><tbody>${day.inflight.map(inflightRow).join('')}</tbody></table>`
    : `<p class="pnote">Rien en vol.</p>`
  const EPIC_VIEWS = ['done-missions', 'dev-missions', 'done-points', 'dev-points']
  const epicRows = (day.epics ?? []).map((epic) => {
    const label = String(epic.title ?? '').replace(/^[A-Z]{2,}-\d+\s*[\u2014\u2013-]\s*/, '')
    const pointsDone = epic.points?.done ?? 0
    const pointsDev = epic.points?.dev ?? pointsDone
    const pointsTotal = epic.points?.total ?? 0
    const missionsDone = epic.missions?.done ?? 0
    const missionsDev = epic.missions?.dev ?? missionsDone
    const missionsTotal = epic.missions?.total ?? 0
    const pct = {
      'done-missions': Math.round((epic.rateMissions ?? 0) * 100),
      'dev-missions': Math.round((epic.rateMissionsDev ?? 0) * 100),
      'done-points': Math.round((epic.rate ?? 0) * 100),
      'dev-points': Math.round((epic.rateDev ?? epic.rate ?? 0) * 100),
    }
    const detail = {
      'done-missions': `${missionsDone} / ${missionsTotal} missions · reste ${missionsTotal - missionsDone}`,
      'dev-missions': `${missionsDev} / ${missionsTotal} missions · reste ${missionsTotal - missionsDev}`,
      'done-points': `${pointsDone} / ${pointsTotal} pts · reste ${pointsTotal - pointsDone}`,
      'dev-points': `${pointsDev} / ${pointsTotal} pts · reste ${pointsTotal - pointsDev}`,
    }
    const bars = EPIC_VIEWS.map(
      (view) =>
        `<i class="epicvar" data-view="${view}" style="width:${Math.max(2, pct[view])}%;display:${view === 'dev-missions' ? 'block' : 'none'}"></i>`,
    ).join('')
    const rates = EPIC_VIEWS.map(
      (view) =>
        `<b class="epicvar" data-view="${view}" style="display:${view === 'dev-missions' ? 'inline' : 'none'}">${pct[view]} %</b>`,
    ).join('')
    const details = EPIC_VIEWS.map(
      (view) =>
        `<span class="epicvar epicdim" data-view="${view}" style="display:${view === 'dev-missions' ? 'inline' : 'none'}">${detail[view]}</span>`,
    ).join('')
    return `<tr><td><b class="mono">${esc(epic.key)}</b></td><td>${esc(label)}</td><td><div class="epicbar2">${bars}</div></td><td>${rates}</td><td>${details}</td></tr>`
  }).join('')
  const epics = epicRows
    ? `<table class="btable epictab" data-epic-rows><thead><tr><th style="width:14%">Epic</th><th>Titre</th><th style="width:22%">Avancement</th><th style="width:10%">Taux</th><th>Détail</th></tr></thead><tbody>${epicRows}</tbody></table>`
    : `<p class="pnote">Aucune epic cadrée.</p>`
  const night = day.night.map((line) => esc(line)).join('\n')
  const tomorrow = day.tomorrow.map((line) => esc(line)).join('\n')
  const markdown = registryMarkdown(day)
  return `<section class="view active bilan-view" data-view="bilan" data-date="${esc(day.date)}" data-figures="${esc(JSON.stringify(day.figures))}" data-saved="${esc(day.updatedAt ?? '')}">
<style>
.bilan-view{flex:1;min-height:0;overflow:auto}
.bilanwrap{padding:22px 26px;max-width:1180px;box-sizing:border-box}
.bilanhead{display:flex;align-items:baseline;gap:14px;margin-bottom:16px}
.bilanhead h1{font-size:19px;margin:0}
.bilanhead .bsub{color:var(--dsw-alias-fg-3,#8ba39d);font-size:12px}
.bilanhead .grow{flex:1}
.bilansave{font-size:11px;color:var(--dsw-alias-fg-3,#8ba39d)}
.billfigs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:10px 0 18px}
.billfig{border:1px solid #E0E0E0;border-radius:4px;padding:9px 11px;background:var(--dsw-alias-bg-2,#0b1614)}
.billfig strong{display:block;font-size:20px;font-weight:600;line-height:1.3}
.billfig-l{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-fg-3,#8ba39d)}
.billfig-h{font-size:11px;color:var(--dsw-alias-fg-3,#8ba39d)}
.bilsector{margin:0 0 18px}
.bilsector h2{font-size:13px;margin:0 0 7px;letter-spacing:.02em}
.bilsector .bnote{font-size:11px;color:var(--dsw-alias-fg-3,#8ba39d);margin:0 0 8px}
.btable{width:100%;border-collapse:collapse;font-size:12px}
.btable th,.btable td{text-align:left;padding:5px 7px;border-bottom:1px solid rgba(224,224,224,.18);vertical-align:middle}
.btable th{font-size:11px;color:var(--dsw-alias-fg-3,#8ba39d);font-weight:500}
.btable input,.btable select{width:100%;background:transparent;border:1px solid rgba(224,224,224,.28);border-radius:3px;padding:3px 5px;color:inherit;font:inherit}
.btable .btitle{display:block}
.btable .bmeta{display:block;font-size:11px;color:var(--dsw-alias-fg-3,#8ba39d)}
.bilfield{width:100%;background:var(--dsw-alias-bg-2,#0b1614);border:1px solid rgba(224,224,224,.28);border-radius:4px;padding:7px 9px;color:inherit;font:inherit;font-size:12px;resize:vertical}
.bilcols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.bilacts{display:flex;gap:8px;align-items:center;margin-top:6px}
.bilacts .grow{flex:1}
.bilerr{color:#ED6D02;font-size:11px}
.epictab .epicbar2{height:6px;border-radius:4px;background:rgba(224,224,224,.25);overflow:hidden;min-width:70px;margin-top:3px}
.epictab .epicbar2 i{display:block;height:100%;background:#23A6D9}
.epictab b.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-weight:500;font-size:11.5px}
.epicmodes{display:inline-flex;gap:6px;vertical-align:middle;margin-left:8px}
.epicmode{display:inline-flex;border:1px solid rgba(224,224,224,.35);border-radius:999px;overflow:hidden;font-size:11px}
.epicmode button{background:transparent;border:0;padding:2px 9px;color:var(--dsw-alias-fg-3,#8ba39d);cursor:pointer;font:inherit}
.epicmode button.on{background:rgba(35,166,217,.14);color:inherit}
.epicdim{color:var(--dsw-alias-fg-3,#6f8a84)}
.epictab .epicbar2 i[data-view^="dev"]{background:#4ec38b}
</style>
<div class="bilanwrap">
  <div class="bilanhead">
    <h1>Bilan du jour</h1>
    <span class="bsub">${esc(day.date)} · protocole 15 min</span>
    <span class="grow"></span>
    <span class="bilansave" data-saved>${day.updatedAt ? 'enregistré' : 'non enregistré'}</span>
    <a class="btn-o" href="/performance/panel">Panneau</a>
  </div>

  <div class="billfigs">
    ${figure('Fusions', day.figures.merged, 'PR fusionnées')}
    ${figure('Livré', day.figures.delivered, 'missions closes')}
    ${figure('En vol', day.figures.inflight, 'missions actives')}
    ${figure('En attente', day.figures.waiting, 'missions à l’arrêt')}
    ${figure('Coût', euros(day.figures.cost), 'jour')}
  </div>

  <div class="bilsector">
    <h2>Avancement par epic <span class="epicmodes"><span class="epicmode" data-epic-base><button type="button" class="on" data-base="missions">Missions</button><button type="button" data-base="points">Points</button></span><span class="epicmode" data-epic-mode><button type="button" data-mode="done">Terminé</button><button type="button" class="on" data-mode="dev">Développement terminé</button></span></span></h2>
    <p class="bnote">Base <b>missions</b> : part des missions qui portent des points sur toutes les missions cadrées de l'epic ; base <b>points</b> : part des story points livrés. <b>Terminé</b> compte les missions closes ; <b>développement terminé</b> y ajoute celles en review, en peer review et à valider. Le périmètre grandit à chaque cadrage : un ajout fait reculer le taux.</p>
    ${epics}
  </div>

  <div class="bilsector">
    <h2>1. En vol</h2>
    <p class="bnote">Une phrase par mission : état, jours dans l'état, ce qu'elle attend.</p>
    ${inflight}
  </div>

  <div class="bilsector">
    <h2>2. Blocages</h2>
    <p class="bnote">Quatre causes : moi, tiers, dépendance, spec. Une action datée, un seul propriétaire.</p>
    ${blockers}
  </div>

  <div class="bilsector">
    <h2>3. Décision</h2>
    <textarea class="bilfield" data-field="decision" rows="2" placeholder="Une seule décision, celle qui débloque le plus de travail en attente.">${esc(day.decision)}</textarea>
  </div>

  <div class="bilsector">
    <h2>4. La nuit et le lendemain</h2>
    <p class="bnote">Une ligne par action. La nuit exécute sans go ; le lendemain demande un go, une relecture ou une fusion.</p>
    <div class="bilcols">
      <div><label class="bnote">Nuit — l'agent, sans go</label><textarea class="bilfield" data-field="night" rows="5">${night}</textarea></div>
      <div><label class="bnote">Lendemain — le principal</label><textarea class="bilfield" data-field="tomorrow" rows="5">${tomorrow}</textarea></div>
    </div>
  </div>

  <div class="bilacts">
    <button class="btn-brand" data-copy><svg><use href="#i-list"/></svg>Copier le bilan</button>
    <span class="grow"></span>
    <span class="bilerr" data-error></span>
  </div>
  <pre class="bilan-src" hidden>${esc(markdown)}</pre>
</div>
</section>`
}
