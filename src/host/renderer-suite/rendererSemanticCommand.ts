import type { RenderSemanticCommand } from '../../contracts/messageRenderer.ts'
import type { WorkbenchHostPort, WorkbenchMountInput } from '../../renderers/solid-workbench/workbenchContracts.ts'

export function isRenderSemanticCommand(value: unknown): value is RenderSemanticCommand {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === 'string')
}

export async function executeRendererSemanticCommand(input: {
  readonly command: RenderSemanticCommand
  readonly host: WorkbenchHostPort
  readonly mountInput: WorkbenchMountInput
  readonly slotId?: string
  readonly kind?: string
}): Promise<void> {
  const { command, host, mountInput } = input
  const sessionId = mountInput.sessionId
  const payload = command.payload
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined
  const reject = (code: string, message: string) => host.diagnostics.report({
    code, message, phase: 'action', recoverability: 'none',
    slotId: input.slotId, kind: input.kind, actionType: command.type,
  })
  if (!sessionId) { reject('renderer_action_context_missing', 'Renderer action 缺少活动 Session'); return }

  let result: { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  switch (command.type) {
    case 'clipboard.write': {
      const text = typeof payload === 'string' ? payload : record?.text
      if (typeof text !== 'string') { reject('renderer_action_invalid', 'clipboard.write 缺少 text'); return }
      result = await host.commands.copy(sessionId, text)
      break
    }
    case 'interaction.respond':
      if (!command.targetId) { reject('renderer_action_invalid', 'interaction.respond 缺少 targetId'); return }
      result = await host.commands.respondInteraction(sessionId, command.targetId, payload)
      break
    case 'tool.action': {
      const action = record?.action
      if (!command.targetId || typeof action !== 'string') { reject('renderer_action_invalid', 'tool.action 缺少 targetId/action'); return }
      result = await host.commands.toolAction(sessionId, command.targetId, action, record?.payload)
      break
    }
    case 'resource.open':
      result = await host.commands.openResource(sessionId, payload)
      break
    case 'resource.reveal':
      result = await host.commands.revealResource(sessionId, payload)
      break
    case 'activity.cancel': {
      // C09/C10：后台活动取消——复用既有 cancel 命令面（targetId=activityId 仅作审计关联）
      if (!command.targetId) { reject('renderer_action_invalid', 'activity.cancel 缺少 targetId'); return }
      result = await host.commands.cancel(sessionId)
      break
    }
    case 'activity.retry': {
      // C09/C10：失败/取消活动重试——复用既有 retry 命令面（messageId 可选）
      result = await host.commands.retry(sessionId, typeof record?.messageId === 'string' ? record.messageId : undefined)
      break
    }
    case 'interaction.respond':
      result = await host.commands.retry(sessionId, command.targetId)
      break
    case 'session.recover':
      result = await host.commands.recover(sessionId, typeof record?.strategy === 'string' ? record.strategy : undefined)
      break
    default:
      reject('renderer_action_unknown', `未知 Renderer semantic action：${command.type}`)
      return
  }
  if (!result.ok) reject(result.error.code, result.error.message)
}
