// @vitest-environment jsdom
// #515：迁移自 ColorPopover.a11y.test.tsx（React RTL → Solid 实体直连；断言集原样保留，
// 无改写点）。下沉自 scripts/test-accessibility.mts（P91 A2）：颜色选择器的读屏可达性
// 原为源码 token 断言，改为渲染后行为断言。
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import ColorPopover from '../ColorPopover.solid.tsx'

afterEach(cleanup)

describe('ColorPopover a11y', () => {
  it('触发按钮默认有可读的可访问名，并反映展开态', () => {
    render(() => <ColorPopover value="#a855f7" onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: '打开颜色选择器' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('ariaLabel 覆盖默认可访问名', () => {
    render(() => <ColorPopover value="#a855f7" onChange={() => {}} ariaLabel="强调色" />)
    expect(screen.getByRole('button', { name: '强调色' })).toBeInTheDocument()
  })

  it('展开后的背板是可键盘触达的关闭按钮（set-color-backdrop）', () => {
    render(() => <ColorPopover value="#a855f7" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '打开颜色选择器' }))
    const backdrop = screen.getByRole('button', { name: '关闭颜色选择器' })
    expect(backdrop.className).toBe('set-color-backdrop')
    fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('紧凑模式（chips=false）的直取色钮仍带可访问名', () => {
    render(() => <ColorPopover value="#a855f7" onChange={() => {}} chips={false} />)
    expect(screen.getByRole('button', { name: '选择颜色' })).toBeInTheDocument()
  })
})
