import { describe, expect, it } from 'vitest'
import { getSkinSchema } from '../../../plugin-runtime/skin/skinSchema.ts'
import { SkinRuntime } from '../../../plugin-runtime/skin/skinRuntime.ts'
import {
  SKIN_STORAGE_KEY,
  SKIN_STORAGE_VERSION,
  loadSkinState,
  persistSkinState,
  removeBindingForTarget,
  restoreSkinState,
  type SkinStorage,
} from '../skinPersistence.ts'

function memoryStorage(initial: Record<string, string> = {}): SkinStorage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
  }
}

const schema = getSkinSchema()

describe('Skin 前端持久化（S5-F）', () => {
  it('commit → persist → 新 Runtime restore 恢复 skin 与 binding', () => {
    const runtime = new SkinRuntime()
    const globalDraft = runtime.createDraft({ name: '全局皮肤', tokens: { accent: '#111111' } })
    runtime.commit(runtime.preview(globalDraft.draftId, { scope: 'global' }).previewId)
    const agentDraft = runtime.createDraft({ name: 'Agent 皮肤', tokens: { accent: '#222222' } })
    runtime.commit(runtime.preview(agentDraft.draftId, { scope: 'agent', agentId: 'a1' }).previewId)

    const storage = memoryStorage()
    persistSkinState(storage, runtime)

    const next = new SkinRuntime()
    const loaded = loadSkinState(storage, schema)
    expect(loaded.error).toBeUndefined()
    expect(loaded.state).not.toBeNull()

    const result = restoreSkinState(next, loaded.state!)
    expect(result.restoredSkins).toBe(2)
    expect(result.restoredBindings).toBe(2)
    expect(next.getBindingSkinId({ scope: 'global' })).toBe(`skin-${globalDraft.draftId}`)
    expect(next.getBindingSkinId({ scope: 'agent', agentId: 'a1' })).toBe(`skin-${agentDraft.draftId}`)
    expect(next.inspect({ scope: 'agent', agentId: 'a1' }).tokens.accent).toBe('#222222')
  })

  it('preview 不持久化为 active binding，draft 可保留但不会自动永久应用', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '仅预览', tokens: { accent: '#123456' } })
    runtime.preview(draft.draftId, { scope: 'global' })

    const storage = memoryStorage()
    persistSkinState(storage, runtime)

    const next = new SkinRuntime()
    const loaded = loadSkinState(storage, schema)
    restoreSkinState(next, loaded.state!)

    expect(next.getSnapshot().activePreview).toBeNull()
    expect(next.getBindingSkinId({ scope: 'global' })).toBeUndefined()
    expect(next.getDraft(draft.draftId)?.tokens.accent).toBe('#123456')
  })

  it('schema revision 变化返回诊断错误，未知字段按当前 schema 丢弃', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '旧皮肤', tokens: { accent: '#123456' } })
    runtime.commit(runtime.preview(draft.draftId, { scope: 'global' }).previewId)

    const storage = memoryStorage()
    persistSkinState(storage, runtime)

    const raw = storage.getItem(SKIN_STORAGE_KEY)!
    const parsed = JSON.parse(raw) as Record<string, unknown>
    parsed.schemaRevision = 'skin-old-revision'
    ;(parsed.skins as Array<Record<string, unknown>>)[0].tokens = {
      accent: '#123456',
      'ghost-field': '#fff',
      transparency: 'not-a-number',
    }
    storage.setItem(SKIN_STORAGE_KEY, JSON.stringify(parsed))

    const next = new SkinRuntime()
    const loaded = loadSkinState(storage, schema)
    expect(loaded.error).toContain('schema revision')
    expect(loaded.state).not.toBeNull()

    restoreSkinState(next, loaded.state!)
    const restored = next.getInstalledSkin(`skin-${draft.draftId}`)
    expect(restored?.tokens.accent).toBe('#123456')
    expect(restored?.tokens).not.toHaveProperty('ghost-field')
    expect(restored?.tokens).not.toHaveProperty('transparency')
  })

  it('非法 JSON / 不支持版本返回可诊断错误', () => {
    const storage = memoryStorage({ [SKIN_STORAGE_KEY]: '{not-json' })
    expect(loadSkinState(storage, schema).error).toContain('JSON 解析失败')

    const badVersion = memoryStorage({ [SKIN_STORAGE_KEY]: JSON.stringify({ version: 99, skins: [] }) })
    expect(loadSkinState(badVersion, schema).error).toContain('版本不支持')
  })

  it('删除某 target binding 不影响其他 scope', () => {
    const runtime = new SkinRuntime()
    const draft = runtime.createDraft({ name: '皮肤', tokens: { accent: '#123456' } })
    const skinId = runtime.commit(runtime.preview(draft.draftId, { scope: 'global' }).previewId).skinId
    runtime.bindSkin(skinId, { scope: 'agent', agentId: 'a1' })
    runtime.bindSkin(skinId, { scope: 'session', sessionId: 's1' })

    removeBindingForTarget(runtime, 'agent:a1')

    expect(runtime.getBindingSkinId({ scope: 'global' })).toBe(skinId)
    expect(runtime.getBindingSkinId({ scope: 'agent', agentId: 'a1' })).toBeUndefined()
    expect(runtime.getBindingSkinId({ scope: 'session', sessionId: 's1' })).toBe(skinId)
  })

  it('持久化 key 与版本独立于 pylon-theme', () => {
    const storage = memoryStorage()
    const runtime = new SkinRuntime()
    persistSkinState(storage, runtime)

    const raw = JSON.parse(storage.getItem(SKIN_STORAGE_KEY)!) as { version: number; bindings: Record<string, string> }
    expect(raw.version).toBe(SKIN_STORAGE_VERSION)
    expect(SKIN_STORAGE_KEY).toBe('pylon-skins')
    expect(storage.getItem('pylon-theme')).toBeNull()
  })
})
