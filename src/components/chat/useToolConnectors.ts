import { useLayoutEffect } from 'react'

/**
 * useToolConnectors — 连续 Tool 连接线测量（CV-2：从 ChatView 抽出，行为原样搬迁）。
 *
 * 测量每对相邻 tool 行 head 中心间距，写入 connector 的 top/height。
 * .chat-view 是 flex 固定高，行展开只改 scrollHeight（overflow），观察容器
 * content-box 不触发 RO——必须观察行元素。messages 变化时重跑绑定（新行挂上 RO）；
 * Tool 或 reasoning body 展开、字号变化由行 RO 触发重测。
 */
export function useToolConnectors(
  containerRef: React.RefObject<HTMLDivElement | null>,
  messages: unknown[],
) {
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    let raf = 0
    const measure = () => {
      raf = 0
      for (const connector of container.querySelectorAll<HTMLElement>('.term-tool-connector')) {
        const previousRow = connector.previousElementSibling as HTMLElement | null
        const row = connector.nextElementSibling as HTMLElement | null
        const previousHead = previousRow?.querySelector<HTMLElement>('.term-tool-head')
        const head = row?.querySelector<HTMLElement>('.term-tool-head')
        const connectorParent = connector.offsetParent as HTMLElement | null
        if (!previousRow || !row || !previousHead || !head || !connectorParent) continue
        // 展开 Tool body 也保持连接，线会自然跨过 body 延伸至下一项。
        connector.style.display = 'block'
        // 所有几何值都从 viewport rect 换算到 connector 的实际 offsetParent，
        // 不依赖 motion wrapper 的 offsetTop 坐标系，避免缩放/动画/嵌套定位导致偏移。
        const parentTop = connectorParent.getBoundingClientRect().top
        const previousRect = previousHead.getBoundingClientRect()
        const currentRect = head.getBoundingClientRect()
        const previousCenter = previousRect.top - parentTop + previousRect.height / 2
        const currentCenter = currentRect.top - parentTop + currentRect.height / 2
        connector.style.top = `${previousCenter}px`
        connector.style.height = `${Math.max(0, currentCenter - previousCenter)}px`
      }
    }
    const schedule = () => {
      if (raf !== 0) return
      raf = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    const observedRows = new Set<Element>()
    const sync = () => {
      // reasoning 展开会推移其后的所有 Tool 行；因此必须观察所有消息行，
      // 而非只观察 Tool 行，才能让绝对定位 connector 重新按 viewport rect 测量。
      for (const row of container.querySelectorAll('.term-row')) {
        if (observedRows.has(row)) continue
        observer.observe(row)
        observedRows.add(row)
      }
    }
    sync()
    schedule()
    return () => {
      observer.disconnect()
      observedRows.clear()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [messages, containerRef])
}
