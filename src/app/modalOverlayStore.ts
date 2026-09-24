import { create } from 'zustand'
import { useEffect } from 'react'

/**
 * modalOverlayStore —— 「有遮挡主区的模态覆盖层打开」这一事实。
 *
 * 原生子视图（浏览器 Sheet 的 WebView2 子窗口）在原生层永远位于 DOM 之上，DOM 覆盖层
 * 盖不住它（#309）：启动器/权限请求等覆盖层打开时，覆盖层上的按钮会被原生页面吃掉
 * 点击。因此覆盖层打开期间原生子视图必须暂时让位（隐藏、页面继续运行），关闭后恢复。
 *
 * 覆盖层用 {@link useModalOverlayVeil} 自我声明（key 任取、互不冲突），store 只聚合
 * 「任一打开」这一布尔；消费方（BrowserSheetView 的原生子视图可见性判定）订阅。
 * **不持久化**——这是瞬时 UI 事实，刷新即复位。
 */
interface ModalOverlayState {
  openKeys: ReadonlySet<string>
  setOverlayOpen: (key: string, open: boolean) => void
}

export const useModalOverlayStore = create<ModalOverlayState>(set => ({
  openKeys: new Set<string>(),
  setOverlayOpen: (key, open) => set(state => {
    const next = new Set(state.openKeys)
    if (open) next.add(key)
    else next.delete(key)
    return { openKeys: next }
  }),
}))

/** 任一已声明的模态覆盖层处于打开状态。 */
export function useModalOverlayOpen(): boolean {
  return useModalOverlayStore(state => state.openKeys.size > 0)
}

/**
 * 覆盖层自我声明：`open` 期间占有 `key` 槽位，卸载/关闭即释放。
 * 必须在覆盖层组件顶层无条件调用（hooks 规则）——组件常以 `open` 条件渲染自身内容，
 * 但组件本身要一直挂载才能在关闭瞬间释放槽位。
 */
export function useModalOverlayVeil(key: string, open: boolean): void {
  const setOverlayOpen = useModalOverlayStore(state => state.setOverlayOpen)
  useEffect(() => {
    setOverlayOpen(key, open)
    return () => setOverlayOpen(key, false)
  }, [key, open, setOverlayOpen])
}
