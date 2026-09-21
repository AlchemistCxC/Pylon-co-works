import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { useWorkspaceStore } from '../../../workspaceStore.ts'
import { useRightRailStore } from '../../../rightRailStore.ts'
import { applyWorkspaceLayoutChange } from '../../../application/transactions/applyWorkspaceLayoutChange.ts'
import { sidebarBlockCollapseStore } from '../../../domains/workbench/sidebarBlockCollapse.ts'
import { record } from '../../../utils/wireGuards.ts'

function id(input: Record<string, unknown>): string { if (typeof input.sheetId !== 'string' || !input.sheetId.trim()) throw new Error('sheetId 必须是非空字符串'); return input.sheetId.trim() }
function boolean(value: unknown, key: string): boolean { if (typeof value !== 'boolean') throw new Error(`${key} 必须是 boolean`); return value }

export function createBuiltinWorkspaceCommandDefinitions(): CommandDefinition[] {
  const base = 400
  return [
    { id: 'layout.inspect', name: 'layout.inspect', description: '读取共享布局状态', priority: base, execute: () => { const s = useWorkspaceStore.getState(); const rail = useRightRailStore.getState(); return { sidebarWidth: rail.leftRailWidth, sidebarCollapsed: rail.leftRailCollapsed, rightPanelCollapsed: rail.collapsed, rightPanelWidth: rail.width, showPet: s.showPet } } },
    { id: 'layout.sidebar.set', name: 'layout.sidebar.set', description: '设置所有 Sheet 共享的左栏折叠状态', priority: base + 1, execute: ({ args }) => { const value = boolean(record(args).collapsed, 'collapsed'); const result = applyWorkspaceLayoutChange({ sidebarCollapsed: value }); if (!result.ok) throw new Error(result.message); return { collapsed: value } } },
    { id: 'layout.sidebar-width.set', name: 'layout.sidebar-width.set', description: '设置共享左栏宽度', priority: base + 2, execute: ({ args }) => { const width = record(args).width; if (typeof width !== 'number' || !Number.isFinite(width)) throw new Error('width 必须是数字'); const result = applyWorkspaceLayoutChange({ sidebarWidth: width }); if (!result.ok) throw new Error(result.message); return { width: useRightRailStore.getState().leftRailWidth } } },
    { id: 'layout.right-panel.set', name: 'layout.right-panel.set', description: '设置共享右栏折叠状态', priority: base + 3, execute: ({ args }) => { const value = boolean(record(args).collapsed, 'collapsed'); const result = applyWorkspaceLayoutChange({ rightPanelCollapsed: value }); if (!result.ok) throw new Error(result.message); return { collapsed: value } } },
    { id: 'layout.pet.set', name: 'layout.pet.set', description: '设置桌宠显示状态', priority: base + 4, execute: ({ args }) => { const show = boolean(record(args).show, 'show'); useWorkspaceStore.getState().setShowPet(show); return { show } } },
    // 旧命令 `layout.agent-sidebar.set { mode: 'work' | 'chat' }` 随左栏互斥页签一并删除。
    // 现命令设置单个模块的折叠。#202 起折叠是**跨 Sheet 的应用级偏好**（全局单一真值，
    // 独立持久化 key），入参因此不再需要 sheetId；**读改写**全局映射而不是整块覆盖。
    { id: 'layout.agent-sidebar.block.set', name: 'layout.agent-sidebar.block.set', description: '设置左栏某模块的折叠状态（跨 Sheet 共享）', priority: base + 5, execute: ({ args }) => { const input = record(args); const blockId = input.blockId; if (typeof blockId !== 'string' || !blockId.trim()) throw new Error('blockId 必须是非空字符串'); const collapsed = boolean(input.collapsed, 'collapsed'); const store = sidebarBlockCollapseStore; store.setCollapseMap({ ...store.collapsed, [blockId.trim()]: collapsed }); return { blockId: blockId.trim(), collapsed } } },
    { id: 'workspace.sheet.focus', name: 'workspace.sheet.focus', description: '聚焦已打开 Sheet', priority: base + 6, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().focusSheet(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.pin.toggle', name: 'workspace.sheet.pin.toggle', description: '切换 Sheet 固定状态', priority: base + 7, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().toggleSheetPin(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.close-others', name: 'workspace.sheet.close-others', description: '关闭其他 Sheet', priority: base + 8, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().closeOtherSheets(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.close-right', name: 'workspace.sheet.close-right', description: '关闭右侧 Sheet', priority: base + 9, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().closeRightSheets(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.reopen', name: 'workspace.sheet.reopen', description: '重新打开最近关闭的 Sheet', priority: base + 10, execute: () => ({ sheetId: useWorkspaceStore.getState().reopenSheet() }) },
  ]
}
