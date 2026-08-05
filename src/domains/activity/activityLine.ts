/**
 * activityLine — 活动行动词覆盖链纯推导（P1-02，D5/D6/D29/D30）。
 *
 * D5 覆盖链（挂 GenerationFooter，行为不变）：plan activeTask.content（最高优先）
 * → tool title（phase=tool）→ thinking/responding → 随机动词。
 * D29：phase=tool 时返回 stallSuppressed（stall 计时归零，长工具调用不误报停滞）。
 * D30：phase=thinking 时返回 durationMs（thinkingStart→now，注入 now 便于测试）。
 * D6：与 GenerationFooter 同源抽取；颜色等主题派生留在消费方（D17 零新主题字段）。
 */

export type ActivityPhase = 'tool' | 'thinking' | 'responding'

export interface ActivityInput {
  /** plan activeTask.content（最高优先） */
  activeTaskContent?: string
  /** phase=tool 时的工具 title */
  toolTitle?: string
  /** 阶段：tool → stall 抑制；thinking → 时长 */
  phase?: ActivityPhase
  /** thinking 开始时间戳（D30 时长计算） */
  thinkingStart?: number
  /** 当前时间戳（注入便于测试；缺省 Date.now()） */
  now?: number
  /** 随机回退分支的固定动词（测试确定性；缺省内部随机） */
  fallbackVerb?: string
}

export interface ActivityLine {
  verb: string
  activity: string
  /** D29：tool 阶段抑制 stall */
  stallSuppressed?: boolean
  /** D30：thinking 已持续时长 ms */
  durationMs?: number
}

/** 随机动词回退集（与现有 spinner 动词集同源语义，消费方可覆盖） */
export const FALLBACK_ACTIVITY_VERBS = ['思考中', '正在思考', '整理思路', '推演中', '规划中'] as const

function pickFallbackVerb(): string {
  return FALLBACK_ACTIVITY_VERBS[Math.floor(Math.random() * FALLBACK_ACTIVITY_VERBS.length)]
}

export function resolveActivityLine(input: ActivityInput): ActivityLine {
  // 覆盖链最高优先：plan activeTask.content（D5）
  if (input.activeTaskContent) {
    return { verb: '正在', activity: `正在${input.activeTaskContent} …` }
  }
  // tool 阶段：stall 计时归零（D29）
  if (input.phase === 'tool') {
    return {
      verb: '正在调用',
      activity: input.toolTitle ? `正在调用 ${input.toolTitle} …` : '正在调用工具 …',
      stallSuppressed: true,
    }
  }
  // thinking：返回已持续时长（D30）
  if (input.phase === 'thinking') {
    const durationMs = typeof input.thinkingStart === 'number'
      ? Math.max(0, (input.now ?? Date.now()) - input.thinkingStart)
      : undefined
    return {
      verb: '思考中',
      activity: '思考中 …',
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
  }
  if (input.phase === 'responding') {
    return { verb: '正在回复', activity: '正在回复 …' }
  }
  // 无 plan / 无 phase → 随机动词（现有行为）
  const verb = input.fallbackVerb ?? pickFallbackVerb()
  return { verb, activity: `${verb} …` }
}
