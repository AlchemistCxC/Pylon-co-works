// @vitest-environment jsdom
/**
 * I09-A-FE-01（L1：registry 完整性，6.10 问题 #4 等级 1）：
 * 9 种 SheetKind 均显式声明 sidebar mode/capability，禁止隐式缺失（ISSUE-09.md 施工点 1）。
 * sidebarMode 语义（方案 A，ISSUE-09.md）：'workspace'=布局层渲染的公共左栏 / 'sheet'=Sheet 内部
 * 自绘侧栏 / 'none'=无侧栏。sidebar 组件声明仅当 mode='workspace'（SheetSidebarSlot 消费）。
 */
import { describe, expect, it } from 'vitest'
import { SHEET_KINDS } from '../sheetTypes'
import { SHEET_RENDER_REGISTRY } from '../sheetRegistry.tsx'

const SIDEBAR_MODES = ['workspace', 'sheet', 'none'] as const

const NO_SIDEBAR_KINDS: readonly string[] = ['prism', 'runtime', 'overview', 'search', 'history', 'gateway']

describe('I09-A-FE-01 registry sidebar mode/capability 完整性', () => {
  it('9 种 SheetKind 均显式声明合法 sidebarMode（禁止隐式缺失）', () => {
    expect(SHEET_KINDS).toHaveLength(9)
    for (const kind of SHEET_KINDS) {
      const entry = SHEET_RENDER_REGISTRY[kind]
      expect(entry, `${kind} 缺少 render registry 条目`).toBeDefined()
      expect(SIDEBAR_MODES, `${kind} 的 sidebarMode 非法`).toContain(entry.sidebarMode)
    }
  })

  it('agent = workspace 级公共左栏（注册 sidebar 组件供布局层渲染）', () => {
    expect(SHEET_RENDER_REGISTRY.agent.sidebarMode).toBe('workspace')
    expect(SHEET_RENDER_REGISTRY.agent.sidebar).toBeDefined()
  })

  it('file/browser = sheet 内栏能力（自绘侧栏，不占 workspace 槽位）', () => {
    expect(SHEET_RENDER_REGISTRY.file.sidebarMode).toBe('sheet')
    expect(SHEET_RENDER_REGISTRY.browser.sidebarMode).toBe('sheet')
    expect(SHEET_RENDER_REGISTRY.file.sidebar).toBeUndefined()
    expect(SHEET_RENDER_REGISTRY.browser.sidebar).toBeUndefined()
  })

  it('无侧栏 Sheet 显式声明 none 且不注册 sidebar 组件', () => {
    for (const kind of NO_SIDEBAR_KINDS) {
      const entry = SHEET_RENDER_REGISTRY[kind as keyof typeof SHEET_RENDER_REGISTRY]
      expect(entry.sidebarMode).toBe('none')
      expect(entry.sidebar).toBeUndefined()
    }
  })
})
