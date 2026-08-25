/**
 * streamingMarkdownSplit — 流式 markdown 增量渲染的稳定/不稳定切分（纯函数）。
 *
 * 问题：Solid `MarkdownContent` 在 streaming 时每次 token 都对整段流式文本重新
 * `getMarkdownRenderModel`（unified 全量解析），含代码块时还重做 `highlightCode`
 * （starry-night）→ 随流式增长呈 O(n²)，即流式"早快晚慢 / 时快时慢"主因。
 *
 * 方案（参考 claude-code-sourcemap `StreamingMarkdown`）：把流式文本在"最后一个已完成
 * 的顶层块边界"处切分——
 *  - `stable`：边界之前的文本（块结构已完成、不再变化）→ 解析结果可缓存/复用，永不重解析。
 *  - `unstable`：边界之后仍在增长的尾部（通常是当前未收尾的最后一个块）→ 每次只重解析这一小段。
 *
 * 不变量：边界只会落在顶层块边界（双换行 / 围栏闭合之后），`unstable` 单独解析结构成立；
 * 代码围栏未闭合时整段计入 `unstable`（不跨边界劈开围栏），保证代码高亮不因切分而破坏。
 */

/** 找"最后一个已完成顶层块边界"的字节偏移。fence-aware：不跨越未闭合的 ```/~~~ 围栏。 */
export function findLastStableBlockBoundary(text: string): number {
  const n = text.length
  if (n === 0) return 0
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  let lastBoundary = 0
  let pos = 0
  while (pos < n) {
    const newline = text.indexOf('\n', pos)
    const nextPos = newline === -1 ? n : newline + 1
    const rawLine = text.slice(pos, newline === -1 ? n : newline)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (inFence) {
      const close = line.match(/^ {0,3}(`+|~+)[\t ]*$/)
      if (close && close[1]![0] === fenceChar && close[1]!.length >= fenceLength) {
        inFence = false
        fenceChar = ''
        fenceLength = 0
      }
      pos = nextPos
      continue
    }

    // CommonMark fenced code allows up to three leading spaces. A backtick
    // info string may not itself contain a backtick; otherwise this is text.
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
      inFence = true
      fenceChar = open[1]![0]!
      fenceLength = open[1]!.length
      pos = nextPos
      continue
    }

    // An empty/whitespace-only line completes the preceding top-level block.
    // Line-based scanning handles LF and CRLF without slicing through \r.
    if (/^[\t ]*$/.test(line) && newline !== -1) lastBoundary = nextPos
    pos = nextPos
  }
  return lastBoundary
}

/** 把流式文本切成 { stable, unstable }。stable 是已完成块；unstable 是仍增长的尾块。 */
export function splitStreamingMarkdown(text: string): { stable: string; unstable: string } {
  const split = splitStreamingMarkdownBlocks(text)
  return { stable: split.stableBlocks.join(''), unstable: split.unstable }
}

/** Stable top-level blocks, kept separate so already parsed blocks never grow. */
export function splitStreamingMarkdownBlocks(text: string): { stableBlocks: readonly string[]; unstable: string } {
  const stableBlocks: string[] = []
  let blockStart = 0
  let inFence = false
  let fenceChar = ''
  let fenceLength = 0
  let position = 0

  while (position < text.length) {
    const newline = text.indexOf('\n', position)
    const nextPosition = newline === -1 ? text.length : newline + 1
    const rawLine = text.slice(position, newline === -1 ? text.length : newline)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (inFence) {
      const close = line.match(/^ {0,3}(`+|~+)[\t ]*$/)
      if (close && close[1]![0] === fenceChar && close[1]!.length >= fenceLength) {
        inFence = false
        fenceChar = ''
        fenceLength = 0
      }
    } else {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
        inFence = true
        fenceChar = open[1]![0]!
        fenceLength = open[1]!.length
      } else if (/^[\t ]*$/.test(line) && newline !== -1) {
        const candidate = text.slice(blockStart, nextPosition)
        // Consecutive blank lines belong to the next meaningful block rather
        // than creating empty renderer rows.
        if (candidate.trim().length > 0) {
          stableBlocks.push(candidate)
          blockStart = nextPosition
        }
      }
    }
    position = nextPosition
  }

  return { stableBlocks, unstable: text.slice(blockStart) }
}

export interface OpenCodeFenceTail {
  readonly prefix: string
  readonly language?: string
  readonly code: string
}

/**
 * Extracts a final, still-open fenced code block before Markdown parsing.
 * The returned code is safe to render as plain text until the closing fence
 * arrives, avoiding a full parser and syntax-highlighter pass per chunk.
 */
export function splitOpenCodeFenceTail(text: string): OpenCodeFenceTail | null {
  let open: {
    start: number
    contentStart: number
    marker: string
    language?: string
  } | null = null
  let position = 0

  while (position < text.length) {
    const newline = text.indexOf('\n', position)
    const lineEnd = newline === -1 ? text.length : newline
    const rawLine = text.slice(position, lineEnd)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (open) {
      const close = line.match(/^ {0,3}(`+|~+)[\t ]*$/)
      if (close && close[1]![0] === open.marker[0] && close[1]!.length >= open.marker.length) {
        open = null
      }
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (opening && (opening[1]![0] === '~' || !opening[2]!.includes('`'))) {
        const language = opening[2]!.trim().split(/\s+/, 1)[0] || undefined
        open = {
          start: position,
          contentStart: newline === -1 ? text.length : newline + 1,
          marker: opening[1]!,
          ...(language ? { language } : {}),
        }
      }
    }

    if (newline === -1) break
    position = newline + 1
  }

  if (!open) return null
  return {
    prefix: text.slice(0, open.start),
    ...(open.language ? { language: open.language } : {}),
    code: text.slice(open.contentStart).replace(/\r\n/g, '\n'),
  }
}
