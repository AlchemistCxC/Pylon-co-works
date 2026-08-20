/**
 * A1-c/B5：HistoryRetention Tauri 模式重接后端保留策略（canonical 数据层就绪）。
 * - 挂载即 retention_policy_get 读后端权威值；无行 → 永久保存表单；
 * - 修改策略 → retention_policy_set（expectedRevision=0 首写乐观并发）；
 * - 非永久策略保存成功后出现「立即清理」入口（preview/prune 由 repository 层测试覆盖）。
 * browser 模式（同步 localStorage）由 historyRetentionPolicy.test.ts 覆盖。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import HistoryRetention from '../HistoryRetention'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('../../../infrastructure/tauri/env', () => ({ IS_TAURI: true }))

describe('HistoryRetention Tauri 模式（A1-c/B5 重接后端）', () => {
  beforeEach(() => {
    localStorage.clear()
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'retention_policy_get') return null
      if (cmd === 'retention_policy_set') return 1
      throw new Error(`unexpected command ${cmd}`)
    })
  })

  it('挂载后读后端权威值（无行 → 永久保存），渲染策略表单', async () => {
    render(<HistoryRetention />)
    expect(await screen.findByLabelText('保留策略')).toBeInTheDocument()
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('retention_policy_get'))
    expect(screen.getByText(/永久保存/)).toBeInTheDocument()
    expect(screen.queryByText(/保留策略待 canonical 数据层就绪后开放/)).toBeNull()
    expect(screen.queryByRole('button', { name: '立即清理' })).toBeNull()
  })

  it('切换到按时间保留 → retention_policy_set 首写 expectedRevision=0，保存后出现清理入口', async () => {
    render(<HistoryRetention />)
    const select = await screen.findByRole('combobox', { name: '保留策略' })
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('retention_policy_get'))
    fireEvent.click(select)
    fireEvent.mouseDown(screen.getByRole('option', { name: '按时间保留' }))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'retention_policy_set')
      expect(calls).toHaveLength(1)
    })
    const [, args] = invokeMock.mock.calls.find(([cmd]) => cmd === 'retention_policy_set')!
    expect(args).toEqual({
      json: JSON.stringify({ mode: 'by_time', days: 30 }),
      expectedRevision: 0,
    })
    expect(await screen.findByRole('button', { name: '立即清理' })).toBeInTheDocument()
  })
})
