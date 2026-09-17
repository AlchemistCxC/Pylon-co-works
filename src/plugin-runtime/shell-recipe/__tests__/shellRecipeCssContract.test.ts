import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const pathname = (relativePath: string) =>
  decodeURIComponent(new URL(relativePath, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const appCss = readFileSync(pathname('../../../plugins/product/packages/builtin.pylon-shell/styles/App.css'), 'utf8')
const appTsx = readFileSync(pathname('../../../App.tsx'), 'utf8')

describe('Shell Recipe 样式契约（ADR-0003）', () => {
  it('App 根节点写入解析值数据属性，默认态即 DOM 顺序', () => {
    expect(appTsx).toMatch(/data-shell-sidebar-side=\{shellRecipe\.sidebarSide\}/)
    expect(appTsx).toMatch(/data-shell-context-side=\{shellRecipe\.contextPanelSide\}/)
  })

  it('重排规则只以 side="right" 为键，不枚举插件 recipe id', () => {
    const swapped = appCss.match(/\.app\[data-shell-sidebar-side="right"\][^\n]*\{[^}]*\}/g) ?? []
    expect(swapped.length).toBeGreaterThanOrEqual(6)
    for (const rule of swapped) {
      expect(rule).not.toMatch(/data-shell-(?:sidebar|context)-side="left"/)
      // #154：镜像规则新增了「布局层左列分割线换边」（right:calc(...)），
      // 故把 right: 整体纳入排列属性。守卫仍是「只允许排列类声明」，
      // 值域由 right:0 扩到 right:<任意> 只多放行换边语义，强度不降。
      const isArrangementRule = rule.includes('order:') || rule.includes('border-') || rule.includes('grid-template-columns') || rule.includes('right:')
      expect(isArrangementRule).toBe(true)
    }
  })

  it('双栏互换：右栏排首位、侧栏排末位，主区不参与 order 保持中位', () => {
    expect(appCss).toMatch(/\.app\[data-shell-sidebar-side="right"\] \.layout > \.right-rail-host \{ order:-2; \}/)
    expect(appCss).toMatch(/\.app\[data-shell-sidebar-side="right"\] \.layout > \.sidebar \{ order:2; \}/)
  })

  it('标题栏镜像：轨道列移到第 3 列且拖拽区属性不在重排规则内被移除', () => {
    expect(appCss).toMatch(
      // #154：轨道列与左列外壳共用唯一宽度真值 --sheet-sidebar-track-width
      // （原 --titlebar-sidebar-width 随三套 token 收敛退休；断言强度不变）。
      /\.app\[data-shell-sidebar-side="right"\] \.workspace-titlebar \{ grid-template-columns:auto minmax\(0,1fr\) minmax\(0,var\(--sheet-sidebar-track-width,0px\)\); \}/,
    )
    expect(appCss).toMatch(/\.app\[data-shell-sidebar-side="right"\] \.workspace-titlebar > \.workspace-titlebar-sidebar \{ order:4; \}/)
    // 红线：默认标题栏的 data-tauri-drag-region 由 WorkspaceTitlebar 输出，重排规则不得涉及
    expect(swappedTitlebarRules(appCss).every(rule => !rule.includes('tauri'))).toBe(true)
  })
})

function swappedTitlebarRules(css: string): string[] {
  return css.match(/\.app\[data-shell-sidebar-side="right"\] \.workspace-titlebar[^{]*\{[^}]*\}/g) ?? []
}
