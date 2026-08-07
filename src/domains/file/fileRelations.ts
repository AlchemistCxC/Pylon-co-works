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

/** path → 关联 sources 反查（按 touchedFiles 最新记录去重保序） */
export function sourcesForPath(
  touchedFiles: Readonly<Record<string, readonly TouchedFileShape[]>>,
  path: string,
): string[] {
  const needle = normalizeFilePath(path)
  const sources: string[] = []
  const seen = new Set<string>()
  for (const [source, files] of Object.entries(touchedFiles)) {
    const hit = (files ?? []).some(file => normalizeFilePath(file.path) === needle)
    if (hit && !seen.has(source)) {
      seen.add(source)
      sources.push(source)
    }
  }
  return sources
}

/** source → 文件列表（正查；保持最近优先排序由调用方决定） */
export function filesForSource(
  touchedFiles: Readonly<Record<string, readonly TouchedFileShape[]>>,
  source: string,
): readonly TouchedFileShape[] {
  return touchedFiles[source] ?? []
}
