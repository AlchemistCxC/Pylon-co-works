import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pathname = decodeURIComponent(new URL('../../../product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const css = readFileSync(pathname, 'utf8')

describe('Terminal-like motion contract', () => {
  it('动画排除冻结的经典终端并提供 reduced-motion 降级', () => {
    expect(css).toContain(':not([data-presentation-profile="builtin.presentation.terminal-classic"]) .term-collapse')
    expect(css).toContain('grid-template-rows 210ms')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
  })
})
