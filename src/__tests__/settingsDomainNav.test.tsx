/**
 * ISSUE-13 W2（T13-2）Settings 布局迁移行为测试：
 * - 设置页不再挂载一级域导航；域切换由标题栏设置菜单的 intent 事件驱动
 * - 切换 domain → 分区列表跟随 domain config 变化
 * - 选择分区 → 内容渲染正确（复用既有块组件）
 */
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../components/Settings'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('ISSUE-13 W2 当前域内 section 导航', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
    useIdentityStore.setState({
      agents: [{ id: 'peri', name: 'Peri' }],
      activeAgent: 'peri',
    })
  })

  // 二级 section 仅在 settings-nav 内；一级 domain 由标题栏菜单驱动。
  const nav = () => within(document.querySelector('.settings-nav') as HTMLElement)
  const navButton = (name: string) => nav().getByRole('button', { name })

  it('设置页不保留一级域导航，tier（快速/进阶/专家）无残留', () => {
    render(<Settings />)
    expect(document.querySelector('.settings-domain-rail')).toBeNull()
    expect(screen.getByText(/使用标题栏.*设置.*菜单切换/)).toBeInTheDocument()
    expect(nav().queryByRole('button', { name: '快速' })).toBeNull()
    expect(nav().queryByRole('button', { name: '进阶' })).toBeNull()
    expect(nav().queryByRole('button', { name: '专家' })).toBeNull()
  })

  it('默认显示外观域分区（模板库/全局/侧栏/消息流/中控台/右栏）——K-2 重命名', () => {
    render(<Settings />)
    for (const section of ['模板库', '全局', '侧栏', '消息流', '中控台', '右栏']) {
      expect(navButton(section)).toBeInTheDocument()
    }
  })

  it('切到工作区 → 分区为窗口/宠物/历史保留/配置备份；选窗口渲染窗口尺寸块', () => {
    render(<Settings initialDomain="workspace" />)
    for (const section of ['窗口', '宠物', '历史保留', '配置备份']) {
      expect(navButton(section)).toBeInTheDocument()
    }
    expect(nav().queryByRole('button', { name: '模板库' })).toBeNull()
    fireEvent.click(navButton('窗口'))
    expect(screen.getByText('当前尺寸')).toBeInTheDocument()
  })

  it('showPet 只有工作区 › 宠物一个可编辑入口，旧主题字段不再重复渲染', () => {
    const view = render(<Settings />)
    expect(screen.queryByText('桌面宠物')).toBeNull()
    view.unmount()
    render(<Settings initialDomain="workspace" />)
    fireEvent.click(navButton('宠物'))
    expect(screen.getByRole('button', { name: /宠物显示中|宠物已隐藏/ })).toBeInTheDocument()
  })

  it('切到 Agent 与连接 → 分区为 Agent/会话/Gateway；选 Agent 渲染当前 Agent 区', () => {
    render(<Settings initialDomain="agents-connections" />)
    for (const section of ['Agent', '会话', 'Gateway']) {
      expect(navButton(section)).toBeInTheDocument()
    }
    fireEvent.click(navButton('Agent'))
    expect(screen.getByText('当前 Agent')).toBeInTheDocument()
  })

  it('标题栏设置意图切换域后分区列表恢复（domain 可往返）', async () => {
    render(<Settings initialDomain="workspace" />)
    window.dispatchEvent(new CustomEvent('pylon:open-settings', { detail: { domain: 'appearance' } }))
    await waitFor(() => expect(nav().getByRole('button', { name: '模板库' })).toBeInTheDocument())
    for (const section of ['模板库', '全局', '侧栏', '消息流', '中控台', '右栏']) {
      expect(navButton(section)).toBeInTheDocument()
    }
  })
})

describe('K-2 左栏二级折叠导航（施工书 09）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('有 ≥2 组的 section 显示折叠箭头，点击展开二级项', () => {
    render(<Settings />)
    const navEl = document.querySelector('.settings-nav') as HTMLElement
    const w = within(navEl)
    // 消息流（chat zone，12 组）应有展开控件
    const chatBtns = w.getAllByRole('button', { name: /消息流/ })
    const chatBtn = chatBtns.find(b => b.getAttribute('aria-expanded') !== null) ?? chatBtns[0]
    expect(chatBtn.getAttribute('aria-expanded')).not.toBeNull()
    // 默认收起：二级项不可见
    expect(w.queryByRole('button', { name: '语法高亮' })).toBeNull()
    fireEvent.click(chatBtn)
    // 展开后二级项可见（组锚点）
    expect(w.getByRole('button', { name: '背景' })).toBeInTheDocument()
    expect(w.getByRole('button', { name: '语法高亮' })).toBeInTheDocument()
  })

  it('页面自有 section（无 zone/组）不显示折叠箭头', () => {
    render(<Settings />)
    const navEl = document.querySelector('.settings-nav') as HTMLElement
    // 模板库是外观 domain 的 page-owned section（无 zone → 无二级）
    const tpl = within(navEl).getByRole('button', { name: '模板库' })
    expect(tpl.getAttribute('aria-expanded')).toBeNull()
  })
})

describe('K-4 边界修复：pinned 跳转与 domain 同步', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
  })

  it('F1 常用区点击其他 domain 的 section 时，domain 跟随切换', async () => {
    render(<Settings />)
    const navEl = document.querySelector('.settings-nav') as HTMLElement
    const w = within(navEl)
    // 在外观域置顶「消息流」
    const chatRow = w.getByRole('button', { name: '消息流' })
    fireEvent.click(within(chatRow.parentElement as HTMLElement).getByRole('button', { name: '置顶 消息流' }))
    // 通过标题栏设置菜单发出域切换意图
    window.dispatchEvent(new CustomEvent('pylon:open-settings', { detail: { domain: 'workspace' } }))
    await waitFor(() => expect(w.getByRole('button', { name: '窗口' })).toBeInTheDocument())
    // 常用区出现置顶项（★ 为 aria-hidden 装饰，accessible name 即「消息流」）——点它
    const pinnedBtn = w.getAllByRole('button', { name: '消息流' }).find(button => button.classList.contains('pinned'))!
    expect(pinnedBtn.closest('.settings-nav-section-block')).toBeNull()
    fireEvent.click(pinnedBtn)
    // 断言：domain 回到外观（分区列表含「全局」）且内容区是消息流的 Owner 头
    await waitFor(() => expect(w.getByRole('button', { name: '全局' })).toBeInTheDocument())
    expect(screen.getByTestId('settings-owner-badge').textContent).toContain('message-stream')
  })
})

describe('P6 Slice A 设置入口兼容', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
  })

  it('消费旧 renderer/suite 事件时落到现行渲染器分区', async () => {
    render(<Settings />)
    window.dispatchEvent(new CustomEvent('pylon:open-settings', {
      detail: { domain: 'renderer', section: 'suite' },
    }))
    const navEl = document.querySelector('.settings-nav') as HTMLElement
    await waitFor(() => {
      expect(within(navEl).getByRole('button', { name: '渲染器' })).toHaveClass('active')
      expect(screen.getByText('Renderer fixture')).toBeInTheDocument()
    })
  })
})
