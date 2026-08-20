/**
 * core.export.* —— 内置三源取证采集器插件（localStorage / sqlite / replay）。
 *
 * 由产品 workspace 插件统一登记和回收。
 */
import {
  type ExportSource,
} from '../../../contracts/exportSource.ts'
import {
  collectLocalStorageSection,
  collectReplaySection,
  collectSqliteSection,
} from '../../../obs04/threeSourceExport.ts'

function createBuiltinExportSource(kind: 'localStorage' | 'sqlite' | 'replay'): ExportSource {
  const pluginId = `core.export.${kind}`
  return {
    sourceId: pluginId,
    sourceName: kind,
    collect(input) {
      if (kind === 'localStorage') {
        const value = input as { sessionId: string; storage: Parameters<typeof collectLocalStorageSection>[1] }
        return collectLocalStorageSection(value.sessionId, value.storage)
      }
      if (kind === 'sqlite') {
        const value = input as Parameters<typeof collectSqliteSection>[0]
        return collectSqliteSection(value)
      }
      const value = input as { identity: Parameters<typeof collectReplaySection>[0]; transport: Parameters<typeof collectReplaySection>[1] }
      return collectReplaySection(value.identity, value.transport)
    },
  }
}

export const BUILTIN_EXPORT_SOURCES = [
  createBuiltinExportSource('localStorage'),
  createBuiltinExportSource('sqlite'),
  createBuiltinExportSource('replay'),
] as const
