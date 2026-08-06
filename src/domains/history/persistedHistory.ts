/**
 * persistedHistory — 存档会话列表纯域（W4-01）。
 *
 * 复用 overview 的 normalizePersistedSessions（W1-06）——单一真值不重写；补分页
 * （按 updatedAt 倒序 + page/pageSize）与导出参数校验（outputPath 绝对路径——前端
 * 预检，后端仍权威）。
 */
import { normalizePersistedSessions, type PersistedSessionSummary } from '../overview/persistedSessions.ts'

export const HISTORY_PAGE_SIZE = 20

export function pagePersistedSessions(raw: unknown, page: number, pageSize = HISTORY_PAGE_SIZE): {
  entries: PersistedSessionSummary[]
  total: number
  page: number
  pages: number
} {
  const sorted = normalizePersistedSessions(raw).sort((a, b) => b.updatedAt - a.updatedAt)
  const total = sorted.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(Math.max(1, page), pages)
  const start = (safePage - 1) * pageSize
  return { entries: sorted.slice(start, start + pageSize), total, page: safePage, pages }
}

/** 导出参数校验：outputPath 必须绝对路径（预检，后端仍权威） */
export function validateExportPath(outputPath: string): string | null {
  if (!outputPath.trim()) return '导出路径不能为空'
  if (!/^[a-zA-Z]:[\/]/.test(outputPath)) return '导出路径必须是绝对路径'
  return null
}
