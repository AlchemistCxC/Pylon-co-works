import { describe, expect, it } from 'vitest'
import { isMaintainedSource, moduleFor } from './audit-maintenance.mts'

describe('maintenance module classification', () => {
  it('uses the specific owner before a wider container', () => {
    expect(moduleFor('src/sheets/agent-workbench/sessionResponseProjection.ts')).toBe('workbench-host')
    expect(moduleFor('src/sheets/file/FileSheet.tsx')).toBe('workspace-ui')
    expect(moduleFor('src-tauri/src/session/prompt.rs')).toBe('rust-session')
    expect(moduleFor('src-tauri/src/terminal.rs')).toBe('rust-host')
  })
  it('does not hide a new frontend directory behind the legacy root group', () => {
    expect(moduleFor('src/identityStore.ts')).toBe('frontend-root')
    expect(moduleFor('src/new-feature/implementation.ts')).toBeUndefined()
  })
  it('keeps vendor, fixtures and test code out of production ownership counts', () => {
    for (const path of ['src-tauri/vendor/acp/client.rs', 'src/test/setup.ts', 'src/demo/__fixtures__/seed.ts', 'scripts/audit-maintenance.test.mts', 'src-tauri/resources/sdk/pylon-plugin-sdk.js', 'src/api.d.ts', 'src/api.d.mts', 'src/api.d.cts']) {
      expect(isMaintainedSource(path)).toBe(false)
    }
    expect(isMaintainedSource('src-tauri/src/session/prompt.rs')).toBe(true)
    expect(isMaintainedSource('src/sheets/agent-workbench/sessionResponseProjection.ts')).toBe(true)
    expect(isMaintainedSource('scripts/pack_release.py')).toBe(true)
    expect(isMaintainedSource('scripts/backup-portable-data.sh')).toBe(true)
    expect(isMaintainedSource('src/new-feature/component.jsx')).toBe(true)
  })
})
