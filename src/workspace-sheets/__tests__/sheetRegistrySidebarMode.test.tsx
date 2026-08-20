// @vitest-environment jsdom
/**
 * I09-A-FE-01（L1：registry 完整性，6.10 问题 #4 等级 1）：
 * 9 种 SheetKind 均显式声明 sidebar mode/capability，禁止隐式缺失（ISSUE-09.md 施工点 1）。
 * sidebarMode 语义（方案 A，ISSUE-09.md）：'workspace'=布局层渲染的公共左栏 / 'sheet'=Sheet 内部
 * 自绘侧栏 / 'none'=无侧栏。sidebar 组件声明仅当 mode='workspace'（SheetSidebarSlot 消费）。
 */
import { describe, expect, it } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { SHEET_KINDS } from '../sheetTypes'
import { resolveSheetRender } from '../sheetRegistry.tsx'

const SIDEBAR_MODES = ['workspace', 'sheet', 'none'] as const

describe('I09-A-FE-01 registry sidebar mode/capability 完整性', () => {
  it('9 种 SheetKind 均显式声明合法 sidebarMode（禁止隐式缺失）', () => {
    expect(SHEET_KINDS).toHaveLength(9)
    for (const kind of SHEET_KINDS) {
      const entry = resolveSheetRender(kind)
      expect(entry, `${kind} 缺少 render registry 条目`).toBeDefined()
      expect(SIDEBAR_MODES, `${kind} 的 sidebarMode 非法`).toContain(entry?.sidebarMode)
    }
  })

  it('agent = workspace 级公共左栏（注册 sidebar 组件供布局层渲染）', () => {
    expect(resolveSheetRender('agent')?.sidebarMode).toBe('workspace')
    expect(resolveSheetRender('agent')?.sidebar).toBeDefined()
  })

  it('其余 8 种内置 Sheet 均自绘业务左栏，不占 workspace 槽位', () => {
    for (const kind of SHEET_KINDS.filter(kind => kind !== 'agent')) {
      const entry = resolveSheetRender(kind)
      expect(entry?.sidebarMode).toBe('sheet')
      expect(entry?.sidebar).toBeUndefined()
    }
  })
})
