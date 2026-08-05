/**
 * gitContracts — Git 只读 DTO 收窄（W2-02）。
 *
 * git_status / git_history（§5.8）宽容 normalize：porcelain 码原样保留（M/A/??/R），
 * date 是 Unix 秒（前端自格式化）；损坏 DTO 跳过不崩；非 git 仓库错误（git_error）分类。
 */

export interface GitStatusEntry {
  path: string
  status: string
  staged: boolean
}

export interface GitCommit {
  hash: string
  author: string
  date: number
  subject: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function normalizeGitStatus(raw: unknown): GitStatusEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: GitStatusEntry[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const path = typeof item.path === 'string' && item.path.length > 0 ? item.path : undefined
    if (!path) continue
    entries.push({
      path,
      status: typeof item.status === 'string' ? item.status : '??',
      staged: item.staged === true,
    })
  }
  return entries
}

export function normalizeGitHistory(raw: unknown): GitCommit[] {
  if (!Array.isArray(raw)) return []
  const commits: GitCommit[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const hash = typeof item.hash === 'string' && item.hash.length > 0 ? item.hash : undefined
    if (!hash) continue
    commits.push({
      hash,
      author: typeof item.author === 'string' ? item.author : '',
      date: typeof item.date === 'number' && Number.isFinite(item.date) ? item.date : 0,
      subject: typeof item.subject === 'string' ? item.subject : '',
    })
  }
  return commits
}

/** git_error 分类（§4：非 git 仓库/不可用/失败/超时） */
export interface GitErrorDetail {
  kind: 'not-repo' | 'unavailable' | 'failed' | 'timeout' | 'unknown'
  message: string
}

export function classifyGitError(error: unknown): GitErrorDetail {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (/not a git|not a repository|non-git|非 ?git|not git/i.test(normalized)) return { kind: 'not-repo', message }
  if (/timeout|超时/i.test(normalized)) return { kind: 'timeout', message }
  if (/unavailable|不可用/i.test(normalized)) return { kind: 'unavailable', message }
  return { kind: 'failed', message: message && message !== '[object Object]' ? message : 'Git 操作失败' }
}
