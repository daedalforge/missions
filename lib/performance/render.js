import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { renderWeek } from './render-week.js'
import { renderMission } from './render-mission.js'
import { renderBilan } from './render-bilan.js'
import { renderTimeline } from './render-timeline.js'

const here = dirname(fileURLToPath(import.meta.url))
const panelCss = readFileSync(join(here, 'panel.css'), 'utf8')
const shellCss = readFileSync(join(here, 'theme-panel.css'), 'utf8')
const panelJs = readFileSync(join(here, 'panel.js'), 'utf8')

const pageCss = `
html,body{margin:0;height:100%;background:var(--bg,#050d0b);overflow:hidden}
.main.performance-page{height:100vh;min-height:0;display:flex;flex-direction:column}
.performance-page .pane{height:100%;min-height:0;overflow:auto}
.view{display:none}
.view.active{display:block}
`

export function renderPage({ week, mission, timeline } = {}) {
  let weekHtml = week ? renderWeek(week) : ''
  let missionHtml = mission ? renderMission(mission) : ''
  const timelineHtml = timeline ? renderTimeline(timeline) : ''
  if (timeline) {
    weekHtml = weekHtml.replace('class="view active"', 'class="view"')
    missionHtml = missionHtml.replace('class="view active"', 'class="view"')
  } else if (mission) {
    weekHtml = weekHtml.replace('class="view active"', 'class="view"')
    missionHtml = missionHtml.replace('class="view"', 'class="view active"')
  }
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Performance</title>
<style>${shellCss}
${panelCss}
${pageCss}</style>
</head>
<body>
<main class="main performance-page" id="main">${weekHtml}
${missionHtml}${timelineHtml}</main>
<script>${panelJs}</script>
</body>
</html>`
}

export function renderBilanPage(day) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bilan · ${day.date} · Performance</title>
<style>${shellCss}
${panelCss}
${pageCss}</style>
</head>
<body>
<main class="main performance-page" id="main">${renderBilan(day)}</main>
<script src="/performance/bilan.js"></script>
</body>
</html>`
}
