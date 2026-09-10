// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { canExecuteRendererSemanticCommand, executeRendererSemanticCommand } from '../rendererSemanticCommand.ts'
import type { WorkbenchHostPort } from '../../../renderers/solid-workbench/workbenchContracts.ts'
import { onPylonEvent } from '../../../domains/events/pylonCustomEvents.ts'

/**
 * P48-② 回归锁：诊断打开动作从 renderer 直发 window CustomEvent 收编为
 * semantic command（宪法 §3.2.5）。锁三点：宿主导航不设 capability 门槛；
 * 执行侧经 typed DOM bridge 派发 `pylon:open-runtime-sheet`；不要求活动
 * Session（空态/未绑定会话的系统错误卡同样可用）。
 */
describe('diagnostics.open semantic command', () => {
  it('dispatches the typed runtime-sheet event without capability or active session', async () => {
    expect(canExecuteRendererSemanticCommand('diagnostics.open', { has: () => false } as never)).toBe(true)

    const diagnostics = { report: vi.fn() }
    const host = { commands: {}, diagnostics } as unknown as WorkbenchHostPort
    const listener = vi.fn()
    const dispose = onPylonEvent(window, 'pylon:open-runtime-sheet', listener)
    try {
      await executeRendererSemanticCommand({
        command: { type: 'diagnostics.open' },
        host,
        mountInput: { sessionId: null } as never,
      })
    } finally {
      dispose()
    }

    expect(listener).toHaveBeenCalledTimes(1)
    expect(diagnostics.report).not.toHaveBeenCalled()
  })
})
