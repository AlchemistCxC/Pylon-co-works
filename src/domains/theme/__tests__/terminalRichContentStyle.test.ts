import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pathname = decodeURIComponent(new URL('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1')
const css = readFileSync(pathname, 'utf8')

describe('terminal-like rich content style contract', () => {
  it('projects structured payloads and rich tool bodies as terminal records', () => {
    expect(css).toContain('.app[data-interface-mode="terminal-like"] :is(.solid-structured-content,.solid-unknown-content)')
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] :is\(\.solid-structured-content,\.solid-unknown-content\)\s*\{[^}]*border-left:/s)
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-tool-body\s*\{[^}]*background:transparent/s)
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.tool-kind-summary\s*\{[^}]*border-bottom:[^}]*background:transparent/s)
  })

  it('keeps terminal resources, progress and nested code compact', () => {
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.solid-structured-resource\s*\{[^}]*border:0[^}]*background:transparent/s)
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.solid-structured-progress\s*\{[^}]*height:2px/s)
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-code-block\s*\{[^}]*border-left:/s)
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-search-results\s*\{[^}]*border:0 !important[^}]*background:transparent !important/s)
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-link-card\s*\{[^}]*grid-template-columns:[^}]*border:0 !important/s)
    // The colored code-block rail replaces the per-line `│` gutter in the
    // terminal-like preset, so nested code does not show two vertical lines.
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.term-code-block \.term-code-gutter\s*\{[^}]*display:none/s)
  })
})
