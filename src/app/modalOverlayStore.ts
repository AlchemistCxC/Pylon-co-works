import { createSolidStoreKernel, type SolidStoreKernel } from '../infrastructure/state/solidStoreKernel'

/**
 * modalOverlayStore —— 「有遮挡主区的模态覆盖层打开」这一事实。
 *
 * 原生子视图（浏览器 Sheet 的 WebView2 子窗口）在原生层永远位于 DOM 之上，DOM 覆盖层
 * 盖不住它（#309）：启动器/权限请求等覆盖层打开时，覆盖层上的按钮会被原生页面吃掉
 * 点击。因此覆盖层打开期间原生子视图必须暂时让位（隐藏、页面继续运行），关闭后恢复。
 *
 * 覆盖层用 veil effect 自我声明（key 任取、互不冲突），store 只聚合
 * 「任一打开」这一布尔；消费方（BrowserSheetView 的原生子视图可见性判定）订阅。
 * **不持久化**——这是瞬时 UI 事实，刷新即复位。
 */
interface ModalOverlayState {
  openKeys: ReadonlySet<string>
  setOverlayOpen: (key: string, open: boolean) => void
}

// #515 批0：zustand → Solid 内核置换；W3 起 useModalOverlayStore 即内核本体（直连，无 shim）。
const kernel = createSolidStoreKernel<ModalOverlayState>({
  openKeys: new Set<string>(),
  setOverlayOpen: (key, open) => kernel.setState(state => {
    const next = new Set(state.openKeys)
    if (open) next.add(key)
    else next.delete(key)
    return { openKeys: next }
  }),
})

export const useModalOverlayStore: SolidStoreKernel<ModalOverlayState> = kernel

// #515 批7：React hook 面（useModalOverlayOpen/useModalOverlayVeil）已随 React 面退役。
// veil 语义在 Solid 侧内联：`createEffect(on(open, v => { setOverlayOpen(key, v);
// onCleanup(() => setOverlayOpen(key, false)) }, { defer: true }))`
// （先例：App.solid 的 createVeil / PermissionDialog.solid）。
