// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@solidjs/testing-library'
import SearchSheetView from '../SearchSheetView.solid'
import { useIdentityStore } from '../../../identityStore'
import { resetStores } from '../../../test/resetStores'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

// #279 第 1 梯队：SearchSheetView Solid 实体的原生渲染路径（不经 React 桥）——
// 断言语义与 searchNavigation.integration.test.tsx 同源（持久定位意图 + owner-aware 打开）。

function seedLocalSnapshot(): void {
  useIdentityStore.setState({
    sessions: [{
      id: 's1', agentId: 'peri', name: '会话一', source: 'local:会话一', profileId: 'profile-a',
      createdAt: 0, lastActiveAt: 0, platform: 'local', workdir: '',
      sessionPrompt: '', skills: [], hooks: [], autoName: '',
    }],
  })
  localStorage.setItem('pylon-msgs-s1', JSON.stringify([
    { id: 'm1', content: '需要定位的消息 hello world', time: '2026-01-01' },
  ]))
}

function setupCtx(): SheetContext {
  const selectSession = vi.fn()
  const openSheet = vi.fn()
  return { selectSession, openSheet } as unknown as SheetContext
}

const sheet: SheetRecord = { id: 'search', kind: 'search', title: '搜索', createdAt: 0, lastFocusedAt: 0 }

describe('SearchSheetView.solid', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('渲染骨架与空态，输入关键词出结果', async () => {
    seedLocalSnapshot()
    const ctx = setupCtx()
    const view = render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
    expect(screen.getByText('跨会话搜索')).toBeTruthy()
    expect(screen.getByText('搜索本地会话消息')).toBeTruthy()
    fireEvent.input(screen.getByLabelText('跨会话搜索'), { target: { value: '定位' } })
    await screen.findByText(/需要定位的消息 hello world/)
    expect(screen.queryByText('搜索本地会话消息')).toBeNull()
    view.unmount()
  })

  it('点击结果创建持久定位意图并 owner-aware 打开会话', async () => {
    seedLocalSnapshot()
    const ctx = setupCtx()
    const view = render(() => <SearchSheetView sheet={sheet} ctx={ctx} />)
    fireEvent.input(screen.getByLabelText('跨会话搜索'), { target: { value: '定位' } })
    await screen.findByText(/需要定位的消息 hello world/)
    fireEvent.click(screen.getByRole('button', { name: /需要定位的消息 hello world/ }))
    await vi.waitFor(() => {
      expect(ctx.selectSession).toHaveBeenCalledWith('s1')
      expect(ctx.openSheet).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent', agentId: 'peri' }))
    })
    view.unmount()
  })
})
