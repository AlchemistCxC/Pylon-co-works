/**
 * mockTauri — 浏览器模式假 Tauri 后端（静态演示全景）。
 *
 * 机制：@tauri-apps/api 的 invoke/transformCallback/listen 全部经
 * window.__TAURI_INTERNALS__（invoke）/__TAURI_EVENT_PLUGIN_INTERNALS__（unlisten）。
 * 浏览器无真实后端 → 安装假 globals → 现有全部 invoke 调用点零改动拿到 mock 数据。
 *
 * 纪律：仅静态数据，不做事件流模拟（pylon:* listen 在浏览器被 IS_TAURI 守卫锁着）。
 * 诚实保留：browser_start/CDP 组与未知命令 reject（走现有「待后端」/错误分支，不冒充成功）。
 *
 * 安装时序（关键）：env.ts 的 IS_TAURI 是模块级 const（探测 __TAURI_INTERNALS__ 存在性），
 * 首次求值即冻结——必须在 main.tsx body（静态 import 全部求值后）安装，绝不能在 env.ts
 * 之前求值的模块 module-scope 安装。
 */
import {
  buildDemoAgents, buildGatewayStatus, buildGitDiff, buildGitHistory, buildGitStatus,
  buildPlatformSessions, buildRuntimeLogs, buildSessionResponse, buildSessionSummaries, buildStartupDiagnostics,
  buildWorkspaceFileText, buildWorkspaceSearchResults, resolveWorkspaceEntries,
} from './demoData.ts'

// 浏览器 mock 有状态网关 routes：gateway 保存后 read-back 一致（浏览器可验 FE-AUD-004 安全写回）
let mockGatewayRoutes = buildGatewayStatus().routes

/** 纯命令路由（node 可测，无 window）。未知命令 reject（含 browser_start/CDP 组）。 */
export async function mockInvokeCommand(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case 'list_agents': return buildDemoAgents()
    case 'list_workspace_entries':
      return resolveWorkspaceEntries(typeof args.relativePath === 'string' ? args.relativePath : '')
    case 'read_workspace_text':
      return buildWorkspaceFileText(typeof args.relativePath === 'string' ? args.relativePath : '')
    case 'git_status': return buildGitStatus()
    case 'git_history': return buildGitHistory()
    case 'git_diff': return buildGitDiff()
    case 'gateway_status': return { ...buildGatewayStatus(), routes: mockGatewayRoutes }
    case 'gateway_sessions': return buildPlatformSessions()
    case 'update_agents_config': {
      // G4 验收：gateway 保存有状态——更新 mock routes，read-back 一致（浏览器可验安全写回）
      const routes = (args.config as { gateway?: { routes?: unknown[] } } | undefined)?.gateway?.routes
      if (Array.isArray(routes)) mockGatewayRoutes = routes as never[]
      return null
    }
    case 'reload_gateway': return null
    case 'list_persisted_sessions': return buildSessionSummaries()
    case 'startup_diagnostics': return buildStartupDiagnostics()
    case 'list_runtime_logs': return buildRuntimeLogs()
    case 'workspace_search': return buildWorkspaceSearchResults(typeof args.query === 'string' ? args.query : '')
    case 'new_session':
    case 'load_persisted_session':
      return buildSessionResponse(args)
    case 'send_message': return { ok: true, mock: true }
    case 'switch_agent':
    case 'reconnect_agent':
    case 'reload_agents':
    case 'set_approval_mode':
    case 'set_mode':
    case 'set_config_option':
    case 'close_session':
    case 'cancel_prompt':
    case 'approve_tool_call':
    case 'export_session':
    case 'clear_runtime_logs':
      return null
    case 'plugin:event|listen': return 1
    case 'plugin:event|unlisten': return null
    case 'plugin:dialog|save':
      return typeof args.defaultPath === 'string'
        ? `G:\\mock\\exports\\${args.defaultPath}`
        : 'G:\\mock\\exports\\session-export.md'
    default:
      return Promise.reject(new Error(`Command not found: ${cmd}`))
  }
}

/** 安装假 Tauri globals（真 Tauri 环境或已安装时 no-op）。 */
export function installMockTauri(): void {
  if (typeof window === 'undefined') return
  const target = window as unknown as Record<string, unknown>
  if (target.__TAURI_INTERNALS__) return
  let callbackId = 0
  target.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => mockInvokeCommand(cmd, args ?? {}),
    transformCallback: (_callback: unknown, _once?: boolean) => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: (filePath: string) => filePath,
  }
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
    unregisterCallback: () => {},
  }
}
