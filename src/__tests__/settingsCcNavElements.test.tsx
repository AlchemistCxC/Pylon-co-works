// @vitest-environment jsdom
import { fireEvent, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CC_WIDGET_GROUPS } from '../domains/cc/widgetDefinitions.ts'
import { useIdentityStore } from '../domains/identity/identityStore'
import { GROUP_ORDER } from '../domains/theme/themeFieldDefs.ts'
import { FakeInvoke } from '../test/fakeInvoke'
import { resetStores } from '../test/resetStores'
import { mountSettingsSheet } from '../test/settingsSheetHarness'

/**
 * #266 CC-09（左栏导航「中控台」按**元件**分层）的行为测试 —— 真渲染，不是模拟推导。
 *
 * 为什么需要它：`navGroupsFor` 是 `SettingsSheetSidebar` 内部的闭包（未导出），只有**挂载组件**
 * 才能验到它的语义。改造前它取 `GROUP_ORDER[zone]` 的**子部件名**（`block.groups[].title`）
 * ⇒ 中控台下平铺 12 个零件名（中控本体面 / 输入框本体 / 提示符 ❯ …），与主区「元件 h3 →
 * 子部件组」的两级结构对不上（用户 2026-09-26 拍板「要分层」）。
 *
 * 判据两条（缺一不可）：
 * 1. **中控台下 = 元件名**（`GROUP_ORDER.cc` 的分区标题，源头是元件定义表 `CC_WIDGET_GROUPS`
 *    的行 label），且**不含任何子部件名**；
 * 2. **其它区一字不动** —— 仍取子部件名（global/sidebar/chat/right 的 block 没有 `heading`）。
 *
 * ★ 关于数量：本次同时删掉了「用量胶囊」名下仅有的两个字段 ⇒ `tokens` 元件无可调项、
 *   按派生规则整块退出（设置页与导航都是 **7** 项，不再有「用量」）。这与施工单 §2.1
 *   「用量整块不再出现，这是预期结果」一致；断言直接锁这个真值，不写死数字 8。
 */
const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))

vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})

/** 未注册命令 resolve undefined —— 设置主区渲染期的后台 invoke 不影响本用例断言。 */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

let fakeInvoke: TolerantFakeInvoke

beforeEach(() => {
  localStorage.clear()
  resetStores()
  fakeInvoke = new TolerantFakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  Element.prototype.scrollIntoView = vi.fn()
  useIdentityStore.setState({ agents: [{ id: 'peri', name: 'Peri' }], activeAgent: 'peri' })
})

const nav = () => within(document.querySelector('.settings-sheet-nav') as HTMLElement)
const navButton = (name: string) => nav().getByRole('button', { name })

/** 展开某个分区，返回它自己那个折叠容器（.settings-nav-subgroups）里的二级项文本。 */
function expandSectionAndReadSubItems(section: string): string[] {
  const row = navButton(section)
  fireEvent.click(row)
  const block = row.closest('.settings-nav-section-block') as HTMLElement
  const subgroups = block.querySelector('.settings-nav-subgroups')
  if (!subgroups) return []
  return within(subgroups as HTMLElement)
    .getAllByRole('button')
    .map(button => button.textContent ?? '')
}

/** 元件名（= 定义表里每行的 label，顺序同表）。 */
const WIDGET_LABELS = CC_WIDGET_GROUPS.map(row => row.label)
/** 子部件名（= 各元件 members 的 label）—— 改造前导航平铺的就是这一批。 */
const MEMBER_LABELS = CC_WIDGET_GROUPS.flatMap(row => row.members.map(member => member.label))

describe('#266 CC-09 · 左栏「中控台」二级项 = 元件层', () => {
  it('中控台的二级项 = 元件名列表，且一个子部件名都不出现', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'cc' })
    const items = expandSectionAndReadSubItems('中控台')

    // 期望 = 分组表里**真有可调项**的元件（本次删完「用量胶囊」后 tokens 无项 ⇒ 整块退出）
    const expected = (GROUP_ORDER.cc ?? []).map(section => section.heading as string)
    expect(items).toEqual(expected)
    expect(expected.length).toBeGreaterThan(1)   // 正控：二级项真的渲染出来了（否则下面的断言空转）

    // 反向：12 个子部件名一个都不该出现（改造前平铺的正是它们）
    for (const label of MEMBER_LABELS) {
      expect(items, `${label} 是子部件名，不该再作为二级项出现`).not.toContain(label)
    }
    // 且四项被删字段所属的「用量胶囊」组名同样不出现
    expect(items).not.toContain('用量胶囊')
    // 元件名与子部件名无重名（施工单 §2.2 已核）—— 保证上面两条断言互不掩盖
    expect(WIDGET_LABELS.filter(label => MEMBER_LABELS.includes(label))).toEqual([])
  })

  it('「用量」元件因无可调项整块退出（字段删完的直接后果，施工单 §2.1 明示为预期）', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'cc' })
    const items = expandSectionAndReadSubItems('中控台')

    expect(items).not.toContain('用量')
    expect(items).toContain('发送按钮')
    expect(items).toContain('命令行提示')
    // 元件表本身一行没动（铁律：不删已有元件）
    expect(CC_WIDGET_GROUPS).toHaveLength(8)
    expect(items).toHaveLength(7)
  })

  it('点二级项能滚到对应**元件标题**（主区 h3 上也挂了锚点）', async () => {
    mountSettingsSheet({ domain: 'appearance', section: 'cc' })
    const items = expandSectionAndReadSubItems('中控台')
    const row = navButton('中控台')
    const block = row.closest('.settings-nav-section-block') as HTMLElement
    const subgroups = within(block.querySelector('.settings-nav-subgroups') as HTMLElement)

    for (const label of items) {
      // 主区：元件标题（h3）必须带同名锚点 —— 这正是本刀在 themeFieldRenderer 上补的那一处
      const anchor = document.querySelector(`[data-group-anchor="${label}"]`)
      expect(anchor, `${label} 在主区没有锚点（点击无处可滚）`).not.toBeNull()
      expect(anchor?.tagName).toBe('H3')
      // 导航侧：点一下确实触发了锚点滚动（滚动挂在 rAF 里 ⇒ 等一帧再断言）
      const scrollIntoView = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
      scrollIntoView.mockClear()
      fireEvent.click(subgroups.getByRole('button', { name: label }))
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    }
  })

  it('其它区一字不动：仍取子部件名（global / sidebar / chat / right）', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'cc' })

    const expectedFor = (zone: 'global' | 'sidebar' | 'chat' | 'right') =>
      (GROUP_ORDER[zone] ?? []).flatMap(block => block.groups.map(group => group.title))

    const global = expandSectionAndReadSubItems('全局')
    expect(global).toEqual(expectedFor('global'))
    expect(global).toContain('个人信息')   // 正控：确实是"分组/子部件"这一层

    const sidebar = expandSectionAndReadSubItems('侧栏')
    expect(sidebar).toEqual(expectedFor('sidebar'))
    expect(sidebar).toContain('玻璃效果')

    const chat = expandSectionAndReadSubItems('消息流')
    expect(chat).toEqual(expectedFor('chat'))
    expect(chat).toContain('语法高亮')

    const right = expandSectionAndReadSubItems('右栏')
    expect(right).toEqual(expectedFor('right'))

    // 其它区没有元件层概念 ⇒ 二级项里不该混进元件名
    for (const label of WIDGET_LABELS) {
      for (const items of [global, sidebar, chat, right]) {
        expect(items, `${label} 是元件名，不该出现在非中控区的二级项里`).not.toContain(label)
      }
    }
  })
})
