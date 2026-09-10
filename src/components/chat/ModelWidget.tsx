import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { setSessionModel } from './sessionModel'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { AgentContext } from '../../agentContext'
import { toAgentContextKey } from '../../agentContext'
import { dispatchPylonEvent } from '../../domains/events/pylonCustomEvents.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import type { ModelChoice } from '../../infrastructure/acp/chatContracts.ts'

/**
 * modelVariant 取值：
 *   - 'dropdown'  : 默认下拉菜单（点击展开）
 *   - 'minimal'   : 单行 inline，点击循环切下一个（省空间）
 *   - 'badge'     : 圆角徽章样式（只读展示）
 *
 * P56/D3：模型切换只允许发送会话宣告列表内的 machine id（发送不变量）。无宣告
 * modelChoices 时渲染只读 badge（不渲染可点列表、不发起 invoke）——原 FALLBACK_MODELS
 * 降级发送路径已删除（裸 id 会被 hermes 的 provider 自动检测劫持，产生「model 与
 * url 不符」）。profile.model 仅作显示兜底，不进入可点列表。
 */
const READ_ONLY_TITLE = '当前 agent 未宣告可选模型'

interface Props { context?: AgentContext }

export default function ModelWidget({ context }: Props) {
  const variant = useStore(s => s.modelVariant) || 'dropdown'
  const ccScale = useStore(s => (s.ccScale || {})['model'] ?? 100)
  const cfg = useRuntimeStore(s => (context ? s.sessionConfig[toAgentContextKey(context)] : undefined))
  // 降级显示：无后端配置时读 profile.model（历史行为；仅显示，不进入可点列表）
  const activeProfile = useIdentityStore(s => s.profiles.find(x => x.id === s.activeProfileId))

  const modelChoices = cfg?.modelChoices ?? []
  const models = cfg?.models ?? []
  const model = cfg?.model || activeProfile?.model || models[0]
  // 可交互 = 会话宣告了可选项且有 owner context；否则只读（验收 5 前端侧）。
  const interactive = modelChoices.length > 0 && Boolean(context)

  const setModel = (choice: ModelChoice) => {
    if (!context || choice.id === model) return
    const key = `chat:model:${toAgentContextKey(context)}`
    setSessionModel(context, choice.id).then(() => {
      resolveRuntimeErrors({ key, source: 'chat.model' })
    }, error => {
      const detail = reportRuntimeError('切换模型', error, context.agentId, {
        key,
        scope: { kind: 'session', id: context.source },
        source: 'chat.model',
        recovery: { kind: 'open-runtime-log', sessionId: context.source },
      })
      // Keep the legacy local event for the input bar's contextual hint;
      // the ErrorCenter remains the sole global error presentation.
      dispatchPylonEvent(window, 'pylon:model-error', detail.message)
    })
  }

  if (!interactive) {
    // 只读 badge：无宣告面（或预览无 session）时统一降级，title 说明原因。
    return (
      <span className="cc-model-badge" title={READ_ONLY_TITLE} style={{ fontSize: `${ccScale}%` }}>
        {model}
      </span>
    )
  }

  if (variant === 'minimal') {
    const current = modelChoices.find(choice => choice.id === model)
    const idx = modelChoices.indexOf(current ?? modelChoices[0])
    const next = modelChoices[(idx + 1) % modelChoices.length]
    return (
      <button className="cc-model-minimal" type="button" onClick={() => setModel(next)} title="点击切换模型"
        style={{ fontSize: `${ccScale}%` }}>
        {current?.label ?? current?.id ?? model}
      </button>
    )
  }

  if (variant === 'badge') {
    return (
      <span className="cc-model-badge" style={{ fontSize: `${ccScale}%` }}>
        {modelChoices.find(choice => choice.id === model)?.label ?? model}
      </span>
    )
  }

  // default: 'dropdown'——菜单显示 label（无 label 显示 id），发送 machine id。
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="model-tag" style={{ fontSize: `${ccScale}%` }}>
        {modelChoices.find(choice => choice.id === model)?.label ?? model} ▾
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu" sideOffset={4}>
          {modelChoices.map(choice => (
            <DropdownMenu.Item key={choice.id} className={`model-item ${choice.id === model ? 'active' : ''}`}
              onClick={() => setModel(choice)}>
              {choice.label ?? choice.id}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
