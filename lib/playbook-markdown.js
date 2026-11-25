/**
 * The reading view's renderer: the bounded markdown subset a playbook page
 * uses. The host renders one page for the panel, so the document is escaped
 * before any syntax is applied — a page can never inject HTML into the panel.
 *
 * The subset is the one the five pages actually carry: headings, ordered and
 * unordered lists with their continuation lines, tables, fenced code, inline
 * code, bold, italics, links and blockquotes. The headings of the six contract
 * sections take their `01`–`06` number from `SECTIONS`, never from the page.
 */

import { SECTIONS } from './playbook-rules.js'

/** The code-span placeholders, restored after the inline syntax is applied. */
const CODE_TOKEN = '\u0000'

/** The hrefs a page may link to: no scheme that runs code. */
const UNSAFE_HREF = /^(?:javascript|data|vbscript):/i

const BLANK = /^\s*$/
const FENCE = /^```(\w*)\s*$/
const FENCE_END = /^```\s*$/
const HEADING = /^(#{1,6})\s+(.+?)\s*$/
const UNORDERED = /^([-*])\s+(.+)$/
const ORDERED = /^\d+\.\s+(.+)$/
const QUOTE = /^>\s?(.*)$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_ROW = /^\|.*\|\s*$/
const TABLE_SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/
const CONTINUATION = /^\s{2,}\S/

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** A stable anchor for a heading, derived from its text. */
function slugOf(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The `01`–`06` number of a contract section, or null for another heading. */
function sectionNumber(text) {
  const index = SECTIONS.indexOf(`## ${String(text).trim()}`)
  return index === -1 ? null : String(index + 1).padStart(2, '0')
}

function safeHref(href) {
  const value = String(href).trim()
  return UNSAFE_HREF.test(value) ? null : value
}

/** The inline syntax, applied to already escaped text. */
function inline(text) {
  const codes = []
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`)
    return `${CODE_TOKEN}${codes.length - 1}${CODE_TOKEN}`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const safe = safeHref(href)
    return safe === null ? match : `<a href="${safe}">${label}</a>`
  })
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)])
  return out
}

function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function renderTable(lines, start) {
  const header = cellsOf(lines[start])
  let index = start + 2
  const rows = []
  while (index < lines.length && TABLE_ROW.test(lines[index])) {
    rows.push(cellsOf(lines[index]))
    index += 1
  }
  const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
    .join('')
  return {
    html: `<table><thead><tr>${head}</tr></thead>${body === '' ? '' : `<tbody>${body}</tbody>`}</table>`,
    next: index,
  }
}

function collectList(lines, start) {
  const ordered = ORDERED.test(lines[start])
  const pattern = ordered ? ORDERED : UNORDERED
  const items = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    const item = pattern.exec(line)
    if (item) {
      items.push(ordered ? item[1] : item[2])
      index += 1
      continue
    }
    if (items.length > 0 && CONTINUATION.test(line)) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`
      index += 1
      continue
    }
    break
  }
  const tag = ordered ? 'ol' : 'ul'
  const html = `<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`
  return { html, next: index }
}

function collectQuote(lines, start) {
  const parts = []
  let index = start
  while (index < lines.length && QUOTE.test(lines[index])) {
    parts.push(QUOTE.exec(lines[index])[1])
    index += 1
  }
  return { html: `<blockquote><p>${inline(parts.join(' '))}</p></blockquote>`, next: index }
}

function isTableStart(lines, index) {
  return TABLE_ROW.test(lines[index]) && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1].trim())
}

function isBlockStart(lines, index) {
  const line = lines[index]
  return FENCE.test(line)
    || HEADING.test(line)
    || UNORDERED.test(line)
    || ORDERED.test(line)
    || QUOTE.test(line)
    || RULE.test(line)
    || isTableStart(lines, index)
}

function collectParagraph(lines, start) {
  const parts = []
  let index = start
  while (index < lines.length && !BLANK.test(lines[index]) && !isBlockStart(lines, index)) {
    parts.push(lines[index].trim())
    index += 1
  }
  return { html: `<p>${inline(parts.join(' '))}</p>`, next: index }
}

/** Render one playbook page to escaped HTML, without a wrapper. */
export function renderPlaybookMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (BLANK.test(line)) {
      index += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const body = []
      index += 1
      while (index < lines.length && !FENCE_END.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push(`<pre class="pb-doc-pre"><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = heading[2]
      const number = sectionNumber(text)
      const prefix = number === null ? '' : `<span class="pb-doc-num">${number}</span>`
      blocks.push(`<h${level} id="${slugOf(text)}">${prefix}${inline(text)}</h${level}>`)
      index += 1
      continue
    }
    if (isTableStart(lines, index)) {
      const table = renderTable(lines, index)
      blocks.push(table.html)
      index = table.next
      continue
    }
    if (QUOTE.test(line)) {
      const quote = collectQuote(lines, index)
      blocks.push(quote.html)
      index = quote.next
      continue
    }
    if (RULE.test(line)) {
      blocks.push('<hr>')
      index += 1
      continue
    }
    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const list = collectList(lines, index)
      blocks.push(list.html)
      index = list.next
      continue
    }
    const paragraph = collectParagraph(lines, index)
    blocks.push(paragraph.html)
    index = paragraph.next
  }
  return blocks.join('\n')
}
