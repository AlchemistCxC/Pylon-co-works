// 视图侧门面（结构审查 B-1/A 域外指涉）：实现在 domains/workspace/sheetRegistry.ts。
// 保留旧导出名供 sheetState/builtinSheetPlugins 等既有调用方无感迁移。
export * from '../domains/workspace/sheetRegistry.ts'

// 阶段 6 兼容门面：renderer/type definition 单一真值位于 Workspace Registry。
// 原独立于 sheetRegistry.tsx（无 JSX 纯门面），2026-10 死代码清理批并入本文件。
import { resolveWorkspace } from '../plugin-runtime/workspaces/workspaceRegistry.ts'
import type { SheetKind } from './sheetTypes.ts'
import type { WorkspaceTypeDefinition } from '../plugin-runtime/workspaces/workspaceTypes.ts'

export function resolveSheetRender(kind: SheetKind): WorkspaceTypeDefinition | undefined {
  return resolveWorkspace(kind)
}
