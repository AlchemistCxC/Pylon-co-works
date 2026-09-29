import type { ChatRowDescriptor } from '../chat/chatRowPipeline.ts'
import { isSameChatRowDescriptor } from '../chat/chatRowPipeline.ts'

export interface MessageListItem {
  key: string
  descriptor: ChatRowDescriptor
  estimatedHeight?: number
}

export interface MessageListAnchor {
  messageId: string
  align: 'start' | 'center' | 'end' | 'nearest'
}

export interface MessageViewportState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
  atBottom: boolean
  firstVisibleMessageId: string | null
  lastVisibleMessageId: string | null
}

export type MeasurementInvalidationReason =
  | 'items-changed'
  | 'theme-changed'
  | 'font-changed'
  | 'container-resized'
  | 'manual'

export interface MessageListPort {
  setItems(items: readonly MessageListItem[]): void
  scrollTo(anchor: MessageListAnchor): Promise<boolean>
  scrollToBottom(behavior: ScrollBehavior): void
  getViewportState(): MessageViewportState
  invalidateMeasurements(reason: MeasurementInvalidationReason): void
  destroy(): void
}

export const EMPTY_MESSAGE_VIEWPORT_STATE: MessageViewportState = Object.freeze({
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  distanceFromBottom: 0,
  atBottom: true,
  firstVisibleMessageId: null,
  lastVisibleMessageId: null,
})

export function createMessageListItems(descriptors: readonly ChatRowDescriptor[]): MessageListItem[] {
  return descriptors.map(descriptor => ({
    key: descriptor.key,
    descriptor,
  }))
}

/**
 * P57 S2-R3 的 items 复用（自 `WorkbenchContent.solid.tsx` 原样抽出，行为逐字节不变）：
 * descriptor 全字段相等时沿用上个 MessageListItem 引用——PlainMessageList 的引用相等门
 * 随之跳过行 update 与测量失效。per-key（不按下标）：中段插入行会平移后继下标，
 * 按键复用让平移段各自重建、未变行保持身份。
 *
 * #441-A：外层再套一道 (previous, descriptors) 双键引用门——descriptors 引用未变
 * （上游 `chatRowDescriptorsOf` 命中）时连 per-key 的 Map 构建与逐行比较都省掉。
 */
let itemsMemo: {
  readonly previous: readonly MessageListItem[]
  readonly descriptors: readonly ChatRowDescriptor[]
  readonly out: readonly MessageListItem[]
} | undefined

export function reuseMessageListItems(
  previous: readonly MessageListItem[],
  descriptors: readonly ChatRowDescriptor[],
): readonly MessageListItem[] {
  const memo = itemsMemo
  // 组件稳态是「上一拍的输出原样喂回当 previous」：out === previous 且 descriptors 未变
  // ⇒ 纯函数输出必等，直接复用。（键在 out 而不是 previous：记 previous 会永远差一拍，
  // 每次喂回的都是上一次的 out，永远不等于上一次的输入。）
  if (memo !== undefined && memo.out === previous && memo.descriptors === descriptors) return memo.out
  const previousByKey = new Map(previous.map(item => [item.key, item]))
  const out = descriptors.map(descriptor => {
    const match = previousByKey.get(descriptor.key)
    if (match !== undefined && isSameChatRowDescriptor(match.descriptor, descriptor)) return match
    return { key: descriptor.key, descriptor }
  })
  itemsMemo = { previous, descriptors, out }
  return out
}
