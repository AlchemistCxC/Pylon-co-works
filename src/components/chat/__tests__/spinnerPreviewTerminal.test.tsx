// @vitest-environment jsdom
/**
 * 行为化承接 scripts/test-spinner-preview-terminal-states.mts：
 * GenerationFooter 在 done/cancelled/error 三终态下渲染不同总结文案，
 * running=false 时不渲染 spinner/停止按钮（原守卫断言 previewSummary 接线与
 * summary.reason 分支，这里直接渲染验证真实行为）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import GenerationFooter from '../GenerationFooter'
import { resetStores } from '../../../test/resetStores'
import type { GenerationSummary } from '../GenerationFooter'

const frames = ['⠋', '⠙', '⠹']

function summaryOf(reason: GenerationSummary['reason']): GenerationSummary {
  return { elapsedMs: 3000, tokenCount: 1200, reason, completedFrame: '' }
}

describe('GenerationFooter 终态渲染（spinner-preview-terminal-states 契约）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('done 终态显示"处理耗时"', () => {
    render(<GenerationFooter running={false} frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={summaryOf('done')} source={null} />)
    expect(screen.getByText(/处理耗时/)).toBeTruthy()
  })

  it('cancelled 终态显示"已停止"且不显示"处理耗时"', () => {
    render(<GenerationFooter running={false} frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={summaryOf('cancelled')} source={null} />)
    expect(screen.getByText(/已停止/)).toBeTruthy()
    expect(screen.queryByText(/处理耗时/)).toBeNull()
  })

  it('error 终态显示"处理失败"且不显示"处理耗时"', () => {
    render(<GenerationFooter running={false} frames={frames} tokenCount={1200} startTime={Date.now() - 3000} summary={summaryOf('error')} source={null} />)
    expect(screen.getByText(/处理失败/)).toBeTruthy()
    expect(screen.queryByText(/处理耗时/)).toBeNull()
  })

  it('running=true 不渲染终态文案（spinner 态与终态互斥）', () => {
    render(<GenerationFooter running frames={frames} tokenCount={1200} startTime={Date.now()} summary={null} source={null} />)
    expect(screen.queryByText(/处理耗时/)).toBeNull()
    expect(screen.queryByText(/已停止/)).toBeNull()
    expect(screen.queryByText(/处理失败/)).toBeNull()
  })
})
