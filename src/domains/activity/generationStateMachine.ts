import type {
  GenerationActivityKind,
  GenerationActivitySnapshot,
  GenerationLiveness,
  GenerationPhase,
  GenerationToolActivity,
} from '../workbench/generationFooterContracts.ts'

// 保留旧模块的类型导出，兼容现有消费者；定义本身属于 Footer contract。
export type { GenerationLiveness } from '../workbench/generationFooterContracts.ts'

/** 生成活动轴的事件；生命周期（running/cancelled/done）仍由会话 reducer 管理。 */
export type GenerationActivityEvent =
  | { readonly type: 'start'; readonly at: number }
  | { readonly type: 'thinking'; readonly at: number }
  | { readonly type: 'responding'; readonly at: number }
  | { readonly type: 'tool-start'; readonly id: string; readonly name: string; readonly at: number }
  | { readonly type: 'tool-end'; readonly id: string; readonly at: number }
  | { readonly type: 'reset' }

function snapshot(
  kind: GenerationActivityKind,
  activeTools: readonly GenerationToolActivity[] = [],
  resumeKind?: Exclude<GenerationActivityKind, 'tooling'>,
): GenerationActivitySnapshot {
  return Object.freeze({
    kind,
    activeTools: Object.freeze(activeTools.map(tool => Object.freeze({ ...tool }))),
    ...(resumeKind ? { resumeKind } : {}),
  })
}

function normalizedTool(event: Extract<GenerationActivityEvent, { type: 'tool-start' }>): GenerationToolActivity {
  const name = event.name.trim() || '?'
  // 缺少协议 toolCallId 时仍给本轮一个稳定的本地键，避免所有无 id 工具互相覆盖。
  const id = event.id.trim() || `local:${name}:${event.at}`
  return { id, name, startedAt: event.at }
}

function resumeKindFor(previous: GenerationActivitySnapshot | undefined): Exclude<GenerationActivityKind, 'tooling'> {
  if (!previous) return 'thinking'
  if (previous.kind === 'tooling') return previous.resumeKind ?? 'thinking'
  return previous.kind
}

/**
 * 只维护“当前活动上下文”，不产生 UI 文案。
 *
 * 工具是集合而不是单值：多个工具并行时，后到的 tool-start 不会覆盖先到的
 * 工具；最后一个工具结束后恢复工具调用前的 thinking/responding 上下文。
 */
export function reduceGenerationActivity(
  previous: GenerationActivitySnapshot | undefined,
  event: GenerationActivityEvent,
): GenerationActivitySnapshot | undefined {
  switch (event.type) {
    case 'reset':
      return undefined
    case 'start':
      return snapshot('thinking')
    case 'thinking': {
      if (previous?.activeTools.length) {
        return snapshot('tooling', previous.activeTools, 'thinking')
      }
      return snapshot('thinking')
    }
    case 'responding': {
      if (previous?.activeTools.length) {
        return snapshot('tooling', previous.activeTools, 'responding')
      }
      return snapshot('responding')
    }
    case 'tool-start': {
      const tool = normalizedTool(event)
      const tools = previous?.activeTools ?? []
      const index = tools.findIndex(item => item.id === tool.id)
      const nextTools = tools.slice()
      if (index >= 0) nextTools[index] = tool
      else nextTools.push(tool)
      return snapshot('tooling', nextTools, resumeKindFor(previous))
    }
    case 'tool-end': {
      if (!previous) return previous
      if (!previous.activeTools.some(tool => tool.id === event.id)) return previous
      const nextTools = previous.activeTools.filter(tool => tool.id !== event.id)
      if (nextTools.length > 0) return snapshot('tooling', nextTools, previous.resumeKind ?? 'thinking')
      if (previous.kind !== 'tooling') return snapshot(previous.kind)
      return snapshot(previous.resumeKind ?? 'thinking')
    }
  }
}

/** 将新活动轴投影为旧 Footer/React 接口使用的单值 phase。 */
export function legacyPhaseFromActivity(activity: GenerationActivitySnapshot | undefined): GenerationPhase | undefined {
  if (!activity) return undefined
  if (activity.kind === 'tooling') {
    const tool = activity.activeTools.at(-1)
    if (tool) return { kind: 'tool', name: tool.name }
    return { kind: activity.resumeKind ?? 'thinking' }
  }
  return { kind: activity.kind === 'thinking' ? 'thinking' : 'responding' }
}

export interface GenerationIndicatorContext {
  readonly kind?: GenerationActivityKind
  /** 当前计划任务或工具摘要，供 Footer 作为次级上下文。 */
  readonly label?: string
  readonly toolNames: readonly string[]
}

export function resolveGenerationIndicatorContext(input: {
  readonly activity?: GenerationActivitySnapshot
  readonly phase?: GenerationPhase
  readonly activeTaskContent?: string
}): GenerationIndicatorContext {
  const phase = legacyPhaseFromActivity(input.activity) ?? input.phase
  const tools = input.activity?.activeTools ?? (
    phase?.kind === 'tool' ? [{ id: 'legacy', name: phase.name }] : []
  )
  const toolNames = tools.map(tool => tool.name)
  const task = input.activeTaskContent?.trim()
  if (task) return {
    kind: input.activity?.kind ?? phaseKind(phase),
    label: `正在${task}`,
    toolNames,
  }
  if (toolNames.length > 0) {
    const last = toolNames.at(-1) || '?'
    return {
      kind: 'tooling',
      label: toolNames.length > 1
        ? `正在调用 ${last} +${toolNames.length - 1}`
        : `正在调用 ${last}`,
      toolNames,
    }
  }
  return {
    kind: input.activity?.kind ?? phaseKind(phase),
    label: phase?.kind === 'thinking' ? '思考中' : phase?.kind === 'responding' ? '正在回复' : undefined,
    toolNames,
  }
}

function phaseKind(phase: GenerationPhase | undefined): GenerationActivityKind | undefined {
  if (!phase) return undefined
  return phase.kind === 'tool' ? 'tooling' : phase.kind
}

export interface GenerationIndicatorCopy {
  readonly primary: string
  readonly secondary?: string
}

/**
 * 将视觉预设与运行上下文合并。预设词是 active 状态的主文案，阶段/工具只作
 * 次级上下文；waiting/stalled 仍优先显示明确的后端活性提示。
 */
export function resolveGenerationIndicatorCopy(input: {
  readonly running: boolean
  readonly liveness: GenerationLiveness
  readonly presetVerb?: string
  readonly context: GenerationIndicatorContext
}): GenerationIndicatorCopy {
  if (!input.running) return { primary: '' }
  if (input.liveness === 'waiting') return { primary: '等待响应' }
  if (input.liveness === 'stalled') return { primary: '仍在等待后端响应' }

  const primary = input.presetVerb?.trim() || '思考中'
  return input.context.label
    ? { primary, secondary: input.context.label }
    : { primary }
}
