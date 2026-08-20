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
  buildDemoAgents, buildGatewayStatus, buildGitDiff, buildGitHistory, buildGitStatus, buildGitStatusWithBranch,
  buildPlatformSessions, buildRuntimeLogs, buildSessionResponse, buildSessionSummaries, buildStartupDiagnostics,
  buildWorkspaceFileText, buildWorkspaceSearchResults, resolveWorkspaceEntries,
} from './demoData.ts'
import { buildVisualQaPluginPackages, buildVisualQaWorkspaces } from './visualQaData.ts'
import type { InstalledPluginPackage } from '../infrastructure/plugins/pluginPackageClient.ts'
import type { Workspace } from '../workspaceEntities.ts'

// 浏览器 mock 有状态网关 routes：gateway 保存后 read-back 一致（浏览器可验 FE-AUD-004 安全写回）
let mockGatewayRoutes = buildGatewayStatus().routes
// CWD-03：Workspace 实体 mock（浏览器演示：内存态 create/list/update/delete）
let mockWorkspaces: Workspace[] = buildVisualQaWorkspaces()
let mockWorkspaceSeq = mockWorkspaces.length + 1
let mockPluginPackages: InstalledPluginPackage[] = buildVisualQaPluginPackages()
let mockGitEntries = buildGitStatus()
let mockGitBranch = 'demo'
let mockGitHistory = buildGitHistory()
let mockAgentConfigRevision = 1

function mockGitOperation(summary: string) {
  return {
    summary,
    status: { branch: { branch: mockGitBranch, detached: false, head: 'ac82de4' }, entries: mockGitEntries },
  }
}

/** 纯命令路由（node 可测，无 window）。未知命令 reject（含 browser_start/CDP 组）。 */
export async function mockInvokeCommand(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case 'list_agents': return buildDemoAgents()
    case 'agent_config_snapshot': return {
      revision: `demo-config-${mockAgentConfigRevision}`,
      agents: buildDemoAgents(),
      diagnostics: [],
    }
    case 'list_workspace_entries':
      return resolveWorkspaceEntries(typeof args.relativePath === 'string' ? args.relativePath : '')
    case 'read_workspace_text':
      return buildWorkspaceFileText(typeof args.relativePath === 'string' ? args.relativePath : '')
    case 'git_status': return mockGitEntries
    case 'git_status_with_branch': return { ...buildGitStatusWithBranch(), branch: { branch: mockGitBranch, detached: false, head: 'ac82de4' }, entries: mockGitEntries }
    case 'git_history': return mockGitHistory
    case 'git_diff': return buildGitDiff()
    case 'git_stage': {
      const paths = Array.isArray(args.paths) ? new Set(args.paths.filter((path): path is string => typeof path === 'string')) : new Set<string>()
      mockGitEntries = mockGitEntries.map(entry => paths.has(entry.path) ? { ...entry, staged: true } : entry)
      return mockGitOperation('已暂存所选文件（演示）')
    }
    case 'git_unstage': {
      const paths = Array.isArray(args.paths) ? new Set(args.paths.filter((path): path is string => typeof path === 'string')) : new Set<string>()
      mockGitEntries = mockGitEntries.map(entry => paths.has(entry.path) ? { ...entry, staged: false } : entry)
      return mockGitOperation('已取消暂存所选文件（演示）')
    }
    case 'git_commit': {
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      mockGitEntries = mockGitEntries.filter(entry => !entry.staged)
      mockGitHistory = [{ hash: 'd3a0c01', author: 'Demo User', date: Math.floor(Date.now() / 1000), subject: message || '演示提交' }, ...mockGitHistory]
      return mockGitOperation('提交成功（演示）')
    }
    case 'git_create_branch':
    case 'git_switch_branch':
      mockGitBranch = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : mockGitBranch
      return mockGitOperation(cmd === 'git_create_branch' ? '已创建并切换分支（演示）' : '已切换分支（演示）')
    case 'git_pull': return mockGitOperation('已经是最新版本（演示）')
    case 'git_push': return mockGitOperation('推送完成（演示）')
    case 'detect_agent_runtimes': return {
      candidates: [{
        candidateId: 'mock-high:C:/Tools/peri.exe', detectorId: 'builtin.detector.peri', provider: 'peri',
        suggestedAgentId: 'peri-local', name: 'Peri Local', executable: 'C:/Tools/peri.exe', args: ['acp'],
        evidence: [{ kind: 'path', detail: 'C:/Tools/peri.exe' }, { kind: 'version', detail: 'peri 1.8.0' }],
        identityConfidence: 'high', protocolAvailability: 'not_tested', warnings: [],
      },
      {
        candidateId: 'mock-medium:C:/Tools/hermes.exe', detectorId: 'builtin.detector.hermes', provider: 'hermes',
        suggestedAgentId: 'hermes-local', name: 'Hermes Local', executable: 'C:/Tools/hermes.exe', args: ['acp'],
        evidence: [{ kind: 'path', detail: 'C:/Tools/hermes.exe' }], identityConfidence: 'medium', protocolAvailability: 'not_tested',
        warnings: ['未能读取版本；导入前必须完成 ACP initialize 验证'],
      }],
      diagnostics: [],
      elapsedMs: 12,
      truncated: false,
    }
    case 'test_agent_candidate': {
      const agentId = typeof args.agentId === 'string' ? args.agentId : 'candidate'
      if (agentId.startsWith('peri')) return {
        ok: false, agentId, durationMs: 418,
        error: { code: 'agent_initialize_failed', message: 'ACP connection closed', action: 'open-runtime-log', stage: 'initialize', exitCode: 7, stderr: 'Provider profile was not selected' },
      }
      return { ok: true, agentId, durationMs: 126, error: null }
    }
    case 'gateway_status': return { ...buildGatewayStatus(), routes: mockGatewayRoutes }
    case 'gateway_sessions': return buildPlatformSessions()
    case 'update_agents_config': {
      const expected = `demo-config-${mockAgentConfigRevision}`
      if (args.expectedRevision !== expected) {
        throw { code: 'config_revision_conflict', message: `期望 ${String(args.expectedRevision)}，实际 ${expected}` }
      }
      // G4 验收：gateway 保存有状态——更新 mock routes，read-back 一致（浏览器可验安全写回）
      const routes = (args.config as { gateway?: { routes?: unknown[] } } | undefined)?.gateway?.routes
      if (Array.isArray(routes)) mockGatewayRoutes = routes as never[]
      mockAgentConfigRevision += 1
      return { applied: true, revision: `demo-config-${mockAgentConfigRevision}` }
    }
    case 'reload_gateway': return null
    case 'list_persisted_sessions': return buildSessionSummaries()
    case 'startup_diagnostics': return buildStartupDiagnostics()
    case 'list_runtime_logs': return buildRuntimeLogs()
    case 'workspace_search': return buildWorkspaceSearchResults(typeof args.query === 'string' ? args.query : '')
    case 'workspace_create': {
      const workspace = {
        id: `w${mockWorkspaceSeq++}`,
        agentId: typeof args.agentId === 'string' ? args.agentId : '',
        name: typeof args.name === 'string' ? args.name : '默认工作区',
        rootPath: typeof args.rootPath === 'string' ? args.rootPath : 'G:\\mock\\workspace',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        skills: [],
        mcpServerIds: [],
        hookPluginIds: [],
      }
      mockWorkspaces = [...mockWorkspaces, workspace]
      return workspace
    }
    case 'workspace_list': return mockWorkspaces
    case 'workspace_update': {
      const workspace = mockWorkspaces.find(w => w.id === args.workspaceId)
      if (!workspace) return Promise.reject(new Error(`workspace not found: ${args.workspaceId}`))
      const updated = {
        ...workspace,
        name: typeof args.name === 'string' ? args.name : workspace.name,
        rootPath: typeof args.rootPath === 'string' ? args.rootPath : workspace.rootPath,
        skills: Array.isArray(args.skills) ? args.skills.filter((value): value is string => typeof value === 'string') : workspace.skills,
        mcpServerIds: Array.isArray(args.mcpServerIds) ? args.mcpServerIds.filter((value): value is string => typeof value === 'string') : workspace.mcpServerIds,
        hookPluginIds: Array.isArray(args.hookPluginIds) ? args.hookPluginIds.filter((value): value is string => typeof value === 'string') : workspace.hookPluginIds,
        lastActiveAt: Date.now(),
      }
      mockWorkspaces = mockWorkspaces.map(w => w.id === updated.id ? updated : w)
      return updated
    }
    case 'workspace_delete': {
      mockWorkspaces = mockWorkspaces.filter(w => w.id !== args.workspaceId)
      return null
    }
    case 'plugin_package_list': return mockPluginPackages
    case 'plugin_package_versions':
      return mockPluginPackages
        .filter(item => item.package.pluginId === args.pluginId)
        .map(item => item.package)
    case 'plugin_package_set_enabled': {
      mockPluginPackages = mockPluginPackages.map(item => item.package.pluginId === args.pluginId
        ? { ...item, enabled: args.enabled === true }
        : item)
      return null
    }
    case 'plugin_package_uninstall': {
      mockPluginPackages = mockPluginPackages.filter(item => item.package.pluginId !== args.pluginId)
      return null
    }
    case 'new_session':
    case 'load_persisted_session':
      return buildSessionResponse(args)
    case 'send_message': return { ok: true, mock: true }
    case 'restart_agent_runtime': return {
      agentId: typeof args.agentId === 'string' ? args.agentId : 'peri',
      configActivationState: 'activated',
    }
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
