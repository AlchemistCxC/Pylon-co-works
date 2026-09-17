/**
 * oracle（期望值）模块：从 wire 输入**独立**推导期望，不经过任何存储/投影代码路径。
 *
 * 刻意不做成 `*.test.ts`（同 `harness.ts` 的约定）：否则需要引用它作断言的测试文件
 * 会连带**重复注册**它的测试（`oracleSelfCheck.test.ts` 一度因此把 95 个测试跑了两遍）。
 *
 * 键名约定：真实 ACP 样本**同时存在**驼峰与蛇形两种写法（claude 用 `sessionUpdate`，
 * hermes 结构化结果用 `session_update`），故判定必须两者都认——只认一种会在真实数据上
 * **静默少数文本**，而期望值也被同样少数，断言因此仍然绿。
 */
export function updateOf(wire: unknown): Record<string, unknown> | undefined {
  if (!wire || typeof wire !== 'object') return undefined
  const update = (wire as { update?: unknown }).update
  return update && typeof update === 'object' ? update as Record<string, unknown> : undefined
}

/** 载荷的 update 类型（两种键名约定都认）。 */
export function updateKind(update: Record<string, unknown> | undefined): string | undefined {
  const kind = update?.sessionUpdate ?? update?.session_update
  return typeof kind === 'string' ? kind : undefined
}

function textOf(update: Record<string, unknown> | undefined): string {
  const content = update?.content as { text?: unknown } | undefined
  return typeof content?.text === 'string' ? content.text : ''
}

/** 全部 text delta 的文本按到达序拼接——assistant 正文的**完整期望值**。 */
export function expectedAssistantText(wires: readonly unknown[]): string {
  return wires
    .map(updateOf)
    .filter(update => updateKind(update) === 'agent_message_chunk')
    .map(textOf)
    .join('')
}

/** 全部 user 消息的文本（按到达序）。 */
export function expectedUserTexts(wires: readonly unknown[]): string[] {
  return wires
    .map(updateOf)
    .filter(update => updateKind(update) === 'user_message_chunk')
    .map(textOf)
}

/** 投影里 assistant 正文的拼接（与逐条断言并用）。 */
export function assistantContent(messages: readonly { role: string; content: string }[]): string {
  return messages.filter(message => message.role === 'assistant').map(message => message.content).join('')
}

/** needle 的字符是否按原序全部出现在 haystack 中（允许中间插入其它字符）。 */
export function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0
  for (const char of haystack) {
    if (char === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return needle.length === 0
}
