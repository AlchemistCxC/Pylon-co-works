import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHEET_LAYOUT,
  EMPTY_PERSISTED_SHEET_STATE,
  SHEET_SCHEMA_VERSION,
  SHEET_STORAGE_KEY,
  parseSheetStateV2,
  persistSheetStateV2,
  serializeSheetStateV2,
  type PersistedSheetState,
} from '../src/workspace-sheets/sheetPersistence.ts'
import { readShowPet, writeShowPet, SHOW_PET_STORAGE_KEY } from '../src/workspace-sheets/showPetPersistence.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

// W1-01：schema v2——layout 三字段、v1 清洗旧 kind、只输出 v2、损坏样本、showPet 独立 key roundtrip

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const state: PersistedSheetState = {
  sheets: [{ id: 'agent-a', kind: 'agent', title: 'Profile A', agentId: 'profile-a', createdAt: 1, lastFocusedAt: 2 }],
  activeSheetId: 'agent-a',
  recentlyClosed: [],
  agentStates: {},
}

function loadSheetStateV2Safe(storage: MemoryStorage) {
  const raw = storage.getItem(SHEET_STORAGE_KEY)
  return parseSheetStateV2(raw)
}

describe('sheet persistence v2 legacy compat', () => {
  // 1. v2 roundtrip：state + layout 往返一致
  it('v2 roundtrip：state + layout 往返一致', () => {
    const layout = { sidebarWidth: 300, sidebarCollapsed: true, rightPanelCollapsed: false }
    const serialized = serializeSheetStateV2(state, layout)
    expect(JSON.parse(serialized).version).toBe(SHEET_SCHEMA_VERSION)
    expect(SHEET_SCHEMA_VERSION).toBe(2)
    const parsed = parseSheetStateV2(serialized)
    expect(parsed.migrated).toBe(false)
    expect(parsed.state).toEqual(state)
    expect(parsed.layout).toEqual(layout)
  })

  // 2. 只输出 v2：serialize 不再生成 v1
  it('只输出 v2：serialize 不再生成 v1', () => {
    const serialized = serializeSheetStateV2(state, { ...DEFAULT_SHEET_LAYOUT })
    const envelope = JSON.parse(serialized) as { version: number; layout?: unknown }
    expect(envelope.version).toBe(2)
    expect(envelope.layout, 'v2 envelope 必须含 layout').toBeTruthy()
  })

  // 3. v1→v2 迁移：旧 kind（diff/changes/git-history）清洗、layout 默认、migrated=true
  it('v1→v2 迁移：旧 kind 清洗、layout 默认、migrated=true', () => {
    const v1 = JSON.stringify({
      version: 1,
      state: {
        sheets: [
          { id: 'a', kind: 'agent', title: 'A', agentId: 'x', createdAt: 1, lastFocusedAt: 2 },
          { id: 'd', kind: 'diff', title: 'Diff', createdAt: 3, lastFocusedAt: 4 },
          { id: 'c', kind: 'changes', title: 'Changes', createdAt: 5, lastFocusedAt: 6 },
          { id: 'g', kind: 'git-history', title: 'Git History', createdAt: 7, lastFocusedAt: 8 },
        ],
        activeSheetId: 'a',
        recentlyClosed: [],
        agentStates: {},
      },
    })
    const result = parseSheetStateV2(v1)
    expect(result.migrated, 'v1 输入必须标记 migrated').toBe(true)
    expect(result.state.sheets.map(sheet => sheet.kind), '旧 kind 必须被清洗').toEqual(['agent'])
    expect(result.layout, 'v1 迁移 layout 取默认').toEqual({ ...DEFAULT_SHEET_LAYOUT })
  })

  // 4. v2 layout 容错：宽度 clamp、collapsed 只接受 boolean
  it('v2 layout 容错：宽度 clamp、collapsed 只接受 boolean', () => {
    const parsed = parseSheetStateV2(JSON.stringify({
      version: 2,
      state,
      layout: { sidebarWidth: 9999, sidebarCollapsed: 'yes', rightPanelCollapsed: true },
    }))
    expect(parsed.layout.sidebarWidth, '宽度必须 clamp 到上限').toBe(520)
    expect(parsed.layout.sidebarCollapsed, '非 boolean collapsed 必须回退默认').toBe(false)
    expect(parsed.layout.rightPanelCollapsed).toBe(true)
    const small = parseSheetStateV2(JSON.stringify({ version: 2, state, layout: { sidebarWidth: 10, sidebarCollapsed: false, rightPanelCollapsed: false } }))
    expect(small.layout.sidebarWidth, '宽度必须 clamp 到下限').toBe(160)
    const missing = parseSheetStateV2(JSON.stringify({ version: 2, state }))
    expect(missing.layout, 'v2 缺 layout 回退默认').toEqual({ ...DEFAULT_SHEET_LAYOUT })
  })

  // 5. 损坏/未知版本样本
  it('损坏/未知版本样本：返回空状态不抛错', () => {
    expect(parseSheetStateV2(null)).toEqual({ state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false })
    expect(parseSheetStateV2('{not-json')).toEqual({ state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false })
    const unknown = parseSheetStateV2(JSON.stringify({ version: 99, state }))
    expect(unknown.state.sheets.length, '未知版本返回空状态').toBe(0)
  })

  // 6. 迁移写回路径：persistSheetStateV2 写盘后 loadSheetStateV2 读回 v2 一致
  it('迁移写回路径：persist 写盘后读回 v2 一致', () => {
    const storage = new MemoryStorage()
    persistSheetStateV2(storage, state, { sidebarWidth: 280, sidebarCollapsed: false, rightPanelCollapsed: false })
    expect(storage.getItem(SHEET_STORAGE_KEY)).toBeTruthy()
    const loaded = loadSheetStateV2Safe(storage)
    expect(loaded.migrated).toBe(false)
    expect(loaded.layout.sidebarWidth).toBe(280)
    expect(loaded.state).toEqual(state)
  })

  // 7. showPet 独立 key roundtrip（非 envelope 持久字段）
  it('showPet 独立 key roundtrip（非 envelope 持久字段）', () => {
    const storage = new MemoryStorage()
    expect(readShowPet(storage), '缺省 true').toBe(true)
    writeShowPet(storage, false)
    expect(storage.getItem(SHOW_PET_STORAGE_KEY)).toBe('false')
    expect(readShowPet(storage)).toBe(false)
    writeShowPet(storage, true)
    expect(readShowPet(storage)).toBe(true)
  })
})
