import type { Message } from './messageTypes.ts'
import { resolveToolRenderer } from './toolPresentation.ts'

const searchTextCache = new WeakMap<Message, string>()

function stringifySearchValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

export function getMessageSearchText(message: Message): string {
  const cached = searchTextCache.get(message)
  if (cached !== undefined) return cached

  const toolText = message.role === 'tool'
    ? resolveToolRenderer(message.toolName || '').getSearchText?.(message.toolOutput) || ''
    : ''
  const text = [
    message.sender,
    message.content,
    message.toolName,
    message.toolInput,
    toolText,
    stringifySearchValue(message.toolOutput),
  ]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase()

  searchTextCache.set(message, text)
  return text
}

export function messageMatchesQuery(message: Message, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return getMessageSearchText(message).includes(normalizedQuery)
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 分块预热搜索文本，避免一次性占满浏览器事件循环。 */
export async function warmMessageSearchIndex(
  messages: readonly Message[],
  batchSize = 500,
): Promise<void> {
  const safeBatchSize = Number.isFinite(batchSize) && batchSize > 0
    ? Math.floor(batchSize)
    : 500

  for (let start = 0; start < messages.length; start += safeBatchSize) {
    const end = Math.min(start + safeBatchSize, messages.length)
    for (let index = start; index < end; index += 1) {
      getMessageSearchText(messages[index])
    }
    if (end < messages.length) await yieldToEventLoop()
  }
}
