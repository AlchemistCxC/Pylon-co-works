/**
 * id — tool 消息 id 解析（B1：三处重复实现收敛为单源）。
 *
 * tool 消息的 id 形如 `tool-<toolId>`；解析失败返回 null。
 * 参数取最小结构（role/id），不依赖 Message 类型，保持域纯净。
 */
export function toolIdFromMessage(message: { role: string; id: string }): string | null {
  if (message.role !== 'tool' || !message.id.startsWith('tool-')) return null
  const toolId = message.id.slice('tool-'.length)
  return toolId || null
}
