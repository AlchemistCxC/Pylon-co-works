import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-shell/styles/App.css',
  'utf8',
)

describe('titlebar menu visual contract', () => {
  it('keeps chrome menus square and compact', () => {
    const chromeBlock = css.match(
      /\.workspace-titlebar \.workspace-menu-chrome \{([\s\S]*?)\n\}/,
    )?.[1] ?? ''

    expect(chromeBlock).toContain('border-radius: 0')
    expect(chromeBlock).toContain('padding: 4px')
    expect(chromeBlock).toContain('min-width: 196px')
    expect(chromeBlock).toContain('var(--surface-overlay)')
    expect(chromeBlock).toContain('var(--stroke-strong)')
    expect(chromeBlock).toContain('var(--shadow-soft)')
  })

  it('uses a fixed check column and semantic state tokens for menu items', () => {
    expect(css).toContain('grid-template-columns: var(--workspace-menu-check-width) minmax(0, 1fr)')
    expect(css).toContain('background: var(--state-hover-bg)')
    expect(css).toContain('background: var(--state-selected-bg)')
    expect(css).toContain('outline: 1px solid var(--state-focus-ring)')
    expect(css).toContain('.workspace-titlebar .workspace-menu-chrome .workspace-menu-check')
  })
})
