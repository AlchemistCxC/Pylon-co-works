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
