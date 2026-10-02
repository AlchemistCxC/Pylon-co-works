import { createMemo, createSignal, onCleanup } from 'solid-js'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { normalizePageState, resolveOpenPage } from '../../plugin-runtime/sidebar/sidebarBlockState.ts'
import type { AgentSidebarContribution } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

/**
 * 解出当前 Sheet 上「已展开成整页」的左栏区块贡献；没有则 `null`（Solid 形态）。
 *
 * 只认**同时**声明了 `page` 的贡献：id 指向已卸载/未声明页面的贡献时回落 `null`，
 * 于是插件停用后主区自然回到聊天视图，而不是锁死在一个不存在的页面上。
 *
 * #515：原 React hook `useOpenSidebarPage.ts` 的 Solid 等价（生产实体
 * Sidebar.solid / AgentSheetView.solid 已各自内联 resolveOpenPage 接线，本文件
 * 保留同一接缝的共享形态供测试与后续 Solid 消费方使用）。
 */
export function createOpenSidebarPage(state: () => unknown): () => AgentSidebarContribution | null {
  const sidebarRegistry = getAgentSidebarRegistry()
  const [snapshot, setSnapshot] = createSignal(sidebarRegistry.getSnapshot())
  onCleanup(sidebarRegistry.subscribe(() => setSnapshot(() => sidebarRegistry.getSnapshot())))
  return createMemo(() => resolveOpenPage(
    snapshot().entries.map(entry => entry.value),
    normalizePageState(state()),
  ))
}
