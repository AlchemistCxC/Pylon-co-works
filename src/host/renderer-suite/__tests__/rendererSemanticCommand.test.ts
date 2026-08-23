import { describe, expect, it, vi } from 'vitest'
import { canExecuteRendererSemanticCommand, executeRendererSemanticCommand } from '../rendererSemanticCommand.ts'
import type { RenderSemanticCommand } from '../../../contracts/messageRenderer.ts'

/**
 * C09/C10/C11 接线复审回归锁（2026-08-23）：卡片实际发送的 semantic command type
 * 必须能路由到 WorkbenchCommandPort 对应方法。此前 InteractionCard 发
 * 'interactionResponse'、SubagentCard 发 'activity.cancel/retry' 均落 unknown 被
 * 生产 gate 拒绝——按钮在真实 capability 下永远禁用而测试全绿（mock 掩盖）。
 */

function makeHost() {
  const diagnostics = { report: vi.fn() }
  const host = {
    commands: {
      respondInteraction: vi.fn().mockResolvedValue({ ok: true, value: null }),
      cancel: vi.fn().mockResolvedValue({ ok: true, value: { status: 'cancelled' } }),
      retry: vi.fn().mockResolvedValue({ ok: true, value: null }),
      toolAction: vi.fn().mockResolvedValue({ ok: true, value: null }),
      copy: vi.fn().mockResolvedValue({ ok: true, value: null }),
    },
    diagnostics,
  }
  return { host, diagnostics }
}

const run = (host: unknown, command: RenderSemanticCommand) => executeRendererSemanticCommand({
  command,
  host: host as never,
  mountInput: { sessionId: 'session-1' } as never,
  slotId: 'slot-test',
  kind: 'activity.subagent',
})

describe('renderer semantic command routing (wiring audit regression)', () => {
  it('exposes activity actions only through the target-preserving toolAction capability', () => {
    const sessionOnly = { has: (capability: string) => capability === 'cancel' || capability === 'retry' }
    expect(canExecuteRendererSemanticCommand('activity.cancel', sessionOnly as never)).toBe(false)
    expect(canExecuteRendererSemanticCommand('activity.retry', sessionOnly as never)).toBe(false)

    const childActions = { has: (capability: string) => capability === 'toolAction' }
    expect(canExecuteRendererSemanticCommand('activity.cancel', childActions as never)).toBe(true)
    expect(canExecuteRendererSemanticCommand('activity.retry', childActions as never)).toBe(true)
  })

  it('routes interaction.respond with targetId to respondInteraction', async () => {
    const { host, diagnostics } = makeHost()
    await run(host, { type: 'interaction.respond', targetId: 'int-1', payload: { optionId: 'deny' } })
    expect(host.commands.respondInteraction).toHaveBeenCalledWith('session-1', 'int-1', { optionId: 'deny' })
    expect(diagnostics.report).not.toHaveBeenCalled()
  })

  it('rejects interaction.respond without targetId instead of silently dropping', async () => {
    const { host, diagnostics } = makeHost()
    await run(host, { type: 'interaction.respond', payload: { optionId: 'deny' } })
    expect(host.commands.respondInteraction).not.toHaveBeenCalled()
    expect(diagnostics.report).toHaveBeenCalledWith(expect.objectContaining({
      code: 'renderer_action_invalid', phase: 'action', actionType: 'interaction.respond',
    }))
  })

  it('routes activity.cancel through target-preserving toolAction instead of cancelling the session', async () => {
    const { host, diagnostics } = makeHost()
    await run(host, { type: 'activity.cancel', targetId: 'sub-1' })
    expect(host.commands.toolAction).toHaveBeenCalledWith('session-1', 'sub-1', 'cancel', undefined)
    expect(host.commands.cancel).not.toHaveBeenCalled()
    expect(diagnostics.report).not.toHaveBeenCalled()
  })

  it('routes activity.retry through target-preserving toolAction instead of retrying the session', async () => {
    const { host, diagnostics } = makeHost()
    await run(host, { type: 'activity.retry', targetId: 'sub-2', payload: { reason: 'manual' } })
    expect(host.commands.toolAction).toHaveBeenCalledWith('session-1', 'sub-2', 'retry', { reason: 'manual' })
    expect(host.commands.retry).not.toHaveBeenCalled()
    expect(diagnostics.report).not.toHaveBeenCalled()
  })

  it('still rejects genuinely unknown action types', async () => {
    const { host, diagnostics } = makeHost()
    await run(host, { type: 'activity.teleport' })
    expect(diagnostics.report).toHaveBeenCalledWith(expect.objectContaining({
      code: 'renderer_action_unknown', actionType: 'activity.teleport',
    }))
  })
})
