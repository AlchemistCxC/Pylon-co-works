/**
 * CSS-04：P6 页面回归（方案书任务表 CSS-04，§5.15 step 6——运行其他 Sheet screenshot/DOM
 * smoke，确认无全局 heading 污染）。
 *
 * CSS-02 把 Markdown heading 层级规则全部限定在 `.term-assistant` 内（ChatView.css:201-206，
 * Solid renderer 仅输出 term-h1~term-h6 类、无裸 heading 选择器）；CSS-03 将聊天字号 fallback
 * 统一为 px contract。CSS-04 以「源码级 scoping lock + renderer 源码锁 + jsdom DOM smoke」
 * 回归该契约，防止后续改动破坏防污染边界：
 *   - 源码锁：ChatView.css 中任何 `.term-h{n}` 规则必须位于 `.term-assistant` 后代作用域
 *     （无裸全局选择器）；聊天 CSS 无 `\d+pt` 字号引用（CSS-03 回归门）。
 *   - renderer 源码锁：Solid（MarkdownContent.solid.tsx headingClass 派生）的 class 输出仍在
 *     （CR-325 消化；另配真实 DOM renderer 测试 MarkdownContent.solid.test.tsx）。
 *   - DOM smoke：真实 ChatView.css 经样式表加载（jsdom CSSOM 解析）后，`.term-h{n}` 规则
 *     全部保持 `.term-assistant` scoping 且 h1~h6 六条齐备。
 *
 * 注：vitest 默认 `css: false` 会把一切 `.css` 导入（含 `?raw`/`?inline`/`?url`）置空；
 * 且 src 模块经 vite transform 后 `import.meta.url` 为 http scheme（非 file://），不可用于
 * fs 定位。故本模块经 `node:fs` + `process.cwd()`（vitest 恒为项目根）读取真实 CSS 文本。
 * node:fs 类型桩见 `node-fs.d.ts`；`process` 用下方最小声明（无 @types/node）。
 */

declare const process: { cwd(): string }

import { readFileSync } from 'node:fs'

export const HEADING_CLASSES = ['term-h1', 'term-h2', 'term-h3', 'term-h4', 'term-h5', 'term-h6'] as const

/** 真实 ChatView.css 文本（vitest css:false 下经 fs 读取，规避 .css 导入置空）。 */
export const CHAT_VIEW_CSS = readFileSync(`${process.cwd()}/src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`, 'utf8')

/** 源码锁：返回 ChatView.css 中未被 `.term-assistant` 限定的 `.term-h{n}` 规则选择器。
 * 按 `}` 切段后取段内最后一个 `{` 之前为选择器部分；仅当选择器含 `.term-h{n}` 且不含
 * `.term-assistant` 时记为未限定（注释随规则段保留，不影响判定）。 */
export function findUnscopedHeadingRules(css: string): string[] {
  const unscoped: string[] = []
  for (const segment of css.split('}')) {
    const brace = segment.lastIndexOf('{')
    if (brace === -1) continue
    const selector = segment.slice(0, brace)
    if (!/\.term-h[1-6](?![\w-])/.test(selector)) continue
    if (!selector.includes('.term-assistant')) unscoped.push(selector.trim())
  }
  return unscoped
}

/** 回归门：返回 css 中所有 `\d+pt` 字号引用（CSS-03 后应为空——聊天字号唯一来源为 px contract）。 */
export function findPtFontSizeReferences(css: string): string[] {
  return Array.from(css.matchAll(/\d+(?:\.\d+)?pt/g)).map(match => match[0])
}
