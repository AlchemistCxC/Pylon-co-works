import { describe, expect, it } from 'vitest'
import { markLegacyMigrationComplete, readLegacyLayoutSnapshot } from '../legacyKeyMigration.ts'

describe('legacy persistence boundary', () => {
  it('uses right-rail/workspace precedence and clamps values', () => {
    const storage = {
      getItem: (key: string) => ({
        'pylon-right-rail': JSON.stringify({ state: { width: 999 } }),
        'pylon-workspace-sheets': JSON.stringify({ layout: { sidebarWidth: 10, rightPanelCollapsed: true, sidebarCollapsed: true } }),
        'pylon-theme': JSON.stringify({ state: { rightWidth: 300, sidebarWidth: 320 } }),
      }[key] ?? null),
    }
    expect(readLegacyLayoutSnapshot(storage)).toEqual({ rightWidth: 560, leftWidth: 160, rightCollapsed: true, leftCollapsed: true })
  })

  it('returns empty snapshot for malformed legacy data', () => {
    expect(readLegacyLayoutSnapshot({ getItem: () => '{broken' })).toEqual({})
  })

  it('keeps valid owners when one legacy key is malformed', () => {
    const values: Record<string, string> = {
      'pylon-right-rail': '{broken',
      'pylon-workspace-sheets': JSON.stringify({ layout: { sidebarWidth: 280, rightPanelCollapsed: true } }),
      'pylon-theme': JSON.stringify({ state: { rightWidth: 340 } }),
    }
    expect(readLegacyLayoutSnapshot({ getItem: key => values[key] ?? null })).toEqual({
      rightWidth: 340,
      leftWidth: 280,
      rightCollapsed: true,
    })
  })

  it('does not read stale legacy keys after the migration marker is committed', () => {
    const values: Record<string, string> = {
      'pylon-right-rail': JSON.stringify({ state: { width: 500 } }),
    }
    const storage = {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => { values[key] = value },
    }
    expect(readLegacyLayoutSnapshot(storage)).toEqual({ rightWidth: 500 })
    markLegacyMigrationComplete(storage)
    expect(readLegacyLayoutSnapshot(storage)).toEqual({})
  })
})
