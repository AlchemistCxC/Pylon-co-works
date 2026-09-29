import type { SheetId, SheetRecord } from '../../contracts/sheets.ts'

/**
 * workspaceControllerPort — 工作区编排器（open/focus/close/list）端口（B-2b）。
 *
 * 断裂 `plugin-runtime → workspace-sheets/workspaceController` 的值边：视图编排实现
 * （sheet 开合的事实编排）不再被 plugin-runtime 直接 import；具体实现由应用装配层
 * （`app/bootstrap/workspaceControllerWiring`）注册。未注册即抛错——不提供静默降级，
 * 装配遗漏必须显性失败（与 identityCrossDomainPort 同一纪律）。
 */

export interface WorkspaceOpenInput {
  type: string
  title?: string
  state?: unknown
  agentId?: string
  singletonKey?: string
  pinned?: boolean
  metadata?: Record<string, string>
}

export interface WorkspaceControllerPort {
  open(input: WorkspaceOpenInput): SheetId | null
  focus(id: SheetId): boolean
  close(id: SheetId): Promise<boolean>
  list(): readonly SheetRecord[]
}

let port: WorkspaceControllerPort | null = null

export function registerWorkspaceControllerPort(implementation: WorkspaceControllerPort): void {
  port = implementation
}

export function workspaceController(): WorkspaceControllerPort {
  if (!port) {
    throw new Error('workspaceControllerPort 未注册：应用装配层（workspaceControllerWiring）须先于任何插件 workspace 调用装配')
  }
  return port
}
