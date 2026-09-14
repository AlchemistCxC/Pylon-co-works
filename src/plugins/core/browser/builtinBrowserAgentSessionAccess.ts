import { invoke } from '@tauri-apps/api/core'
import type { PluginSessionCreationApi } from '../../../plugin-runtime/session-creation/pluginSessionCreationApi.ts'
import { ACP_NEW_SESSION_OPTIONS_EFFECT_KIND, SESSION_PREFLIGHT_PHASE } from '../sessionCreation/sessionPreflight.ts'
import type { SessionCreationPhaseEffect } from '../../../plugin-runtime/session-creation/sessionCreationTypes.ts'

/**
 * 内置浏览器 Agent 会话贡献（issue #82）。
 *
 * 会话创建时经 `pylon/session-preflight` 询问 Rust 侧有效档位
 * （`browser.agentAccess`，默认 readonly）：off 时不产出任何 effect（agent
 * 拿不到浏览器工具）；否则把 `pylon.exe browser-bridge` 注入 ACP
 * `session/new` 的 mcpServers——桥由 agent 侧自行拉起，这里不启动进程。
 * `--session` 注入会话身份，作为 Rust claim 与审计的绑定键。
 */

export const BROWSER_AGENT_CONTRIBUTION_KIND = 'pylon.browser/bootstrap'
export const BROWSER_AGENT_ARTIFACT_KIND = 'pylon.browser/prepare'
export const BROWSER_AGENT_MCP_ID = 'pylon-browser'

interface AccessResolution {
  mode?: unknown
}

interface ExePathResolution {
  path?: unknown
}

export function registerBuiltinBrowserAgentSessionAccess(api: PluginSessionCreationApi): void {
  api.registerContribution({
    id: 'builtin.browser/agent-access',
    kind: BROWSER_AGENT_CONTRIBUTION_KIND,
    order: 120,
    failurePolicy: 'optional',
    payload: () => ({ source: 'builtin.browser' }),
  })

  api.registerCompiler({
    id: 'builtin.browser/agent-access-compiler',
    kind: BROWSER_AGENT_CONTRIBUTION_KIND,
    order: 120,
    compile: () => [{
      phase: SESSION_PREFLIGHT_PHASE,
      kind: BROWSER_AGENT_ARTIFACT_KIND,
      order: 120,
      payload: { source: 'builtin.browser' },
    }],
  })

  api.registerArtifactHandler({
    id: 'builtin.browser/agent-access-handler',
    phase: SESSION_PREFLIGHT_PHASE,
    kind: BROWSER_AGENT_ARTIFACT_KIND,
    order: 120,
    async run(_artifact, context) {
      if (context.signal.aborted) throw new Error('session preflight aborted')
      // 解析失败（开发预览无 Tauri、Rust 未就绪等）→ 不注入且不产生 diagnostic：
      // 桥缺席本身就是 fail-closed，不应在每次建会话时留下告警噪音。
      try {
        const workspaceId = context.session.workspaceId ?? null
        const access = await invoke<AccessResolution>('browser_agent_resolve_access', { workspaceId })
        if (access.mode === 'off') return []
        const exe = await invoke<ExePathResolution>('browser_agent_exe_path')
        if (typeof exe.path !== 'string' || !exe.path.trim()) return []
        const args = ['browser-bridge', '--session', context.session.id]
        if (workspaceId) args.push('--workspace', workspaceId)
        const effect: SessionCreationPhaseEffect = {
          kind: ACP_NEW_SESSION_OPTIONS_EFFECT_KIND,
          payload: {
            mcpServers: [{
              id: BROWSER_AGENT_MCP_ID,
              name: 'Pylon Browser',
              transport: 'stdio',
              enabled: true,
              command: exe.path,
              args,
            }],
          },
        }
        return [effect]
      } catch {
        return []
      }
    },
  })
}
