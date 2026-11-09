export function createPanelComponents(h) {
	const cx = (...names) => names.filter(Boolean).join(' ')

	function Panel(props) {
		return h('div', { className: cx('dsh-panel', props.className) }, props.children)
	}

	function PanelHead(props) {
		const Title = props.titleAs || 'h1'
		const Sub = props.subAs || 'p'
		return h(
			'div',
			{ className: cx('dsh-panel-head', props.inset && 'dsh-panel-head--inset', props.className) },
			h('div', null,
				h(Title, { className: 'dsh-panel-title' }, props.title),
				props.sub === undefined || props.sub === null || props.sub === false ? null : h(Sub, { className: 'dsh-panel-sub' }, props.sub),
				props.children),
			props.actions === undefined || props.actions === null || props.actions === false ? null : h(PanelActions, null, props.actions),
		)
	}

	function PanelActions(props) {
		return h('div', { className: cx('dsh-panel-actions', props.className) }, props.children)
	}

	function PanelButton(props) {
		const { primary, icon, quiet, className, type = 'button', children, ...rest } = props
		return h('button', {
			...rest,
			type,
			className: cx('dsh-panel-btn', primary && 'dsh-panel-btn--primary', icon && 'dsh-panel-btn--icon', quiet && 'dsh-panel-btn--quiet', className),
		}, children)
	}

	function PanelStat(props) {
		return h('span', { className: cx('dsh-panel-stat', props.className) },
			props.point ? h('i', { 'aria-hidden': 'true' }) : null,
			props.children)
	}

	function PanelTabs(props) {
		return h('div', { className: cx('dsh-panel-tabs', props.flush && 'dsh-panel-tabs--flush', props.className), role: 'tablist' },
			props.tabs.map((entry) => h('button', {
				key: entry.id,
				type: 'button',
				role: 'tab',
				'aria-selected': entry.id === props.active ? 'true' : 'false',
				className: 'dsh-panel-tab',
				onClick: () => props.onSelect(entry.id),
			}, entry.icon || null, entry.label)))
	}

	function PanelInput(props) {
		const { className, ...rest } = props
		return h('input', { ...rest, className: cx('dsh-panel-input', className) })
	}

	function PanelSelect(props) {
		const { className, children, ...rest } = props
		return h('select', { ...rest, className: cx('dsh-panel-select', className) }, children)
	}

	function PanelToolbar(props) {
		return h('div', { className: cx('dsh-panel-toolbar', props.className) }, props.children)
	}

	return { Panel, PanelHead, PanelActions, PanelButton, PanelStat, PanelTabs, PanelToolbar, PanelInput, PanelSelect }
}
