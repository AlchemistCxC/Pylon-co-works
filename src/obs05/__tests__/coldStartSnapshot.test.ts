/**
 * OBS-05：P3 冷启动状态快照取证工具单元测试。
 *
 * 覆盖：四域 section 构建（workspace/agent/runtime）；P3 判定（Sheet 恢复 ≠ Agent 激活、
 * owner 错发、send_message 显式 agentId 结构证据）；IPC 只读 trace（ring 上限、停止、脱敏）；wrapper
 * 幂等安装；工件组装与 phase 标注。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentSection,
  buildColdStartArtifact,
  buildP3Checks,
  buildRuntimeSection,
  buildWorkspaceSection,
  createIpcTrace,
  installIpcTraceWrapper,
  narrowPathValues,
  IPC_TRACE_MAX_EXPORTED,
  type ColdStartSources,
} from '../coldStartSnapshot'
import type { AgentStatus } from '../../components/settings/agentTypes'
import type { Session } from '../../identityStore'

const SESSION: Session = {
  id: 's1', agentId: 'peri', name: '会话一', source: 'local:s1', profileId: 'profile-a',
  createdAt: 1, lastActiveAt: 2, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '', periId: 'peri-9',
}

// ── workspace（Sheet） ───────────────────────────────────────────────────────

describe('buildWorkspaceSection', () => {
  it('activeSheetId + sheets 摘要 + recentlyClosed 计数 + sheetAgentStates', () => {
    const section = buildWorkspaceSection({
      activeSheetId: 'sheet-b',
      sheets: [
        { id: 'sheet-a', kind: 'agent', title: 'A', agentId: 'peri', createdAt: 1, lastFocusedAt: 2 },
        { id: 'sheet-b', kind: 'agent', title: 'B', agentId: 'hermes', createdAt: 3, lastFocusedAt: 4, pinned: true },
      ],
      recentlyClosed: [{ id: 'sheet-c', kind: 'overview', title: 'C', createdAt: 5, lastFocusedAt: 6 }],
      sheetAgentStates: { peri: { activeSessionId: 's1' }, hermes: {} },
    })
    expect(section.activeSheetId).toBe('sheet-b')
    expect(section.sheets).toHaveLength(2)
    expect(section.sheets[1]).toMatchObject({ id: 'sheet-b', kind: 'agent', agentId: 'hermes', pinned: true })
    expect(section.sheets[0].pinned).toBeUndefined()
    expect(section.recentlyClosedCount).toBe(1)
    expect(section.sheetAgentStates.peri?.activeSessionId).toBe('s1')
  })
})

// ── agent ────────────────────────────────────────────────────────────────────

describe('buildAgentSection', () => {
  it('activeAgent / sessions(owner+periId) / owner 计数', () => {
    const section = buildAgentSection({
      activeAgent: 'peri',
      activeProfileId: 'profile-a',
      profiles: [{ id: 'profile-a', name: 'Profile A', model: 'm' }],
      agents: [{ id: 'peri', name: 'Peri', provider: 'peri' }],
      sessions: [
        SESSION,
        { ...SESSION, id: 's2', agentId: 'hermes', source: 'local:s2' },
      ],
    })
    expect(section.activeAgent).toBe('peri')
    expect(section.sessions).toHaveLength(2)
    expect(section.sessions[0].agentId).toBe('peri')
    expect(section.sessions[0].periId).toBe('peri-9')
    expect(section.sessionOwnerCounts).toEqual({ peri: 1, hermes: 1 })
  })
})

// ── runtime ─────────────────────────────────────────────────────────────────

describe('buildRuntimeSection', () => {
  it('agentStatuses 含 generation（OBS-02 correlation 对齐）+ sessionScoped 计数', () => {
    const statuses: Record<string, AgentStatus> = {
      peri: { agent: 'peri', agentId: 'peri', status: 'connected', generation: 3, lastConnectedAt: 100 },
    }
    const section = buildRuntimeSection({
      agentStatuses: statuses,
      liveGenerating: 's1',
      liveGeneratingSources: ['local:s1'],
      approvalMode: 'default',
      sessionModes: { 'peri|local:s1': 'default' },
      sessionConfig: { 'peri|local:s1': { model: 'x' } },
      // CR-003（玉衡）：用真实 SessionLiveStats 字段，不用 as never 逃逸
      sessionLiveStats: { 'peri|local:s1': { tokensUsed: 42, tokensMax: 131072, cacheReadTokens: 0, commands: [] } },
    })
    expect(section.agentStatuses.peri).toMatchObject({ status: 'connected', generation: 3 })
    expect(section.liveGenerating).toBe('s1')
    expect(section.sessionScoped).toEqual({ modes: 1, configs: 1, liveStats: 1 })
  })
})

// ── P3 判定 ─────────────────────────────────────────────────────────────────

describe('buildP3Checks', () => {
  it('Sheet 恢复但 Agent 未连接 → sheetRestoredNotActivated；connected/无 activeSessionId 不误报', () => {
    const checks = buildP3Checks({
      activeAgent: 'peri',
      sheetAgentStates: {
        peri: { activeSessionId: 's1' },        // connected → 不报
        hermes: { activeSessionId: 's2' },      // disconnected → 报
        unknown: {},                            // 无 activeSessionId → 不报
      },
      sessions: [SESSION],
      agentStatuses: {
        peri: { agent: 'peri', status: 'connected' } as AgentStatus,
        hermes: { agent: 'hermes', status: 'disconnected' } as AgentStatus,
      },
      ipcTraceCount: 5,
    })
    expect(checks.sheetRestoredNotActivated).toHaveLength(1)
    expect(checks.sheetRestoredNotActivated[0]).toContain('hermes')
    expect(checks.sheetRestoredNotActivated[0]).toContain('activeSessionId=s2')
    expect(checks.sessionsOwnedByOtherAgent).toEqual([])
    expect(checks.sendMessageIncludesAgentId).toBe(true)
    expect(checks.ipcTraceCount).toBe(5)
  })

  it('owner.agentId != activeAgent 的会话登记为 sessionsOwnedByOtherAgent', () => {
    const checks = buildP3Checks({
      activeAgent: 'peri',
      sheetAgentStates: {},
      sessions: [SESSION, { ...SESSION, id: 's9', agentId: 'hermes' }],
      agentStatuses: {},
      ipcTraceCount: 0,
    })
    expect(checks.sessionsOwnedByOtherAgent).toHaveLength(1)
    expect(checks.sessionsOwnedByOtherAgent[0]).toContain('owner=hermes')
  })
})

// ── 工件组装 ────────────────────────────────────────────────────────────────

describe('buildColdStartArtifact', () => {
  function minimalSources(overrides?: Partial<ColdStartSources>): ColdStartSources {
    return {
      phase: 'bootstrap-t0',
      workspace: {
        sheets: [], activeSheetId: null, recentlyClosed: [],
        sheetAgentStates: { peri: { activeSessionId: 's1' } },
      },
      identity: {
        activeAgent: 'peri', activeProfileId: 'profile-a',
        profiles: [{ id: 'profile-a', name: 'Profile A', model: 'm' }],
        agents: [{ id: 'peri', name: 'Peri' }],
        sessions: [SESSION],
      },
      runtime: {
        agentStatuses: { peri: { agent: 'peri', status: 'disconnected' } as AgentStatus },
        liveGenerating: null, liveGeneratingSources: [], approvalMode: 'default',
        sessionModes: {}, sessionConfig: {}, sessionLiveStats: {},
      },
      ipcTrace: null,
      ...overrides,
    }
  }

  it('组装四域 + phase + P3 判定（t0 未连接信号）', () => {
    const artifact = buildColdStartArtifact(minimalSources())
    expect(artifact.tool).toBe('obs05-cold-start-snapshot')
    expect(artifact.schemaVersion).toBe(1)
    expect(artifact.phase).toBe('bootstrap-t0')
    expect(artifact.ipc.enabled).toBe(false)
    expect(artifact.workspace.sheetAgentStates.peri?.activeSessionId).toBe('s1')
    expect(artifact.agent.sessions[0].periId).toBe('peri-9')
    expect(artifact.p3Checks.sheetRestoredNotActivated).toHaveLength(1)
    expect(artifact.p3Checks.sheetRestoredNotActivated[0]).toContain('peri')
  })

  it('IPC trace 注入后 enabled=true 且 entries 进入工件', () => {
    const trace = createIpcTrace()
    trace.push('send_message', { source: 'local:s1', content: 'hi', persona: 'p', sessionPrompt: 'sp', attachments: [] })
    const artifact = buildColdStartArtifact(minimalSources({ ipcTrace: trace }))
    expect(artifact.ipc.enabled).toBe(true)
    expect(artifact.ipc.count).toBe(1)
    expect(artifact.ipc.entries[0].cmd).toBe('send_message')
    expect(artifact.p3Checks.ipcTraceCount).toBe(1)
  })

  it('脱敏：sessionPrompt/persona 中 secret 形态值 REDACTED', () => {
    const trace = createIpcTrace()
    trace.push('send_message', { source: 'local:s1', content: 'hi', persona: 'Bearer abc', sessionPrompt: 'sk-proj-leak', attachments: [] })
    const artifact = buildColdStartArtifact(minimalSources({ ipcTrace: trace }))
    const json = JSON.stringify(artifact.ipc.entries)
    expect(json).not.toContain('sk-proj-leak')
    expect(json).not.toContain('Bearer abc')
    expect(json).toContain('[REDACTED]')
  })

  it('CR-001（玉衡）：cwd 与 ipc.args 绝对路径收窄为 目录名（工件不含绝对路径）', () => {
    const trace = createIpcTrace()
    trace.push('load_persisted_session', { source: 'local:s1', cwd: 'G:/work/prism-desktop' })
    const artifact = buildColdStartArtifact(minimalSources({
      runtime: {
        agentStatuses: { peri: { agent: 'peri', status: 'connected', cwd: 'G:/work/prism-desktop' } as AgentStatus },
        liveGenerating: null, liveGeneratingSources: [], approvalMode: 'default',
        sessionModes: {}, sessionConfig: {}, sessionLiveStats: {},
      },
      ipcTrace: trace,
    }))
    const json = JSON.stringify(artifact)
    expect(json).not.toContain('G:/work')
    expect(json).toContain('…/prism-desktop')
    expect(artifact.runtime.agentStatuses.peri?.cwd).toBe('…/prism-desktop')
    const ipcArgs = artifact.ipc.entries[0].args as Record<string, unknown>
    expect(ipcArgs.cwd).toBe('…/prism-desktop')
  })
})

// ── 绝对路径收窄（CR-001 闭环） ────────────────────────────────────────────────

describe('narrowPathValues', () => {
  it('盘符/UNC/根相对 ≥2 段收窄为 目录名；单段与相对路径原样保留', () => {
    expect(narrowPathValues('G:/work/prism-desktop')).toBe('…/prism-desktop')
    expect(narrowPathValues('C:\\Users\\me\\app')).toBe('…/app')
    expect(narrowPathValues('//server/share/app')).toBe('…/app')
    expect(narrowPathValues('/home/u/proj')).toBe('…/proj')
    expect(narrowPathValues('relative/dir')).toBe('relative/dir')
    expect(narrowPathValues('/help')).toBe('/help')          // 单段命令形态不误伤
    expect(narrowPathValues('C:/x')).toBe('…/x')             // 盘符根也是绝对路径（2 段），收窄
  })

  it('递归：对象/数组内路径字符串收窄，普通字符串不变', () => {
    const out = narrowPathValues({
      cwd: 'G:/a/b',
      meta: ['/x/y', 'ok'],
      plain: 'hello world',
      nested: { workdir: '/home/u/deep' },
    }) as Record<string, unknown>
    expect(out.cwd).toBe('…/b')
    expect((out.meta as string[])[0]).toBe('…/y')
    expect((out.meta as string[])[1]).toBe('ok')
    expect(out.plain).toBe('hello world')
    expect((out.nested as Record<string, unknown>).workdir).toBe('…/deep')
  })
})

// ── IPC trace ───────────────────────────────────────────────────────────────

describe('createIpcTrace', () => {
  it('push/snapshot/stop 语义', () => {
    const trace = createIpcTrace()
    expect(trace.enabled).toBe(true)
    trace.push('agent_status', {})
    expect(trace.snapshot().count).toBe(1)
    trace.stop()
    trace.push('send_message', {}) // stop 后不再记录
    expect(trace.snapshot().count).toBe(1)
    expect(trace.snapshot().enabled).toBe(false)
    // CR-002（玉衡）：enabled 为反映 !stopped 的 getter，stop() 后同步为 false
    expect(trace.enabled).toBe(false)
  })

  it('ring 上限：超出截断并置 truncated', () => {
    const trace = createIpcTrace()
    for (let i = 0; i < IPC_TRACE_MAX_EXPORTED + 10; i += 1) {
      trace.push('evt_list', { i })
    }
    const snapshot = trace.snapshot()
    expect(snapshot.count).toBe(IPC_TRACE_MAX_EXPORTED)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.entries[0].seq).toBe(11) // 保留最新 IPC_TRACE_MAX 条
  })

  it('脱敏在 push 时应用（apiKey 剔除、sk- 值 REDACTED）', () => {
    const trace = createIpcTrace()
    trace.push('approve_tool_call', { optionId: 'allowOnce', rawInput: { path: 'x', apiKey: 'sk-x' } })
    const entry = trace.snapshot().entries[0]
    const json = JSON.stringify(entry.args)
    expect(json).not.toContain('sk-x')
    expect(json).not.toContain('apiKey')
    expect((entry.args as Record<string, unknown>).optionId).toBe('allowOnce')
  })
})

// ── wrapper 幂等安装 ────────────────────────────────────────────────────────

describe('installIpcTraceWrapper', () => {
  it('无 window（node 环境）→ false', () => {
    expect(installIpcTraceWrapper(createIpcTrace())).toBe(false)
  })

  it('有 __TAURI_INTERNALS__.invoke → 包裹并透传；重复安装幂等不二次包裹', async () => {
    const calls: string[] = []
    const original = async (cmd: string, args?: unknown) => { calls.push(cmd); return { ok: true, args } }
    const fakeWindow = {
      __TAURI_INTERNALS__: { invoke: original },
    }
    const previous = globalThis.window
    vi.stubGlobal('window', fakeWindow)
    try {
      const trace = createIpcTrace()
      expect(installIpcTraceWrapper(trace)).toBe(true)
      expect(installIpcTraceWrapper(trace)).toBe(true) // 幂等
      const internals = (fakeWindow.__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<unknown>)
      const result = await internals('send_message', { content: 'hi', persona: 'secret-token' })
      expect(calls).toEqual(['send_message'])
      expect(result).toEqual({ ok: true, args: { content: 'hi', persona: 'secret-token' } })
      expect(trace.snapshot().count).toBe(1)
      expect(JSON.stringify(trace.snapshot().entries[0].args)).not.toContain('secret-token')
    } finally {
      if (previous === undefined) {
        vi.unstubAllGlobals()
      } else {
        vi.stubGlobal('window', previous)
      }
    }
  })
})
