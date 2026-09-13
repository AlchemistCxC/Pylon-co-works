import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  'src/plugins/product/packages/builtin.pylon-shell/styles/App.css',
  'utf8',
)

/** 取某选择器**最后**一条规则体——CSS 同优先级下后者生效，契约块在文件末尾。（照 FileSheet.css.test.ts 先例） */
function lastRuleBody(selector: string): string {
  const needle = `${selector} {`
  const at = css.lastIndexOf(needle)
  expect(at, `缺少规则：${selector}`).toBeGreaterThan(-1)
  const start = css.indexOf('{', at) + 1
  return css.slice(start, css.indexOf('}', start))
}

describe('titlebar menu visual contract', () => {
  it('keeps chrome menus square and compact', () => {
    const chromeBlock = css.match(
      /\.workspace-titlebar \.workspace-menu-chrome \{([\s\S]*?)\n\}/,
    )?.[1] ?? ''

    expect(chromeBlock).toContain('border-radius: 0')
    expect(chromeBlock).toContain('padding: 4px')
    expect(chromeBlock).toContain('min-width: 196px')
    expect(chromeBlock).toContain('var(--surface-overlay)')
    expect(chromeBlock).toContain('var(--stroke-strong)')
    expect(chromeBlock).toContain('var(--shadow-soft)')
  })

  it('uses a fixed check column and semantic state tokens for menu items', () => {
    // 勾选列网格：限域到 titlebar 菜单按钮规则体（不再对 App.css 全文 toContain）
    expect(lastRuleBody('.workspace-titlebar .workspace-menu-chrome button'))
      .toContain('grid-template-columns: var(--workspace-menu-check-width) minmax(0, 1fr)')
    // hover 组规则（多选择器组，取组规则体）
    const hoverGroup = css.match(
      /\.workspace-titlebar \.workspace-menu-chrome button:hover:not\(:disabled\),[\s\S]*?\{([^}]*)\}/,
    )?.[1] ?? ''
    expect(hoverGroup).toContain('background: var(--state-hover-bg)')
    // 选中态 / 焦点态 / 勾选列：各自最后一条规则体
    expect(lastRuleBody('.workspace-titlebar .workspace-menu-chrome button[data-selected="true"]'))
      .toContain('background: var(--state-selected-bg)')
    expect(lastRuleBody('.workspace-titlebar .workspace-menu-chrome button:focus-visible'))
      .toContain('outline: 1px solid var(--state-focus-ring)')
    expect(lastRuleBody('.workspace-titlebar .workspace-menu-chrome .workspace-menu-check'))
      .toContain('width: var(--workspace-menu-check-width)')
  })
})
