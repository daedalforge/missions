const numberFormatter = new Intl.NumberFormat('fr-FR')
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

export function num(value) {
  return numberFormatter.format(Number(value) || 0)
}

export function tokens(value) {
  const n = Number(value) || 0
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} G`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} M`
  if (n >= 1e3) return `${Math.round(n / 1e3)} K`
  return num(n)
}

export function euro(value) {
  return `${(Number(value) || 0).toFixed(2).replace('.', ',')} €`
}

export function cycle(value) {
  const days = Number(value) || 0
  if (days <= 0) return '0'
  if (days < 1) return `${(days * 24).toFixed(1).replace('.', ',')} h`
  return `${days.toFixed(1).replace('.', ',')} j`
}

export function percent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1).replace('.', ',')} %`
}

export function hours(value) {
  const ms = Number(value) || 0
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return m > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`
}

export function dateShort(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

const STATUS = {
  done: ['ok', 'terminée'],
  active: ['ok', 'active'],
  in_review: ['warn', 'en review'],
  in_peer_review: ['warn', 'en peer review'],
  awaiting_validation: ['warn', 'à valider'],
  ready: ['grey', 'prête'],
  draft: ['grey', 'brouillon'],
  abandoned: ['bad', 'abandonnée'],
  archived: ['grey', 'archivée'],
}

export function statusInfo(status) {
  const [kind, label] = STATUS[status] || ['grey', status || '—']
  return { kind, label }
}

export function verdictInfo(verdict) {
  const text = String(verdict || '').trim()
  if (!text || text === '—') return { kind: 'grey', label: '—' }
  if (/renvoy|refus|reject|échec/i.test(text)) return { kind: 'bad', label: text }
  if (/accept|go|réserve/i.test(text)) return { kind: 'ok', label: text }
  return { kind: 'warn', label: text }
}

export function severityClass(severity) {
  return severity === 'bad' ? 'bad' : 'warn'
}
