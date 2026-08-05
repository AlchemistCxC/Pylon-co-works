import { strict as assert } from 'node:assert'
import {
  EMPTY_PERSISTED_SHEET_STATE,
  loadSheetStateV2,
  parseSheetStateV1,
  serializeSheetStateV1,
  type PersistedSheetState,
} from '../src/workspace-sheets/sheetPersistence.ts'

// W1-01：v1 parser 保留为迁移源（细化路线 §4 步骤 1），本测试锁定 v1 normalize/roundtrip 输出

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const state: PersistedSheetState = {
  sheets: [
    {
      id: 'agent-a',
      kind: 'agent',
      title: 'Riccati',
      agentId: 'riccati',
      singletonKey: 'agent:riccati',
      pinned: true,
      createdAt: 10,
      lastFocusedAt: 20,
    },
    {
      id: 'file-a',
      kind: 'file',
      title: 'App.tsx',
      singletonKey: 'file:App.tsx',
      createdAt: 11,
      lastFocusedAt: 21,
      metadata: { path: 'src/App.tsx' },
    },
  ],
  activeSheetId: 'file-a',
  recentlyClosed: [],
  agentStates: {
    riccati: { activeProfileId: 'default', activeSessionId: 'session-a' },
    obsolete: { activeSessionId: 'must-drop' },
  },
}

const serialized = serializeSheetStateV1(state)
assert.equal(JSON.parse(serialized).version, 1)
assert.deepEqual(parseSheetStateV1(serialized, ['riccati']), {
  ...state,
  agentStates: { riccati: state.agentStates.riccati },
})
assert.equal(parseSheetStateV1(serialized, ['riccati']).sheets.find(sheet => sheet.id === 'agent-a')?.pinned, true)
assert.deepEqual(parseSheetStateV1(serialized, ['other']).sheets.map(sheet => sheet.agentId), [undefined])
assert.deepEqual(parseSheetStateV1(serialized, ['riccati']).agentStates, { riccati: state.agentStates.riccati })
assert.deepEqual(parseSheetStateV1(JSON.stringify({ version: 999, state })), EMPTY_PERSISTED_SHEET_STATE)
assert.deepEqual(parseSheetStateV1('{not-json'), EMPTY_PERSISTED_SHEET_STATE)

const duplicate = {
  ...state,
  sheets: [state.sheets[0], { ...state.sheets[0], id: 'agent-duplicate' }],
  activeSheetId: 'agent-duplicate',
}
assert.equal(parseSheetStateV1(serializeSheetStateV1(duplicate)).sheets.length, 1)

// v1 存储经 v2 加载路径迁移（loadSheetStateV2 读 v1 输入 → migrated=true）
const storage = new MemoryStorage()
storage.setItem('pylon-workspace-sheets', serialized)
const migrated = loadSheetStateV2(storage, ['riccati'])
assert.equal(migrated.migrated, true, 'v1 输入必须标记 migrated')
assert.deepEqual(migrated.state, { ...state, agentStates: { riccati: state.agentStates.riccati } })
assert.equal(migrated.layout.sidebarWidth, 250, 'v1 迁移 layout 取默认 250（主题值由 workspaceStore hydrate 搬家）')

console.log('F0.2 Sheet 持久化 v1 迁移源回归测试通过')
