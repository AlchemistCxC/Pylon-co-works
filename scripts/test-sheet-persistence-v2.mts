import { strict as assert } from 'node:assert'
import '../src/plugin-runtime/pluginCompositionRoot.ts'
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

// 1. v2 roundtrip：state + layout 往返一致
{
  const layout = { sidebarWidth: 300, sidebarCollapsed: true, rightPanelCollapsed: false }
  const serialized = serializeSheetStateV2(state, layout)
  assert.equal(JSON.parse(serialized).version, SHEET_SCHEMA_VERSION)
  assert.equal(SHEET_SCHEMA_VERSION, 2)
  const parsed = parseSheetStateV2(serialized)
  assert.equal(parsed.migrated, false)
  assert.deepEqual(parsed.state, state)
  assert.deepEqual(parsed.layout, layout)
}

// 2. 只输出 v2：serialize 不再生成 v1
{
  const serialized = serializeSheetStateV2(state, { ...DEFAULT_SHEET_LAYOUT })
  const envelope = JSON.parse(serialized) as { version: number; layout?: unknown }
  assert.equal(envelope.version, 2)
  assert.ok(envelope.layout, 'v2 envelope 必须含 layout')
}

// 3. v1→v2 迁移：旧 kind（diff/changes/git-history）清洗、layout 默认、migrated=true
{
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
  assert.equal(result.migrated, true, 'v1 输入必须标记 migrated')
  assert.deepEqual(result.state.sheets.map(sheet => sheet.kind), ['agent'], '旧 kind 必须被清洗')
  assert.deepEqual(result.layout, { ...DEFAULT_SHEET_LAYOUT }, 'v1 迁移 layout 取默认')
}

// 4. v2 layout 容错：宽度 clamp、collapsed 只接受 boolean
{
  const parsed = parseSheetStateV2(JSON.stringify({
    version: 2,
    state,
    layout: { sidebarWidth: 9999, sidebarCollapsed: 'yes', rightPanelCollapsed: true },
  }))
  assert.equal(parsed.layout.sidebarWidth, 520, '宽度必须 clamp 到上限')
  assert.equal(parsed.layout.sidebarCollapsed, false, '非 boolean collapsed 必须回退默认')
  assert.equal(parsed.layout.rightPanelCollapsed, true)
  const small = parseSheetStateV2(JSON.stringify({ version: 2, state, layout: { sidebarWidth: 10, sidebarCollapsed: false, rightPanelCollapsed: false } }))
  assert.equal(small.layout.sidebarWidth, 160, '宽度必须 clamp 到下限')
  const missing = parseSheetStateV2(JSON.stringify({ version: 2, state }))
  assert.deepEqual(missing.layout, { ...DEFAULT_SHEET_LAYOUT }, 'v2 缺 layout 回退默认')
}

// 5. 损坏/未知版本样本
{
  assert.deepEqual(parseSheetStateV2(null), { state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false })
  assert.deepEqual(parseSheetStateV2('{not-json'), { state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false })
  const unknown = parseSheetStateV2(JSON.stringify({ version: 99, state }))
  assert.equal(unknown.state.sheets.length, 0, '未知版本返回空状态')
}

// 6. 迁移写回路径：persistSheetStateV2 写盘后 loadSheetStateV2 读回 v2 一致
{
  const storage = new MemoryStorage()
  persistSheetStateV2(storage, state, { sidebarWidth: 280, sidebarCollapsed: false, rightPanelCollapsed: false })
  assert.ok(storage.getItem(SHEET_STORAGE_KEY))
  const loaded = loadSheetStateV2Safe(storage)
  assert.equal(loaded.migrated, false)
  assert.equal(loaded.layout.sidebarWidth, 280)
  assert.deepEqual(loaded.state, state)
}

// 7. showPet 独立 key roundtrip（非 envelope 持久字段）
{
  const storage = new MemoryStorage()
  assert.equal(readShowPet(storage), true, '缺省 true')
  writeShowPet(storage, false)
  assert.equal(storage.getItem(SHOW_PET_STORAGE_KEY), 'false')
  assert.equal(readShowPet(storage), false)
  writeShowPet(storage, true)
  assert.equal(readShowPet(storage), true)
}

function loadSheetStateV2Safe(storage: MemoryStorage) {
  const raw = storage.getItem(SHEET_STORAGE_KEY)
  return parseSheetStateV2(raw)
}

console.log('sheet persistence v2 迁移守卫通过')
