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

describe('titlebar 右簇与页签语法契约（#154 阶段 2）', () => {
  /** 取**基础**规则体（文件里第一次出现的裸选择器）。`lastRuleBody` 取的是最后一条，
      会被 `.app[data-interface-mode=…] .sheet-tab {` 这类前缀选择器命中（它包含 `.sheet-tab {`）。 */
  function baseRuleBody(selector: string): string {
    const at = css.indexOf(`\n${selector} {`)
    expect(at, `缺少基础规则：${selector}`).toBeGreaterThan(-1)
    const start = css.indexOf('{', at) + 1
    return css.slice(start, css.indexOf('}', start))
  }

  it('右栏折叠钮与齿轮菜单同规格：两个并排图标按钮的盒子必须逐项相等', () => {
    // 用户实机报「右栏折叠按钮高度没对齐」：右栏钮若留给 `.workspace-window-controls button`
    // 那条规则，会拿到 38px 宽 + 4px 上下外边距，与齿轮（36×36、margin auto）差 2px 宽、0.5px 高。
    const block = css.match(
      /\.workspace-titlebar-menu-anchor > button\.workspace-titlebar-menu-icon,\s*\n\.workspace-titlebar-icon\.workspace-right-rail-toggle \{([^}]*)\}/,
    )?.[1] ?? ''
    expect(block).not.toBe('')
    expect(block).toMatch(/width:var\(--ui-control-standard\)/)
    expect(block).toMatch(/height:var\(--ui-control-standard\)/)
    expect(block).toMatch(/margin:auto 1px/)
  })

  it('溢出选单触发器不画左边线（那是「新建 Sheet 左边的竖线」）', () => {
    const body = baseRuleBody('.sheet-tab-overflow-trigger')
    expect(body).toMatch(/border:0/)
    expect(body).not.toContain('border-left')
  })

  it('页签随数量压缩：flex 基准 + token 最小宽度，而不是固定宽度', () => {
    const body = baseRuleBody('.sheet-tab')
    expect(body).toMatch(/flex:1 1 160px/)
    expect(body).toMatch(/min-width:var\(--sheet-tab-min-width,96px\)/)
    expect(body).toMatch(/max-width:160px/)
    // 固定 160 的下限会让「压缩」名存实亡：一旦多开就只能滚动。
    expect(body).not.toMatch(/min-width:160px/)
    // 最小宽度是 JS 侧「装得下几个」的尺子，必须在页签区上声明。
    expect(baseRuleBody('.sheet-tab-strip')).toMatch(/--sheet-tab-min-width:96px/)
  })

  it('页签区不滚动：装不下的页签从渲染窗口剔除、进「···」选单，容器右缘不留半个页签', () => {
    expect(baseRuleBody('.sheet-tab-strip')).toMatch(/overflow:hidden/)
    expect(baseRuleBody('.sheet-tab-strip')).not.toMatch(/overflow-x:auto/)
    // 滚动时代的边缘渐隐与预留已经无处消费，不得留下死规则。
    expect(css).not.toContain('can-scroll-left')
    expect(css).not.toContain('--sheet-overflow-reserve')
  })

  it('页签之间是小竖线分隔，且最后一个页签右侧没有', () => {
    expect(css).toMatch(/\.app\[data-interface-mode="terminal-like"\] \.sheet-tab \+ \.sheet-tab::before \{[\s\S]*?height:14px/)
    // 相邻选择器保证只在页签之间画：首个页签与「最后一个页签之后的空隙」都不画。
    expect(css).not.toMatch(/\.sheet-tab \.sheet-tab::before/)
  })

  it('标题栏里所有可点盒子高度一致且垂直居中：图标钮 / 「···」/ 窗口控制三钮同高', () => {
    // 用户实机报「···、侧栏折叠钮、窗口控制三钮高度不一致」：窗口控制曾是 margin:4px 0 + 计算高度，
    // 与图标按钮的 margin:auto 差半像素，「···」还通高 43px。三者统一到 --ui-control-standard + 居中。
    expect(css).toMatch(/\.workspace-window-controls button \{ width:38px; margin:auto 0; height:var\(--ui-control-standard\)/)
    expect(css).not.toMatch(/\.workspace-window-controls button \{ width:38px; margin:var\(--ui-space-1\)/)
    const overflow = baseRuleBody('.sheet-tab-overflow-trigger')
    expect(overflow).toMatch(/align-self:center/)
    expect(overflow).toMatch(/height:var\(--ui-control-standard\)/)
  })

  it('右栏折叠钮用画出来的面板符号，两个 chrome 风格各一套且都不是 `»`', () => {
    // 字形风格：CSS 画的面板符号（右侧实心条 = 右栏在），折叠时压淡。
    expect(css).toMatch(/\.workspace-rail-glyph \{[\s\S]*?width:15px; height:12px/)
    expect(css).toMatch(/\.workspace-rail-glyph::after \{[\s\S]*?background:currentColor/)
    expect(css).toMatch(/\.workspace-right-rail-toggle\[aria-expanded="false"\] \.workspace-rail-glyph::after \{ opacity:\.22; \}/)
    // 图标风格走 lucide 的 PanelRight*，不回流到 ›/» 那类箭头。
    expect(css).toMatch(/\.app\[data-interface-mode="modern-gui"\] \.sheet-tab-overflow-trigger \{ height:34px/)
  })
})
