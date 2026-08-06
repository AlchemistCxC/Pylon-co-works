/**
 * dispatchMessage — 发令消息组装纯函数（W2-07，§4.2 规则表）。
 *
 * T=200 阈值：整文件/选区行数 ≤ T 内联全文/选区，> T 只给路径让 agent 自读（S22）；
 * markdown 恒内联（md 给 agent 读全文收益 > 省 context），truncated 强制长形态
 * （内联截断内容是错误上下文，不能被 md 特例覆盖）；代码块围栏长度 = 内容中最长
 * 连续反引号数 + 1（不是固定 3→4）。
 */

export const DISPATCH_THRESHOLD_LINES = 200

export interface DispatchSelection {
  startLine: number
  endLine: number
}

/** 围栏升级：基础 3 反引号；内容最长连续反引号 ≥3 时升级为 最长 + 1（不是固定 3→4） */
export function fenceFor(content: string): string {
  const longest = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
  return '`'.repeat(Math.max(3, longest + 1))
}

/** 按 1-based 行号提取文本（含端点） */
export function extractLines(content: string, startLine: number, endLine: number): string {
  return content.split('\n').slice(startLine - 1, endLine).join('\n')
}

export interface DispatchMessageInput {
  filePath: string
  selection: DispatchSelection | null
  instruction: string
  /** 文件全文（整文件形态内联用；框选由本函数按行号提取） */
  content: string
  truncated: boolean
}

export function buildDispatchMessage(input: DispatchMessageInput): string {
  const { filePath, selection, instruction, content, truncated } = input
  const isMarkdown = /\.(md|markdown)$/i.test(filePath)
  const totalLines = content.split('\n').length
  const selectionLines = selection ? selection.endLine - selection.startLine + 1 : null
  // 截断强制长形态（优先级最高）；md 恒内联；否则按行数 vs T
  const inline = !truncated && (isMarkdown || (selectionLines ?? totalLines) <= DISPATCH_THRESHOLD_LINES)
  const lineLabel = selection
    ? selection.startLine === selection.endLine
      ? `行号为${selection.startLine}`
      : `行号为${selection.startLine}-${selection.endLine}`
    : ''

  if (!inline) {
    return `文件路径为${filePath}${lineLabel ? `，${lineLabel}` : ''}\n\n${instruction}`
  }

  const text = selection ? extractLines(content, selection.startLine, selection.endLine) : content
  const fence = fenceFor(text)
  const header = selection
    ? `文件路径为${filePath}，${lineLabel}，选中内容如下：`
    : `文件路径为${filePath}，内容如下：`
  return `${header}\n${fence}\n${text}\n${fence}\n\n${instruction}`
}
