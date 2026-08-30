// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWorkbenchClock } from '../../../../domains/workbench/fakeWorkbenchClock.ts'
import type { SpinnerAppearanceSnapshot } from '../../../../domains/workbench/appearance.ts'
import type { GenerationFooterLifecycle } from '../../../../domains/workbench/generationFooterContracts.ts'
import { SolidGenerationFooter, formatElapsed, formatTokens } from '../GenerationFooter.solid.tsx'

const APPEARANCE: SpinnerAppearanceSnapshot = {
  framePreset: 'ascii-line',
  frames: ['|', '/', '-', '\\'],
  motion: 'cycle',
  intervalMs: 120,
  verbSet: 'zh',
  verbs: ['验证中'],
  color: '#4488ff',
  stalledColor: '#ff4455',
  size: 14,
  doneMarker: '✓',
  cancelledMarker: '■',
  errorMarker: '✕',
  doneMarkerMode: 'custom',
  cancelledMarkerMode: 'custom',
  errorMarkerMode: 'custom',
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SolidGenerationFooter', () => {
  it('按 fake clock 推进 frame、elapsed、thinking duration 与 token catch-up', () => {
    const clock = createFakeWorkbenchClock(10_000)
    const result = render(() => <SolidGenerationFooter
      running
      tokenCount={100}
      startTime={10_000}
      lastTokenAt={10_000}
      summary={null}
      phase={{ kind: 'thinking' }}
      thinkingStart={9_000}
      appearance={APPEARANCE}
      showTokenCount
      clock={clock}
      random={() => 0}
    />)

    expect(result.container.querySelector('.spinner-frame')?.textContent).toBe('|')
    expect(result.container.textContent).toContain('0s')
    expect(result.container.textContent).toContain('思考 1s')
    expect(result.container.textContent).toContain('↓ 0 tokens')

    clock.advance(120)
    expect(result.container.querySelector('.spinner-frame')?.textContent).toBe('/')
    expect(result.container.textContent).toContain('↓ 25 tokens')

    clock.advance(880)
    expect(result.container.textContent).toContain('1s')
    expect(result.container.textContent).toContain('思考 2s')
    expect(result.container.textContent).toContain('↓ 91 tokens')
  })

  it('waiting/stalled 活动状态与 stall progress 随 idle 时间推进', async () => {
    const clock = createFakeWorkbenchClock(0)
    const result = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={0} lastTokenAt={0} summary={null}
      appearance={APPEARANCE} clock={clock} random={() => 0}
    />)
    const spinner = result.container.querySelector('.term-spinner') as HTMLElement
    expect(spinner.dataset.activity).toBe('active')

    clock.advance(3_200)
    expect(spinner.dataset.activity).toBe('waiting')
    clock.advance(3_000)
    await waitFor(() => expect(result.container.textContent).toContain('等待响应'))

    clock.advance(5_000)
    expect(spinner.dataset.activity).toBe('stalled')
    expect(Number(spinner.style.getPropertyValue('--stall-progress'))).toBeGreaterThan(0.35)
    expect(Number(spinner.style.getPropertyValue('--stall-progress'))).toBeLessThan(0.45)
    clock.advance(1_200)
    await waitFor(() => expect(result.container.textContent).toContain('仍在等待后端响应'))
  })

  it('默认隐藏 ChatView token 用量', () => {
    const result = render(() => <SolidGenerationFooter
      running tokenCount={1234} startTime={10_000} lastTokenAt={10_000} summary={null}
      appearance={APPEARANCE} clock={createFakeWorkbenchClock(10_000)}
    />)
    expect(result.container.textContent).not.toContain('tokens')
  })

  it('legacy startTime=0 在真实 epoch 时从当前时刻计时', () => {
    const clock = createFakeWorkbenchClock(1_800_000_000_000)
    const result = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={0} lastTokenAt={1_800_000_000_000} summary={null}
      appearance={APPEARANCE} clock={clock}
    />)
    expect(result.container.querySelector('.spinner-meta')).toHaveTextContent('(0s)')
  })

  it('tool phase 抑制 stalled，并使用工具标题；active task 覆盖 phase', () => {
    const clock = createFakeWorkbenchClock(10_000)
    const tool = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={0} lastTokenAt={0} summary={null}
      phase={{ kind: 'tool', name: 'Read' }} appearance={APPEARANCE} clock={clock} random={() => 0}
    />)
    expect((tool.container.querySelector('.term-spinner') as HTMLElement).dataset.activity).toBe('active')
    expect(tool.container.textContent).toContain('正在调用 Read')
    tool.unmount()

    const taskClock = createFakeWorkbenchClock(10_000)
    const task = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={10_000} lastTokenAt={10_000} summary={null}
      phase={{ kind: 'responding' }} activeTaskContent="执行 focused tests"
      appearance={APPEARANCE} clock={taskClock} random={() => 0}
    />)
    expect(task.container.textContent).toContain('正在执行 focused tests')
  })

  it('有 phase 时仍显示配置的预设主文案，而不是被固定阶段文案吞掉', () => {
    const result = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={0} lastTokenAt={0} summary={null}
      phase={{ kind: 'thinking' }}
      appearance={{ ...APPEARANCE, verbs: ['博大精深'] }}
      clock={createFakeWorkbenchClock(0)} random={() => 0}
    />)
    expect(result.container.querySelector('.spinner-verb')?.textContent).toContain('博大精深')
    expect(result.container.querySelector('.spinner-context')?.textContent).toContain('思考')
  })

  it('回合重启时重新选择 preset，且 waiting 恢复不会立即跳词', async () => {
    const clock = createFakeWorkbenchClock(0)
    const [running, setRunning] = createSignal(false)
    const [startTime, setStartTime] = createSignal(0)
    const [lastTokenAt, setLastTokenAt] = createSignal(0)
    const result = render(() => <SolidGenerationFooter
      running={running()} tokenCount={0} startTime={startTime()} lastTokenAt={lastTokenAt()} summary={null}
      phase={{ kind: 'thinking' }} appearance={{ ...APPEARANCE, verbs: ['博大精深', '大道至简'] }}
      clock={clock} random={() => 0}
    />)

    setRunning(true)
    await waitFor(() => expect(result.container.querySelector('.spinner-verb')).toHaveTextContent('博大精深'))
    clock.advance(3_240)
    await waitFor(() => expect(result.container.querySelector('.spinner-verb')).toHaveTextContent('等待响应'))

    setLastTokenAt(clock.now())
    await waitFor(() => expect((result.container.querySelector('.term-spinner') as HTMLElement).dataset.activity).toBe('active'))
    // active 恢复后仍先保留 waiting 文案；定时器到期才回到 preset。
    expect(result.container.querySelector('.spinner-verb')).toHaveTextContent('等待响应')
    // waiting 实际在最近一次 120ms tick（约 3,120ms）切入，
    // 所以从当前 3,240ms 到截止点还剩 1,080ms。
    clock.advance(1_079)
    expect(result.container.querySelector('.spinner-verb')).toHaveTextContent('等待响应')
    clock.advance(1)
    await waitFor(() => expect(result.container.querySelector('.spinner-verb')).toHaveTextContent('博大精深'))

    setRunning(false)
    await waitFor(() => expect(result.container.querySelector('.term-spinner')).toBeNull())
    setStartTime(5_000)
    setRunning(true)
    await waitFor(() => expect(result.container.querySelector('.spinner-verb')).toHaveTextContent('博大精深'))
  })

  it('reduced-motion 固定首帧且禁用 glimmer', () => {
    const clock = createFakeWorkbenchClock(0)
    const result = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={0} summary={null} reducedMotion
      appearance={APPEARANCE} clock={clock} random={() => 0}
    />)
    clock.advance(600)
    expect(result.container.querySelector('.spinner-frame')?.textContent).toBe('|')
    expect(result.container.querySelector('.spinner-verb')?.getAttribute('data-glimmer-active')).toBe('false')
  })

  it('stop callback 可达，summary 按 done/cancel/error marker 渲染', async () => {
    const onStop = vi.fn()
    const running = render(() => <SolidGenerationFooter
      running tokenCount={0} startTime={0} summary={null}
      appearance={APPEARANCE} clock={createFakeWorkbenchClock(0)} onStop={onStop}
    />)
    await fireEvent.click(running.getByRole('button', { name: /停止/ }))
    expect(onStop).toHaveBeenCalledTimes(1)
    running.unmount()

    for (const [reason, label, marker] of [
      ['done', '处理耗时', '✓'],
      ['cancelled', '已停止', '■'],
      ['error', '处理失败', '✕'],
    ] as const) {
      const result = render(() => <SolidGenerationFooter
        running={false} tokenCount={20} startTime={0}
        summary={{ elapsedMs: 65_000, tokenCount: 20, completedFrame: '', reason }}
        appearance={APPEARANCE} clock={createFakeWorkbenchClock(65_000)}
      />)
      expect(result.container.querySelector('.term-summary-frame')?.textContent).toBe(marker)
      expect(result.container.textContent).toContain(`${label} 1m 5s`)
      result.unmount()
    }
  })

  it('pause/resume/destroy 清理并恢复 timer，destroy 幂等', () => {
    const clock = createFakeWorkbenchClock(0)
    let lifecycle: GenerationFooterLifecycle | undefined
    const result = render(() => <SolidGenerationFooter
      running tokenCount={100} startTime={0} summary={null} showTokenCount
      appearance={APPEARANCE} clock={clock}
      onLifecycleReady={value => { lifecycle = value }}
    />)
    expect(clock.activeTaskCount()).toBeGreaterThan(0)
    lifecycle!.pause()
    expect(clock.activeTaskCount()).toBe(0)
    const pausedText = result.container.textContent
    clock.advance(1000)
    expect(result.container.textContent).toBe(pausedText)

    lifecycle!.resume()
    expect(clock.activeTaskCount()).toBeGreaterThan(0)
    clock.advance(120)
    expect(result.container.textContent).toContain('↓ 25 tokens')

    lifecycle!.destroy()
    lifecycle!.destroy()
    expect(clock.activeTaskCount()).toBe(0)
  })

  it('空 summary 且非 running 时不渲染', () => {
    const result = render(() => <SolidGenerationFooter
      running={false} tokenCount={0} startTime={0} summary={null}
      appearance={APPEARANCE} clock={createFakeWorkbenchClock(0)}
    />)
    expect(result.container.childElementCount).toBe(0)
  })
})

describe('GenerationFooter formatter', () => {
  it('格式化 elapsed 与 token', () => {
    expect(formatElapsed(65_999)).toBe('1m 5s')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_250)).toBe('1.3k')
    expect(formatTokens(12_480)).toBe('12k')
  })
})
