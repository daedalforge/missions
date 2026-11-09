export const READY_STATUSES = new Set(['Ready to Dev', 'Ready for dev'])

export function jiraDate(value) {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : 0
}

export function firstReadyToDev(transitions = []) {
  return (
    transitions
      .filter((transition) => READY_STATUSES.has(transition.to))
      .sort((left, right) => jiraDate(left.at) - jiraDate(right.at))[0] ?? null
  )
}

export function parseJqlKeys(output) {
  const keys = []
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9]*-\d+)\s+\[/.exec(line)
    if (match) keys.push(match[1])
  }
  return keys
}

export function stateOf({ ready, created, journalFirstDate }) {
  if (!ready) return { state: 'sans-transition', reason: 'aucune transition vers Ready to Dev' }
  const readyAt = jiraDate(ready.at)
  const first = journalFirstDate ? jiraDate(`${journalFirstDate}T00:00:00`) : 0
  if (!first) return { state: 'rejete', reason: 'journal sans événement' }
  const createdMs = jiraDate(created)
  if (createdMs && createdMs < first - 30 * 86_400_000) {
    return {
      state: 'rejete',
      reason: `création (${created}) antérieure de plus de 30 jours au premier événement du journal (${journalFirstDate})`,
    }
  }
  if (readyAt < first) {
    return {
      state: 'rejete',
      reason: `Ready to Dev (${ready.at}) antérieur au premier événement du journal (${journalFirstDate})`,
    }
  }
  return { state: 'retenu', reason: '' }
}

const DEV_STATUSES = new Set(['To Dev', 'In Progress'])
const PROD_STATUSES = new Set(['Ready for prod', 'Local Testing'])

function orderedTransitions(jira) {
  if (!jira || !Array.isArray(jira.transitions)) return []
  return jira.transitions
    .map((transition, index) => ({ ...transition, at: jiraDate(transition.at), index }))
    .filter((transition) => transition.at > 0)
    .sort((left, right) => left.at - right.at || left.index - right.index)
}

export function jiraLastTransition(jira) {
  return orderedTransitions(jira).at(-1) ?? null
}

/** Livrée : la dernière transition porte le statut prod (Local Testing, Ready for prod). */
export function isDelivered(jira) {
  const last = jiraLastTransition(jira)
  return Boolean(last && PROD_STATUSES.has(last.to))
}

export function jiraLifecycle(jira, { closedAt = 0 } = {}) {
  if (!jira || !Array.isArray(jira.transitions)) return null
  const transitions = orderedTransitions(jira)
  const created = jiraDate(jira.created)
  if (!created || transitions.length === 0) return null
  const ready = transitions.find((transition) => READY_STATUSES.has(transition.to))?.at ?? 0
  const devFrom = ready > 0 ? ready : created
  const toDev = transitions.find((transition) => transition.at >= devFrom && DEV_STATUSES.has(transition.to))?.at ?? 0
  const reviewFrom = toDev > 0 ? toDev : devFrom
  const codeReview = transitions.find((transition) => transition.at >= reviewFrom && transition.to === 'Code review')?.at ?? 0
  const prodFrom = codeReview > 0 ? codeReview : reviewFrom
  const readyForProd = transitions.find((transition) => transition.at >= prodFrom && PROD_STATUSES.has(transition.to))?.at ?? 0
  const lastAt = transitions.at(-1).at
  const end = Math.max(lastAt, closedAt > 0 ? closedAt : 0)
  const cadrageEnd = ready > 0 ? ready : toDev > 0 ? toDev : end
  const goEnd = toDev > 0 ? Math.max(cadrageEnd, toDev) : cadrageEnd
  const execEnd = codeReview > 0 ? Math.max(goEnd, codeReview) : Math.max(goEnd, readyForProd > 0 ? readyForProd : end)
  const reviewEnd = readyForProd > 0 ? Math.max(execEnd, readyForProd) : end
  const valEnd = Math.max(reviewEnd, end)
  const steps = {
    cadrage: Math.max(0, cadrageEnd - created),
    go: Math.max(0, goEnd - cadrageEnd),
    exec: Math.max(0, execEnd - goEnd),
    review: Math.max(0, reviewEnd - execEnd),
    val: Math.max(0, valEnd - reviewEnd),
    close: 0,
  }
  return { created, ready, toDev, codeReview, readyForProd, end: valEnd, steps }
}

export function importFiche({ key, summary, created, status, epic, today }) {
  return `---
id: ${key}
type: produit
status: draft
priority:
epic: ${epic}
story_points:
repo:
base_branch:
category:
branch_name:
pr:
suite:
queue:
bruno: []
---

# ${summary}

## Objectif

Mettre en œuvre « ${summary} » (ticket ${key}, epic ${epic}).

## Contexte

Ticket Jira ${key} de l'epic ${epic}, créé le ${created} (statut Jira : ${status}). Importé dans konoha le ${today} pour que l'inventaire de la Timeline couvre les tickets produit. Aucune branche ni PR n'est ouverte ; le cadrage précisera le dépôt, le périmètre et les critères.

## Critères d'acceptation

- À définir au cadrage.

## Livrable

À définir au cadrage.

## Scope

Dedans:
- À définir au cadrage.

Dehors:
- À définir au cadrage.
`
}

export function importJournal({ key, summary, created, status, epic, today }) {
  return `# Journal

## ${today} — Import depuis Jira

Ticket ${key} (« ${summary} »), epic ${epic}, créé le ${created}, statut Jira « ${status} ». Fiche créée en \`draft\` pour que la Timeline couvre l'inventaire produit ; aucun travail ouvert. Le cadrage reprendra le ticket et remplira dépôt, périmètre et critères.
`
}
