import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #116 子项 1 的护栏：全局 reset 必须落在低优先层。
 *
 * 未分层规则按 Cascade Layers 规范恒压 `@layer utilities`，而 Tailwind 的
 * p-* / m-* 等 spacing utility 全在 utilities 层——reset 一旦回到未分层区，
 * spacing 工具类会在**没有任何存量类**的元素上整体失效（首包 plugin-manager
 * 就是这样带着假绿合入的）。本用例只读源码文本，不依赖浏览器。
 */

const indexCss = readFileSync('src/index.css', 'utf8')

function layerBlock(css: string, name: string): string | null {
  const start = css.indexOf(`@layer ${name}`)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

/** reset 规则本体：该选择器 + 设置 margin/padding 的声明（reduced-motion 块不设这两项）。 */
const RESET_RULE = /\*,\s*\*::before,\s*\*::after\s*\{[^}]*(?:margin\s*:\s*0|padding\s*:\s*0)/

describe('全局 reset 的层叠归属（#116 子项 1）', () => {
  it('层序显式声明为 base < theme < utilities', () => {
    expect(indexCss).toMatch(/@layer\s+base\s*,\s*theme\s*,\s*utilities\s*;/)
  })

  it('margin/padding 全量 reset 位于 @layer base 内', () => {
    const base = layerBlock(indexCss, 'base')
    expect(base).not.toBeNull()
    expect(base).toMatch(RESET_RULE)
    // box-sizing 的全局默认是既有首方样式的依赖（P93 第五块），不得随 reset 一起删掉
    expect(base).toMatch(/box-sizing\s*:\s*border-box/)
  })

  it('reset 不会以未分层形态再出现一次（未分层恒压 utilities，会让 spacing 全系失效）', () => {
    const base = layerBlock(indexCss, 'base') ?? ''
    const outsideBase = indexCss.replace(base, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(outsideBase).not.toMatch(RESET_RULE)
  })
})
