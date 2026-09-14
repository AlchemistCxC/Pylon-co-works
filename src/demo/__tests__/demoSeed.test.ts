// 迁移自 scripts/test-demo-seed.mts（P91 A1）。
// builder 段（demoData/messagePersistence 纯函数）逐条平移；seed 接线段按施工书改为
// 对 runBrowserDemoSeed 导出（src/app/bootstrap/browserDemoBootstrap.ts → demo/seed.ts）的
// 行为断言——原 App.tsx/seed.ts 源码正则断言（DEV/IS_TAURI 编译期守卫、demoSeededRef、
// 「声明在 hydrate 之后」等 App 组件内部细节）无导出面行为等价，改为外部可观察行为锁定。
import { describe, expect, it, beforeEach, vi } from 'vitest'
// openSheet 经 sheet registry（插件贡献）路由；接线测试需先注册第一方产品 sheet kinds。
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { buildDemoAgents, buildDemoMessages, buildDemoPermissionRequest, buildDemoSessions, buildGitStatus, buildSessionSummaries } from '../demoData.ts'
import { persistMessageSnapshot, parseMessageSnapshot } from '../../components/chat/messagePersistence.ts'
import { runBrowserDemoSeed } from '../../app/bootstrap/browserDemoBootstrap.ts'
import { useIdentityStore } from '../../identityStore.ts'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { useRuntimeStore } from '../../runtimeStore.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { resetStores } from '../../test/resetStores.ts'

describe('demo seed builders（原 test-demo-seed.mts）', () => {
  it('会话 builder：4 条 Session 形状完整（含 source/periId/profileId）', () => {
    const sessions = buildDemoSessions()
    expect(sessions.length, '必须 4 条演示会话').toBe(4)
    for (const session of sessions) {
      expect(typeof session.id).toBe('string')
      expect(session.id.length > 0).toBe(true)
      expect(session.source.startsWith('local:demo-'), `source 必须 local:demo-*（${session.source}）`).toBe(true)
      expect(Boolean(session.periId), '演示会话必须带 periId（load_persisted_session 走恢复路径）').toBe(true)
      expect(['default', 'local'].includes(session.profileId)).toBe(true)
      expect(typeof session.workdir).toBe('string')
    }
  })

  it('每会话消息：id 以 -<seq> 结尾（seq 正则兼容），tool 以 tool- 开头且各会话叙事不同', () => {
    const sessions = buildDemoSessions()
    for (const session of sessions) {
      const messages = buildDemoMessages(session.id)
      expect(messages.length >= 5, `${session.id} 必须有富对话（≥5 条）`).toBe(true)
      for (const message of messages) {
        expect(message.id, `${session.id} 消息 id 必须以 -<seq> 结尾（${message.id}）`).toMatch(/-\d+$/)
        if (message.role === 'tool') {
          expect(message.id.startsWith('tool-'), `tool 消息 id 必须以 tool- 开头（${message.id}）`).toBe(true)
          expect(typeof message.toolKind, 'tool 消息必须带 toolKind（ToolCard 按 kind 渲染）').toBe('string')
          expect(['completed', 'failed', 'in_progress', 'waiting', 'queued', 'cancelled'].includes(String(message.toolStatus)), `toolStatus 合法（${message.toolStatus}）`).toBe(true)
        }
      }
      expect(messages.some(m => m.role === 'reasoning'), `${session.id} 必须含 reasoning`).toBe(true)
      expect(messages.some(m => m.role === 'assistant'), `${session.id} 必须含 assistant`).toBe(true)
    }
    // 会话间对话不同（各自叙事）
    expect(buildDemoMessages('demo-fe')).not.toEqual(buildDemoMessages('demo-hermes'))
  })

  it('消息缓存信封：persistMessageSnapshot 产物可被 parseMessageSnapshot 往返解析', () => {
    const storage = new Map<string, string>()
    const storageLike = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } }
    const messages = buildDemoMessages('demo-fe')
    persistMessageSnapshot('demo-fe', messages, storageLike)
    const raw = storage.get('pylon-msgs-demo-fe')
    expect(raw, '必须写入 pylon-msgs-<id> 键').toBeTruthy()
    const envelope = JSON.parse(raw!) as { version: number; messages: unknown[] }
    expect(envelope.version, '信封必须带 version 1').toBe(1)
    const restored = parseMessageSnapshot<typeof messages>(raw ?? null)
    expect(restored, '快照往返解析必须还原原消息').toEqual(messages)
    const key = [...storage.keys()][0]
    expect(key?.startsWith('pylon-msgs-'), '键必须命中 isMessageSnapshotKey（search 可扫）').toBe(true)
  })

  it('存档列表（list_persisted_sessions）≥4 条且 id/updatedAt 齐', () => {
    const summaries = buildSessionSummaries()
    expect(summaries.length >= 4).toBe(true)
    for (const item of summaries) {
      expect(typeof item.id).toBe('string')
      expect(typeof item.updatedAt).toBe('number')
    }
  })

  it('git status porcelain 码合法', () => {
    for (const entry of buildGitStatus()) {
      expect(['M', 'A', 'D', 'R', '??'].includes(entry.status), `porcelain 码（${entry.status}）`).toBe(true)
    }
  })

  it('权限请求形状（PermissionRequest 必需键）', () => {
    const request = buildDemoPermissionRequest()
    expect(typeof request.requestId).toBe('string')
    expect(typeof request.title).toBe('string')
    expect(Array.isArray(request.options) && request.options.length >= 2).toBe(true)
    for (const option of request.options) {
      expect(typeof option.optionId).toBe('string')
    }
  })
})

describe('runBrowserDemoSeed 接线（原 seed 接线源码正则段的行为化）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('standard：种 agents/会话 + 持久化 + 每会话消息缓存 + agent sheet 聚焦 + file sheet 绑会话 + 状态灯', () => {
    const setActiveSession = vi.fn()
    runBrowserDemoSeed(setActiveSession)
    const sessions = buildDemoSessions()
    // setAgents 最先（演示 agents 非持久化，每次补）
    expect(useIdentityStore.getState().agents).toEqual(buildDemoAgents())
    // 会话种入 + 持久化（幂等）
    expect(useIdentityStore.getState().sessions.map(s => s.id)).toEqual(sessions.map(s => s.id))
    const raw = localStorage.getItem('pylon-sessions')
    expect(raw, '会话必须持久化').toBeTruthy()
    for (const session of sessions) {
      expect(raw).toContain(session.id)
      expect(localStorage.getItem(`pylon-msgs-${session.id}`), `${session.id} 每会话必须种消息缓存`).not.toBeNull()
    }
    // 必须先开 agent sheet 并聚焦；file sheet 绑演示会话 source（打开即见文件树/git/搜索）
    const { workspaceSheets } = useWorkspaceStore.getState()
    expect(workspaceSheets.sheets.some(sheet => sheet.kind === 'agent'), '必须先开 agent sheet').toBe(true)
    expect(workspaceSheets.sheets.some(sheet => sheet.kind === 'file' && sheet.singletonKey === `file:${sessions[0].source}`), 'file sheet 必须绑演示会话 source').toBe(true)
    const focused = workspaceSheets.sheets.find(sheet => sheet.id === workspaceSheets.activeSheetId)
    expect(focused?.kind, '必须聚焦 agent sheet').toBe('agent')
    // setActiveSession 随会话种入（写回 effect 持久化）
    expect(setActiveSession, 'setActiveSession 必须随会话种入').toHaveBeenCalledWith(sessions[0].id)
    // 状态灯每次补（非持久化）
    expect(useRuntimeStore.getState().agentStatuses.peri?.status).toBe('connected')
    expect(useRuntimeStore.getState().agentStatuses.hermes?.status).toBe('error')
  })

  it('二次调用跳过会话种入（不重复），agents/状态灯仍每次补', () => {
    runBrowserDemoSeed(vi.fn())
    const firstIds = useIdentityStore.getState().sessions.map(s => s.id)
    runBrowserDemoSeed(vi.fn())
    expect(useIdentityStore.getState().sessions.map(s => s.id)).toEqual(firstIds)
    expect(useIdentityStore.getState().agents).toEqual(buildDemoAgents())
    expect(useRuntimeStore.getState().agentStatuses.peri?.status).toBe('connected')
  })

  it('visual 场景锁定 terminal-like（视觉验收基线）', () => {
    runBrowserDemoSeed(vi.fn(), { scenario: 'visual' })
    expect(useInterfaceModeStore.getState().interfaceMode).toBe('terminal-like')
  })
})
