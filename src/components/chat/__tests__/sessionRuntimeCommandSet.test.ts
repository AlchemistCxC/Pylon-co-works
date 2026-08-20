import { describe, expect, it } from 'vitest'
import '../../../plugin-runtime/pluginCompositionRoot.ts'
import { buildSendMessagePayload } from '../sessionRuntime'
import { CORE_COMMAND_SET_PLUGIN_ID } from '../../../contracts/agentCommandSet'
import type { Session } from '../../../identityStore'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agentId: 'peri',
    name: 'S',
    source: 'local:s1',
    profileId: 'p1',
    createdAt: 1,
    lastActiveAt: 1,
    platform: 'local',
    workdir: '',
    sessionPrompt: '',
    skills: [],
    hooks: [],
    autoName: '',
    ...overrides,
  }
}

describe('buildSendMessagePayload commandSet 注入（M2）', () => {
  it('缺省命令集（旧数据）注入 core 命令清单，不覆盖空用户提示词语义', () => {
    const payload = buildSendMessagePayload({
      session: session(),
      content: 'hi',
      persona: 'p',
      attachments: [],
    })
    expect(payload).toMatchObject({
      agentId: 'peri',
      profileId: 'p1',
      source: 'local:s1',
    })
    expect(payload.sessionPrompt).toContain('可用 CLI 命令：')
    expect(payload.sessionPrompt).toContain('/model')
    expect(payload.sessionPrompt).toContain('/compact')
  })

  it('会话显式启用 core 插件时同样注入', () => {
    const payload = buildSendMessagePayload({
      session: session({ commandSetPlugins: [CORE_COMMAND_SET_PLUGIN_ID] }),
      content: 'hi',
      persona: 'p',
      attachments: [],
    })
    expect(payload.sessionPrompt).toContain('/mode')
  })

  it('Profile、用户 sessionPrompt 与命令贡献按顺序独立组合', () => {
    const payload = buildSendMessagePayload({
      session: session({ sessionPrompt: '系统提示', commandSetPlugins: [CORE_COMMAND_SET_PLUGIN_ID] }),
      content: 'hi',
      persona: 'p',
      attachments: [],
    })
    expect(payload.sessionPrompt.startsWith('p\n\n系统提示\n\n可用 CLI 命令：')).toBe(true)
  })

  it('启用集合为空时仍保留 Profile persona', () => {
    const payload = buildSendMessagePayload({
      session: session({ commandSetPlugins: [] }),
      content: 'hi',
      persona: 'p',
      attachments: [],
    })
    expect(payload.sessionPrompt).toBe('p')
  })

  it('新会话优先使用创建时 Profile 贡献快照，不被之后的 Profile 编辑追改', () => {
    const payload = buildSendMessagePayload({
      session: session({
        commandSetPlugins: [],
        creationSnapshot: {
          version: 1,
          createdAt: 1,
          registryRevision: 2,
          diagnostics: [],
          artifacts: [{
            id: 'builtin.pylon/profile-persona#0',
            phase: 'pylon/session-first-message',
            kind: 'pylon/prompt-prelude',
            ownerPluginId: 'builtin.pylon-agent-adapters',
            ownerRuntimeInstanceId: 'builtin.pylon-agent-adapters@1#run',
            sourceContributionId: 'builtin.pylon/profile-persona',
            order: 100,
            failurePolicy: 'required',
            payload: { source: 'profile', profileId: 'p1', text: '创建时 Persona' },
          }],
        },
      }),
      content: 'hi',
      persona: '后来修改的 Persona',
      attachments: [],
    })
    expect(payload.sessionPrompt).toBe('创建时 Persona')
  })
})
