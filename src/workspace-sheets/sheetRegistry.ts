/**
 * sheetRegistry — Workspace 元数据查询门面（阶段 6 首个切片）。
 *
 * 旧静态表 SHEET_REGISTRY / SHEET_SIDEBAR_MODES / SHEET_LAUNCH_OPTIONS 已删除；
 * 单一真值在 workspaceRegistry.ts（v2 core.sheet.* 注册完整 type definition）。本文件保留导出名，
 * 供 sheetState / builtinSheetPlugins 等既有调用方无感迁移。
 */
import type { WorkspaceLaunchOption, WorkspaceTypeDefinition } from './workspaceTypes.ts'
import {
  listWorkspaceLaunchOptions,
  resolveSheetSingletonKey as resolveSingletonKey,
  resolveWorkspace,
} from './workspaceRegistry.ts'
import type { SheetInput } from './sheetTypes.ts'

export function getSheetRegistryEntry(kind: unknown): WorkspaceTypeDefinition | undefined {
  return resolveWorkspace(kind)
}

export function resolveSheetSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined {
  return resolveSingletonKey(input)
}

export function getSheetLaunchOptions(): readonly WorkspaceLaunchOption[] {
  return listWorkspaceLaunchOptions()
}

export function getSheetLaunchOption(kind: unknown): WorkspaceLaunchOption | undefined {
  return listWorkspaceLaunchOptions().find(option => option.kind === kind)
}
