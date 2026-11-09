import { esc, num, tokens as fmtTokens, euro as fmtEuro, cycle as fmtCycle, percent, hours, statusInfo, severityClass } from './render-common.js'

const WAITING_LABEL = {
  awaiting_validation: 'à valider',
  in_review: 'en review',
  in_peer_review: 'en peer review',
  ready: 'prête',
  draft: 'brouillon',
}

function statusBadge(status) {
  const { kind, label } = statusInfo(status)
  const dot = kind === 'ok' ? 'd-green' : kind === 'bad' ? 'd-red' : kind === 'warn' ? 'd-amber' : 'd-grey'
  return `<span class="st ${kind}"><span class="dot ${dot}"></span>${esc(label)}</span>`
}

function filterChip(label, key, values, current) {
  const options = ['', ...(values ?? [])].map((value) => `<option value="${esc(value)}"${value === (current ?? '') ? ' selected' : ''}>${value ? esc(value) : 'Tous'}</option>`).join('')
  return `<label class="fchip">${label} <select data-filter="${esc(key)}">${options}</select></label>`
}

function coverageLine(week) {
  const gaps = (week.coverage?.gaps ?? []).slice(0, 2).map((gap) => gap.replace(/\.$/, ''))
  return [...gaps, 'Jira : lecture seule'].join(' · ')
}

function barChart(series) {
  const max = Math.max(1, ...series.map((entry) => entry.done))
  return series.map((entry, index) => {
    const current = index === series.length - 1
    const height = entry.done > 0 ? Math.max(8, Math.round((entry.done / max) * 80)) : 2
    return `<div class="pcol${current ? ' cur' : ''}"><span class="pv">${entry.done}</span><i class="bar" style="height:${height}%"></i><span class="lab">${esc(entry.label)}</span></div>`
  }).join('')
}

function cycleChart(series) {
  const values = series.map((entry) => entry.cycle || 0)
  const max = Math.max(0.05, ...values)
  const points = values.map((value, index) => {
    const x = 12 + index * 42
    const y = 80 - (value / max) * 64
    return { x, y: Math.max(6, Math.min(84, y)) }
  })
  const polyline = points.map((point) => `${point.x},${point.y.toFixed(1)}`).join(' ')
  const area = `${polyline} ${points[points.length - 1].x},90 12,90`
  const dots = points.map((point, index) => `<circle class="pt${index === points.length - 1 ? ' cur' : ''}" cx="${point.x}" cy="${point.y.toFixed(1)}" r="${index === points.length - 1 ? 3.4 : 2.2}"/>`).join('')
  return `<svg class="psvg" viewBox="0 0 320 90" preserveAspectRatio="none" aria-hidden="true"><line class="grid" x1="0" y1="22" x2="320" y2="22"/><line class="grid" x1="0" y1="47" x2="320" y2="47"/><line class="grid" x1="0" y1="72" x2="320" y2="72"/><polygon class="area" points="${area}"/><polyline class="line" points="${polyline}"/>${dots}</svg>`
}

function tokensChart(byDay) {
  const max = Math.max(1, ...byDay.map((day) => day.tokens))
  return byDay.map((day) => {
    const height = day.tokens > 0 ? Math.max(6, Math.round((day.tokens / max) * 80)) : 2
    return `<div class="pcol${day.date === byDay[byDay.length - 1].date ? ' cur' : ''}${day.tokens === 0 ? ' zero' : ''}"><span class="pv">${fmtTokens(day.tokens)}</span><span class="pstackbar" style="height:${height}%"><i class="in" style="height:100%"></i></span><span class="lab">${esc(day.label)}</span></div>`
  }).join('')
}

function costChart(byDay) {
  const max = Math.max(0.01, ...byDay.map((day) => day.cost))
  const points = byDay.map((day, index) => {
    const x = 12 + index * (296 / Math.max(1, byDay.length - 1))
    const y = 40 - (day.cost / max) * 30
    return { x, y: Math.max(6, Math.min(44, y)) }
  })
  const polyline = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
  const area = `${polyline} ${points[points.length - 1].x.toFixed(1)},50 12,50`
  const dots = points.map((point, index) => `<circle class="pt${index === points.length - 1 ? ' cur' : ''}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${index === points.length - 1 ? 2.8 : 2}"/>`).join('')
  return `<svg class="psvg psvg-cost" viewBox="0 0 320 50" preserveAspectRatio="none" aria-hidden="true"><line class="grid" x1="0" y1="12" x2="320" y2="12"/><line class="grid" x1="0" y1="25" x2="320" y2="25"/><line class="grid" x1="0" y1="38" x2="320" y2="38"/><polygon class="area" points="${area}"/><polyline class="line" points="${polyline}"/>${dots}</svg>`
}

function repriseKind(entry) {
  const text = `${entry.kind ?? ''} ${entry.label ?? ''} ${entry.detail ?? ''}`.toLowerCase()
  if (/rollback|retour arrière/.test(text)) return 'rollback'
  if (/abandon/.test(text)) return 'abandon'
  if (/cadrage|périmètre|re-?cadr/.test(text)) return 'recadrage'
  return 'reprise'
}

function ageLabel(snapshot) {
  const ms = Number(snapshot?.ageMs)
  if (!Number.isFinite(ms) || ms < 0) return "à l'instant"
  const min = Math.round(ms / 60_000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `de ${min} min`
  const hours = Math.round(min / 60)
  return `de ${hours} h`
}

export function renderWeek(week, options = {}) {
  const counters = week.counters
  const previousDone = week.throughput.series.at(-2)?.done ?? 0
  const doneDelta = counters.done - previousDone
  const costDelta = week.effort.prevCostEur > 0 ? (week.effort.costEur - week.effort.prevCostEur) / week.effort.prevCostEur : null
  const totalTokens = week.effort.input + week.effort.output + week.effort.cacheRead
  const tokensBar = totalTokens > 0 ? Math.min(92, Math.round((week.effort.input + week.effort.output) / (totalTokens || 1) * 80)) : 0
  const costBar = week.effort.prevCostEur > 0 ? Math.min(92, Math.round((week.effort.costEur / Math.max(week.effort.prevCostEur, 0.01)) * 45)) : 0
  const topMission = [...week.table].sort((left, right) => (right.cost ?? 0) - (left.cost ?? 0))[0]
  const humanMs = week.humanAgent.human.activeMs
  const agentMs = week.humanAgent.agent.activeMs
  const totalMs = humanMs + agentMs
  const humanPct = totalMs > 0 ? humanMs / totalMs : 0
  const agentPct = totalMs > 0 ? agentMs / totalMs : 0
  const recadrages = week.quality.reprises.filter((entry) => repriseKind(entry) === 'recadrage').length
  const rollbacks = week.quality.reprises.filter((entry) => repriseKind(entry) === 'rollback').length
  const abandons = week.quality.abandoned?.length ?? 0
  const accepted = week.quality.reviews.filter((review) => /accept|go/i.test(review.verdict ?? '')).length
  const labelParts = String(week.period.label ?? '').split(' · ')
  const labelHead = labelParts[0] ?? week.period.label ?? ''
  const labelRange = labelParts.slice(1).join(' · ')
  const alerts = week.alerts ?? []
  const epicEntries = week.epicProgress?.epics ?? []
  const epicOrphans = week.epicProgress?.orphans ?? { missions: 0, points: 0 }
  const EPIC_VIEWS = ['done-missions', 'dev-missions', 'done-points', 'dev-points']
  const epicRows = epicEntries.map((epic) => {
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
      'done-missions': `${num(missionsDone)} / ${num(missionsTotal)} missions · reste ${num(missionsTotal - missionsDone)}`,
      'dev-missions': `${num(missionsDev)} / ${num(missionsTotal)} missions · reste ${num(missionsTotal - missionsDev)}`,
      'done-points': `${num(pointsDone)} / ${num(pointsTotal)} pts · reste ${num(pointsTotal - pointsDone)}`,
      'dev-points': `${num(pointsDev)} / ${num(pointsTotal)} pts · reste ${num(pointsTotal - pointsDev)}`,
    }
    const bars = EPIC_VIEWS.map(
      (view) =>
        `<i class="epicvar" data-view="${view}" style="width:${Math.max(2, pct[view])}%;display:${view === 'dev-missions' ? 'block' : 'none'}"></i>`,
    ).join('')
    const stats = EPIC_VIEWS.map(
      (view) =>
        `<span class="epicvar" data-view="${view}" style="display:${view === 'dev-missions' ? 'inline' : 'none'}"><b>${pct[view]} %</b><span class="epicdim">${detail[view]}</span></span>`,
    ).join('')
    return `<div class="epicrow"><div class="epichead"><span class="mono">${esc(epic.key)}</span><span class="epictitle" title="${esc(epic.title ?? '')}">${esc(label)}</span></div><div class="epicbar">${bars}</div><div class="epicstats">${stats}</div></div>`
  }).join('') || '<div class="epicrow empty">Aucune epic cadrée</div>'

  const tableRows = week.table.map((row) => {
    const agentShare = row.agentShare ?? row.share
    return `<tr${row.href ? ` data-mission="${esc(row.id)}"` : ''}><td><b class="mono">${esc(row.id)}</b><span class="mt">${esc(row.title)}</span></td><td>${esc(row.type ?? '—')}</td><td>${statusBadge(row.status)}</td><td>${fmtCycle(row.cycle)}</td><td>${row.points ? num(row.points) : '—'}</td><td>${fmtTokens(row.tokens)}</td><td>${fmtEuro(row.cost)}</td><td>${agentShare != null ? percent(agentShare) : '—'}</td><td>${row.reprises ?? 0}</td></tr>`
  }).join('')
  const qualityEvents = [
    ...week.quality.reviews.map((review) => ({ kind: /renvoy|refus/i.test(review.verdict ?? '') ? 'bad' : 'warn', date: review.date, id: review.missionId, text: `${review.verdict ?? 'review'}${review.unmet?.length ? ` · ${review.unmet.length} critère${review.unmet.length > 1 ? 's' : ''} non tenu${review.unmet.length > 1 ? 's' : ''}` : ''}` })),
    ...week.quality.reprises.map((entry) => ({ kind: 'warn', date: entry.date, id: entry.missionId, text: `${repriseKind(entry)} — ${entry.label ?? entry.detail ?? ''}` })),
  ].slice(0, 4)
  const waitingEvents = week.waiting.slice(0, 4).map((item) => ({ kind: item.status === 'awaiting_validation' ? 'warn' : item.days && item.days > 7 ? 'bad' : 'warn', id: item.id, text: `${WAITING_LABEL[item.status] ?? item.status}${item.days ? ` · ${item.days} j` : ''}` }))
  const qualityCount = week.quality.reprises.length + week.quality.findings + abandons

  return `<section class="view active" data-view="semaine">
      <div class="pane">
        <div class="pwrap wide">
          <div class="dsh-panel-head dsh-panel-head--inset">
            <div>
              <h2 class="dsh-panel-title">Performance</h2>
              <div class="dsh-panel-sub">${counters.done} mission${counters.done > 1 ? 's' : ''} terminée${counters.done > 1 ? 's' : ''} · ${counters.active} ouverte${counters.active > 1 ? 's' : ''} · ${counters.waiting} en attente · lecture seule sur les sources · ${esc(week.period.label)}</div>
            </div>
            <div class="dsh-panel-actions">
              <span class="dsh-panel-stat" title="Lecture seule sur les sources"><i class="dot ${Number(week.snapshot?.ageMs) > 300_000 ? 'd-amber' : 'd-green'}"></i>Données ${ageLabel(week.snapshot)}</span>
              <button class="dsh-panel-btn" data-refresh>Rafraîchir</button>
              <a class="dsh-panel-btn dsh-panel-btn--primary" href="/performance/bilan"><svg><use href="#i-list"/></svg>Bilan du jour</a>
            </div>
          </div>

          <div class="palerts">
            ${alerts.map((alert) => `<span class="palert ${severityClass(alert.level)}"><i class="dot ${alert.level === 'bad' ? 'd-red' : alert.level === 'ok' ? 'd-green' : 'd-amber'}"></i>${esc(alert.title)}</span>`).join('')}
            <span class="grow"></span>
            <button class="btn-o" data-static>Voir les alertes</button>
          </div>

          <div class="dsh-panel-tabs dsh-panel-tabs--flush">
            <button class="dsh-panel-tab" aria-selected="true" data-screen="semaine">Semaine</button>
            <button class="dsh-panel-tab" aria-selected="false" data-screen="mission">Mission${options.defaultMission ? ` · ${esc(options.defaultMission)}` : ''}</button>
            <button class="dsh-panel-tab" aria-selected="false" data-screen="timeline">Timeline</button>
            <span class="grow"></span>
              <div class="pperiod">
                <button class="pnav" data-nav="-1" aria-label="Période précédente">‹</button>
                <span class="pcur"><b>${esc(labelHead)}</b><span>${esc(labelRange)}</span></span>
                <button class="pnav" data-nav="1" aria-label="Période suivante">›</button>
              </div>
              <div class="pseg">${['week', 'month', 'day'].map((kind) => `<button class="${week.period.kind === kind ? 'on' : ''}" data-period="${kind}">${kind === 'week' ? 'Semaine' : kind === 'month' ? 'Mois' : 'Jour'}</button>`).join('')}</div>
              <button class="dsh-panel-btn" data-bilan><svg><use href="#i-list"/></svg>Copier la semaine</button>
          </div>

          <div class="pfilters">
            <span class="flabel">Filtres</span>
            ${filterChip('Type', 'type', week.filterOptions.types, week.filters.type)}
            ${filterChip('Epic', 'epic', week.filterOptions.epics, week.filters.epic)}
            ${filterChip('Dépôt', 'repo', week.filterOptions.repos, week.filters.repo)}
            ${filterChip('Statut', 'status', week.filterOptions.statuses, week.filters.status)}
            <span class="grow"></span>
            <span class="coverage">${esc(coverageLine(week))}</span>
          </div>

          <div class="sysgrid">
            <div class="sysstats pstats">
              <div class="syskpi">
                <div class="cap">Missions terminées</div>
                <div class="big">${counters.done}<small>${doneDelta === 0 ? 'stable' : `${doneDelta > 0 ? '+' : ''}${doneDelta} vs S-1`}</small></div>
                <div class="mini">${counters.created} créées · ${counters.active} ouvertes</div>
                <div class="bar"><i style="width:${Math.min(92, Math.round((counters.done / Math.max(1, counters.done + counters.active + counters.waiting)) * 400))}%"></i></div>
              </div>
              <div class="syskpi">
                <div class="cap">Cycle médian</div>
                <div class="big">${fmtCycle(week.cycle.median)}<small>${week.cycle.prevMedian > 0 ? `${week.cycle.median >= week.cycle.prevMedian ? '+' : ''}${fmtCycle(week.cycle.median - week.cycle.prevMedian)}` : '—'}</small></div>
                <div class="mini">p90 ${fmtCycle(week.cycle.p90)} · ${week.cycle.count} mesurée${week.cycle.count > 1 ? 's' : ''}</div>
                <div class="bar"><i style="width:${Math.min(92, Math.round((week.cycle.median / Math.max(week.cycle.p90, 0.01)) * 45))}%"></i></div>
              </div>
              <div class="syskpi">
                <div class="cap">Tokens</div>
                <div class="big">${fmtTokens(totalTokens)}<small>${percent(week.effort.cacheRate)} cache</small></div>
                <div class="mini">input ${fmtTokens(week.effort.input)} · output ${fmtTokens(week.effort.output)}</div>
                <div class="bar"><i style="width:${tokensBar}%"></i></div>
              </div>
              <div class="syskpi">
                <div class="cap">Coût</div>
                <div class="big">${fmtEuro(week.effort.costEur)}<small>${costDelta === null ? '—' : `${costDelta > 0 ? '+' : ''}${Math.round(costDelta * 100)} %`}</small></div>
                <div class="mini">${topMission ? `dont ${fmtEuro(topMission.cost)} sur ${esc(topMission.id)}` : 'aucune session facturée'}</div>
                <div class="bar"><i style="width:${costBar}%"></i></div>
              </div>
              <div class="syskpi">
                <div class="cap">Production livrée</div>
                <div class="big">${week.production.commits}<small>commit${week.production.commits > 1 ? 's' : ''}</small></div>
                <div class="mini">${week.production.points} points · ${week.production.prs} PR · ${week.production.reviews} review${week.production.reviews > 1 ? 's' : ''}</div>
                <div class="bar"><i style="width:${Math.min(92, week.production.commits > 0 ? 60 : 4)}%"></i></div>
              </div>
              <div class="syskpi ${qualityCount > 0 ? 'warn' : ''}">
                <div class="cap">Reprises</div>
                <div class="big">${week.quality.reprises.length}<small>${recadrages} re-cadrage${recadrages > 1 ? 's' : ''}</small></div>
                <div class="mini">${rollbacks} rollback · ${abandons} abandon · ${week.quality.findings} constat${week.quality.findings > 1 ? 's' : ''}</div>
                <div class="bar"><i style="width:${Math.min(92, week.quality.reprises.length * 12)}%"></i></div>
              </div>
              <div class="syskpi ${counters.waiting > 0 ? 'warn' : ''}">
                <div class="cap">En attente</div>
                <div class="big">${counters.waiting}<small>${counters.dormant} dormante${counters.dormant > 1 ? 's' : ''}</small></div>
                <div class="mini">${counters.review} review · ${counters.validation} à valider · ${counters.queue} en file</div>
                <div class="bar"><i style="width:${Math.min(92, Math.round((counters.waiting / Math.max(1, counters.done + counters.active + counters.waiting)) * 400))}%"></i></div>
              </div>
            </div>

            <section class="syscard ptablecard epicscard">
              <div class="schead"><h3>Avancement par epic</h3><div class="epicmodes"><div class="epicmode" data-epic-base><button type="button" class="on" data-base="missions">Missions</button><button type="button" data-base="points">Points</button></div><div class="epicmode" data-epic-mode><button type="button" data-mode="done">Terminé</button><button type="button" class="on" data-mode="dev" title="Développement terminé">Dév. terminé</button></div></div><a href="#" class="more" data-static>Cadre<svg><use href="#i-chevron"/></svg></a></div>
              <div class="epiclist" data-epic-rows>${epicRows}</div>
              <div class="pnote">Base <b>missions</b> : part des missions qui portent des points sur toutes les missions cadrées de l'epic ; base <b>points</b> : part des story points livrés. <b>Terminé</b> compte les closes, <b>dév. terminé</b> y ajoute les missions en review, en peer review et à valider. Un cadrage fait reculer le taux. ${num(epicOrphans.missions)} missions sans epic (${num(epicOrphans.points)} pts) ne sont pas comptées.</div>
            </section>

            <div class="prow3">
              <section class="syscard">
                <div class="schead"><h3>Débit &amp; cycle</h3><span class="state-pill ok"><i class="dot d-green"></i>${counters.done} terminées</span><a href="#" class="more" data-static>Détail<svg><use href="#i-chevron"/></svg></a></div>
                <div class="pchartrow">
                  <div class="pchartbox">
                    <div class="pcap">Missions terminées · 8 semaines</div>
                    <div class="pchart">${barChart(week.throughput.series)}</div>
                  </div>
                  <div class="pchartbox">
                    <div class="pcap">Cycle médian · jours</div>
                    ${cycleChart(week.throughput.series)}
                  </div>
                </div>
                <div class="pfoot"><span>Médiane <b>${fmtCycle(week.cycle.median)}</b></span><span>p90 <b>${fmtCycle(week.cycle.p90)}</b></span><span>terminées <b>${counters.done}</b></span><span>créées <b>${counters.created}</b></span></div>
              </section>

              <section class="syscard">
                <div class="schead"><h3>Effort &amp; coût</h3><span class="state-pill ok"><i class="dot d-green"></i>${fmtTokens(totalTokens)} tokens</span><a href="#" class="more" data-static>Détail<svg><use href="#i-chevron"/></svg></a></div>
                <div class="pchartrow pchartrow-stack">
                  <div class="pchartbox">
                    <div class="pcap">Tokens par jour · input + output + cache</div>
                    <div class="pchart">${tokensChart(week.effort.byDay)}</div>
                  </div>
                  <div class="pchartbox pchartbox-line">
                    <div class="pcap">Coût par jour · <b>${fmtEuro(week.effort.costEur)}</b></div>
                    ${costChart(week.effort.byDay)}
                  </div>
                </div>
                <div class="pfoot"><span>Input <b>${fmtTokens(week.effort.input)}</b></span><span>Output <b>${fmtTokens(week.effort.output)}</b></span><span>Cache <b>${fmtTokens(week.effort.cacheRead)}</b> (${percent(week.effort.cacheRate)})</span><span>Total <b>${fmtEuro(week.effort.costEur)}</b></span></div>
              </section>

              <section class="syscard">
                <div class="schead"><h3>Part humaine / part agent</h3><span class="state-pill ok"><i class="dot d-green"></i>${week.humanAgent.human.go} go</span><a href="#" class="more" data-static>Détail<svg><use href="#i-chevron"/></svg></a></div>
                <div class="psplit">
                  <div class="psplitbar"><i class="ph" style="width:${Math.max(2, Math.round(humanPct * 100))}%"></i><i class="pa" style="width:${Math.max(2, Math.round(agentPct * 100))}%"></i></div>
                  <div class="psplitlab"><span class="ph">Toi ${hours(humanMs)} · ${Math.round(humanPct * 100)} %</span><span class="pa">Agent ${hours(agentMs)} · ${Math.round(agentPct * 100)} %</span></div>
                </div>
                <div class="pcols2">
                  <div class="pwho human">
                    <div class="whead"><span class="dot d-green"></span>Toi</div>
                    <div class="wgrid">
                      <div><b>${num(week.humanAgent.human.userMessages)}</b><span>messages</span></div>
                      <div><b>${num(week.humanAgent.human.go)}</b><span>go</span></div>
                      <div><b>${num(week.humanAgent.human.reviews)}</b><span>reviews</span></div>
                      <div><b>${hours(humanMs)}</b><span>focus indirect</span></div>
                    </div>
                  </div>
                  <div class="pwho agent">
                    <div class="whead"><span class="dot d-amber"></span>L'agent</div>
                    <div class="wgrid">
                      <div><b>${num(week.humanAgent.agent.sessions)}</b><span>sessions</span></div>
                      <div><b>${num(week.humanAgent.agent.turns)}</b><span>tours</span></div>
                      <div><b>${num(week.humanAgent.agent.commits)}</b><span>commits</span></div>
                      <div><b>${num(week.humanAgent.agent.tools)}</b><span>appels d'outils</span></div>
                    </div>
                  </div>
                </div>
                <div class="pnote">Temps actif : sessions DSH (tours). Focus humain déduit des messages, go et reviews.</div>
              </section>
            </div>

            <div class="prow3">
              <section class="syscard">
                <div class="schead"><h3>Qualité &amp; reprises</h3><span class="state-pill ${qualityCount > 0 ? 'warn' : 'ok'}"><i class="dot ${qualityCount > 0 ? 'd-amber' : 'd-green'}"></i>${qualityCount} reprise${qualityCount > 1 ? 's' : ''}</span><a href="#" class="more" data-static>Détail<svg><use href="#i-chevron"/></svg></a></div>
                <div class="qstats">
                  <div><b>${recadrages}</b><span>re-cadrages</span></div>
                  <div><b>${rollbacks}</b><span>rollbacks</span></div>
                  <div><b>${abandons}</b><span>abandons</span></div>
                  <div><b>${week.quality.findings}</b><span>constats</span></div>
                </div>
                <div class="qrev">${week.quality.reviews.length} review${week.quality.reviews.length > 1 ? 's' : ''} · ${accepted} acceptée${accepted > 1 ? 's' : ''} · ${week.quality.unmet} critère${week.quality.unmet > 1 ? 's' : ''} non tenu${week.quality.unmet > 1 ? 's' : ''}</div>
                <div class="qevents">${qualityEvents.map((event) => `<div class="qev ${event.kind}"><span class="t">${esc(event.date ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(event.date)) : '—')}</span><b>${esc(event.id ?? '—')}</b><span>${esc(event.text)}</span></div>`).join('') || '<div class="qev"><span class="t">—</span><b>—</b><span>aucune reprise sur la période</span></div>'}</div>
                <div class="pnote">Reprises = re-cadrages + rollbacks + abandons ; les reviews sont comptées à part.</div>
              </section>

              <section class="syscard">
                <div class="schead"><h3>Attentes &amp; blocages</h3><span class="state-pill ${counters.waiting > 0 ? 'warn' : 'ok'}"><i class="dot ${counters.waiting > 0 ? 'd-amber' : 'd-green'}"></i>${counters.waiting} en attente</span><a href="#" class="more" data-static>Détail<svg><use href="#i-chevron"/></svg></a></div>
                <div class="qstats">
                  <div><b>${counters.dormant}</b><span>dormantes</span></div>
                  <div><b>${counters.validation}</b><span>à valider</span></div>
                  <div><b>${counters.review}</b><span>en review</span></div>
                  <div><b>${counters.queue}</b><span>en file</span></div>
                </div>
                <div class="qevents">${waitingEvents.map((event) => `<div class="qev ${event.kind}"><span class="t">${esc(event.days ? `${event.days} j` : '—')}</span><b>${esc(event.id)}</b><span>${esc(event.text)}</span></div>`).join('') || '<div class="qev"><span class="t">—</span><b>—</b><span>aucune attente</span></div>'}</div>
                <div class="pnote">Dormance : active ou en attente sans journal depuis 7 j. File : missions ready non commencées.</div>
              </section>

              <section class="syscard">
                <div class="schead"><h3>Bilan de la semaine</h3><span class="state-pill ok"><i class="dot d-green"></i>déterministe</span><a href="#" class="more" data-static>Gabarit<svg><use href="#i-chevron"/></svg></a></div>
                <div class="bilan">${week.bilan.lines.map((line) => `<p>${esc(line)}</p>`).join('')}</div>
                <div class="bilanacts"><button class="btn-o" data-bilan><svg><use href="#i-list"/></svg>Copier</button><span class="grow"></span><span class="pnote" style="margin:0;padding:0">Sans LLM</span></div>
              </section>
            </div>
            <section class="syscard ptablecard">
              <div class="schead"><h3>Missions de la période</h3><span class="state-pill ok"><i class="dot d-green"></i>${week.table.length} mission${week.table.length > 1 ? 's' : ''}</span><a href="#" class="more" data-static>Tout voir<svg><use href="#i-chevron"/></svg></a></div>
              <table class="dtab ptab">
                <thead><tr><th style="width:27%">Mission</th><th style="width:8%">Type</th><th style="width:10%">Statut</th><th style="width:7%">Cycle</th><th style="width:6%">Points</th><th style="width:8%">Tokens</th><th style="width:7%">Coût</th><th style="width:6%">Agent</th><th style="width:7%">Reprises</th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>
              <div class="pnote">Données réelles · ${week.table.length} missions sur la période · tokens et coûts issus du ledger, cycles des sessions liées ou des journaux.</div>
            </section>
          </div>
        </div>
      </div>
    </section>`
}
