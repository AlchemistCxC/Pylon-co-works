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
    for (const source of classicRendererCss) {
      expect(source).not.toContain('var(--ui-radius-')
    }
  })
})
