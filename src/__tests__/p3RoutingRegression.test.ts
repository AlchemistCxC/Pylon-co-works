/**
 * OWNER-05：P3 路由回归矩阵（方案书 §1.4 P3 / LRP M2 卡点：双 Agent/断线/重连）。
 *
 * 冷启动目标路径（§5.9）：Sheet 恢复 → resolve owner → agent status → load/create binding →
 * Binding Ready → enable InputBar。本矩阵在真实 stores + 真实 send_message payload 构造层
 * 上走通整条链路的域内不变量（不用 UI 渲染，避免"仅凭 UI 颜色判定已连接"）：
 *
 *   R1 冷启动绑定就绪：send_message payload 显式携带 Session.agentId（owner 路由）
 *   R2 双 Agent 同名 source：发送路由按 Session owner，绝不取 activeAgent；binding
 *      generation 按 AgentContextKey 隔离不串线
 *   R3 断线：owner 断开 → agent_disconnected → 发送锁定（gate 阻断）
 *   R4 重连：generation 变化 → binding_stale → 锁定 + "需重新加载会话"
 *   R5 重连后重建绑定（established===current）→ 解锁
 *   R6 冷启动 agent 状态快照未达 → restoring 锁定（Sheet 恢复 ≠ Agent 已连）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import '../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { useWorkspaceStore } from '../workspaceStore'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { toAgentContextKey } from '../agentContext'
import { createSheetState } from '../workspace-sheets/sheetState'
import { buildSendMessagePayload } from '../components/chat/sessionRuntime'
import { resetStores } from '../test/resetStores'
import { resolveBindingState, refineBindingGeneration, isBindingLocked, bindingStatusText } from '../domains/binding/bindingState'
import type { AgentStatus } from '../components/settings/agentTypes'
import type { Session } from '../identityStore'

function session(id: string, agentId: string, source: string, periId?: string): Session {
  return {
    id, agentId, name: `s-${id}`, source, profileId: 'profile-a',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '', ...(periId ? { periId } : {}),
  }
}

function status(agentId: string, s: AgentStatus['status'], generation: number): AgentStatus {
  return { agent: agentId, agentId, status: s, generation, lastConnectedAt: Date.now() }
}

/** 镜像 useBindingState 的派生逻辑（纯 store 读取 + resolve + refine），供矩阵断言 */
function deriveBinding(sessionId: string | null) {
  const ws = useWorkspaceStore.getState()
  const sheetId = ws.workspaceSheets.activeSheetId
  const activeSheet = sheetId ? ws.workspaceSheets.sheets.find(s => s.id === sheetId) ?? null : null
  const identity = useIdentityStore.getState()
  const rt = useRuntimeStore.getState()
  const ownerId = activeSheet?.kind === 'agent' ? activeSheet.agentId : undefined
  const ownerStatus = ownerId ? rt.agentStatuses[ownerId] : undefined
  const activeSession = sessionId ? identity.sessions.find(s => s.id === sessionId) ?? null : null
  const bindingKey = activeSession
    ? toAgentContextKey({ agentId: activeSession.agentId, source: activeSession.source })
    : undefined
  const establishedGeneration = bindingKey ? rt.bindingGenerations[bindingKey] : undefined
  const binding = resolveBindingState({
    activeSheet,
    activeSessionId: sessionId,
    sessions: identity.sessions,
    activeAgent: identity.activeAgent,
    ownerStatus,
  })
  return refineBindingGeneration(binding, {
    establishedGeneration,
    currentGeneration: ownerStatus?.generation,
  })
}

function seedAgentSheet(agentId: string): void {
  const sheetId = `sheet-${agentId}`
  useWorkspaceStore.setState({
    workspaceSheets: createSheetState([
      { id: sheetId, kind: 'agent', agentId, title: agentId, createdAt: 1, lastFocusedAt: 1 },
    ], sheetId, []),
  })
}

describe('OWNER-05 P3 路由回归矩阵', () => {
  beforeEach(() => {
    resetStores()
  })

  it('R1 冷启动绑定就绪：Sheet 恢复 + owner 一致 + connected + generation 一致 → binding_ready 不锁定，send_message payload 显式 agentId', () => {
    const s = session('s1', 'hermes', 'local:h1', 'peri-1')
    seedAgentSheet('hermes')
    useIdentityStore.setState({ sessions: [s], activeAgent: 'hermes' })
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 5))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: s.source }, 5)

    expect(deriveBinding('s1')).toEqual({ kind: 'binding_ready', agentId: 'hermes', sessionId: 's1' })
    expect(isBindingLocked(deriveBinding('s1'))).toBe(false)
    // §1.4 P3：点击发送 → 检查 send_message payload → owner 路由（绝不取 activeAgent）
    expect(buildSendMessagePayload({ session: s, content: 'hi', persona: 'p', attachments: [] }))
      .toMatchObject({ agentId: 'hermes', source: 'local:h1' })
  })

  it('R2 双 Agent 同名 source：发送路由按 Session owner（≠ activeAgent），binding generation 按 AgentContextKey 隔离', () => {
    const active = session('s-a', 'peri', 'local:同名', 'peri-a')
    const other = session('s-b', 'hermes', 'local:同名', 'peri-b')
    seedAgentSheet('peri') // 激活 sheet 归 peri，activeAgent=peri
    useIdentityStore.setState({ sessions: [active, other], activeAgent: 'peri' })
    useRuntimeStore.getState().setAgentStatus('peri', status('peri', 'connected', 3))
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 7))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source: 'local:同名' }, 3)
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: 'local:同名' }, 7)

    // 同名 source，两个 Agent 各自路由：payload.agentId = Session owner，绝不串线
    expect(buildSendMessagePayload({ session: other, content: 'hi', persona: 'p', attachments: [] }))
      .toMatchObject({ agentId: 'hermes', source: 'local:同名' })
    expect(buildSendMessagePayload({ session: active, content: 'hi', persona: 'p', attachments: [] }))
      .toMatchObject({ agentId: 'peri', source: 'local:同名' })
    // binding generation 快照按 AgentContextKey 隔离，不互相覆盖
    const rt = useRuntimeStore.getState()
    expect(rt.bindingGenerations[toAgentContextKey({ agentId: 'peri', source: 'local:同名' })]).toBe(3)
    expect(rt.bindingGenerations[toAgentContextKey({ agentId: 'hermes', source: 'local:同名' })]).toBe(7)
    // 各自 refine 后仍 ready（established === current），互不串
    expect(deriveBinding('s-a').kind).toBe('binding_ready')
    // 清理只动自己的 key：删 hermes 会话的 runtime 不影响 peri 的记录
    useRuntimeStore.getState().clearSessionRuntime({ agentId: 'hermes', source: 'local:同名' })
    const after = useRuntimeStore.getState()
    expect(after.bindingGenerations[toAgentContextKey({ agentId: 'peri', source: 'local:同名' })]).toBe(3)
    expect(after.bindingGenerations[toAgentContextKey({ agentId: 'hermes', source: 'local:同名' })]).toBeUndefined()
  })

  it('R3 断线：owner 断开 → agent_disconnected → 发送锁定', () => {
    const s = session('s1', 'hermes', 'local:h1', 'peri-1')
    seedAgentSheet('hermes')
    useIdentityStore.setState({ sessions: [s], activeAgent: 'hermes' })
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 5))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: s.source }, 5)
    expect(isBindingLocked(deriveBinding('s1'))).toBe(false)

    // Hermes 断开（终态）→ agent_disconnected，发送必须被 gate 阻断
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'disconnected', 5))
    const binding = deriveBinding('s1')
    expect(binding).toEqual({ kind: 'agent_disconnected', agentId: 'hermes', status: 'disconnected' })
    expect(isBindingLocked(binding)).toBe(true)
  })

  it('R4 重连：generation 变化 → binding_stale → 锁定 + 需重新加载会话（不发送旧 remote id）', () => {
    const s = session('s1', 'hermes', 'local:h1', 'peri-1')
    seedAgentSheet('hermes')
    useIdentityStore.setState({ sessions: [s], activeAgent: 'hermes' })
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 5))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: s.source }, 5)
    expect(isBindingLocked(deriveBinding('s1'))).toBe(false)

    // 后端重启/替换 → generation 单调递增 5→6（shouldAcceptAgentStatus 放行）
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 6))
    const binding = deriveBinding('s1')
    expect(binding).toEqual({
      kind: 'binding_stale', agentId: 'hermes', sessionId: 's1', fromGeneration: 5, toGeneration: 6,
    })
    expect(isBindingLocked(binding)).toBe(true)
    expect(bindingStatusText(binding)).toContain('已重连')
    expect(bindingStatusText(binding)).toContain('需重新加载会话')
  })

  it('R5 重连后重建绑定（load 成功记录新 generation）→ binding_ready 解锁', () => {
    const s = session('s1', 'hermes', 'local:h1', 'peri-1')
    seedAgentSheet('hermes')
    useIdentityStore.setState({ sessions: [s], activeAgent: 'hermes' })
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 5))
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: s.source }, 5)
    useRuntimeStore.getState().setAgentStatus('hermes', status('hermes', 'connected', 6))
    expect(isBindingLocked(deriveBinding('s1'))).toBe(true)

    // load_persisted_session/new_session 成功 → useSessionLifecycle 记录当前 generation
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'hermes', source: s.source }, 6)
    expect(deriveBinding('s1')).toEqual({ kind: 'binding_ready', agentId: 'hermes', sessionId: 's1' })
    expect(isBindingLocked(deriveBinding('s1'))).toBe(false)
  })

  it('R6 冷启动 agent 状态快照未达 → restoring 锁定（Sheet 恢复 ≠ Agent 已连，不得仅凭 UI 判定）', () => {
    const s = session('s1', 'hermes', 'local:h1', 'peri-1')
    seedAgentSheet('hermes')
    useIdentityStore.setState({ sessions: [s], activeAgent: 'hermes' })
    // 不设置 agentStatuses：快照尚未到达（bootstrap 降级）
    const binding = deriveBinding('s1')
    expect(binding).toEqual({ kind: 'restoring', agentId: 'hermes' })
    expect(isBindingLocked(binding)).toBe(true)
  })
})
