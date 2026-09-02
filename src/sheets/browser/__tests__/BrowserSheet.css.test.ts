import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/browser/BrowserSheet.css',
  'utf8',
)

describe('browser address focus visual contract', () => {
  it('keeps focus feedback inset without an external glow or layout expansion', () => {
    const focusBlock = css.match(
      /\.browser-address-wrap:focus-within\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? ''

    expect(focusBlock).toContain('border-color: var(--border-focus)')
    expect(focusBlock).toContain('box-shadow: inset 0 -2px 0 var(--accent)')
    expect(focusBlock).not.toMatch(/0 0 0 2px/)
    expect(css).toContain('.browser-address:focus-visible')
    expect(css).toContain('outline: 1px solid var(--state-focus-ring)')
  })
})
