/** @jsxImportSource solid-js */
import { createMemo, Show } from 'solid-js'
import { useThemeStore } from '../domains/theme/themeStore'
import { createZustandSignal } from '../infrastructure/state/solidStoreBridge.ts'
import type { SheetContext, SheetRecord } from './sheetTypes'
import { resolveSheetRender } from './sheetRegistry.ts'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from '../plugin-runtime/workspaces/workspaceRegistry'
import { createRegistrySignal } from '../infrastructure/state/solidSheetSupport.solid.tsx'

/**
 * SheetSidebarSlot — 左栏内容槽（#154 统一侧栏模型）。
 *
 * 布局层按 activeSheet.kind 查渲染注册表的 `sidebar` 声明渲染左栏内容；
 * entry 无 sidebar → 自然收起（能力差异不判断，F2-A）。showSidebar 主题开关
 * 消费点在 W1-03 移入本壳。
 *
 * **几何归属（#154）**：左列宽度、竖直分割线、折叠与拖拽全部由布局层拥有，
 * 不在此处也不在任何 Sheet 里：
 * - 宽度：唯一真值 `--sheet-sidebar-track-width`（展开=用户宽 / 折叠或本 Sheet
 *   无左栏=0），由 `SheetLayout` 写入 `.layout` 的 `sidebar-visible` 状态类。
 * - 分割线：`.layout` 上的一条装饰线（见 Sidebar.css），全应用只有这一条。
 * - 每个 Sheet 的左栏外壳都挂同一个几何类 `.sidebar`，各 Sheet 不得自带宽度/边框。
 *
 * 迁移前 8 个 Sheet 各自画 `<aside>` 并自带宽度/边框，于是标题栏分割线与左列
 * 分割线是两条互不相干的线——浏览器 Sheet 硬编码 156px 时实测错开 84px，
 * Gateway 折叠后标题栏还留下一条 42px 的悬空分割线。
 *
 * `sidebarMode` 的三个字符串值仍是契约（`'workspace' | 'sheet' | 'none'`），
 * 本文件只按注册表取内容，不改变它们的含义。
 *
 * #515：Solid 实体；registry sidebar 与组件面同为 Solid `Component`，Dynamic 直连。
 * 原实现 try/catch 的保护对象是 deserialize 的同步抛错（React 下组件体本就不在
 * try 内执行）——memo 内自兜，抛错即静默收起，行为逐字对齐。
 */
export default function SheetSidebarSlot(props: { sheet: SheetRecord; ctx: SheetContext }) {
  const showSidebar = createZustandSignal(useThemeStore, s => s.showSidebar !== false)
  const registry = createRegistrySignal({ subscribe: subscribeWorkspaceRegistry }, getWorkspaceRegistrySnapshot)
  type SidebarEntry = NonNullable<NonNullable<ReturnType<typeof resolveSheetRender>>['sidebar']>
  const rendered = createMemo<{ Sidebar: SidebarEntry; state: unknown } | null>(() => {
    try {
      registry()
      const entry = resolveSheetRender(props.sheet.kind)
      if (!entry?.sidebar) return null
      return { Sidebar: entry.sidebar, state: entry.deserialize(props.sheet.state) }
    } catch {
      return null
    }
  })
  return (
    <Show when={showSidebar() ? rendered() : null}>
      {payload => {
        const Sidebar = payload().Sidebar
        return <Sidebar sheet={props.sheet} ctx={props.ctx} state={payload().state} />
      }}
    </Show>
  )
}
