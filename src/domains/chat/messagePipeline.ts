import { toRenderMessage, type Message, type RenderDecision, type RenderMessage, renderDecisionKind } from './messageTypes.ts'

export function prepareMessages(messages: readonly Message[]): RenderMessage[] {
  return messages.map(toRenderMessage)
}

/**
 * #441-A：`prepareMessages` 的单槽引用门。输入数组引用未变 ⇒ 输出引用原样复用——
 * tool/usage 等不改 messages 引用的发布（`reduceTool` 只换 activities/timeline）不再
 * 每拍重映射整表。安全性：纯函数 + 输入是快照冻结数组（#204③ COW 纪律），引用相等
 * 则输出必等；宿主若就地变异数组，破坏的是整个 memo 化栈的既有前提（freezeItems
 * 指针短路、toRenderMessage WeakMap），不是本门新增的。
 */
let prepareMemo: { readonly source: readonly Message[], readonly out: readonly RenderMessage[] } | undefined

export function prepareMessagesOf(messages: readonly Message[]): readonly RenderMessage[] {
  const memo = prepareMemo
  if (memo !== undefined && memo.source === messages) return memo.out
  const out = prepareMessages(messages)
  prepareMemo = { source: messages, out }
  return out
}

export function decideMessageVisibility(message: RenderMessage): RenderDecision {
  if (message.type === 'assistant' && !message.message.content && !message.message.running) {
    return { kind: 'skip', reason: 'empty-assistant' }
  }
  return { kind: 'render', message }
}

export function prepareRenderableMessages(messages: Message[]): RenderMessage[] {
  return prepareMessages(messages).filter(message => renderDecisionKind(decideMessageVisibility(message)) === 'render')
}

/**
 * 消息静态化判定（参考 CC components/Messages.tsx::shouldRenderStatically 的保守子集）：
 * 静态消息跳过入场动画，只有可能继续变化的动态消息保留动画。
 * - running 中 → 动态
 * - tool_call（未 settle，等待 tool_call_update）→ 动态
 * - 其余（user/assistant/reasoning/tool_result/error/system）→ 静态
 */
export function isMessageStatic(renderMessage: RenderMessage): boolean {
  if (renderMessage.message.running === true) return false
  if (renderMessage.type === 'tool_call') return false
  return true
}
