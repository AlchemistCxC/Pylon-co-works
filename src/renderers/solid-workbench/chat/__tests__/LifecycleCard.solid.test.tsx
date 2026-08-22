// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { SolidLifecycleCard } from '../LifecycleCard.solid.tsx'
import type { LifecycleState } from '../../../../domains/workbench/lifecycle/lifecycleModel.ts'

afterEach(() => cleanup())

const RETRYING: LifecycleState = {
  history: [],
  retry: {
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4000,
    error: {
      userSummary: 'Provider 过载',
      technicalMessage: '429 overloaded',
      code: 'provider_overloaded',
      recoverability: 'retry',
    },
  },
}

describe('SolidLifecycleCard (C13)', () => {
  it('renders retry attempt with countdown semantics and technical detail collapsed', () => {
    const result = render(() => <SolidLifecycleCard state={RETRYING} reducedMotion={true} />)
    const root = result.container.querySelector('.lifecycle-card')!
    expect(root.getAttribute('data-phase')).toBe('retry')
    expect(root.getAttribute('data-reduced-motion')).toBe('true')
    // alert 语义：retry 是活动状态，需要被辅助技术感知
    expect(root.getAttribute('role')).toBe('status')
    expect(result.container.textContent).toContain('第 2/3 次重试')
    expect(result.container.textContent).toContain('Provider 过载')
    // 技术详情默认折叠
    const details = result.container.querySelector('details.lifecycle-technical')!
    expect(details.hasAttribute('open')).toBe(false)
    expect(details.textContent).toContain('429 overloaded')
  })

  it('renders recovered summary and hides when idle', () => {
    const empty = render(() => <SolidLifecycleCard state={{ history: [] }} />)
    expect(empty.container.querySelector('.lifecycle-card')).toBeNull()
    empty.unmount()

    const recovered = render(() => <SolidLifecycleCard state={{
      history: [
        { kind: 'compact', phase: 'completed', summary: '保留最近 40 条', tokensBefore: 180000, tokensAfter: 42000 },
        { kind: 'recovered', source: 'agent-import', importedEvents: 42 },
      ],
      lastRecovery: { source: 'agent-import', importedEvents: 42 },
    }} />)
    expect(recovered.container.querySelector('.lifecycle-card')?.getAttribute('data-phase')).toBe('recovered')
    expect(recovered.container.textContent).toContain('保留最近 40 条')
    expect(recovered.container.textContent).toContain('42')
  })

  it('renders suspended reason without crashing on unknown shapes', () => {
    const result = render(() => <SolidLifecycleCard state={{
      history: [{ kind: 'suspended' }],
      suspended: { reason: '等待用户输入' },
    }} />)
    expect(result.container.querySelector('.lifecycle-card')?.getAttribute('data-phase')).toBe('suspended')
    expect(result.container.textContent).toContain('等待用户输入')
  })

  it('keeps completed compact and rewind results visible as terminal lifecycle states', () => {
    const compact = render(() => <SolidLifecycleCard state={{
      history: [],
      compact: {
        phase: 'completed',
        tokensBefore: 180000,
        tokensAfter: 42000,
        summary: '保留最近 40 条',
      },
    }} />)
    expect(compact.getByRole('status', { name: '生命周期：上下文压缩完成' })).toHaveAttribute('data-phase', 'compact')
    expect(compact.container).toHaveTextContent('180000→42000 tokens')
    expect(compact.container).toHaveTextContent('保留最近 40 条')
    compact.unmount()

    const rewind = render(() => <SolidLifecycleCard state={{
      history: [],
      rewind: {
        phase: 'completed',
        files: [{ path: 'src/app.tsx' }],
        messages: [{ id: 'message-1' }],
        summary: '恢复到检查点',
      },
    }} />)
    expect(rewind.getByRole('status', { name: '生命周期：回退完成' })).toHaveAttribute('data-phase', 'rewind')
    expect(rewind.container).toHaveTextContent('已还原 1 个文件、1 条消息')
    expect(rewind.container).toHaveTextContent('恢复到检查点')
  })
})
