/**
 * sidebarPrefsHooks — 侧栏偏好 store 的 React 订阅钩子（自 domains/appearance 拆出）。
 *
 * store 正身（sidebarModulePrefs / sidebarBlockCollapse）是框架无关外部 store，住
 * domains/appearance（plugin-runtime 侧 sidebarBlockState 也消费）；useSyncExternalStore
 * 订阅是视图关切，集中在本文件（结构审查 WS-G：域模块零 React 依赖）。
 */
import { useSyncExternalStore } from 'react'
import { sidebarModulePrefsStore, type SidebarModulePrefs } from '../../domains/appearance/sidebarModulePrefs.ts'
import { sidebarBlockCollapseStore, type BlockCollapseMap } from '../../domains/appearance/sidebarBlockCollapse.ts'

export function useSidebarModulePrefs(): SidebarModulePrefs {
  return useSyncExternalStore(
    listener => sidebarModulePrefsStore.subscribe(listener),
    () => sidebarModulePrefsStore.getSnapshot(),
    () => sidebarModulePrefsStore.getSnapshot(),
  )
}

export function useSidebarBlockCollapse(): BlockCollapseMap {
  return useSyncExternalStore(
    listener => sidebarBlockCollapseStore.subscribe(listener),
    () => sidebarBlockCollapseStore.getSnapshot(),
    () => sidebarBlockCollapseStore.getSnapshot(),
  )
}
