// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * SheetErrorBoundary 行为测试（报告 8.2）：
 * Sheet 渲染异常被隔离（显示错误态 + retry 恢复），不扩散。
 *
 * #515：迁移自 SheetErrorBoundary.test.tsx（React RTL → @solidjs/testing-library）。
 * 改写点登记：
 * - `render(<SheetErrorBoundary>…)` → `render(() => …)`，实体直连 SheetErrorBoundary.solid.tsx；
 * - React `rerender`（外部修复后换 children，边界错误态保留）→ 信号驱动：修复开关
 *   `fixed()` 由探针组件体读取（untrack），「外部修复」只翻转信号——Solid ErrorBoundary
 *   出错后已卸载 children 改渲染 fallback，信号翻转不会自行复位边界，等价保留
 *   「ErrorBoundary state 保留」语义；点击重试（reset）后 children 以已修复状态重建；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - 断言集逐字保留（错误标题/原始错误文案/role=alert/重试后新内容）。
 */
import { createSignal, type JSX } from 'solid-js'
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import SheetErrorBoundary from '../../workspace-sheets/SheetErrorBoundary.solid.tsx'

// vitest globals 未开，solid testing-library 不自动 cleanup。
afterEach(cleanup)

describe('SheetErrorBoundary', () => {
  it('Sheet 渲染异常 → 错误态，retry 恢复后显示新内容', () => {
    const [fixed, setFixed] = createSignal(false)

    // 修复开关经组件体（untrack）读取：保证「外部修复」不触发边界自动复位，
    // 与 React rerender 版「ErrorBoundary state 保留」语义逐点对齐。
    function CrashProbe(props: { fixed: () => boolean }): JSX.Element {
      if (!props.fixed()) throw new Error('boom in sheet')
      return <div>normal content</div>
    }

    render(() => (
      <SheetErrorBoundary sheetId="s1">
        <CrashProbe fixed={fixed} />
      </SheetErrorBoundary>
    ))
    expect(screen.getByText('此 Sheet 渲染失败')).toBeTruthy()
    expect(screen.getByText(/boom in sheet/)).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    // 外部修复（原 React rerender 换 children；此处信号翻转）后错误态保留；点击重试清 error 渲染新内容
    setFixed(true)
    expect(screen.getByText('此 Sheet 渲染失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(screen.getByText('normal content')).toBeTruthy()
  })
})
