import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import { SHEET_KINDS } from '../src/workspace-sheets/sheetTypes.ts'
import { getSheetRegistryEntry } from '../src/workspace-sheets/sheetRegistry.ts'
import { getWorkspaceRegistrySnapshot } from '../src/workspace-sheets/workspaceRegistry.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

// 阶段 6：metadata + renderer/type definition 同一 Workspace Registry。
// 仅迁行为段（原第 1 节）；原第 2/4/5/6 节的源码 token/正则结构断言（registryTsx /
// SheetHost / SheetLayout / sheetTypes / workspaceTypes readFileSync）按处置行删除。

describe('sheetRegistry legacy compat', () => {
  it('注册表精确覆盖 SHEET_KINDS', () => {
    const workspaceSnapshot = getWorkspaceRegistrySnapshot()
    expect(workspaceSnapshot.workspaces.length, '注册表必须精确覆盖 SHEET_KINDS').toBe(SHEET_KINDS.length)
  })

  it('每个 kind 的 registry entry 完整性：singleton/getSingletonKey/component/createInitialState/serialize/deserialize', () => {
    for (const kind of SHEET_KINDS) {
      const entry = getSheetRegistryEntry(kind)
      expect(entry, `${kind} 必须有 registry entry`).toBeTruthy()
      if (!entry) throw new Error(`${kind} 必须有 registry entry`)
      expect(typeof entry.singleton).toBe('boolean')
      expect(typeof entry.getSingletonKey).toBe('function')
      expect(entry.component, `${kind} 必须注册 component`).toBeTruthy()
      expect(typeof entry.createInitialState).toBe('function')
      expect(typeof entry.serialize).toBe('function')
      expect(typeof entry.deserialize).toBe('function')
    }
  })
})
