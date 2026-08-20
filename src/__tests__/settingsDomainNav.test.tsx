/**
 * ISSUE-13 W2（T13-2）Settings 布局迁移行为测试：
 * - 左侧一级导航 = 稳定设置域（外观/工作区/Agent 与连接），tier（快速/进阶/专家）无残留
 * - 切换 domain → 分区列表跟随 domain config 变化
 * - 选择分区 → 内容渲染正确（复用既有块组件）
 */
// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../components/Settings'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('ISSUE-13 W2 左侧 domain 导航', () => {
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

  // 限定左侧导航容器查询——SettingsPreview 右侧面板 mock 里可能有同名 tab（如"工作区"）
  const nav = () => within(document.querySelector('.settings-nav') as HTMLElement)
  const navButton = (name: string) => nav().getByRole('button', { name })

  it('一级导航渲染三个设置域，tier（快速/进阶/专家）无残留', () => {
    render(<Settings />)
    for (const label of ['外观', '工作区', 'Agent 与连接']) {
      expect(navButton(label)).toBeInTheDocument()
    }
    expect(nav().queryByRole('button', { name: '快速' })).toBeNull()
    expect(nav().queryByRole('button', { name: '进阶' })).toBeNull()
    expect(nav().queryByRole('button', { name: '专家' })).toBeNull()
  })

  it('默认显示外观域分区（模板库/全局/左栏/终端/中控区/右栏）', () => {
    render(<Settings />)
    for (const section of ['模板库', '全局', '左栏', '终端', '中控区', '右栏']) {
      expect(navButton(section)).toBeInTheDocument()
    }
  })

  it('切到工作区 → 分区为窗口/宠物/历史保留/配置备份；选窗口渲染窗口尺寸块', () => {
    render(<Settings />)
    fireEvent.click(navButton('工作区'))
    for (const section of ['窗口', '宠物', '历史保留', '配置备份']) {
      expect(navButton(section)).toBeInTheDocument()
    }
    expect(nav().queryByRole('button', { name: '模板库' })).toBeNull()
    fireEvent.click(navButton('窗口'))
    expect(screen.getByText('当前尺寸')).toBeInTheDocument()
  })

  it('切到 Agent 与连接 → 分区为 Agent/会话/Gateway；选 Agent 渲染当前 Agent 区', () => {
    render(<Settings />)
    fireEvent.click(navButton('Agent 与连接'))
    for (const section of ['Agent', '会话', 'Gateway']) {
      expect(navButton(section)).toBeInTheDocument()
    }
    fireEvent.click(navButton('Agent'))
    expect(screen.getByText('当前 Agent')).toBeInTheDocument()
  })

  it('切回外观 → 分区列表恢复（domain 可往返）', () => {
    render(<Settings />)
    fireEvent.click(navButton('工作区'))
    fireEvent.click(navButton('外观'))
    for (const section of ['模板库', '全局', '左栏', '终端', '中控区', '右栏']) {
      expect(navButton(section)).toBeInTheDocument()
    }
  })
})
