import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import {
  buildSendMessagePayload,
  clearSessionSourceState,
  emptySessionLiveStats,
  updateSessionLiveStats,
} from '../src/components/chat/sessionRuntime.ts'
import type { Session } from '../src/store.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

const session: Session = {
  id: 'local-a',
  agentId: 'agent-a',
  periId: 'peri-a',
  name: 'A',
  source: 'source-a',
  profileId: 'profile-a',
  createdAt: 1,
  lastActiveAt: 1,
  platform: 'local',
  workdir: 'G:/Project/example',
  sessionPrompt: '只用于当前会话',
  skills: ['legacy-skill'],
  hooks: ['legacy-hook'],
  autoName: '',
}

describe('sessionRuntime legacy compat', () => {
  it('buildSendMessagePayload：首轮提示词契约组合，skills/hooks 不进入 payload', () => {
    const payload = buildSendMessagePayload({
      session,
      content: '测试消息',
      persona: '测试人格',
      attachments: ['G:/tmp/a.txt'],
    })

    expect(payload.agentId).toBe('agent-a')
    expect(payload.source).toBe('source-a')
    expect(payload.content).toBe('测试消息')
    expect(payload.persona).toBe('测试人格')
    // Profile persona + 用户提示词 + commandSet 按当前首轮提示词契约组合
    expect(payload.sessionPrompt.startsWith('测试人格\n\n只用于当前会话\n\n可用 CLI 命令：')).toBe(true)
    expect(payload.attachments).toEqual(['G:/tmp/a.txt'])
    expect('skills' in payload).toBe(false) // 未接入的 Skills 不得进入运行时 payload
    expect('hooks' in payload).toBe(false) // 未接入的 Hooks 不得进入运行时 payload
  })

  it('updateSessionLiveStats：按 context key 隔离，新 context 从明确空态开始', () => {
    const commands = [{ name: 'compact', description: '压缩上下文' }]
    const ctxA = { agentId: 'agent-a', source: 'source-a' }
    const ctxB = { agentId: 'agent-b', source: 'source-b' }
    const keyA = JSON.stringify(['agent-a', 'source-a'])
    const keyB = JSON.stringify(['agent-b', 'source-b'])
    const runtimeA = updateSessionLiveStats({}, ctxA, {
      tokensUsed: 1200,
      tokensMax: 8000,
      cacheReadTokens: 300,
      commands,
    })
    const runtimeAB = updateSessionLiveStats(runtimeA, ctxB, { tokensUsed: 25 })
    // 后台 context 更新不得覆盖其他会话快照
    expect(runtimeAB[keyA]).toEqual({
      tokensUsed: 1200,
      tokensMax: 8000,
      cacheReadTokens: 300,
      commands,
    })
    // 新 context 应从明确空态开始
    expect(runtimeAB[keyB]).toEqual({
      ...emptySessionLiveStats(),
      tokensUsed: 25,
    })
    // 无活动会话必须使用明确空态
    expect(emptySessionLiveStats()).toEqual({
      tokensUsed: 0,
      tokensMax: 131072,
      cacheReadTokens: 0,
      commands: [],
    })
  })

  it('clearSessionSourceState：清理目标 context 且不影响其他会话', () => {
    const ctxA = { agentId: 'agent-a', source: 'source-a' }
    const ctxB = { agentId: 'agent-b', source: 'source-b' }
    const keyA = JSON.stringify(['agent-a', 'source-a'])
    const keyB = JSON.stringify(['agent-b', 'source-b'])
    const runtimeAB = updateSessionLiveStats(
      updateSessionLiveStats({}, ctxA, { tokensUsed: 1200, tokensMax: 8000, cacheReadTokens: 300, commands: [{ name: 'compact', description: '压缩上下文' }] }),
      ctxB,
      { tokensUsed: 25 },
    )
    const cleared = clearSessionSourceState({
      context: ctxA,
      sessionLiveStats: runtimeAB,
      sessionModes: { [keyA]: 'edit', [keyB]: 'auto' },
      sessionConfig: { [keyA]: { model: 'a' }, [keyB]: { model: 'b' } },
      generatingSources: ['source-a', 'source-b'],
    })
    expect(cleared.sessionLiveStats[keyA]).toBeUndefined()
    expect(cleared.sessionModes[keyA]).toBeUndefined()
    expect(cleared.sessionConfig[keyA]).toBeUndefined()
    expect(cleared.generatingSources).toEqual(['source-b'])
    // 删除 A 不得影响 B 的运行时状态
    expect(cleared.sessionLiveStats[keyB]).toEqual(runtimeAB[keyB])
  })
})
