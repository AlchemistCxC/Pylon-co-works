import { useEffect, useRef, useState } from 'react'

/**
 * 每个值至少展示 minMs（最小展示时长），防止快速切换的进度文案闪跳。
 * 与 debounce（等安静）/throttle（限速）不同：保证每个值被看到至少一次。
 * 移植自 CC hooks/useMinDisplayTime.ts。
 */
export function useMinDisplayTime<T>(value: T, minMs: number): T {
  const [displayed, setDisplayed] = useState(value)
  const lastShownAtRef = useRef(0)

  useEffect(() => {
    const elapsed = Date.now() - lastShownAtRef.current
    if (elapsed >= minMs) {
      lastShownAtRef.current = Date.now()
      setDisplayed(value)
      return
    }
    const timer = window.setTimeout(() => {
      lastShownAtRef.current = Date.now()
      setDisplayed(value)
    }, minMs - elapsed)
    return () => window.clearTimeout(timer)
  }, [value, minMs])

  return displayed
}
