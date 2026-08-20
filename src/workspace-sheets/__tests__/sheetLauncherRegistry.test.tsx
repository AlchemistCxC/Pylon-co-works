// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SheetLauncher from '../SheetLauncher'
import { resetStores } from '../../test/resetStores'
import '../../plugin-runtime/pluginCompositionRoot'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import { registerWorkspace } from '../workspaceRegistry'

describe('SheetLauncher Registry 卡片', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('按注册分类显示图标卡片，并可打开包含新增 Overview 在内的 Sheet', () => {
    const onOpenSheet = vi.fn()
    const onOpenChange = vi.fn()
    render(<SheetLauncher
      open
      agents={[]}
      sheets={[]}
      onOpenChange={onOpenChange}
      onFocusSheet={vi.fn()}
      onOpenSheet={onOpenSheet}
      onOpenSettings={vi.fn()}
      onOpenProfiles={vi.fn()}
    />)

    expect(screen.getByText('工作台')).toBeInTheDocument()
    expect(screen.getByText('观察与诊断')).toBeInTheDocument()
    expect(screen.getByText('系统与管理')).toBeInTheDocument()
    const overview = screen.getByRole('option', { name: /Overview.*工作状态与最近会话概览/ })
    expect(overview.querySelector('[data-launch-icon="layout-dashboard"]')).not.toBeNull()
    fireEvent.click(overview)
    expect(onOpenSheet).toHaveBeenCalledWith('overview', 'Overview')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('注册关键词参与 Command 搜索', () => {
    render(<SheetLauncher
      open
      agents={[]}
      sheets={[]}
      onOpenChange={vi.fn()}
      onFocusSheet={vi.fn()}
      onOpenSheet={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenProfiles={vi.fn()}
    />)
    fireEvent.change(screen.getByPlaceholderText('搜索 Sheet、Agent 或管理入口...'), { target: { value: 'diagnostic' } })
    expect(screen.getByRole('option', { name: /Runtime/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Browser/ })).toBeNull()
  })

  it('插件声明未知图标键时使用 host 通用图标，不加载插件 React 组件', () => {
    const registration = registerWorkspace(createPluginIdentity('test.launcher-card', 'unknown-icon'), {
      kind: 'test.unknown-icon',
      label: 'Future',
      singleton: true,
      getSingletonKey: () => 'test.unknown-icon',
      sidebarMode: 'none',
      launch: { kind: 'test.unknown-icon', title: 'Future Sheet', description: '插件未来图标', launchable: true, icon: 'future-glyph' },
      component: () => null,
      createInitialState: () => undefined,
      serialize: state => state,
      deserialize: state => state,
    })
    try {
      render(<SheetLauncher
        open
        agents={[]}
        sheets={[]}
        onOpenChange={vi.fn()}
        onFocusSheet={vi.fn()}
        onOpenSheet={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenProfiles={vi.fn()}
      />)
      const future = screen.getByRole('option', { name: /Future Sheet/ })
      expect(future.querySelector('[data-launch-icon="future-glyph"] .lucide-square-stack')).not.toBeNull()
    } finally {
      registration.dispose()
    }
  })
})
