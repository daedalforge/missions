(function () {
  const root = document.querySelector('[data-view="bilan"]')
  if (!root) return
  const date = root.dataset.date
  let figures = {}
  try {
    figures = JSON.parse(root.dataset.figures || '{}')
  } catch {
    figures = {}
  }
  const savedTag = root.querySelector('[data-saved]')
  const errorTag = root.querySelector('[data-error]')
  const DAYS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam']

  function lines(field) {
    const area = root.querySelector(`textarea[data-field="${field}"]`)
    if (!area) return []
    return area.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function collect() {
    const blockers = {}
    for (const row of root.querySelectorAll('tr[data-blocker]')) {
      const id = row.dataset.blocker
      const read = (field) => row.querySelector(`[data-field="${field}"]`)?.value?.trim() ?? ''
      blockers[id] = { cause: read('cause'), action: read('action'), due: read('due'), owner: read('owner') }
    }
    return {
      date,
      decision: root.querySelector('textarea[data-field="decision"]')?.value?.trim() ?? '',
      blockers,
      night: lines('night'),
      tomorrow: lines('tomorrow'),
    }
  }

  function registryLine(day) {
    const stamp = new Date(`${day.date}T12:00:00`)
    const merged = Number(figures.merged) || 0
    const delivered = Number(figures.delivered) || 0
    const cost = (Number(figures.cost) || 0).toFixed(2).replace('.', ',')
    const decision = day.decision ? day.decision.replace(/\|/g, '/').replace(/\n/g, ' ') : 'à faire'
    return `| ${day.date} (${DAYS[stamp.getDay()]}) | ${merged} | ${delivered > 0 ? delivered : '—'} | ${Number(figures.inflight) || 0} | ${Number(figures.waiting) || 0} | ${cost} $ | ${decision} |`
  }

  function markdown() {
    const day = collect()
    const night = day.night.length ? day.night.join(' ; ') : 'rien'
    const tomorrow = day.tomorrow.length ? day.tomorrow.join(' ; ') : 'rien'
    return `${registryLine(day)}\n\n**Nuit** — ${night}\n\n**Lendemain** — ${tomorrow}`
  }

  let timer = null
  let lastSaved = null

  function markSaving() {
    if (savedTag) savedTag.textContent = 'enregistrement…'
  }

  function markSaved(at) {
    lastSaved = at
    if (!savedTag) return
    const time = new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    savedTag.textContent = `enregistré à ${time}`
  }

  function markError(message) {
    if (errorTag) errorTag.textContent = message
  }

  async function save() {
    markSaving()
    try {
      const response = await fetch(`/performance/api/bilan/day?date=${encodeURIComponent(date)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collect()),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      markError('')
      markSaved(payload.day?.updatedAt ?? new Date().toISOString())
    } catch (error) {
      markError(`non enregistré (${error.message})`)
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    markSaving()
    timer = setTimeout(save, 700)
  }

  root.addEventListener('input', schedule)
  root.addEventListener('change', schedule)

  const copy = root.querySelector('[data-copy]')
  if (copy) {
    copy.addEventListener('click', async () => {
      const text = markdown()
      const pre = root.querySelector('.bilan-src')
      if (pre) pre.textContent = text
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      }
      const label = copy.innerHTML
      copy.innerHTML = 'Copié'
      setTimeout(() => {
        copy.innerHTML = label
      }, 1600)
    })
  }

  if (lastSaved == null && savedTag && root.dataset.saved) markSaved(root.dataset.saved)
  const EPIC_STORE = 'performance.epicView'
  const epicState = { mode: 'dev', base: 'missions' }

  function applyEpicView() {
    const view = `${epicState.mode}-${epicState.base}`
    for (const el of document.querySelectorAll('.epicvar')) {
      const show = el.dataset.view === view
      el.style.display = show ? (el.tagName === 'I' ? 'block' : 'inline') : 'none'
    }
    for (const button of document.querySelectorAll('[data-epic-mode] button[data-mode]')) {
      button.classList.toggle('on', button.dataset.mode === epicState.mode)
    }
    for (const button of document.querySelectorAll('[data-epic-base] button[data-base]')) {
      button.classList.toggle('on', button.dataset.base === epicState.base)
    }
  }

  try {
    const [savedMode, savedBase] = String(localStorage.getItem(EPIC_STORE) || '').split('-')
    if (savedMode === 'dev' || savedMode === 'done') epicState.mode = savedMode
    if (savedBase === 'points' || savedBase === 'missions') epicState.base = savedBase
  } catch {}
  applyEpicView()

  document.addEventListener('click', (event) => {
    const baseButton = event.target.closest?.('[data-epic-base] button[data-base]')
    const modeButton = event.target.closest?.('[data-epic-mode] button[data-mode]')
    if (!baseButton && !modeButton) return
    event.preventDefault()
    if (baseButton) epicState.base = baseButton.dataset.base
    if (modeButton) epicState.mode = modeButton.dataset.mode
    try {
      localStorage.setItem(EPIC_STORE, `${epicState.mode}-${epicState.base}`)
    } catch {}
    applyEpicView()
  })
})()
