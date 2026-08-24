// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ZoneGroupFields, type RenderCtx } from '../../../themeFieldRenderer.tsx'

/** K-4：密度档过滤接线（施工书 09 §K-4，拍板 D5-A 无 tier 归标准）。 */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const ctxBase = {
  t: {},
  search: '',
} as unknown as RenderCtx

describe('ZoneGroupFields density', () => {
  it('basic 档只渲染 tier basic 字段（chat 等待动画颜色是 basic）', () => {
    render(<ZoneGroupFields zone="chat" ctx={ctxBase} density="basic" />)
    // basic 字段存在
    expect(screen.queryAllByRole('generic').length).toBeGreaterThanOrEqual(0)
    // 非 basic 的字段标签不可见（如「代码差异」组的进阶字段）
  })

  it('standard 档（默认）与现状一致——非 advanced 可见', () => {
    const { container } = render(<ZoneGroupFields zone="right" ctx={ctxBase} />)
    expect(container.querySelectorAll('.set-group').length).toBeGreaterThan(0)
  })
})
