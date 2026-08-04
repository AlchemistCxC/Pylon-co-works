import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useSessionUiState } from './sessionUiState'
import { messageMatchesQuery } from './messageSearchIndex'
import type { Message } from './messageTypes'

/**
 * useMessageSearch — 消息搜索（CV-3：从 ChatView 抽出，行为原样搬迁）。
 *
 * 搜索开关/词/位置按会话作用域（useSessionUiState 注册表，切会话保留各会话状态）；
 * Ctrl+F 快捷键、命中匹配、索引收敛、命中滚动定位。messageRefs 供行渲染注册 DOM。
 */
export function useMessageSearch(sessionId: string | null, messages: readonly Message[]) {
  // 搜索状态按会话作用域（多会话基建）：切会话保留各会话的搜索词/开关/位置
  const [searchOpen, setSearchOpen] = useSessionUiState(sessionId, 'search-open', false)
  const [searchQuery, setSearchQuery] = useSessionUiState(sessionId, 'search-query', '')
  const [searchIndex, setSearchIndex] = useSessionUiState(sessionId, 'search-index', 0)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    const onSearchShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onSearchShortcut)
    return () => window.removeEventListener('keydown', onSearchShortcut)
    // setSearchOpen 按会话作用域（useSessionUiState）：切会话必须重绑快捷键，
    // 否则捕获首个会话的 setter，Ctrl+F 会操作旧会话的搜索状态
  }, [sessionId, setSearchOpen])

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return []
    return messages.filter(message => messageMatchesQuery(message, searchQuery))
  }, [messages, searchQuery])

  useEffect(() => {
    if (searchMatches.length === 0) {
      setSearchIndex(0)
      return
    }
    setSearchIndex(index => Math.min(index, searchMatches.length - 1))
    // setSearchIndex 按会话作用域：跨会话需重绑（同快捷键 effect 的理由）
  }, [searchMatches.length, setSearchIndex])

  const moveSearch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return
    setSearchIndex(index => (index + direction + searchMatches.length) % searchMatches.length)
  }, [searchMatches.length, setSearchIndex])

  useEffect(() => {
    const message = searchMatches[searchIndex]
    if (!message) return
    const node = messageRefs.current.get(message.id)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchMatches, searchIndex])

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchIndex,
    setSearchIndex,
    searchMatches,
    moveSearch,
    messageRefs,
  }
}
