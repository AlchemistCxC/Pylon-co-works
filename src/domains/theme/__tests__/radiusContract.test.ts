import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const css = (relativePath: string) => {
  const pathname = decodeURIComponent(new URL(relativePath, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
  return readFileSync(pathname, 'utf8')
}
const rootCss = css('../../../index.css')
const settingsCss = css('../../../plugins/product/packages/builtin.pylon-shell/styles/components/SettingsCommon.css')
const classicRendererCss = [
  'ChatView.css',
  'DiffCard.css',
  'InputBar.css',
  'StatusBar.css',
].map(file => css(`../../../plugins/product/packages/builtin.pylon-renderers/styles/components/chat/${file}`))

describe('第一方圆角语义', () => {
  it('基础尺度保持克制，只有语义胶囊使用全圆角', () => {
    expect(rootCss).toMatch(/--ui-radius-xs:\s*2px/)
    expect(rootCss).toMatch(/--ui-radius-sm:\s*4px/)
    expect(rootCss).toMatch(/--ui-radius-md:\s*6px/)
    expect(rootCss).toMatch(/--ui-radius-lg:\s*8px/)
    expect(rootCss).toMatch(/--ui-radius-pill:\s*999px/)
    expect(settingsCss).toContain('--settings-radius-lg: var(--ui-radius-lg)')
    expect(settingsCss).toContain('border-radius: var(--ui-radius-pill)')
  })

  it('冻结的经典终端视图不消费壳层圆角尺度', () => {
    // 豁免（2026-08-23 圆角契约裁决）：chat-recovery-error / chat-recovery-actions /
    // chat-replay-warning 是恢复与警告反馈面（非终端记录流本体），允许消费壳层圆角。
    // 记录流本体（term-*、消息行、输入区）仍维持无壳层圆角冻结。
    const exemptSelectors = ['chat-recovery-error', 'chat-recovery-actions', 'chat-replay-warning']
    for (const source of classicRendererCss) {
      const consumed = source
        .split('}')
        .filter(block => !exemptSelectors.some(name => block.includes(`.${name}`)))
        .join('}')
      expect(consumed).not.toContain('var(--ui-radius-')
    }
  })
})
