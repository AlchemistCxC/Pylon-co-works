/**
 * 导出证据源契约（施工方案书 v3 §M7）：export.source 扩展点。
 *
 * 契约层不 import domains；运行时采集经 obs04/threeSourceExport（legacy 查询面）。
 * 插件贡献的 source 在 activate/deactivate 时同步进 legacy registry。
 */

/** export.source 扩展点 id。 */
export const EXPORT_SOURCE_POINT = 'export.source'

export type ExportSourceName = 'localStorage' | 'sqlite' | 'replay'

/** export.source 贡献 impl：一个可替换的三源取证采集器。 */
export interface ExportSource {
  readonly sourceId: string
  readonly sourceName: ExportSourceName
  collect(input: unknown): unknown | Promise<unknown>
}
