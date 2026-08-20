import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = (relativePath: string) => {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
}
const chatCss = css('../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css')

/**
 * Bug3 回归门（纯 CSS 契约）：工具卡头 / spinner 状态行长文本不得引起尾部换行。
 *
 * 规则：
 * - flex 行内永远不换行容器（flex-wrap:nowrap）；
 * - name/summary/verb 允许收缩 + 行内省略（min-width:0 + overflow:hidden + text-overflow:ellipsis +
 *   white-space:nowrap + flex:0 1 auto），长工具名/长参数/长状态不把尾部挤出换行；
 * - indicator/suffix/meta/activity 永不收缩、不换行（flex:0 0 auto + white-space:nowrap）。
 */
describe('Bug3 工具卡 / spinner 长文本不尾部换行（CSS 契约）', () => {
  it('工具卡头 flex 容器强制不换行', () => {
    expect(chatCss).toMatch(/\.term-tool-head\s*\{[^}]*flex-wrap:\s*nowrap/)
  })

  it('工具名/参数摘要可收缩并省略，不尾部换行', () => {
    for (const selector of ['.term-tool-name', '.term-tool-summary']) {
      const esc = selector.replace(/\./g, '\\.')
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*min-width:\\s*0`))).not.toBeNull()
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*white-space:\\s*nowrap`))).not.toBeNull()
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*overflow:\\s*hidden`))).not.toBeNull()
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*text-overflow:\\s*ellipsis`))).not.toBeNull()
    }
  })

  it('indicator / suffix 固定不换行不收缩', () => {
    for (const selector of ['.term-tool-indicator', '.term-tool-suffix']) {
      const esc = selector.replace(/\./g, '\\.')
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*flex:\\s*0\\s+0\\s+auto`))).not.toBeNull()
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*white-space:\\s*nowrap`))).not.toBeNull()
    }
  })

  it('spinner 状态动词/元信息长文本不尾部换行', () => {
    // verb 可收缩 + 省略
    expect(chatCss.match(/\.spinner-verb\s*\{[^}]*white-space:\s*nowrap/)).not.toBeNull()
    expect(chatCss.match(/\.spinner-verb\s*\{[^}]*overflow:\s*hidden/)).not.toBeNull()
    expect(chatCss.match(/\.spinner-verb\s*\{[^}]*text-overflow:\s*ellipsis/)).not.toBeNull()
    // meta / activity 固定不换行
    for (const selector of ['.spinner-meta', '.spinner-activity']) {
      const esc = selector.replace(/\./g, '\\.')
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*flex:\\s*0\\s+0\\s+auto`))).not.toBeNull()
      expect(chatCss.match(new RegExp(`${esc}\\s*\\{[^}]*white-space:\\s*nowrap`))).not.toBeNull()
    }
  })
})
