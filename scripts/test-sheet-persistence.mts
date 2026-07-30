import { strict as assert } from 'node:assert'
import {
  EMPTY_PERSISTED_SHEET_STATE,
  SHEET_SCHEMA_VERSION,
  SHEET_STORAGE_KEY,
  loadSheetState,
  parseSheetState,
  persistSheetState,
  serializeSheetState,
  type PersistedSheetState,
} from '../src/workspace-sheets/sheetPersistence.ts'

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
    riccati: { activeProfileId: 'default', activeSessionId: 'session-a', rightPanelTab: 'workspace' },
    obsolete: { activeSessionId: 'must-drop' },
  },
}

const serialized = serializeSheetState(state)
assert.equal(JSON.parse(serialized).version, SHEET_SCHEMA_VERSION)
assert.deepEqual(parseSheetState(serialized, ['riccati']), {
  ...state,
  agentStates: { riccati: state.agentStates.riccati },
})
assert.deepEqual(parseSheetState(serialized, ['other']).sheets.map(sheet => sheet.agentId), [undefined])
assert.deepEqual(parseSheetState(serialized, ['riccati']).agentStates, { riccati: state.agentStates.riccati })
assert.deepEqual(parseSheetState(JSON.stringify({ version: 999, state })), EMPTY_PERSISTED_SHEET_STATE)
assert.deepEqual(parseSheetState('{not-json'), EMPTY_PERSISTED_SHEET_STATE)

const duplicate = {
  ...state,
  sheets: [state.sheets[0], { ...state.sheets[0], id: 'agent-duplicate' }],
  activeSheetId: 'agent-duplicate',
}
assert.equal(parseSheetState(serializeSheetState(duplicate)).sheets.length, 1)

const storage = new MemoryStorage()
persistSheetState(storage, state)
assert.ok(storage.getItem(SHEET_STORAGE_KEY))
assert.deepEqual(loadSheetState(storage, ['riccati']), {
  ...state,
  agentStates: { riccati: state.agentStates.riccati },
})

console.log('F0.2 Sheet 持久化回归测试通过')
