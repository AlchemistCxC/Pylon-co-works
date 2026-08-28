// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Keep the URL in a variable so Vite does not rewrite the expression as a
// browser asset URL during test transforms (which breaks Windows paths).
const cssRelativePath = '../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css'
const cssPath = decodeURIComponent(new URL(cssRelativePath, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const chatCss = readFileSync(cssPath, 'utf8')

describe('assistant Markdown whitespace contract', () => {
  it('keeps one line of visual separation between completed Markdown paragraphs', () => {
    // A Markdown parser emits sibling <p> blocks for a blank source line. The
    // source newline itself is not a rendered element, so the CSS contract
    // must provide the missing line-height-sized separation explicitly.
    expect(chatCss).toMatch(
      /\.term-assistant\s+\.term-p\s*\+\s*\.term-p\s*\{[^}]*margin-top\s*:\s*calc\([^}]*1em/s,
    )
    // Presentation profiles may provide a more specific paragraph rule. The
    // final row-scoped contract must still win for the actual assistant row.
    expect(chatCss).toMatch(
      /\.term-row-assistant\s+\.term-assistant\s+\.term-p\s*\+\s*\.term-p\s*\{[^}]*margin-top\s*:\s*calc\([^}]*1em/s,
    )
  })

  it('keeps literal newlines for the plain-text fast path', () => {
    expect(chatCss).toMatch(/\.term-plain-text\s*\{[^}]*white-space\s*:\s*pre-wrap/s)
    expect(chatCss).toMatch(/\.term-assistant\s+p\s*,\s*\.term-assistant\s+\.term-p\s*\{[^}]*white-space\s*:\s*pre-wrap/s)
  })
})
