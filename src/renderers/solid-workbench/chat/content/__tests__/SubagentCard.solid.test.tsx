// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SolidSubagentCard } from '../SubagentCard.solid.tsx'
import type { WorkbenchActivityNode } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C09 RED：子代理卡契约。
 * - rich 字段与层级来自节点列；缺失字段不渲染（不猜）；
 * - cancel/retry 仅 capability 允许且状态匹配时出现；
 * - synthetic provenance 可见；parts 内嵌 terminal/log 复用 C07 层。
 */

const richNode = {
  id: 'sub-1', kind: 'activity', activityKind: 'subagent', semanticKind: 'activity.subagent',
  title: 'Explore repo', status: 'running', parentId: 'tool-1', depth: 2,
  role: 'explorer', model: 'ox-alpha-free', provider: 'opencode-go',
  goal: 'find call sites', progress: { completed: 3, total: 5 },
  usage: { inputTokens: 1200, outputTokens: 340 }, files: ['src/a.ts'],
} as unknown as WorkbenchActivityNode

describe('C09 SolidSubagentCard', () => {
  it('renders rich metadata and hierarchy from node columns only', () => {
    const result = render(() => <SolidSubagentCard activity={richNode} />)
    expect(result.container.textContent).toContain('Explore repo')
    expect(result.container.textContent).toContain('explorer')
    expect(result.container.textContent).toContain('ox-alpha-free · opencode-go')
    expect(result.container.textContent).toContain('parent: tool-1')
    expect(result.container.textContent).toContain('find call sites')
    expect(result.container.textContent).toContain('进度 3/5')
    expect(result.container.textContent).toContain('1200 in · 340 out')
    expect(result.container.textContent).toContain('1 个文件')
    const card = result.container.querySelector('.term-subagent-card') as HTMLElement
    expect(card.dataset.depth).toBe('2')
    expect(card.style.getPropertyValue('--subagent-depth')).toBe('2')
    expect(card.getAttribute('role')).toBe('status')
  })

  it('degrades a minimal node without fabricating fields', () => {
    const minimal = { id: 'sub-2', kind: 'activity', activityKind: 'team', status: 'failed' } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={minimal} />)
    expect(result.container.querySelector('[data-depth="0"]')).not.toBeNull()
    expect(result.container.textContent).not.toContain('parent:')
    expect(result.container.textContent).not.toContain('目标：')
  })

  it('gates cancel/retry actions behind command capabilities and status', async () => {
    const execute = vi.fn()
    const canExecute = (type: string) => type === 'activity.cancel'
    const running = render(() => <SolidSubagentCard activity={richNode} commands={{ execute, canExecute }} />)
    expect([...running.container.querySelectorAll('button')].map(b => b.title)).toEqual(['取消此子代理'])
    await running.container.querySelector('button')!.click()
    expect(execute).toHaveBeenCalledWith({ type: 'activity.cancel', targetId: 'sub-1' })

    // failed 节点：capability 只给了 cancel → retry 按钮仍不可见
    const failed = { ...richNode, status: 'failed' } as unknown as WorkbenchActivityNode
    const failedView = render(() => <SolidSubagentCard activity={failed} commands={{ execute, canExecute }} />)
    expect(failedView.container.querySelectorAll('button').length).toBe(0)

    // 无 commands → 无动作
    const bare = render(() => <SolidSubagentCard activity={richNode} />)
    expect(bare.container.querySelectorAll('button').length).toBe(0)
  })

  it('surfaces synthetic provenance and reuses terminal/log part rendering', () => {
    const withParts = {
      ...richNode,
      provenance: { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed' as const, synthetic: { reason: 'terminal response observed' } },
      parts: [
        { kind: 'terminal', streams: [{ stream: 'stdout', text: 'hello' }] },
        { kind: 'log', entries: [{ level: 'info', text: 'logged' }] },
      ],
    } as unknown as WorkbenchActivityNode
    const result = render(() => <SolidSubagentCard activity={withParts} />)
    expect(result.container.textContent).toContain('合成生命周期：terminal response observed')
    expect(result.container.querySelector('.term-terminal-card')).not.toBeNull()
    expect(result.container.querySelector('.term-log-card')).not.toBeNull()
  })
})
