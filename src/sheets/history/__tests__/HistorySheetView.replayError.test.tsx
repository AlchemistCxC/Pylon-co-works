// @vitest-environment jsdom
/**
 * CR-002（玉衡 finding）：History openReplay 遇事务失败（如 source/periId 归属冲突）
 * 必须把 result.message 呈现到 exportError 槽（role=alert），而不是静默 return。
 * 修复前 RED：点击回放后无 alert；修复后 GREEN。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HistorySheetView from '../HistorySheetView'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
vi.mock('../../../infrastructure/acp/sessionClient', () => ({
  createSessionClient: () => ({
    listPersistedSessions: vi.fn().mockResolvedValue([
      { id: 'p1', source: 'qq:group:1', title: '回放冲突存档', periId: 'peri-9', updatedAt: 100 },
    ]),
    exportSession: vi.fn(),
  }),
}))
vi.mock('../../../application/transactions/resumePersistedSessionTransaction', () => ({
  resumePersistedSessionTransaction: vi.fn(() => ({
    ok: false,
    kind: 'conflict',
    message: '存档会话归属冲突：source 与 periId 指向不同会话，需显式选择',
  })),
}))

const sheet: SheetRecord = { id: 'history', kind: 'history', title: '存档', createdAt: 0, lastFocusedAt: 0 }

function makeCtx(): SheetContext {
  return { selectSession: vi.fn(), openSheet: vi.fn() } as unknown as SheetContext
}

describe('CR-002 History 回放冲突呈现', () => {
  it('事务冲突 → exportError 槽显示 message，不进入姿态', async () => {
    const ctx = makeCtx()
    render(<HistorySheetView sheet={sheet} ctx={ctx} />)
    const button = await screen.findByRole('button', { name: /回放/ })
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
        // I01-W4：存档无 owner → blocked（不静默归 active Agent）
    expect(alert.textContent).toContain('归属不明')
    expect(ctx.selectSession).not.toHaveBeenCalled()
    expect(ctx.openSheet).not.toHaveBeenCalled()
  })
})
