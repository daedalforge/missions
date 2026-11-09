import { esc, num, tokens as fmtTokens, euro as fmtEuro, cycle as fmtCycle, hours, statusInfo } from './render-common.js'

function badge(status) {
  const { kind, label } = statusInfo(status)
  const dot = kind === 'ok' ? 'd-green' : kind === 'bad' ? 'd-red' : kind === 'warn' ? 'd-amber' : 'd-grey'
  return `<span class="st ${kind}"><span class="dot ${dot}"></span>${esc(label)}</span>`
}

export function renderMission(m) {
  if (!m) return ''
  const mission = m.mission
  const cycle = m.cycle ?? {}
  const split = m.split ?? {}
  const journal = m.journal ?? {}
  const review = m.review
  const events = journal.events ?? []
  const sessions = m.sessions ?? []
  const commits = m.commits ?? []
  const humanMessages = split.userMessages ?? 0
  const assistantMessages = split.assistantMessages ?? 0
  const humanShare = humanMessages + assistantMessages > 0 ? humanMessages / (humanMessages + assistantMessages) : 0
  const agentShare = 1 - humanShare
  const unmet = review?.unmet?.length ?? 0
  const sources = [
    ['Fiche', m.links?.mission, 'mission.md'],
    ['Journal', m.links?.journal, 'journal.md'],
    review ? ['Review', m.links?.review, 'review.md'] : null,
  ].filter(Boolean)
  return `<section class="view" data-view="mission">
      <div class="pane">
        <div class="pwrap wide">
          <div class="backline"><button class="btn-o" data-screen="semaine"><span aria-hidden="true">←</span> Retour à la semaine</button></div>
          <div class="dsh-panel-head dsh-panel-head--inset">
            <div>
              <h2 class="dsh-panel-title">${esc(mission.id)} · ${esc(mission.title)}</h2>
              <div class="dsh-panel-sub">${esc(mission.type ?? '—')} · ${esc(mission.priority ?? '—')} · créée le ${esc(mission.created ?? '—')} · ${statusInfo(mission.status).label}${mission.epic ? ` · ${esc(mission.epic)}` : ''}${mission.points ? ` · ${num(mission.points)} points` : ''}</div>
            </div>
            <div class="dsh-panel-actions">${badge(mission.status)}<a class="dsh-panel-btn" href="${esc(m.links?.mission ?? '#')}" target="_blank" rel="noreferrer"><svg><use href="#i-folder"/></svg>Ouvrir la fiche</a></div>
          </div>

          <div class="sysstats mstats">
            <div class="syskpi"><div class="cap">Sessions liées</div><div class="big">${num(split.sessions ?? sessions.length)}</div><div class="mini">${num(split.turns ?? 0)} tours · ${num(split.toolCalls ?? 0)} outils</div></div>
            <div class="syskpi"><div class="cap">Tokens</div><div class="big">${fmtTokens(split.tokens ?? m.tokens ?? 0)}</div><div class="mini">${split.cost != null ? fmtEuro(split.cost) : '—'} · ${cycle.days != null ? `${fmtCycle(cycle.days)} de cycle` : 'cycle non mesuré'}</div></div>
            <div class="syskpi"><div class="cap">Commits</div><div class="big">${num(split.commits ?? commits.length)}</div><div class="mini">${commits.length ? 'collectés' : 'git non collecté'}</div></div>
            <div class="syskpi"><div class="cap">Reprises</div><div class="big">${num((journal.reprises ?? []).length)}</div><div class="mini">${unmet} critère${unmet > 1 ? 's' : ''} non tenu${unmet > 1 ? 's' : ''}${review ? ' · review' : ''}</div></div>
            <div class="syskpi"><div class="cap">Âge</div><div class="big">${cycle.age != null ? `${num(Math.max(0, Math.round(cycle.age)))} j` : '—'}</div><div class="mini">${cycle.close ? `clôturée le ${esc(cycle.close)}` : 'en cours'}</div></div>
          </div>

          <div class="mgrid">
            <div class="mcol">
              <section class="syscard"><div class="schead"><h3>Chronologie</h3><span class="state-pill ok"><i class="dot d-green"></i>${events.length} événement${events.length > 1 ? 's' : ''}</span></div><div class="jrows">${events.map((event) => `<div class="jrow"><span class="t">${esc(event.date ?? '—')}</span><span class="jres">${esc(event.title ?? event.label ?? '—')}</span></div>`).join('') || '<div class="jrow"><span class="t">—</span><span class="jres">journaux non renseignés</span></div>'}</div><div class="pnote">Journal de la mission · ${events.length} événement${events.length > 1 ? 's' : ''}.</div></section>
              <section class="syscard"><div class="schead"><h3>Sessions</h3><span class="state-pill ok"><i class="dot d-green"></i>${sessions.length} liée${sessions.length > 1 ? 's' : ''}</span></div><div class="jrows">${sessions.map((session) => `<div class="jrow"><span class="t">${esc(session.id.slice(-4))}</span><span class="jres">${num(session.turns)} tours · ${num(session.toolCalls)} outils · ${hours(session.turnMs)}</span></div>`).join('') || '<div class="jrow"><span class="t">—</span><span class="jres">aucune session liée</span></div>'}</div></section>
              <section class="syscard"><div class="schead"><h3>Commits</h3><span class="state-pill ${commits.length ? 'ok' : 'warn'}"><i class="dot ${commits.length ? 'd-green' : 'd-amber'}"></i>${commits.length}</span></div><div class="jrows">${commits.map((commit) => `<div class="jrow"><span class="t">${esc(commit.date?.slice(0, 10) ?? '—')}</span><span class="jres"><span class="hash">${esc(commit.hash?.slice(0, 7) ?? '—')}</span> ${esc(commit.message ?? '')}</span></div>`).join('') || '<div class="jrow"><span class="t">—</span><span class="jres">git non collecté sur cette lecture</span></div>'}</div></section>
            </div>
            <div class="mcol">
              <section class="syscard"><div class="schead"><h3>Part humaine / part agent</h3><span class="state-pill ok"><i class="dot d-green"></i>${Math.round(humanShare * 100)} %</span></div><div class="psplit"><div class="psplitbar"><i class="ph" style="width:${Math.max(2, Math.round(humanShare * 100))}%"></i><i class="pa" style="width:${Math.max(2, Math.round(agentShare * 100))}%"></i></div><div class="psplitlab"><span class="ph">Toi ${num(humanMessages)} messages</span><span class="pa">Agent ${num(assistantMessages)} messages</span></div></div><div class="wgrid"><div><b>${num(split.go ?? 0)}</b><span>go</span></div><div><b>${num(split.reviews ?? 0)}</b><span>review</span></div><div><b>${num(split.sessions ?? 0)}</b><span>sessions</span></div><div><b>${num(split.toolCalls ?? 0)}</b><span>outils</span></div></div></section>
              <section class="syscard"><div class="schead"><h3>Qualité</h3><span class="state-pill ${unmet > 0 ? 'warn' : 'ok'}"><i class="dot ${unmet > 0 ? 'd-amber' : 'd-green'}"></i>${review ? esc(review.verdict ?? 'review') : 'pas de review'}</span></div><div class="qstats"><div><b>${unmet}</b><span>critères non tenus</span></div><div><b>${num(review?.findings ?? 0)}</b><span>constats</span></div><div><b>${num((journal.reprises ?? []).length)}</b><span>reprises</span></div></div><div class="pnote">${review?.date ? `Review du ${esc(review.date)} · verdict ${esc(review.verdict ?? '—')}.` : 'Aucune review sur cette mission.'}</div></section>
              <section class="syscard"><div class="schead"><h3>Liens</h3><span class="state-pill ok"><i class="dot d-green"></i>lecture seule</span></div><div class="jrows">${sources.map(([label, href, name]) => `<a class="linkrow" href="${esc(href)}" target="_blank" rel="noreferrer"><span>${esc(label)}</span><span class="hash">${esc(name)}</span><span class="arrow">↗</span></a>`).join('')}</div></section>
            </div>
          </div>
          <div class="pnote">Vue mission · lecture seule sur les sources · ${esc(mission.id)}.</div>
        </div>
      </div>
    </section>`
}
