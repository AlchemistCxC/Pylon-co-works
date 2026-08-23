/**
 * Activity 分类层：在工具展示和用户交互之间建立稳定分流。
 *
 * 这里只做纯协议分类，不负责解析问题答案、状态事务或 UI 渲染。
 * 未知事件默认保留为普通 tool，避免因未知协议变体静默丢失可见活动。
 */

export type ActivitySurface = 'tool' | 'interaction'

export type InteractionKind =
  | 'clarify'
  | 'ask-question'
  | 'approval'
  | 'oauth'
  | 'secret'
  | 'sudo'
  | 'unknown'

export type ActivityMatch = 'wire-event' | 'interaction-name' | 'fallback'

export interface ActivityResolution {
  surface: ActivitySurface
  interactionKind: InteractionKind | null
  rawName: string
  matchedBy: ActivityMatch
}

const INTERACTION_NAMES: Record<string, InteractionKind> = {
  askuserquestion: 'ask-question',
  ask_user_question: 'ask-question',
  clarify: 'clarify',
  approval: 'approval',
  approval_request: 'approval',
  requestpermission: 'approval',
  request_permission: 'approval',
  oauth: 'oauth',
  oauth_needed: 'oauth',
  secret: 'secret',
  sudo: 'sudo',
}

const INTERACTION_EVENT_TYPES: Record<string, InteractionKind> = {
  'clarify.request': 'clarify',
  'approval.request': 'approval',
  'permission.request': 'approval',
  'oauth-needed': 'oauth',
  'oauth.needed': 'oauth',
  'ask-user': 'ask-question',
  'ask_user': 'ask-question',
}

function key(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/**
 * 解析事件优先于工具名：同一个工具名在普通 tool_call 中不应被误判为交互，
 * 但明确的独立 request event 必须进入 interaction surface。
 */
export function resolveActivity(input: {
  name?: string
  eventType?: string
  surface?: string
}): ActivityResolution {
  const rawName = input.name?.trim() || 'unknown'
  const eventKind = INTERACTION_EVENT_TYPES[key(input.eventType)]
  if (eventKind) {
    return { surface: 'interaction', interactionKind: eventKind, rawName, matchedBy: 'wire-event' }
  }

  const explicitSurface = key(input.surface)
  if (explicitSurface === 'interaction') {
    return {
      surface: 'interaction',
      interactionKind: INTERACTION_NAMES[key(rawName)] ?? 'unknown',
      rawName,
      matchedBy: 'wire-event',
    }
  }

  const interactionKind = INTERACTION_NAMES[key(rawName)]
  if (interactionKind) {
    return { surface: 'interaction', interactionKind, rawName, matchedBy: 'interaction-name' }
  }

  return { surface: 'tool', interactionKind: null, rawName, matchedBy: 'fallback' }
}

export function isInteractionActivity(input: Parameters<typeof resolveActivity>[0]): boolean {
  return resolveActivity(input).surface === 'interaction'
}
