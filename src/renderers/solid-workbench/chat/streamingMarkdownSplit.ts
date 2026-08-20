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
  let lastBoundary = 0
  let pos = 0
  while (pos < n) {
    const lineStart = pos === 0 || text[pos - 1] === '\n'
    if (!inFence) {
      // 顶层块边界：连续双换行（段落/块之间的空行）
      if (text.startsWith('\n\n', pos)) {
        while (pos < n && text[pos] === '\n') pos += 1
        lastBoundary = pos
        continue
      }
      // 代码围栏开（须在行首）
      if (lineStart && (text.startsWith('```', pos) || text.startsWith('~~~', pos))) {
        inFence = true
        fenceChar = text[pos]
        const nl = text.indexOf('\n', pos)
        pos = nl === -1 ? n : nl + 1
        continue
      }
      pos += 1
      continue
    }
    // 围栏内：行首检测闭合（同字符 ≥3 个）
    if (lineStart && text[pos] === fenceChar && text.startsWith(fenceChar.repeat(3), pos)) {
      inFence = false
      const nl = text.indexOf('\n', pos)
      pos = nl === -1 ? n : nl + 1
      // 闭合行之后若紧接换行，这个围栏块在此收尾成稳定边界
      if (pos < n && text[pos] === '\n') {
        while (pos < n && text[pos] === '\n') pos += 1
        lastBoundary = pos
      }
      continue
    }
    pos += 1
  }
  return lastBoundary
}

/** 把流式文本切成 { stable, unstable }。stable 是已完成块；unstable 是仍增长的尾块。 */
export function splitStreamingMarkdown(text: string): { stable: string; unstable: string } {
  const boundary = findLastStableBlockBoundary(text)
  return { stable: text.slice(0, boundary), unstable: text.slice(boundary) }
}
