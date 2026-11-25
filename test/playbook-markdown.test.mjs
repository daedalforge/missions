import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { renderPlaybookMarkdown } from '../lib/playbook-markdown.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/playbook/', import.meta.url))
const PAGES = ['cadrage.md', 'execution.md', 'revue.md', 'cloture.md', 'workspace.md']

async function fixture(name) {
  return readFile(new URL(`./fixtures/playbook/${name}`, import.meta.url), 'utf8')
}

test('le rendu numérote les six sections de 01 à 06', async () => {
  // Given
  const source = await fixture('execution.md')

  // When
  const html = renderPlaybookMarkdown(source)

  // Then
  const numbers = [...html.matchAll(/<h2 id="[^"]+"><span class="pb-doc-num">(\d{2})<\/span>/g)].map((match) => match[1])
  assert.deepEqual(numbers, ['01', '02', '03', '04', '05', '06'])
  assert.match(html, /<h2 id="avant-d-agir"><span class="pb-doc-num">01<\/span>Avant d&#39;agir<\/h2>/)
  assert.match(html, /<h2 id="la-fiche-du-depot"><span class="pb-doc-num">06<\/span>La fiche du dépôt<\/h2>/)
})

test('le rendu porte listes, tableau, code, gras, italique, lien et citation', async () => {
  // Given
  const source = await fixture('execution.md')

  // When
  const html = renderPlaybookMarkdown(source)

  // Then
  assert.match(html, /<ol><li>Premier geste\.<\/li><li>Second geste, qui cite <a href="\.\.\/workflows\/execution\.md">le document<\/a>\.<\/li><\/ol>/)
  assert.match(html, /<ul><li>Piège connu, <strong>en gras<\/strong> et en <em>italique<\/em>\.<\/li><\/ul>/)
  assert.match(html, /<pre class="pb-doc-pre"><code>node tools\/check-playbook\.mjs<\/code><\/pre>/)
  assert.match(html, /<blockquote><p>Une citation qui rappelle le contrat\.<\/p><\/blockquote>/)
  assert.match(html, /<table><thead><tr><th>Dépôt<\/th><th>Commandes<\/th><\/tr><\/thead><tbody>/)
  assert.match(html, /<tr><td><code>missions<\/code><\/td><td><code>npm test<\/code><\/td><\/tr>/)
  assert.match(html, /<li>Vérifier le ticket et la branche\.<\/li>/)
  assert.match(html, /<p>Document : workflows\/execution\.md<\/p>/)
})

test('le rendu échappe le HTML et ne lie pas un schéma exécutable', () => {
  // Given
  const source = [
    '# Titre <script>alert(1)</script>',
    '',
    'Un paragraphe <img src=x onerror=alert(1)> et du **<b>gras</b>**.',
    '',
    '[lien](javascript:alert(1)) et [relatif](../workflows/execution.md).',
  ].join('\n')

  // When
  const html = renderPlaybookMarkdown(source)

  // Then
  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /<strong>&lt;b&gt;gras&lt;\/b&gt;<\/strong>/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /<a href="\.\.\/workflows\/execution\.md">relatif<\/a>/)
})

test('les cinq pages passent par le rendu sans laisser de markdown brut', async () => {
  for (const name of PAGES) {
    // Given
    const source = await fixture(name)

    // When
    const html = renderPlaybookMarkdown(source)

    // Then
    assert.doesNotMatch(html, /(^|\n)#{1,6} /, `${name} : aucun titre brut`)
    assert.doesNotMatch(html, /```/, `${name} : aucune clôture de code brute`)
    assert.doesNotMatch(html, /\*\*/, `${name} : aucun gras brut`)
    assert.doesNotMatch(html, /\| ---/, `${name} : aucun séparateur de tableau brut`)
    assert.equal((html.match(/<h2 [^>]*>/g) ?? []).length, 6, `${name} : les six sections sont rendues`)
    assert.equal((html.match(/<span class="pb-doc-num">/g) ?? []).length, 6, `${name} : les six sections sont numérotées`)
  }
})
