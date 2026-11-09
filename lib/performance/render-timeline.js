import { esc, num, percent } from './render-common.js'

const DAY = 86_400_000

const STEP_META = {
  cadrage: { num: '01', chip: 'goulot ①', tone: 'bad', gain: '−1 à 3 j', direction: "Cadrer et faire valider dans la même séance, le soir de l'import." },
  go: { num: '02', chip: 'goulot ②', tone: 'warn', gain: '−1 j', direction: "Ouvrir depuis la fiche ; alerter si une mission validée n'a pas de session au bout d'une heure." },
  exec: { num: '03', chip: 'travail', tone: 'ok', gain: '−30 min', direction: 'Pré-vol avant le go : base, spec et plan figés ; refuser une branche hors base.' },
  review: { num: '04', chip: 'forme', tone: 'warn', gain: '−2 rounds', direction: 'Checklist pré-vol dans le template de review : nommage des tests, contrat Given/When/Then, cas indéterminé.' },
  val: { num: '05', chip: 'goulot ③', tone: 'bad', gain: '−4 passes', direction: "Préparer les missions d'une même vague pour une validation groupée : une lecture, une décision, une passe." },
  close: { num: '06', chip: 'fluide', tone: 'ok', gain: '0', direction: "Rien à changer : c'est la référence à garder." },
}

function span(ms) {
  const minutes = Math.round((Number(ms) || 0) / 60_000)
  if (minutes <= 0) return '—'
  if (minutes < 60) return `${minutes} min`
  const wholeHours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (wholeHours < 24) return rest > 0 ? `${wholeHours} h ${String(rest).padStart(2, '0')}` : `${wholeHours} h`
  const days = Math.floor(wholeHours / 24)
  const hours = wholeHours % 24
  return hours > 0 ? `${days} j ${hours} h` : `${days} j`
}

function dayLabel(ms) {
  return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

function tone(toneName) {
  return toneName === 'bad' ? 'bad' : toneName === 'warn' ? 'warn' : 'ok'
}

function constat(step, data) {
  const total = data.count
  if (step.key === 'cadrage') return `${step.reached}/${total} missions valident leur fiche après ${span(step.median)} en médiane, ${span(step.max)} pour la plus longue.`
  if (step.key === 'go') return `${step.reached}/${total} missions ont attendu la file : ${span(step.median)} en médiane, ${span(step.max)} au pire.`
  if (step.key === 'exec') return `${span(step.mean)} par mission, ${span(step.median)} en médiane ; ${data.reprises} reprises sur la fenêtre.`
  if (step.key === 'review') return `${step.reached}/${total} missions passées en review : ${span(step.median)} en médiane, ${span(step.max)} au pire.`
  if (step.key === 'val') return `${data.waiting} missions en attente maintenant, ${span(data.waitingTotal)} cumulées ; ${span(step.median)} en médiane.`
  return `${step.reached} clôture sur la fenêtre ; le temps de clôture reste hors calcul tant que la mission tourne.`
}

function heroBar(data) {
  const parts = [
    { key: 'cadrage', label: 'Cadrage', cls: 'cad' },
    { key: 'go', label: 'File', cls: 'go' },
    { key: 'val', label: 'Validation', cls: 'val' },
    { key: 'work', label: 'Travail', cls: 'work' },
  ]
  const total = Math.max(1, parts.reduce((sum, part) => sum + (part.key === 'work' ? data.work : data.steps[part.key].mean), 0))
  return parts
    .map((part) => {
      const value = part.key === 'work' ? data.work : data.steps[part.key].mean
      const width = (value / total) * 100
      return `<i class="hseg ${part.cls}" style="width:${Math.max(0.4, width)}%" title="${part.label} · ${span(value)}"></i>`
    })
    .join('')
}

function legend(data) {
  const items = [
    { label: 'Cadrage', value: data.steps.cadrage.mean, share: data.steps.cadrage.share, cls: 'cad' },
    { label: 'File', value: data.steps.go.mean, share: data.steps.go.share, cls: 'go' },
    { label: 'Validation', value: data.steps.val.mean, share: data.steps.val.share, cls: 'val' },
    { label: 'Travail', value: data.work, share: data.workShare, cls: 'work' },
  ]
  return items
    .map((item) => `<span class="hlegi"><i class="sw ${item.cls}"></i>${esc(item.label)} <b>${span(item.value)}</b><span class="hshare">${percent(item.share)}</span></span>`)
    .join('')
}

function alertPills(data) {
  const pills = [
    { tone: 'bad', text: `Goulot ① cadrage · ${span(data.steps.cadrage.mean)} par mission` },
    { tone: 'warn', text: `Goulot ② file · ${span(data.steps.go.mean)} par mission` },
    { tone: 'bad', text: `Goulot ③ validation · ${data.waiting} en attente · ${span(data.waitingTotal)}` },
    { tone: 'warn', text: `${data.reprises} reprises sur la fenêtre` },
    { tone: 'ok', text: data.reference ? `Référence · ${esc(data.reference.id)} close en ${span(data.reference.cycle)}` : 'Aucune clôture sur la fenêtre' },
  ]
  return pills.map((pill) => `<span class="palert ${pill.tone}"><i class="dot ${pill.tone === 'bad' ? 'd-red' : pill.tone === 'warn' ? 'd-amber' : 'd-green'}"></i>${pill.text}</span>`).join('')
}

function kpis(data) {
  const tiles = [
    { cap: 'Cycle moyen', big: span(data.cycle), small: `${data.count} missions`, mini: `médiane ${span(data.cycleMedian)}`, width: Math.min(92, Math.round((data.cycle / Math.max(data.cycle, data.cycleMedian * 2)) * 50)) },
    { cap: "Part d'attente", big: percent(data.waitShare), small: span(data.wait), mini: `travail ${span(data.work)}`, width: Math.min(92, Math.round(data.waitShare * 100)), tone: 'bad' },
    { cap: 'En attente maintenant', big: String(data.waiting), small: 'missions', mini: `${span(data.waitingTotal)} cumulées`, width: Math.min(92, data.waiting * 12), tone: data.waiting > 0 ? 'warn' : '' },
    { cap: 'Reprises', big: String(data.reprises), small: 'sur la fenêtre', mini: 're-cadrages et rollbacks du journal', width: Math.min(92, data.reprises * 12), tone: data.reprises > 0 ? 'warn' : '' },
    { cap: 'Référence fluide', big: data.reference ? span(data.reference.cycle) : '—', small: data.reference ? esc(data.reference.id) : 'aucune', mini: 'mission close dans la fenêtre', width: 40, tone: 'ok' },
  ]
  return `<div class="sysstats mstats tlkpis">${tiles
    .map((tile) => `<div class="syskpi ${tile.tone ?? ''}"><div class="cap">${tile.cap}</div><div class="big">${tile.big}<small>${tile.small}</small></div><div class="mini">${tile.mini}</div><div class="bar"><i style="width:${tile.width}%"></i></div></div>`)
    .join('')}</div>`
}

function hero(data) {
  return `<section class="syscard tlhero">
    <div class="schead"><h3>Le temps d'une mission moyenne</h3><span class="state-pill ${data.waitShare > 0.8 ? 'bad' : 'warn'}"><i class="dot ${data.waitShare > 0.8 ? 'd-red' : 'd-amber'}"></i>${percent(data.waitShare)} en attente</span><span class="tlgrow"></span><span class="tlsub">${data.count} missions produit · ${dayLabel(data.window.from)} → ${dayLabel(data.window.to)}</span></div>
    <div class="herobody">
      <div class="heroside">
        <div class="herobig">${span(data.cycle)}</div>
        <div class="herosub">de cycle moyen, de l'import à la clôture</div>
        <div class="herometa">attente ${span(data.wait)} · travail ${span(data.work)} · ${data.reprises} reprises</div>
      </div>
      <div class="heroplot">
        <div class="hstack">${heroBar(data)}</div>
        <div class="hlegend">${legend(data)}</div>
        <div class="heronote">Le travail (exécution et review) pèse ${percent(data.workShare)} du cycle : le temps d'une mission est d'attente. ${data.waiting > 0 ? `Aujourd'hui, ${data.waiting} missions attendent une décision pour ${span(data.waitingTotal)} cumulées.` : 'Aucune mission en attente de décision.'}</div>
      </div>
    </div>
  </section>`
}

function stageCard(step, data) {
  const meta = STEP_META[step.key] ?? STEP_META.close
  return `<section class="syscard stg">
    <div class="stghead"><span class="stgnum">${meta.num}</span><h3>${esc(step.label)}</h3><span class="state-pill ${tone(meta.tone)}"><i class="dot d-${meta.tone === 'bad' ? 'red' : meta.tone === 'warn' ? 'amber' : 'green'}"></i>${meta.chip}</span><span class="tlsub">${esc(step.hint)}</span></div>
    <div class="stgv">${step.mean > 0 ? span(step.mean) : '0'}<small>en moyenne</small></div>
    <div class="stgmeta">${step.reached}/${data.count} missions · médiane ${span(step.median)} · max ${span(step.max)}</div>
    <div class="stgbar"><i style="width:${Math.min(100, Math.round(step.share * 100))}%"></i><span>${percent(step.share)} du cycle</span></div>
    <div class="stgbody">${esc(constat(step, data))}</div>
    <div class="stgdir"><span class="stglabel">DIRECTION</span>${esc(meta.direction)}</div>
    <div class="stggain">${meta.gain}</div>
  </section>`
}

function reprises(data) {
  if (data.repriseList.length === 0) return ''
  const items = data.repriseList
    .map((event) => `<div class="rline"><span class="rdate">${esc(event.date)}</span><b class="mono">${esc(event.id)}</b><span class="rtitle">${esc(event.title)}</span></div>`)
    .join('')
  return `<section class="syscard reprcard">
    <div class="schead"><h3>Reprises récentes</h3><span class="state-pill warn"><i class="dot d-amber"></i>${data.reprises} sur la fenêtre</span><span class="tlgrow"></span><span class="tlsub">re-cadrages, rollbacks et retours</span></div>
    <div class="rlist">${items}</div>
  </section>`
}

function table(data) {
  const rows = Object.values(data.steps)
    .map((step) => `<tr><td><b>${esc(step.label)}</b><span class="ttid">${esc(step.key)}</span></td><td>${step.reached}/${data.count}</td><td>${span(step.mean)}</td><td>${span(step.median)}</td><td>${span(step.max)}</td><td>${percent(step.share)}</td></tr>`)
    .join('')
  return `<section class="syscard ttcard">
    <div class="schead"><h3>Distribution par étape</h3><span class="state-pill"><i class="dot d-grey"></i>${num(data.count)} missions</span><span class="tlgrow"></span><span class="tlsub">cycle moyen ${span(data.cycle)}</span></div>
    <table class="dtab tt"><thead><tr><th style="width:30%">Étape</th><th style="width:14%">Missions</th><th style="width:16%">Moyenne</th><th style="width:14%">Médiane</th><th style="width:12%">Max</th><th style="width:14%">Part du cycle</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="pnote">Fenêtre = missions ayant travaillé dans la période ; chaque étape est mesurée sur le cycle complet de la mission. Sources : journal, sessions, commits, review ; les statuts ne sont pas historisés.</div>
  </section>`
}

export function renderTimeline(data, options = {}) {
  const period = data.window.kind
  const anchor = options.anchor ?? ''
  const segment = (kind, label) => `<button class="${period === kind ? 'on' : ''}" data-period="${kind}">${label}</button>`
  const waitingLabel = `${data.window.label} · ${dayLabel(data.window.from)} → ${dayLabel(data.window.to)}`
  return `<section class="view active" data-view="timeline">
      <div class="pane">
        <div class="pwrap wide tlwrap">
          <div class="dsh-panel-head dsh-panel-head--inset">
            <div>
              <h2 class="dsh-panel-title">Performance</h2>
              <div class="dsh-panel-sub">Lecture en moyennes · ${data.count} missions produit · ${esc(waitingLabel)} · lecture seule sur les sources · lecture à ${timeLabel(data.generatedAt)}</div>
            </div>
            <div class="dsh-panel-actions">
              <span class="dsh-panel-stat" title="Lecture seule sur les sources"><i class="dot d-green"></i>Données à l'instant</span>
              <button class="dsh-panel-btn" data-refresh>Rafraîchir</button>
              <a class="dsh-panel-btn dsh-panel-btn--primary" href="/performance/bilan"><svg><use href="#i-list"/></svg>Bilan du jour</a>
            </div>
          </div>

          <div class="palerts">${alertPills(data)}</div>

          <div class="dsh-panel-tabs dsh-panel-tabs--flush">
            <button class="dsh-panel-tab" aria-selected="false" data-screen="semaine">Semaine</button>
            <button class="dsh-panel-tab" aria-selected="false" data-screen="mission">Mission</button>
            <button class="dsh-panel-tab" aria-selected="true" data-screen="timeline">Timeline</button>
            <span class="grow"></span>
              <div class="pperiod">
                <button class="pnav" data-nav="-1" aria-label="Fenêtre précédente">‹</button>
                <span class="pcur"><b>${esc(data.window.label)}</b><span>${dayLabel(data.window.from)} → ${dayLabel(data.window.to)}${anchor ? ' · relu' : ''}</span></span>
                <button class="pnav" data-nav="1" aria-label="Fenêtre suivante">›</button>
              </div>
              <div class="pseg">${segment('week', 'Semaine')}${segment('month', 'Mois')}${segment('day', 'Jour')}</div>
          </div>

          ${kpis(data)}
          ${hero(data)}
          <div class="stgrow">${Object.values(data.steps).map((step) => stageCard(step, data)).join('')}</div>
          ${reprises(data)}
          ${table(data)}
        </div>
      </div>
    </section>`
}

export { span }
