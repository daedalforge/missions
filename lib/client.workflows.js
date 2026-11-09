window.__ModuleLoader__.load({
  id: '@daedalforge/dsh-missions',
  chunk: 'client.workflows.js',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Panel, PanelHead, PanelButton, PanelStat, PanelToolbar } = require('dsh-theme-konoha/client')
    const exports = {}

    const LIST_URL = 'missions/api/workflows/list'
    const MODEL_URL = 'missions/api/workflows/model'
    const STYLE_ID = 'dsh-missions-workflows'

    const WRITERS = ['principal', 'orchestrateur', 'implementer', 'reviewer', 'outil']
    const STATUSES = ['draft', 'ready', 'active', 'in_review', 'in_peer_review', 'awaiting_validation', 'done', 'abandoned']
    const WRITER_COLOR = {
      principal: '#23A6D9',
      orchestrateur: '#1B9CD6',
      implementer: '#5B8C5A',
      reviewer: '#9C6AB8',
      outil: '#8A8A8A',
    }

    const CSS = `
.wf-panel { display: flex; flex-direction: column; gap: 12px; }
.wf-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.wf-canvas { border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; overflow: auto; padding: 8px; }
.wf-node { cursor: pointer; }
.wf-node rect { stroke: #d5d5d5; }
.wf-node rect.wf-node-bar { stroke: none; }
.wf-node.is-selected rect { stroke: #23a6d9; stroke-width: 2; }
.wf-node.is-selected rect.wf-node-bar { stroke: none; }
.wf-node text { font-family: Poppins, sans-serif; font-size: 11px; fill: #263238; }
.wf-node .wf-node-id { font-size: 9px; fill: #7a7a7a; }
.wf-edge { stroke: #b9b9b9; stroke-width: 1.2; fill: none; }
.wf-edge-label { font-family: Poppins, sans-serif; font-size: 8px; fill: #8a8a8a; }
.wf-inspector { border: 1px solid #e0e0e0; border-radius: 4px; padding: 12px; background: #fff; display: flex; flex-direction: column; gap: 8px; }
.wf-field { display: flex; flex-direction: column; gap: 4px; }
.wf-field label { font-size: 11px; color: #5f6b73; text-transform: uppercase; letter-spacing: .04em; }
.wf-field input, .wf-field select, .wf-field textarea { font-family: Poppins, sans-serif; font-size: 12px; line-height: 1.4; color: #263238; background: #fff; border: 1px solid #d5d5d5; border-radius: 4px; padding: 6px; }
.wf-field input, .wf-field select { height: 30px; }
.wf-field select { appearance: auto; }
.wf-field textarea { min-height: 48px; resize: vertical; }
.wf-errors { border: 1px solid #ed6d02; border-radius: 4px; padding: 8px 12px; background: #fff6ef; color: #7a3a00; font-size: 12px; }
.wf-errors ul { margin: 4px 0 0 16px; padding: 0; }
.wf-note { font-size: 12px; color: #5f6b73; }
.wf-edges { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.wf-edges button { align-self: flex-start; }
.wf-arc-form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.wf-arc-form select { height: 30px; font-family: Poppins, sans-serif; font-size: 12px; color: #263238; background: #fff; border: 1px solid #d5d5d5; border-radius: 4px; padding: 0 6px; flex: 1; min-width: 0; }
.wf-subhead { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: #8a8a8a; margin: 14px 0 6px; }
.wf-edges > div { display: flex; align-items: center; gap: 8px; padding: 3px 0; border-bottom: 1px solid #eee; font-size: 12px; color: #263238; }
.wf-edges > div > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-ok { color: #2e7d32; font-size: 12px; }
.wf-select { height: 30px; font-family: Poppins, sans-serif; font-size: 12px; color: #263238; background: #fff; border: 1px solid #d5d5d5; border-radius: 4px; padding: 0 6px; }
.wf-panel, .wf-panel .wf-note, .wf-panel .wf-errors { font-family: Poppins, sans-serif; }
`

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-missions'
      style.textContent = CSS
      document.head.append(style)
    }

    function layout(model) {
      const outgoing = new Map(model.nodes.map((node) => [node.id, []]))
      for (const edge of model.edges) {
        if (outgoing.has(edge.from)) outgoing.get(edge.from).push(edge.to)
      }
      const state = new Map()
      const back = new Set()
      const walk = (id) => {
        state.set(id, 'active')
        for (const next of outgoing.get(id) ?? []) {
          const seen = state.get(next)
          if (seen === 'active') back.add(`${id}->${next}`)
          else if (seen === undefined) walk(next)
        }
        state.set(id, 'done')
      }
      for (const node of model.nodes) if (!state.has(node.id)) walk(node.id)

      const depth = new Map(model.nodes.map((node) => [node.id, 0]))
      const order = []
      const pending = new Map(model.nodes.map((node) => [node.id, 0]))
      for (const edge of model.edges) {
        if (back.has(`${edge.from}->${edge.to}`) || !pending.has(edge.to)) continue
        pending.set(edge.to, pending.get(edge.to) + 1)
      }
      const ready = model.nodes.filter((node) => pending.get(node.id) === 0).map((node) => node.id)
      while (ready.length > 0) {
        const id = ready.shift()
        order.push(id)
        for (const next of outgoing.get(id) ?? []) {
          if (back.has(`${id}->${next}`) || !pending.has(next)) continue
          depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1))
          pending.set(next, pending.get(next) - 1)
          if (pending.get(next) === 0) ready.push(next)
        }
      }
      for (const node of model.nodes) if (!order.includes(node.id)) order.push(node.id)

      const columns = new Map()
      for (const node of model.nodes) {
        const level = depth.get(node.id) ?? 0
        if (!columns.has(level)) columns.set(level, [])
        columns.get(level).push(node.id)
      }
      const positions = new Map()
      for (const [level, ids] of columns) {
        ids.forEach((id, index) => {
          positions.set(id, { x: 24 + level * 240, y: 24 + index * 68 })
        })
      }
      return positions
    }

    function nodeTitle(node) {
      const text = node.section || node.id
      return text.length > 24 ? `${text.slice(0, 23)}…` : text
    }

    function Graph(props) {
      const { model, selected, onSelect } = props
      const positions = layout(model)
      const width = Math.max(320, ...[...positions.values()].map((point) => point.x + 196))
      const height = Math.max(160, ...[...positions.values()].map((point) => point.y + 56))
      const edges = model.edges.map((edge, index) => {
        const from = positions.get(edge.from)
        const to = positions.get(edge.to)
        if (!from || !to) return null
        const x1 = from.x + 190
        const y1 = from.y + 19
        const x2 = to.x
        const y2 = to.y + 19
        const mid = (x1 + x2) / 2
        return h(
          'g',
          { key: `edge-${index}` },
          h('path', {
            className: 'wf-edge',
            markerEnd: 'url(#wf-arrow)',
            d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
          }),
          edge.when
            ? h(
                'text',
                {
                  className: 'wf-edge-label',
                  x: mid,
                  y: (y1 + y2) / 2 - 6,
                  textAnchor: 'middle',
                  style: { paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 },
                },
                edge.when.length > 30 ? `${edge.when.slice(0, 29)}…` : edge.when,
              )
            : null,
        )
      })
      return h(
        'div',
        { className: 'wf-canvas' },
        h(
          'svg',
          { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', style: { display: 'block' } },
          h(
            'defs',
            null,
            h(
              'marker',
              { id: 'wf-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' },
              h('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: '#b9b9b9' }),
            ),
          ),
          edges,
          model.nodes.map((node) => {
            const point = positions.get(node.id)
            const color = WRITER_COLOR[node.writer] ?? '#8a8a8a'
            return h(
              'g',
              {
                key: node.id,
                className: `wf-node${node.id === selected ? ' is-selected' : ''}`,
                onClick: () => onSelect(node.id),
              },
              h('rect', { x: point.x, y: point.y, width: 190, height: 38, rx: 4, stroke: color, fill: '#f7fbfd' }),
              h('rect', { className: 'wf-node-bar', x: point.x, y: point.y, width: 4, height: 38, rx: 2, fill: color, stroke: 'none' }),
              h('text', { x: point.x + 8, y: point.y + 16 }, nodeTitle(node)),
              h(
                'text',
                { className: 'wf-node-id', x: point.x + 8, y: point.y + 30 },
                `${node.writer}${node.status ? ` · ${node.status}` : ''}`,
              ),
            )
          }),
        ),
      )
    }

    function Inspector(props) {
      const { model, selected, onChange, onDelete } = props
      const node = model.nodes.find((entry) => entry.id === selected)
      if (!node) return h('div', { className: 'wf-inspector' }, h('p', { className: 'wf-note' }, 'Sélectionne un geste dans le graphe.'))
      const update = (patch) =>
        onChange({ ...model, nodes: model.nodes.map((entry) => (entry.id === node.id ? { ...entry, ...patch } : entry)) })
      return h(
        'div',
        { className: 'wf-inspector' },
        h('div', { className: 'wf-field' }, h('label', null, 'Identifiant'), h('input', {
          value: node.id,
          onChange: (event) => update({ id: event.target.value }),
        })),
        h('div', { className: 'wf-field' }, h('label', null, 'Section du document'), h('input', {
          value: node.section ?? '',
          onChange: (event) => update({ section: event.target.value }),
        })),
        h('div', { className: 'wf-field' }, h('label', null, 'Écrivain'), h(
          'select',
          { value: node.writer ?? 'orchestrateur', onChange: (event) => update({ writer: event.target.value }) },
          WRITERS.map((writer) => h('option', { key: writer, value: writer }, writer)),
        )),
        h('div', { className: 'wf-field' }, h('label', null, 'Statut écrit'), h(
          'select',
          { value: node.status ?? '', onChange: (event) => update({ status: event.target.value || undefined }) },
          [h('option', { key: '', value: '' }, 'aucun')].concat(
            STATUSES.map((status) => h('option', { key: status, value: status }, status)),
          ),
        )),
        h('div', { className: 'wf-field' }, h('label', null, 'Condition'), h('textarea', {
          value: node.condition ?? '',
          onChange: (event) => update({ condition: event.target.value || undefined }),
        })),
        h('div', { className: 'wf-field' }, h('label', null, 'Artefact'), h('textarea', {
          value: node.artifact ?? '',
          onChange: (event) => update({ artifact: event.target.value || undefined }),
        })),
        h('div', { className: 'wf-field' }, h('label', null, 'Preuve ou porte'), h('textarea', {
          value: node.gate ?? '',
          onChange: (event) => update({ gate: event.target.value || undefined }),
        })),
        h(PanelButton, { onClick: () => onDelete(node.id) }, 'Supprimer le geste'),
      )
    }

    function WorkflowsPanel(props) {
      ensureStyles()
      const tabs = props?.tabs ?? null
      const [state, setState] = React.useState({ loading: true, error: null, list: null })
      const [workflow, setWorkflow] = React.useState('missions')
      const [model, setModel] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [arc, setArc] = React.useState({ from: '', to: '' })
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(LIST_URL, { credentials: 'same-origin' })
          const payload = await response.json()
          if (!payload.ok) throw new Error(payload.error?.message ?? 'lecture refusée')
          setState({ loading: false, error: null, list: payload.value })
          const entry = payload.value.workflows.find((candidate) => candidate.workflow === workflow)
          if (entry && !dirty) setModel(entry.models)
        } catch (error) {
          setState({ loading: false, error: error instanceof Error ? error.message : String(error), list: null })
        }
      }, [workflow, dirty])

      React.useEffect(() => {
        load()
      }, [load])

      const entry = state.list?.workflows.find((candidate) => candidate.workflow === workflow)

      const chooseWorkflow = (next) => {
        setWorkflow(next)
        setSelected(null)
        setDirty(false)
        setStatus(null)
        const found = state.list?.workflows.find((candidate) => candidate.workflow === next)
        setModel(found ? found.models : null)
      }

      const edit = (nextModel) => {
        setModel(nextModel)
        setDirty(true)
        setStatus(null)
      }

      const save = async () => {
        if (!model) return
        setBusy(true)
        try {
          const response = await fetch(MODEL_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workflow,
              model: {
                workflow: model.workflow,
                title: model.title,
                document: model.document,
                nodes: model.nodes,
                edges: model.edges,
              },
            }),
          })
          const payload = await response.json()
          if (!payload.ok) {
            setStatus({ kind: 'error', errors: payload.error?.errors ?? [payload.error?.message ?? 'enregistrement refusé'] })
            return
          }
          setDirty(false)
          setStatus({ kind: 'ok', text: `${workflow} : modèle enregistré et validé.` })
          await load()
        } catch (error) {
          setStatus({ kind: 'error', errors: [error instanceof Error ? error.message : String(error)] })
        } finally {
          setBusy(false)
        }
      }

      const addNode = () => {
        if (!model) return
        let index = model.nodes.length + 1
        let id = `geste-${index}`
        while (model.nodes.some((node) => node.id === id)) {
          index += 1
          id = `geste-${index}`
        }
        edit({ ...model, nodes: model.nodes.concat({ id, section: '', writer: 'orchestrateur' }) })
        setSelected(id)
      }

      const deleteNode = (id) => {
        if (!model) return
        edit({
          ...model,
          nodes: model.nodes.filter((node) => node.id !== id),
          edges: model.edges.filter((edge) => edge.from !== id && edge.to !== id),
        })
        setSelected(null)
      }

      const openArc = () => {
        if (!model || !arc.from || !arc.to || arc.from === arc.to) return
        if (model.edges.some((edge) => edge.from === arc.from && edge.to === arc.to)) return
        edit({ ...model, edges: model.edges.concat({ from: arc.from, to: arc.to }) })
        setArc({ from: '', to: '' })
      }

      const closeArc = (target) => {
        if (!model) return
        edit({ ...model, edges: model.edges.filter((edge) => !(edge.from === target.from && edge.to === target.to)) })
      }

      const head = h(PanelHead, {
        title: 'Workflows',
        sub: 'Les sept parcours de konoha, en graphes de gestes : le modèle porte l\'ordre, l\'écrivain, la condition et la preuve.',
        actions: h(React.Fragment, null,
          h(PanelStat, { point: true }, `${entry ? entry.gestures : 0} gestes`),
          h(PanelStat, null, `${entry ? entry.arcs : 0} arcs`),
          h(PanelButton, { primary: true, disabled: busy || !dirty, onClick: save }, busy ? 'Enregistrement…' : 'Enregistrer'),
        ),
      })

      if (state.loading) return h(Panel, { className: 'wf-panel' }, head, tabs, h('p', { className: 'wf-note' }, 'Lecture des modèles…'))
      if (state.error) return h(Panel, { className: 'wf-panel' }, head, tabs, h('div', { className: 'wf-errors' }, state.error))

      const options = state.list.workflows.map((candidate) => h('option', { key: candidate.workflow, value: candidate.workflow }, candidate.workflow))
      const nodeOptions = model
        ? model.nodes.map((node) => h('option', { key: node.id, value: node.id }, node.id))
        : []

      return h(
        Panel,
        { className: 'wf-panel' },
        head,
        tabs,
        h(PanelToolbar, null,
          h('select', { className: 'wf-select', value: workflow, onChange: (event) => chooseWorkflow(event.target.value) }, options),
          h(PanelStat, null, entry?.title ?? ''),
          h(PanelButton, { onClick: addNode }, 'Ajouter un geste'),
          h(PanelButton, { onClick: () => load() }, 'Relire les fichiers'),
          dirty ? h(PanelStat, { point: true }, 'modifications non enregistrées') : null,
        ),
        status?.kind === 'ok' ? h('p', { className: 'wf-ok' }, status.text) : null,
        status?.kind === 'error'
          ? h('div', { className: 'wf-errors' },
              h('strong', null, 'Modèle refusé'),
              h('ul', null, status.errors.map((error, index) => h('li', { key: index }, String(error)))),
            )
          : null,
        entry?.errors?.length && !status
          ? h('div', { className: 'wf-errors' },
              h('strong', null, `${entry.errors.length} écart(s) entre le modèle et le document`),
              h('ul', null, entry.errors.map((error, index) => h('li', { key: index }, error))),
            )
          : null,
        model
          ? h('div', { className: 'wf-grid' },
              h(Graph, { model, selected, onSelect: setSelected }),
              h('div', null,
                h(Inspector, { model, selected, onChange: edit, onDelete: deleteNode }),
                h('div', { className: 'wf-inspector' },
                  h('div', { className: 'wf-subhead' }, 'Ouvrir un arc'),
                  h('div', { className: 'wf-arc-form' },
                    h('select', { value: arc.from, onChange: (event) => setArc({ ...arc, from: event.target.value }) },
                      [h('option', { key: '', value: '' }, 'depuis…')].concat(nodeOptions)),
                    h('select', { value: arc.to, onChange: (event) => setArc({ ...arc, to: event.target.value }) },
                      [h('option', { key: '', value: '' }, 'vers…')].concat(nodeOptions)),
                    h(PanelButton, { disabled: !arc.from || !arc.to || arc.from === arc.to, onClick: openArc }, 'Ouvrir l\'arc'),
                  ),
                  h('div', { className: 'wf-subhead' }, `Arcs (${model.edges.length})`),
                  h('div', { className: 'wf-edges' },
                    model.edges.map((edge, index) => h('div', { key: index },
                      h('span', null, `${edge.from} → ${edge.to}${edge.when ? ` · ${edge.when}` : ''}`),
                      h(PanelButton, { quiet: true, onClick: () => closeArc(edge) }, 'fermer'),
                    )),
                  ),
                ),
              ),
            )
          : h('p', { className: 'wf-note' }, 'Aucun modèle sélectionné.'),
      )
    }

    exports.WorkflowsPanel = WorkflowsPanel
    exports.layout = layout
    return exports
  },
})
