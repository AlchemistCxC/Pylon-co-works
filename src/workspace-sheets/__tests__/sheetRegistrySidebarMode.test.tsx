// @vitest-environment jsdom
/**
 * I09-A-FE-01（L1：registry 完整性，6.10 问题 #4 等级 1）：
 * 全部 SheetKind 均显式声明 sidebar mode/capability，禁止隐式缺失（ISSUE-09.md 施工点 1）。
 * sidebarMode 语义（方案 A，ISSUE-09.md）：'workspace'=布局层渲染的公共左栏 / 'sheet'=布局层
 * 渲染 sheet 提供的左栏内容 / 'none'=无侧栏。sidebar 组件声明即左栏内容来源（SheetSidebarSlot
 * 消费，#154 统一侧栏模型）。
 *
 * #154 阶段 4 改写登记：旧断言「mode='sheet' 的 sheet 一律不注册 sidebar（自绘 aside）」
 * 是统一侧栏模型之前的形态——settings 迁入 sheet 体系后成为第一个「mode='sheet' 且注册
 * sidebar」的 kind，其余 'sheet' kind 仍无 sidebar。断言强度不降：逐 kind 显式点名。
 */
import { describe, expect, it } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { SHEET_KINDS } from '../sheetTypes'
import { resolveSheetRender } from '../sheetRegistry.tsx'

const SIDEBAR_MODES = ['workspace', 'sheet', 'none'] as const

describe('I09-A-FE-01 registry sidebar mode/capability 完整性', () => {
  it('全部 SheetKind 均显式声明合法 sidebarMode（禁止隐式缺失）', () => {
    expect(SHEET_KINDS).toHaveLength(10)
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

  it('settings = sheet 级左栏（一二级导航注册为 sidebar，#154 阶段 4）', () => {
    expect(resolveSheetRender('settings')?.sidebarMode).toBe('sheet')
    expect(resolveSheetRender('settings')?.sidebar).toBeDefined()
    expect(resolveSheetRender('settings')?.singleton).toBe(true)
    expect(resolveSheetRender('settings')?.getSingletonKey({ agentId: undefined, singletonKey: undefined, metadata: undefined })).toBe('settings')
  })

  it('其余 sheet 模式 Sheet 仍无注册表 sidebar（业务左栏未迁移的保持现状）', () => {
    for (const kind of SHEET_KINDS.filter(kind => kind !== 'agent' && kind !== 'settings')) {
      const entry = resolveSheetRender(kind)
      expect(entry?.sidebarMode).toBe('sheet')
      expect(entry?.sidebar).toBeUndefined()
    }
  })
})
