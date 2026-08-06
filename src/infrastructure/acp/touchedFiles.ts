/**
 * touchedFiles — 工具改动文件提取（W2-09，发令闭环 §3.2/§5.1）。
 *
 * extractTouchedPath：kind === 'edit' 为主，kind 缺失回退工具名集合（Edit/Write/
 * edit/write_file/patch——旧消息兼容）；rawInput 多键兜底 {path|file_path|filePath|
 * relativePath}；绝对路径对会话 cwd 求相对（拿不到/不在 cwd 内 → null 不记录，防
 * FileSheet 永远匹配不到）；提取失败必须 null 不误记。pushTouchedFile：每 source
 * 50 条 LRU（按 path 去重、最新在后）。
 */

export interface TouchedFile {
  source: string
  path: string
  toolKind: string
  at: number
}

export const TOUCHED_FILE_LIMIT = 50

const EDIT_TOOL_NAMES = ['Edit', 'Write', 'edit', 'write_file', 'patch']

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const firstString = (...values: unknown[]): string =>
  values.find((value): value is string => typeof value === 'string' && value.length > 0) || ''

/** 绝对路径对 cwd 求相对；相对路径原样；绝对且无 cwd/不在 cwd 内 → null（不记录） */
export function relativizePath(path: string, cwd?: string): string | null {
  const isAbsolute = /^[a-zA-Z]:[\\/]|^[\\/]/.test(path)
  if (!isAbsolute) return path
  if (cwd) {
    const normalized = path.replace(/\\/g, '/')
    const cwdNorm = cwd.replace(/\\/g, '/').replace(/\/$/, '')
    if (normalized.startsWith(cwdNorm + '/')) return normalized.slice(cwdNorm.length + 1)
  }
  return null
}

/** 提取编辑类工具的目标相对路径；非 edit 类/提取失败 → null */
export function extractTouchedPath(input: { kind?: string; title?: string; rawInput?: unknown; cwd?: string }): string | null {
  const { kind, title, rawInput, cwd } = input
  const isEdit = kind === 'edit' || (!kind && !!title && EDIT_TOOL_NAMES.includes(title))
  if (!isEdit) return null
  const raw = isPlainObject(rawInput) ? rawInput : {}
  const path = firstString(raw.path, raw.file_path, raw.filePath, raw.relativePath)
  if (!path) return null
  return relativizePath(path, cwd)
}

/** LRU 写入：按 path 去重（同文件新记录顶替旧记录）、最新在后、上限截断 */
export function pushTouchedFile(list: readonly TouchedFile[], file: TouchedFile, limit = TOUCHED_FILE_LIMIT): TouchedFile[] {
  const without = list.filter(item => item.path !== file.path)
  return [...without, file].slice(-limit)
}
