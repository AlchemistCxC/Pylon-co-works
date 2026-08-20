/**
 * selectThemeCssSnapshot 行为测试（FE-AUD-013 / 报告 9B.1）：
 * 显式派生（背景/字体/布局）+ defs 循环注入 + 空 color 省略 + 布局宽度。
 */
import { describe, expect, it } from 'vitest'
import { selectThemeCssSnapshot, WORKSPACE_SIDEBAR_COLLAPSED_WIDTH } from '../themeCssSnapshot'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...overrides }
}

describe('selectThemeCssSnapshot', () => {
  it('界面字体同时投影到继承入口与显式 UI 字体 token', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalFont: 'serif', chatFont: 'sans', msgFont: 'mono' }), LAYOUT)
    expect(vars['--global-font']).toContain('--font-serif-default')
    expect(vars['--font']).toBe(vars['--global-font'])
    expect(vars['--chat-font']).toContain('--font-system')
    expect(vars['--msg-font']).toContain('--font-mono-default')
  })

  it('插件字体 id 投影为稳定 CSS 变量并保留系统字体 fallback', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalFont: 'vendor.readable-ui', codeFont: 'vendor.code' }), LAYOUT)
    expect(vars['--global-font']).toContain('--pylon-font-vendor-readable-ui')
    expect(vars['--mono']).toContain('--pylon-font-vendor-code')
  })

  it('有左栏 Sheet 的 TitleBar 与左栏在展开/折叠时保持同宽', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: true, sidebarWidth: 250, sidebarEnabled: true, sidebarExpandedTrack: true })
    expect(vars['--titlebar-sidebar-width']).toBe('42px')
    expect(vars['--workspace-sidebar-track-width']).toBe('42px')
    const expanded = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: false, sidebarWidth: 320, sidebarEnabled: true, sidebarExpandedTrack: true })
    expect(expanded['--titlebar-sidebar-width']).toBe('320px')
    expect(expanded['--workspace-sidebar-track-width']).toBe('320px')
    expect(expanded['--sheet-sidebar-width']).toBe('320px')
  })

  it('背景图经 toCssBackgroundImage 转换（非空输入产生 var 引用）', () => {
    const vars = selectThemeCssSnapshot(makeState({ globalBgImage: 'linear-gradient(#000,#111)' }), LAYOUT)
    expect(vars['--global-bg-image']).toContain('linear-gradient')
  })

  it('defs 驱动循环注入 color/number 且空 color 省略', () => {
    const vars = selectThemeCssSnapshot(makeState({ accent: '#3b82f6', editorFontSize: 14 }), LAYOUT)
    expect(vars['--accent']).toBe('#3b82f6')
    expect(vars['--editor-font-size']).toBe('14px')
    const empty = selectThemeCssSnapshot(makeState({ accent: '' }), LAYOUT)
    expect(empty['--accent']).toBeUndefined()
  })

  it('msgTextColor 空时走兜底链', () => {
    const vars = selectThemeCssSnapshot(makeState(), LAYOUT)
    expect(vars['--msg-text']).toContain('var(--chat-text-color')
  })
})

describe('I09-A-FE-01 统一折叠宽度 token 契约（D-08：42px）', () => {
  it('token 冻结为 42px 且快照发出 --workspace-sidebar-collapsed-width', () => {
    expect(WORKSPACE_SIDEBAR_COLLAPSED_WIDTH).toBe(42)
    const vars = selectThemeCssSnapshot(makeState(), LAYOUT)
    expect(vars['--workspace-sidebar-collapsed-width']).toBe('42px')
  })

  it('公共左栏折叠时收窄到统一 42px 控制轨道', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: true, sidebarWidth: 320, sidebarEnabled: true, sidebarExpandedTrack: true })
    expect(vars['--titlebar-sidebar-width']).toBe('42px')
    expect(vars['--workspace-sidebar-track-width']).toBe('42px')
    expect(vars['--workspace-sidebar-collapsed-width']).toBe(`${WORKSPACE_SIDEBAR_COLLAPSED_WIDTH}px`)
  })

  it('无 sidebar 时 titlebar 第一列固定为 42px 控制区（不占展开宽度，方案 B）', () => {
    const vars = selectThemeCssSnapshot(makeState(), { sidebarCollapsed: false, sidebarWidth: 320, sidebarEnabled: false })
    expect(vars['--titlebar-sidebar-width']).toBe('42px')
    expect(vars['--workspace-sidebar-track-width']).toBe('42px')
  })
})
