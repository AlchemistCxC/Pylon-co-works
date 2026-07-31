import { useEffect, useState } from 'react'

/**
 * 共享动画时钟：所有 useBlink 实例从同一时钟派生状态，同步闪烁；
 * 无订阅者时停止时钟；document 失焦/隐藏时暂停。
 * Web 等价实现，参考 CC hooks/useBlink.ts + use-animation-frame.ts 的时钟语义。
 */
const CLOCK_TICK_MS = 50

const blinkListeners = new Set<(time: number) => void>()
let clockTimer: number | null = null
let clockTime = 0

function startClock() {
  if (clockTimer !== null) return
  clockTimer = window.setInterval(() => {
    clockTime = Date.now()
    for (const listener of blinkListeners) listener(clockTime)
  }, CLOCK_TICK_MS)
}

function stopClock() {
  if (clockTimer !== null && blinkListeners.size === 0) {
    window.clearInterval(clockTimer)
    clockTimer = null
  }
}

export function useDocumentFocus(): boolean {
  const [focused, setFocused] = useState(() => typeof document === 'undefined' ? true : document.hasFocus())
  useEffect(() => {
    const update = () => setFocused(document.hasFocus())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return focused
}

/** 纯逻辑：给定共享时钟时间与间隔，当前是否处于可见半周期 */
export function blinkVisible(time: number, intervalMs: number): boolean {
  return Math.floor(time / intervalMs) % 2 === 0
}

/**
 * 同步闪烁 hook：enabled 或失焦时恒亮（true）。
 * 所有实例共享同一时钟，闪烁节奏一致。
 */
export function useBlink(enabled: boolean, intervalMs = 600): boolean {
  const focused = useDocumentFocus()
  const [time, setTime] = useState(clockTime)

  useEffect(() => {
    if (!enabled || !focused) return
    blinkListeners.add(setTime)
    startClock()
    return () => {
      blinkListeners.delete(setTime)
      stopClock()
    }
  }, [enabled, focused])

  if (!enabled || !focused) return true
  return blinkVisible(time, intervalMs)
}
