import { describe, expect, it } from 'vitest'
import { toolConnectorMotionClass } from '../toolIndicatorMotion.ts'

// 下沉自 scripts/test-tool-connector-motion.mts（P91 A2）：连接线状态 → 动画 class
// 映射（动画 CSS 契约由 ChatView.css.test.ts 承担）。
describe('toolConnectorMotionClass 状态动画映射', () => {
  it('六态各自绑定正确动画 class', () => {
    expect(toolConnectorMotionClass('queued')).toBe('term-tool-connector--static')
    expect(toolConnectorMotionClass('running')).toBe('term-tool-connector--breathe')
    expect(toolConnectorMotionClass('waiting')).toBe('term-tool-connector--pulse')
    expect(toolConnectorMotionClass('completed')).toBe('term-tool-connector--settle')
    expect(toolConnectorMotionClass('failed')).toBe('term-tool-connector--flash')
    expect(toolConnectorMotionClass('cancelled')).toBe('term-tool-connector--static')
  })
})
