import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { SkinRuntime } from '../skinRuntime.ts'

describe('SkinRuntime 状态机（S5-B）', () => {
  it('createDraft 只返回非默认 delta，revision 从 1 开始', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '测试', tokens: { accent: '#123456' } })

    expect(draft.draftId).toMatch(/^draft-/)
    expect(draft.tokens).toEqual({ accent: '#123456' })
    expect(draft.revision).toBe(1)
    expect(draft.status).toBe('editing')
    expect(draft.name).toBe('测试')
  })

  it('patchDraft 单调递增 revision，未知 key 由 validate 返回结构化错误', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '测试' })

    const patched = runtime.patchDraft(draft.draftId, { tokens: { accent: '#654321' } })
    expect(patched.revision).toBe(2)
    expect(patched.tokens.accent).toBe('#654321')

    runtime.patchDraft(draft.draftId, { tokens: { 'not-a-field': '#fff' } })
    const result = runtime.validate(draft.draftId)
    expect(result.valid).toBe(false)
    expect(result.issues[0]).toMatchObject({ code: 'unknown-token' })
  })

  it('preview 不写入 committed/binding；resolveSkin 反映 overlay', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '测试', tokens: { accent: '#123456' } })
    const preview = runtime.preview(draft.draftId, { scope: 'global' })

    expect(preview.status).toBe('active')
    expect(preview.before.tokens.accent).toBe(DEFAULTS.accent)
    expect(preview.resolved.tokens.accent).toBe('#123456')
    expect(runtime.getSnapshot().committedSkinCount).toBe(0)
    expect(runtime.getBindingSkinId({ scope: 'global' })).toBeUndefined()
    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe('#123456')
  })

  it('rollback 恢复 preview 前 resolved skin，重复 rollback 幂等', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '测试', tokens: { accent: '#123456' } })
    const preview = runtime.preview(draft.draftId, { scope: 'global' })

    const first = runtime.rollback(preview.previewId)
    expect(first.status).toBe('rolled-back')
    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe(DEFAULTS.accent)

    const second = runtime.rollback(preview.previewId)
    expect(second.status).toBe('already-settled')
    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe(DEFAULTS.accent)
  })

  it('同一 target 新建 preview 会先回滚旧 preview，不双激活', () => {
    const runtime = new SkinRuntime()
    const draft1 = runtime.createDraft({ name: '一', tokens: { accent: '#111111' } })
    const draft2 = runtime.createDraft({ name: '二', tokens: { accent: '#222222' } })
    const first = runtime.preview(draft1.draftId, { scope: 'global' })
    const second = runtime.preview(draft2.draftId, { scope: 'global' })

    expect(first.status).toBe('rolled-back')
    expect(second.status).toBe('active')
    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe('#222222')
  })

  it('commit 写入 committed skin 与 binding，且幂等', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '提交皮肤', tokens: { accent: '#123456' } })
    const preview = runtime.preview(draft.draftId, { scope: 'global' })

    const installed = runtime.commit(preview.previewId)
    expect(installed.skinId).toBe(`skin-${draft.draftId}`)
    expect(runtime.getSnapshot().committedSkinCount).toBe(1)
    expect(runtime.getBindingSkinId({ scope: 'global' })).toBe(installed.skinId)
    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe('#123456')
    expect(draft.status).toBe('committed')

    const again = runtime.commit(preview.previewId)
    expect(again.skinId).toBe(installed.skinId)
    expect(runtime.getSnapshot().committedSkinCount).toBe(1)
  })

  it('global/workspace/agent/session 四级优先级正确', () => {
    const runtime = new SkinRuntime()
    const globalDraft = runtime.createDraft({ name: 'global', tokens: { accent: '#111111' } })
    runtime.commit(runtime.preview(globalDraft.draftId, { scope: 'global' }).previewId)

    const agentDraft = runtime.createDraft({ name: 'agent', tokens: { accent: '#222222' } })
    runtime.preview(agentDraft.draftId, { scope: 'agent', agentId: 'a1' })

    const sessionDraft = runtime.createDraft({ name: 'session', tokens: { accent: '#333333' } })
    runtime.preview(sessionDraft.draftId, { scope: 'session', sessionId: 's1' })

    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe('#111111')
    expect(runtime.inspect({ scope: 'agent', agentId: 'a1' }).tokens.accent).toBe('#222222')
    expect(runtime.inspect({ scope: 'agent', agentId: 'a2' }).tokens.accent).toBe('#111111')
    // session 目标自身 id 生效；显式带 agent 上下文时 session 覆盖 agent
    expect(runtime.inspect({ scope: 'session', sessionId: 's1' }).tokens.accent).toBe('#333333')
    expect(runtime.inspect({ scope: 'session', sessionId: 's1' }, { agentId: 'a1' }).tokens.accent).toBe('#333333')
  })

  it('workspace overlay 位于 global 之上、agent 之下', () => {
    const runtime = new SkinRuntime()
    const globalDraft = runtime.createDraft({ name: 'global', tokens: { accent: '#111111' } })
    runtime.commit(runtime.preview(globalDraft.draftId, { scope: 'global' }).previewId)

    const workspaceDraft = runtime.createDraft({ name: 'workspace', tokens: { accent: '#222222' } })
    runtime.preview(workspaceDraft.draftId, { scope: 'workspace', workspaceId: 'ws1' })

    const agentDraft = runtime.createDraft({ name: 'agent', tokens: { accent: '#333333' } })
    runtime.preview(agentDraft.draftId, { scope: 'agent', agentId: 'a1' })

    expect(runtime.inspect({ scope: 'agent', agentId: 'a1' }, { workspaceId: 'ws1' }).tokens.accent).toBe('#333333')
    expect(runtime.inspect({ scope: 'workspace', workspaceId: 'ws1' }).tokens.accent).toBe('#222222')
  })

  it('空字符串显式覆盖上一层的值', () => {
    const runtime = new SkinRuntime()
    const globalDraft = runtime.createDraft({ name: 'global', tokens: { accent: '#111111' } })
    runtime.commit(runtime.preview(globalDraft.draftId, { scope: 'global' }).previewId)

    const override = runtime.createDraft({ name: 'override', tokens: { accent: '' } })
    runtime.preview(override.draftId, { scope: 'global' })

    expect(runtime.inspect({ scope: 'global' }).tokens.accent).toBe('')
  })

  it('subscribe 在 create/patch/preview/rollback/commit 后单调递增 revision', () => {
    const runtime = new SkinRuntime()
    const revisions: number[] = []
    runtime.subscribe(() => revisions.push(runtime.getSnapshot().revision))

    const draft = runtime.createDraft({ name: '测试', tokens: { accent: '#123456' } })
    const preview = runtime.preview(draft.draftId, { scope: 'global' })
    runtime.patchDraft(draft.draftId, { tokens: { accent: '#654321' } })
    runtime.rollback(preview.previewId)

    expect(revisions.length).toBeGreaterThanOrEqual(4)
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
    expect(new Set(revisions).size).toBe(revisions.length)
  })
})
