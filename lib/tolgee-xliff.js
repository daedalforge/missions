/**
 * XLIFF 1.2 serialization of the import the panel prepares.
 *
 * One `trans-unit` per key: the key is both `id` and `resname`, the French
 * value is both `source` and `target` (the platform imports it as-is), and the
 * note names the occurrences so a translator can find the call site. Every
 * value is escaped: the file is the only thing Tolgee ever reads.
 */

const HEADER = '<?xml version="1.0" encoding="UTF-8"?>'

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function transUnit(entry) {
  const key = escapeXml(entry.key)
  const value = escapeXml(entry.value)
  const note = escapeXml((entry.occurrences ?? []).join(', '))
  return [
    `      <trans-unit id="${key}" resname="${key}">`,
    `        <source>${value}</source>`,
    `        <target>${value}</target>`,
    `        <note>${note}</note>`,
    '      </trans-unit>',
  ].join('\n')
}

/** A complete XLIFF 1.2 document for `entries`, with the French value. */
export function buildXliff({ entries = [], original = 'missions' } = {}) {
  const units = entries.map(transUnit).join('\n')
  const body = units ? `\n${units}\n    ` : ''
  return [
    HEADER,
    '<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">',
    `  <file source-language="fr" target-language="fr" original="${escapeXml(original)}" datatype="plaintext">`,
    `    <body>${body}</body>`,
    '  </file>',
    '</xliff>',
    '',
  ].join('\n')
}
