import { useCallback, useEffect, useRef } from 'react'
import {
  beginProgrammaticScroll,
  createScrollFollowState,
  onUserScroll,
  shouldAutoScroll,
  type ScrollFollowState,
} from './scrollFollowState.ts'

/**
 * useScrollFollow — 聊天滚动跟随（CV-1：从 ChatView 抽出，行为原样搬迁）。
 *
 * 状态机（scrollFollowState 纯函数）+ 滚动监听 + 自动跟随 + 回底按钮。
 * 切会话重置为 sticky（新会话从底部开始，不继承上一会话的 user_scrolled）。
 */
export function useScrollFollow(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string | null,
  messages: unknown[],
  generating: boolean,
  streamingText: string,
  streamingThinking: string,
) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollFollowRef = useRef<ScrollFollowState>(createScrollFollowState())
  const scrollRafRef = useRef<number | null>(null)
  const scrollBoundRef = useRef(false)
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null)

  // 会话级滚动跟随：切会话重置为 sticky
  useEffect(() => {
    scrollFollowRef.current = createScrollFollowState()
  }, [sessionId])

  // 依赖 sessionId：空状态（无会话）时 .chat-view 未渲染、ref 为 null，effect 首跑直接
  // return；选中会话后 .chat-view 挂载，必须重跑才能绑定 scroll listener。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateFollowState = () => {
      scrollRafRef.current = null
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      // 状态机纯函数：锁窗内不更新相位，相位不变返回原引用
      scrollFollowRef.current = onUserScroll(scrollFollowRef.current, distanceFromBottom, performance.now())
    }
    const handleScroll = () => {
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = requestAnimationFrame(updateFollowState)
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    // 仅首次绑定时 eager 判定初始相位；会话切换（重绑定）时容器仍停留在上一会话的
    // 滚动位置，eager 判定会基于过期位置把刚重置的 sticky 翻成 user_scrolled
    if (!scrollBoundRef.current) {
      scrollBoundRef.current = true
      updateFollowState()
    }
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [sessionId, containerRef])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    // 置 sticky + 写锁窗（smooth 动画期间用户 scroll 不推翻跟随）
    scrollFollowRef.current = beginProgrammaticScroll(performance.now(), behavior === 'smooth')
    if (!bottomRef.current) return
    bottomRef.current.scrollIntoView({ behavior })
  }, [])
  scrollToBottomRef.current = scrollToBottom

  useEffect(() => {
    if (!bottomRef.current) return
    if (!shouldAutoScroll(scrollFollowRef.current)) return
    scrollToBottomRef.current?.()
  }, [messages, generating, streamingText, streamingThinking])

  return { bottomRef, scrollToBottomRef }
}
