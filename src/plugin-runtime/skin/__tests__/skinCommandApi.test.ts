import { describe, expect, it } from 'vitest'
import { CommandRegistry } from '../../commands/commandRegistry.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { createSkinCommandDefinitions } from '../skinCommandApi.ts'
import { SkinRuntime, type SkinRollbackResult } from '../skinRuntime.ts'
import type {
  InstalledSkin,
  SkinDraft,
  SkinPreview,
  SkinValidationResult,
} from '../skinTypes.ts'

function setup() {
  const runtime = new SkinRuntime()
  const registry = new CommandRegistry()
  const identity = createPluginIdentity('builtin.skin', 'builtin-test')
  for (const command of createSkinCommandDefinitions(runtime)) {
    registry.register(identity, command, {
      contributionId: `builtin.skin.${command.id}`,
      layer: 'platform',
      priority: command.priority,
    })
  }
  const execute = <T>(id: string, args?: unknown) => registry.execute<T>(id, args)
  return { runtime, registry, identity, execute }
}

describe('Skin Command API（S5-E）', () => {
  it('skin.schema 返回 JSON 稳定 contract', async () => {
    const { execute } = setup()

    const schema = await execute<{ revision: string; fields: Record<string, unknown>; surfaces: string[] }>('skin.schema')

    expect(schema).toMatchObject({ revision: expect.any(String), fields: expect.any(Object), surfaces: expect.any(Array) })
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  })

  it('skin.draft.create / patch / validate 闭环', async () => {
    const { runtime, execute } = setup()

    const draft = await execute<SkinDraft>('skin.draft.create', { name: '命令皮肤', tokens: { accent: '#123456' } })
    expect(draft).toMatchObject({ name: '命令皮肤', revision: 1, status: 'editing' })

    const patched = await execute<SkinDraft>('skin.draft.patch', { draftId: draft.draftId, patch: { tokens: { accent: '#654321' } } })
    expect(patched.revision).toBe(2)

    const validation = await execute<SkinValidationResult>('skin.validate', { draftId: draft.draftId })
    expect(validation.valid).toBe(true)

    await execute('skin.draft.patch', { draftId: draft.draftId, patch: { tokens: { 'not-a-field': '#fff' } } })
    const invalid = await execute<SkinValidationResult>('skin.validate', { draftId: draft.draftId })
    expect(invalid.valid).toBe(false)
    expect(runtime.getDraft(draft.draftId)?.status).toBe('invalid')
  })

  it('skin.preview / inspect / preview.patch / rollback / commit 闭环', async () => {
    const { runtime, execute } = setup()

    const draft = await execute<SkinDraft>('skin.draft.create', { name: '提交皮肤', tokens: { accent: '#123456' } })
    const preview = await execute<SkinPreview>('skin.preview', { draftId: draft.draftId, target: { scope: 'global' } })
    expect(preview.status).toBe('active')

    const inspected = await execute<{ tokens: Record<string, unknown> }>('skin.inspect', { target: { scope: 'global' } })
    expect(inspected.tokens.accent).toBe('#123456')

    const patchedPreview = await execute<SkinPreview>('skin.preview.patch', { previewId: preview.previewId, patch: { tokens: { accent: '#654321' } } })
    expect(patchedPreview.resolved.tokens.accent).toBe('#654321')

    const rollback = await execute<SkinRollbackResult>('skin.rollback', { previewId: preview.previewId })
    expect(rollback.status).toBe('rolled-back')

    const rollbackAgain = await execute<SkinRollbackResult>('skin.rollback', { previewId: preview.previewId })
    expect(rollbackAgain.status).toBe('already-settled')

    const preview2 = await execute<SkinPreview>('skin.preview', { draftId: draft.draftId, target: { scope: 'global' } })
    const committed = await execute<InstalledSkin>('skin.commit', { previewId: preview2.previewId })
    expect(committed.skinId).toBe(`skin-${draft.draftId}`)

    const committedAgain = await execute<InstalledSkin>('skin.commit', { previewId: preview2.previewId })
    expect(committedAgain.skinId).toBe(committed.skinId)
    expect(runtime.getSnapshot().committedSkinCount).toBe(1)
  })

  it('skin.inspect-computed 未安装 port 返回 structured unsupported，安装 port 后透传', async () => {
    const { execute } = setup()
    const result = await execute('skin.inspect-computed', { previewId: 'preview-x' })
    expect(result).toEqual({ supported: false, previewId: 'preview-x', error: '宿主未安装 SkinInspectionPort' })

    const runtime = new SkinRuntime()
    const portedRegistry = new CommandRegistry()
    const identity = createPluginIdentity('builtin.skin', 'builtin-test-port')
    for (const command of createSkinCommandDefinitions(runtime, {
      inspectionPort: {
        inspectComputed: async previewId => ({ supported: true, previewId, computedStyle: { '--accent': '#123456' }, dataAttributes: {} }),
      },
    })) {
      portedRegistry.register(identity, command, { contributionId: `builtin.skin.${command.id}`, layer: 'platform', priority: command.priority })
    }

    const ported = await portedRegistry.execute('skin.inspect-computed', { previewId: 'preview-1' })
    expect(ported).toEqual({ supported: true, previewId: 'preview-1', computedStyle: { '--accent': '#123456' }, dataAttributes: {} })
  })

  it('skin.capture 未安装 port 返回 unsupported，不伪造截图', async () => {
    const { execute } = setup()
    const result = await execute('skin.capture', { previewId: 'preview-x' })
    expect(result).toEqual({ supported: false, status: 'unsupported', previewId: 'preview-x', error: '宿主未安装 SkinCapturePort' })
  })

  it('非法 target / draftId 返回明确错误', async () => {
    const { execute } = setup()

    await expect(execute('skin.inspect', { target: { scope: 'ghost' } })).rejects.toThrow('非法 SkinTarget')
    await expect(execute('skin.draft.patch', { draftId: '', patch: {} })).rejects.toThrow('draftId')
  })
})
