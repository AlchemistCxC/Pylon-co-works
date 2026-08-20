import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pathname = decodeURIComponent(new URL('../../../product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const css = readFileSync(pathname, 'utf8')

describe('non-classic composer visual contract', () => {
  it.each([
    'builtin.presentation.terminal-modern',
    'builtin.presentation.paper-low-contrast',
    'builtin.presentation.console-glass',
  ])('%s 拥有局部 composer 材质', profileId => {
    expect(css).toContain(`[data-presentation-profile="${profileId}"] .input-bar:not(.cli-mode)`)
  })

  it('Modern GUI 使用独立 command dock composer，经典终端被总作用域排除', () => {
    expect(css).toContain('[data-interface-mode="modern-gui"] .modern-command-dock .input-bar:not(.cli-mode)')
    expect(css).toContain(':not([data-presentation-profile="builtin.presentation.terminal-classic"]) .input-bar:not(.cli-mode)')
  })
})
