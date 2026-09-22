/**
 * #243 切片 2：行高估算（D5 裁定「估算 + 实测回填」的估算侧）。
 *
 * 定位是**起步猜测**：占位符与偏移索引在行从未挂载时用它，行一旦挂载即被
 * ResizeObserver 实测回填（rowHeightTable.measure），估算只留作卸载后的回落值。
 * 因此公式只求三条性质，不求精确：
 * 1. **确定性**——同一 item 恒出同一值（偏移一致性断言与测试都依赖）；
 * 2. **单调性**——内容越长估值越高（滚动条刻度方向不能反）；
 * 3. **量级正确**——误差压在 ±几倍以内（D6：锚定视口行 + 允许滚动条伸缩兜底）。
 *
 * `MessageListItem.estimatedHeight` 缝（chatRowPipeline 侧可显式给值）优先于本地公式。
 */

import type { MessageListItem } from '../../../domains/workbench/messageListPort.ts'

/** 每行可容纳的字符数代理（聊天列宽 ~720px、正文 ~14px 字号的实测量级）。 */
const CHARS_PER_LINE = 80
/** 单行文本行高代理（px）。 */
const LINE_HEIGHT_PX = 24
/** 行自身外壳（padding + 头部徽标/时间戳）的基础高度，按渲染类型分档。 */
const BASE_HEIGHT_BY_TYPE: Record<string, number> = {
  user: 44,
  assistant: 52,
  reasoning: 48,
  tool_call: 56,
  tool_result: 56,
  error: 56,
  system: 36,
}
const FALLBACK_BASE_HEIGHT_PX = 52
/** 每个代码块的外壳开销（边框/头部/内边距；文本量已计入行数）。 */
const CODE_BLOCK_CHROME_PX = 96
/** #208：reasoning 超 8000 字符默认折叠——折叠态高度有界，估算随之封顶。 */
const REASONING_FOLDED_CAP_PX = 160
/** 最小行高（空消息/占位语义也不低于一行外壳）。 */
const MIN_ROW_HEIGHT_PX = 40

export function estimateRowHeight(item: MessageListItem): number {
  if (item.estimatedHeight !== undefined) return item.estimatedHeight
  const renderMessage = item.descriptor.renderMessage
  const message = renderMessage.message
  const base = BASE_HEIGHT_BY_TYPE[renderMessage.type] ?? FALLBACK_BASE_HEIGHT_PX

  // C01 隐去推理：正文不渲染，只剩安全占位
  if (message.redacted === true) return Math.max(MIN_ROW_HEIGHT_PX, base)

  const content = message.content ?? ''
  const newlineCount = countNewlines(content)
  const wrappedLines = Math.floor(content.length / CHARS_PER_LINE)
  let contentHeight = (1 + newlineCount + wrappedLines) * LINE_HEIGHT_PX

  if (renderMessage.type === 'tool_result') {
    // 工具输出行数是投影层已知的权威口径，优先于字符数折算
    const declaredLines = message.toolOutputLines ?? 0
    contentHeight = Math.max(contentHeight, declaredLines * LINE_HEIGHT_PX)
  }
  if (renderMessage.type === 'reasoning') {
    contentHeight = Math.min(contentHeight, REASONING_FOLDED_CAP_PX)
  }

  const codeBlocks = countCodeFences(content)
  const total = base + contentHeight + codeBlocks * CODE_BLOCK_CHROME_PX
  return Math.max(MIN_ROW_HEIGHT_PX, total)
}

function countNewlines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function countCodeFences(text: string): number {
  // ``` 出现次数 / 2 = 块数（未闭合的流式块按半块计，向上取整）
  let fences = 0
  let index = text.indexOf('```')
  while (index !== -1) {
    fences += 1
    index = text.indexOf('```', index + 3)
  }
  return Math.ceil(fences / 2)
}
