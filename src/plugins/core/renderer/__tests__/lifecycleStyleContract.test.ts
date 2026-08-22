import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pathname = decodeURIComponent(new URL('../../../product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const css = readFileSync(pathname, 'utf8')

describe('C13 lifecycle visual contract', () => {
  it('styles lifecycle and system cards through the declared severity and density settings', () => {
    expect(css).toMatch(/\.lifecycle-card[\s\S]*\.system-error-card[\s\S]*\.system-notice-card\s*\{[^}]*border-inline-start:\s*var\(--line-width-3\)\s+solid\s+var\(--lifecycle-severity-color/)
    expect(css).toMatch(/\[data-density="compact"\][^{]*\{[^}]*padding:/)
  })

  it('allows subtle entry motion but disables it for both runtime and OS reduced-motion signals', () => {
    expect(css).toMatch(/\[data-motion="subtle"\][^{]*\{[^}]*animation:\s*lifecycle-card-enter/)
    expect(css).toMatch(/\[data-reduced-motion="true"\][^{]*\{[^}]*animation:\s*none/)
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.lifecycle-card[\s\S]*animation:\s*none/)
  })
})
