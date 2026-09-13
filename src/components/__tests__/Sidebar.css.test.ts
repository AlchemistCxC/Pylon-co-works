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
  it('键盘聚焦会话行露出齿轮钮（focus-within 不依赖指针）', () => {
    const body = lastRuleBody('.session-item:focus-within .session-gear')
    expect(body).not.toBe('')
    expect(body).toContain('opacity')
  })

  it('齿轮钮的 :focus-visible 规则给焦点环（选择器可为逗号列表成员）', () => {
    const rule = css.match(/[^{}]*\.session-gear:focus-visible[^{}]*\{([^}]*)\}/)
    expect(rule, '缺少 .session-gear:focus-visible 规则').not.toBeNull()
    expect(rule![1]).toMatch(/outline|box-shadow/)
  })
})
