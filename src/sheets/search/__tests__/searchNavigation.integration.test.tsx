// @vitest-environment jsdom
/**
 * FE-AUD-003 行为回归（阶段 0，先 RED）：跨会话搜索「定位消息」必须有消费者。
 *
 * 目标行为：点击搜索结果时，按 sessionId+messageId 保存持久导航意图
 * （sessionUiState key `pendingMessageLocation`），不依赖瞬时 CustomEvent——
 * 后者在 ChatView 跨挂载场景下必然丢失。当前实现（2026-08-07）只 dispatch
 * `pylon:locate-message` CustomEvent（全前端无 listener）→ 本文件应 RED。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SearchSheetView from '../SearchSheetView'
import { useIdentityStore } from '../../../identityStore'
import { resetStores } from '../../../test/resetStores'
import { sessionUiStateGet } from '../../../components/chat/sessionUiState'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

function seedLocalSnapshot(): void {
  useIdentityStore.setState({
    sessions: [{
      id: 's1', name: '会话一', source: 'local:会话一', profileId: 'riccati',
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

function renderSearch(ctx: SheetContext): void {
  const sheet: SheetRecord = { id: 'search', kind: 'search', title: '搜索', createdAt: 0, lastFocusedAt: 0 }
  render(<SearchSheetView sheet={sheet} ctx={ctx} />)
}

async function searchAndClick(query: string, ctx: SheetContext): Promise<void> {
  renderSearch(ctx)
  fireEvent.change(screen.getByLabelText('跨会话搜索'), { target: { value: query } })
  await screen.findByText(/需要定位的消息 hello world/)
  fireEvent.click(screen.getByRole('button', { name: /需要定位的消息 hello world/ }))
}

describe('FE-AUD-003 搜索定位消费者', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('点击结果创建持久定位意图（当前仅瞬时 CustomEvent → RED）', async () => {
    seedLocalSnapshot()
    await searchAndClick('定位', setupCtx())
    expect(sessionUiStateGet('s1', 'pendingMessageLocation')).toEqual({ sessionId: 's1', messageId: 'm1' })
  })

  it('点击结果打开对应会话（当前已实现 — 基线绿）', async () => {
    seedLocalSnapshot()
    const ctx = setupCtx()
    await searchAndClick('定位', ctx)
    expect(ctx.selectSession as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('s1')
    expect(ctx.openSheet as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent', agentId: 'peri' }))
  })
})
