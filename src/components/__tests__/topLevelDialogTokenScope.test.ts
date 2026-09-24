import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #306 回归：App 顶层挂载的弹窗（不经 `.settings-surface` 作用域）不得悬空引用只在该
 * 作用域内声明的 token。
 *
 * 为什么判据落在源码层：`var()` 引用未声明的自定义属性时，属性在 computed-value time
 * 变为无效并落到 initial（`background-color` → `transparent`、`box-shadow` → `none`）——
 * 这正是 #306 的面板全透明。jsdom 不解析 CSS 层叠，这条在单测里不可观测，真机 computed
 * style 才是行为判据；而在源码层，「引用的 token 是不是全局声明过」可以直接钉死。
 *
 * 判据口径：index.css 是宿主全局 token 源（基础块 + 各 scheme 覆盖）。弹窗消费的每个
 * `var(--x)` 必须满足其一——① `--x:` 在 index.css 里声明；② 该处自带 fallback。
 */

function localPath(relativePath: string): string {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname)
  return /^\/[a-zA-Z]:\//.test(pathname) ? pathname.slice(1) : pathname
}

const GLOBAL_TOKENS = readFileSync(localPath('../../index.css'), 'utf8')

/** 注释里提到的 token 不是消费点；不剥离会让散文污染判据。 */
const stripBlockComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '')

/** 直接消费（无 fallback）的 token：`var(--x)` 捕获到 `)`，`var(--x, …)` 捕获到 `,`。 */
function bareConsumedTokens(source: string): string[] {
  return [...source.matchAll(/var\((--[a-zA-Z0-9-]+)\s*([,)])/g)]
    .filter(([, , terminator]) => terminator === ')')
    .map(([, token]) => token!)
}

const TOP_LEVEL_DIALOGS = [
  '../PermissionDialog.tsx',
  '../SessionOwnerRecoveryDialog.tsx',
] as const

describe('#306 顶层弹窗的 CSS token 作用域', () => {
  for (const relative of TOP_LEVEL_DIALOGS) {
    it(`${relative} 的每个无 fallback var() 都在 index.css 全局声明`, () => {
      const source = stripBlockComments(readFileSync(localPath(relative), 'utf8'))
      const consumed = bareConsumedTokens(source)
      // 判据本身要有牙齿：消费集为空说明抽取失效，不能算通过。
      expect(consumed.length).toBeGreaterThan(0)
      const unresolved = [...new Set(consumed)].filter(token => !GLOBAL_TOKENS.includes(`${token}:`))
      expect(unresolved).toEqual([])
    })
  }

  it('Settings 域 token 不会被这两个顶层弹窗当作无 fallback 依赖', () => {
    // #306 的原始缺陷形状：--settings-surface / --settings-shadow 只声明在
    // `.settings-surface` 上，顶层弹窗取不到。带 fallback 的写法是合法修复路径，
    // 故只断言「不存在无 fallback 的依赖」。
    for (const relative of TOP_LEVEL_DIALOGS) {
      const consumed = bareConsumedTokens(stripBlockComments(readFileSync(localPath(relative), 'utf8')))
      expect(consumed.filter(token => token.startsWith('--settings-'))).toEqual([])
    }
  })
})
