import { useSyncExternalStore } from 'react'
import { getAgentSidebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import {
  applyModulePrefs,
  sidebarModulePrefsStore,
  useSidebarModulePrefs,
} from '../../domains/workbench/sidebarModulePrefs.ts'

/**
 * 侧栏模块显隐（设置 → 侧栏）。
 *
 * 顺序与显隐是**跨 Sheet 的界面偏好**，与具体某个 Sheet 的折叠状态无关，因此读写
 * `sidebarModulePrefs`（独立 localStorage key），不碰 sheet state。
 *
 * `alwaysOpen` 的模块（会话）列出但开关禁用：左栏没有会话列表就失去了主体。
 */
export default function SidebarModulesPanel() {
  const prefs = useSidebarModulePrefs()
  const registry = getAgentSidebarRegistry()
  const snapshot = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  )

  const all = snapshot.entries.map(entry => entry.value)
  const visibleIds = new Set(applyModulePrefs(all, prefs).map(contribution => contribution.id))
  const hidden = new Set(prefs.hidden)

  const setHidden = (id: string, nextHidden: boolean) => {
    const next = nextHidden
      ? [...hidden, id]
      : [...hidden].filter(candidate => candidate !== id)
    sidebarModulePrefsStore.setPrefs({ order: prefs.order, hidden: next })
  }

  if (all.length === 0) return <p className="set-hint">当前没有已注册的左栏模块。</p>

  return (
    <div className="sidebar-modules-panel" role="group" aria-label="侧栏模块显隐">
      {all.map(contribution => {
        const alwaysOpen = contribution.alwaysOpen === true
        const shown = alwaysOpen || visibleIds.has(contribution.id)
        return (
          <label className="sidebar-modules-row" key={contribution.id}>
            <input
              type="checkbox"
              checked={shown}
              disabled={alwaysOpen}
              aria-label={`显示模块 ${contribution.label}`}
              onChange={event => setHidden(contribution.id, !event.target.checked)}
            />
            <span className="sidebar-modules-name">{contribution.label}</span>
            {alwaysOpen && <span className="sidebar-modules-note">常开</span>}
            {contribution.page && <span className="sidebar-modules-note">可展开为页面</span>}
          </label>
        )
      })}
      <p className="set-hint">次序在左栏里直接拖拽模块标题左侧的手柄调整。</p>
    </div>
  )
}
