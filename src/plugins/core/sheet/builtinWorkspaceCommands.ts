import type { CommandDefinition } from '../../../plugin-runtime/commands/commandRegistry.ts'
import { useWorkspaceStore } from '../../../workspaceStore.ts'
import { useRightRailStore } from '../../../rightRailStore.ts'

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function id(input: Record<string, unknown>): string { if (typeof input.sheetId !== 'string' || !input.sheetId.trim()) throw new Error('sheetId 必须是非空字符串'); return input.sheetId.trim() }
function boolean(value: unknown, key: string): boolean { if (typeof value !== 'boolean') throw new Error(`${key} 必须是 boolean`); return value }

export function createBuiltinWorkspaceCommandDefinitions(): CommandDefinition[] {
  const base = 400
  return [
    { id: 'layout.inspect', name: 'layout.inspect', description: '读取共享布局状态', priority: base, execute: () => { const s = useWorkspaceStore.getState(); const rail = useRightRailStore.getState(); return { sidebarWidth: rail.leftRailWidth, sidebarCollapsed: rail.leftRailCollapsed, rightPanelCollapsed: rail.collapsed, rightPanelWidth: rail.width, showPet: s.showPet } } },
    { id: 'layout.sidebar.set', name: 'layout.sidebar.set', description: '设置所有 Sheet 共享的左栏折叠状态', priority: base + 1, execute: ({ args }) => { const value = boolean(record(args).collapsed, 'collapsed'); useRightRailStore.getState().setLeftRailCollapsed(value); useWorkspaceStore.getState().setSidebarCollapsed(value); return { collapsed: value } } },
    { id: 'layout.sidebar-width.set', name: 'layout.sidebar-width.set', description: '设置共享左栏宽度', priority: base + 2, execute: ({ args }) => { const width = record(args).width; if (typeof width !== 'number' || !Number.isFinite(width)) throw new Error('width 必须是数字'); useRightRailStore.getState().setLeftRailWidth(width); useWorkspaceStore.getState().setSidebarWidth(width); return { width: useRightRailStore.getState().leftRailWidth } } },
    { id: 'layout.right-panel.set', name: 'layout.right-panel.set', description: '设置共享右栏折叠状态', priority: base + 3, execute: ({ args }) => { const value = boolean(record(args).collapsed, 'collapsed'); useRightRailStore.getState().setCollapsed(value); useWorkspaceStore.getState().setRightPanelCollapsed(value); return { collapsed: value } } },
    { id: 'layout.pet.set', name: 'layout.pet.set', description: '设置桌宠显示状态', priority: base + 4, execute: ({ args }) => { const show = boolean(record(args).show, 'show'); useWorkspaceStore.getState().setShowPet(show); return { show } } },
    { id: 'layout.agent-sidebar.set', name: 'layout.agent-sidebar.set', description: '设置 Agent Sheet 左栏工作/聊天模式', priority: base + 5, execute: ({ args }) => { const input = record(args); const mode = input.mode; if (mode !== 'work' && mode !== 'chat') throw new Error('mode 必须是 work 或 chat'); useWorkspaceStore.getState().patchSheetState(id(input), { sidebarMode: mode }); return { sheetId: id(input), mode } } },
    { id: 'workspace.sheet.focus', name: 'workspace.sheet.focus', description: '聚焦已打开 Sheet', priority: base + 6, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().focusSheet(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.pin.toggle', name: 'workspace.sheet.pin.toggle', description: '切换 Sheet 固定状态', priority: base + 7, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().toggleSheetPin(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.close-others', name: 'workspace.sheet.close-others', description: '关闭其他 Sheet', priority: base + 8, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().closeOtherSheets(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.close-right', name: 'workspace.sheet.close-right', description: '关闭右侧 Sheet', priority: base + 9, execute: ({ args }) => { const sheetId = id(record(args)); useWorkspaceStore.getState().closeRightSheets(sheetId); return { sheetId } } },
    { id: 'workspace.sheet.reopen', name: 'workspace.sheet.reopen', description: '重新打开最近关闭的 Sheet', priority: base + 10, execute: () => ({ sheetId: useWorkspaceStore.getState().reopenSheet() }) },
  ]
}
