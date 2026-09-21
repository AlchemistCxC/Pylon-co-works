// ─────────────────────────────────────────────────────────────────────────────
// 【冻结基线】迁移前的 TS 流式 markdown 切分引擎（issue #220 WP3）。
//
// 出处：`git show 76cbc819^:src/renderers/solid-workbench/chat/streamingMarkdownSplit.ts`
//（该文件在 76cbc819「切流并删除旧实现」中被整文件删除）。
// 仅服务 `scripts/compute-parity/` 脚手架的 TS↔wasm 对照，**不在任何生产路径**。
// **不要修改本文件的实现逻辑**——它的价值在于忠实代表迁移前行为；
// 要修切分逻辑请改 Rust 计算核（src-tauri/pylon-compute/src/streaming/split.rs）。
// 原文件无任何 import，逐字节原样取出（仅加本头注）。
// ─────────────────────────────────────────────────────────────────────────────

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
 * 不变量：只提交已确认的顶层块边界；容器内空行不构成边界，`unstable` 单独解析结构成立；
 * 代码围栏未闭合时整段计入 `unstable`（不跨边界劈开围栏），保证代码高亮不因切分而破坏。
 */

/** Offset of the last boundary proven safe by the shared streaming splitter. */
export function findLastStableBlockBoundary(text: string): number {
  return text.length - splitStreamingMarkdownBlocks(text).unstable.length
}

/** Conservative container marker: false positives retain context instead of corrupting it. */
function isContainerLine(line: string): boolean {
  return /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?:[\t ]|$))/.test(line)
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
      // Blank lines do not close lists or quotes. Keep the container and its
      // suffix together until completion instead of guessing a CommonMark
      // boundary from indentation (nested fences/lazy continuations need it).
      if (isContainerLine(line)) break
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
        inFence = true
        fenceChar = open[1]![0]!
        fenceLength = open[1]!.length
      } else if (/^[\t ]*$/.test(line) && newline !== -1) {
        const candidate = text.slice(blockStart, nextPosition)
        // Keep blank delimiters in the source prefix without empty rows.
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
      if (isContainerLine(line)) return null
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
