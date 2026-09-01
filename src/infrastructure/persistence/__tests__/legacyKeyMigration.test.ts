import { describe, expect, it } from 'vitest'
import { readLegacyLayoutSnapshot } from '../legacyKeyMigration.ts'

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
})
