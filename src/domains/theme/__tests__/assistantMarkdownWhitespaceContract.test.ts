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

  it('aligns the reasoning fast path with parsed soft-break semantics', () => {
    // Inside the reasoning body the parsed path has no pre-wrap scope, so a
    // single source newline collapses to a space (CommonMark). The plain fast
    // path must agree, otherwise a streaming reasoning tail flips between the
    // two geometries on every tick (shattered lines + height oscillation).
    expect(chatCss).toMatch(/\.term-reasoning-body\s+\.term-plain-text\s*\{[^}]*white-space\s*:\s*normal/s)
  })
})
