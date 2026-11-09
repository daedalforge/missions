(() => {
  const qs = () => new URLSearchParams(location.search)
  const iso = (d) => {
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const navigate = (params) => {
    const u = new URL(location.href)
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') u.searchParams.delete(k)
      else u.searchParams.set(k, v)
    }
    location.href = u.toString()
  }
  const currentPeriod = () => qs().get('period') || 'week'
  const currentAnchor = () => qs().get('anchor') || iso(new Date())

  const refresh = async () => {
    const btn = document.querySelector('[data-refresh]')
    if (btn) {
      btn.disabled = true
      btn.textContent = 'Calcul…'
    }
    try {
      const response = await fetch('/performance/api/refresh', { method: 'POST' })
      const data = await response.json()
      if (data?.ok) {
        location.reload()
        return
      }
    } catch {
    }
    if (btn) {
      btn.disabled = false
      btn.textContent = 'Rafraîchir'
    }
  }

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-screen],[data-mission],[data-period],[data-nav],[data-bilan],[data-refresh]')
    if (!el) return
    if (el.hasAttribute('data-refresh')) {
      event.preventDefault()
      refresh()
      return
    }
    const { screen, mission, period, nav } = el.dataset
    if (screen === 'timeline') {
      event.preventDefault()
      const u = new URL('/performance/timeline', location.origin)
      u.search = location.search
      location.href = u.toString()
      return
    }
    if (screen === 'semaine') {
      event.preventDefault()
      const u = new URL('/performance/panel', location.origin)
      u.search = location.search
      u.searchParams.delete('mission')
      location.href = u.toString()
      return
    }
    if (screen === 'mission') {
      event.preventDefault()
      const id = document.querySelector('tr[data-mission]')?.dataset.mission
      if (!id) return
      const u = new URL('/performance/panel', location.origin)
      u.search = location.search
      u.searchParams.set('mission', id)
      location.href = u.toString()
      return
    }
    if (mission) {
      event.preventDefault()
      navigate({ mission })
      return
    }
    if (period) {
      event.preventDefault()
      navigate({ period, anchor: '' })
      return
    }
    if (nav) {
      event.preventDefault()
      const dir = Number(nav) || 0
      const d = new Date(`${currentAnchor()}T12:00:00`)
      if (currentPeriod() === 'day') d.setDate(d.getDate() + dir)
      else if (currentPeriod() === 'month') d.setMonth(d.getMonth() + dir)
      else d.setDate(d.getDate() + 7 * dir)
      navigate({ anchor: iso(d) })
      return
    }
    if (el.hasAttribute('data-bilan')) {
      const bilan = document.querySelector('.bilan')
      if (el.closest('.bilanacts')) {
        event.preventDefault()
        const text = bilan ? bilan.innerText : ''
        const done = () => {
          el.textContent = 'Copié'
          setTimeout(() => { el.textContent = 'Copier' }, 1200)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done)
        else done()
      } else if (bilan) {
        bilan.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  })

  document.addEventListener('change', (event) => {
    const sel = event.target.closest('[data-filter]')
    if (sel) navigate({ [sel.dataset.filter]: sel.value })
  })
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
