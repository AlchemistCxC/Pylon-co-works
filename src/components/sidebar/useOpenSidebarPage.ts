import { useSyncExternalStore } from 'react'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { normalizePageState, resolveOpenPage } from '../../plugin-runtime/sidebar/sidebarBlockState.ts'
import type { AgentSidebarContribution } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * 解出当前 Sheet 上「已展开成整页」的左栏区块贡献；没有则 `null`。
 *
 * 主区（`AgentSheetView`）与页面宿主共用它，避免两处各算一遍「现在到底有没有页面」。
 * 只认**同时**声明了 `page` 的贡献：id 指向已卸载/未声明页面的贡献时回落 `null`，
 * 于是插件停用后主区自然回到聊天视图，而不是锁死在一个不存在的页面上。
 *
 * #515：本 hook 无 JSX，抽成中立 .ts 让 React 薄桥（AgentSheetPageHost.tsx）与 Solid
 * 侧测试共享——React 消费方（AgentSheetView.tsx）未迁前它保持 React hook 形态。
 */
export function useOpenSidebarPage(state: unknown): AgentSidebarContribution | null {
  const sidebarRegistry = getAgentSidebarRegistry()
  const snapshot = useSyncExternalStore(
    listener => sidebarRegistry.subscribe(listener),
    () => sidebarRegistry.getSnapshot(),
    () => sidebarRegistry.getSnapshot(),
  )
  const blockState = normalizePageState(state)
  return resolveOpenPage(snapshot.entries.map(entry => entry.value), blockState)
}
