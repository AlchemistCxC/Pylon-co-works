import { describe, expect, it } from 'vitest'
import {
  APPROVAL_MODE_STORAGE_KEY,
  persistApprovalMode,
  readPersistedApprovalMode,
} from '../approvalMode.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

describe('approval mode persistence', () => {
  it('round-trips only valid approval modes', () => {
    const storage = memoryStorage()
    persistApprovalMode('bypass', storage)
    expect(storage.values.get(APPROVAL_MODE_STORAGE_KEY)).toBe('bypass')
    expect(readPersistedApprovalMode(storage)).toBe('bypass')

    storage.values.set(APPROVAL_MODE_STORAGE_KEY, 'plan')
    expect(readPersistedApprovalMode(storage)).toBeNull()
  })

  it('treats unavailable storage as a recoverable boundary', () => {
    const storage = {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    }
    expect(readPersistedApprovalMode(storage)).toBeNull()
    expect(() => persistApprovalMode('default', storage)).not.toThrow()
  })
})
