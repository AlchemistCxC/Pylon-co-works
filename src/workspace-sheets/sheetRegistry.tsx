/**
 * 阶段 6 兼容门面：renderer/type definition 单一真值位于 Workspace Registry。
 * 保留文件名仅供既有 consumer 渐进迁移，不再持有静态渲染表。
 */
import { resolveWorkspace } from './workspaceRegistry.ts'
import type { SheetKind } from './sheetTypes.ts'
import type { WorkspaceTypeDefinition } from './workspaceTypes.ts'

export function resolveSheetRender(kind: SheetKind): WorkspaceTypeDefinition | undefined {
  return resolveWorkspace(kind)
}
