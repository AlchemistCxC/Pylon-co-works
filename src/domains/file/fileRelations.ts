/**
 * fileRelations — 文件↔会话关联纯域（报告 5D / FE-AUD-022）。
 *
 * touchedFiles 反查：给定文件路径 → 所有改动过它的会话 source。
 * Windows 路径大小写/分隔符统一 normalize（反查键一致）。
 */

export interface TouchedFileShape {
  source: string
  path: string
  toolKind?: string
  at?: number
}

/** Windows 路径 normalize：反斜杠转正斜杠 + 小写（盘符/大小写差异不分裂反查键） */
export function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/** 单条 touchedFile 的键（source + normalized path） */
export function touchedFileKey(file: TouchedFileShape): string {
  return `${file.source}:${normalizeFilePath(file.path)}`
}

/** path → 关联 sources 反查（按 TouchedFile.source 去重保序——record key 为 context key，反查返回原始 source） */
export function sourcesForPath(
  touchedFiles: Readonly<Record<string, readonly TouchedFileShape[]>>,
  path: string,
): string[] {
  const needle = normalizeFilePath(path)
  const sources: string[] = []
  const seen = new Set<string>()
  for (const files of Object.values(touchedFiles)) {
    for (const file of files ?? []) {
      if (normalizeFilePath(file.path) === needle && !seen.has(file.source)) {
        seen.add(file.source)
        sources.push(file.source)
      }
    }
  }
  return sources
}

/** context key → 文件列表（正查；保持最近优先排序由调用方决定）。I01-W3：按 AgentContextKey 键控 */
export function filesForContext(
  touchedFiles: Readonly<Record<string, readonly TouchedFileShape[]>>,
  contextKey: string,
): readonly TouchedFileShape[] {
  return touchedFiles[contextKey] ?? []
}
