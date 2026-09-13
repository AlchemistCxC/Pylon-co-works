import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 下沉自 scripts/test-style-guards.mts（P91 A2 拆分）：SessionSettings 暗色
// 可读性 token 与 Portal Dialog 暗色接线。

const sessionCss = readFileSync(
  'src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css',
  'utf8',
)
const indexCss = readFileSync('src/index.css', 'utf8')

describe('SessionSettings 暗色可读性契约', () => {
  it('暗色模式建立独立可读性 token，Dialog 表面为不透明实色', () => {
    expect(sessionCss).toMatch(/\.app\[data-ui-scheme="dark"\] \.session-settings \{/)
    expect(sessionCss).toMatch(/--session-settings-surface:\s*#[0-9a-fA-F]{6}/)
  })

  it('暗色输入控件使用实底高对比样式，主文字走专用 token', () => {
    expect(sessionCss).toMatch(/\.app\[data-ui-scheme="dark"\] \.session-settings \.sess-field (?:input|select|textarea)/)
    expect(sessionCss).toMatch(/color:\s*var\(--session-settings-text\)/)
  })

  it('Portal Dialog 的暗色样式支持 body data-ui-scheme', () => {
    expect(indexCss).toMatch(/body\[data-ui-scheme="dark"\] \.dialog-content/)
  })
})
