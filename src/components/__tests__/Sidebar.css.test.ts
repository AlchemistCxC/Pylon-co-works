import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css',
  'utf8',
)

/** 取某选择器**最后**一条规则体——CSS 同优先级下后者生效（FileSheet.css.test.ts 同款限域）。 */
function lastRuleBody(selector: string): string {
  const needle = `${selector} {`
  const at = css.lastIndexOf(needle)
  expect(at, `缺少规则：${selector}`).toBeGreaterThan(-1)
  const start = css.indexOf('{', at) + 1
  return css.slice(start, css.indexOf('}', start))
}

// 下沉自 scripts/test-accessibility.mts（P91 A2）：键盘可达性的焦点指示 CSS 契约。
// 原为全文 toInclude token 断言，改为选择器限域断言（防 token 撞车误绿）。
describe('Sidebar 键盘焦点 CSS 契约', () => {
  it('键盘聚焦会话行露出行内动作（focus-within 不依赖指针）', () => {
    // 行内动作为「置顶 + 设置」：门控都在**容器** `.session-actions` 上（opacity 作用于
    // 整个子树，按钮不得再自带第二层——那正是「设置不可见」的根因）。
    expect(lastRuleBody('.session-item:focus-within > .session-pin')).toContain('opacity')
    expect(lastRuleBody('.session-item:focus-within .session-actions')).toContain('opacity')
  })

  it('行内动作的 :focus-visible 规则给焦点环（选择器可为逗号列表成员）', () => {
    const pinRule = css.match(/[^{}]*\.session-pin:focus-visible[^{}]*\{([^}]*)\}/)
    expect(pinRule, '缺少 .session-pin:focus-visible 规则').not.toBeNull()
    expect(pinRule![1]).toMatch(/outline|box-shadow/)
    // 设置钮另有一条只给 :focus-visible 的焦点环规则（不与 :hover 共用的显形规则混在一起）。
    // 注意不能用 `css.match(...)` 取「第一条」：逗号列表里也有同名选择器，取到的是显形那条。
    expect(css).toMatch(/\.session-action:focus-visible \{[^}]*outline:2px solid var\(--accent\)/)
  })
})
