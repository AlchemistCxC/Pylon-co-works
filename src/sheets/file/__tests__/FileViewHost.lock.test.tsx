// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import FileViewHost from '../FileViewHost'
import type { FileTabRecord } from '../fileSheetState'
import { resetStores } from '../../../test/resetStores'
import { fileEditorEditable, fileEditorView, replaceFileEditorValue, waitForFileEditor } from './codeMirrorTestUtils.ts'
import { useWorkspaceStore, touchedFileVersionKey } from '../../../domains/workspace/workspaceStore'

// 0-A3 写冲突锁：冷却窗口（3s）内 touchVersion ≥2 次递增 = agent 正在写盘 →
// 内核只读 + 状态条提示 + 保存禁用；静默满冷却 → 解锁并 probeDisk 确认稳定；
// 「仍要编辑」逃生口恢复编辑但锁内保存仍禁用（防半成品文件写回）。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

const fileTab: FileTabRecord = { path: 'src/a.ts', mode: 'file' }
const lockKey = touchedFileVersionKey({ agentId: 'agent-test', source: 'ws-a' }, 'src/a.ts')

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

function bumpTouch(version: number) {
  useWorkspaceStore.setState({ touchVersions: { [lockKey]: version } })
}

describe('FileViewHost 写冲突锁（0-A3 / issue #285）', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') return Promise.resolve(readTextResult('const x = 2'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('单次 touchVersion 递增 → 不置锁（正常外部刷新路径）', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} context={{ agentId: 'agent-test', source: 'ws-a' }} onCloseTab={vi.fn()} />)
    await waitForFileEditor('const x = 1')

    vi.useFakeTimers()
    act(() => bumpTouch(5))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(fileEditorEditable()).toBe(true)
    expect(screen.queryByText('Agent 正在修改此文件，编辑已暂停')).toBeNull()
    vi.useRealTimers()
  })

  it('冷却窗口内 2 次递增 → 置锁：只读 + 状态条提示 + 保存禁用；静默 3s → 解锁', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} context={{ agentId: 'agent-test', source: 'ws-a' }} onCloseTab={vi.fn()} />)
    await waitForFileEditor('const x = 1')

    vi.useFakeTimers()
    act(() => bumpTouch(5))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    act(() => bumpTouch(6))
    expect(fileEditorEditable()).toBe(false)
    expect(screen.getByText('Agent 正在修改此文件，编辑已暂停')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    // 静默满冷却 → 解锁 + probeDisk 稳定确认
    const readsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'read_workspace_text').length
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fileEditorEditable()).toBe(true)
    expect(screen.queryByText('Agent 正在修改此文件，编辑已暂停')).toBeNull()
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'read_workspace_text').length).toBeGreaterThan(readsBefore)
    vi.useRealTimers()
  })

  it('恰满冷却 3s 后的第二次 touch 不置锁（窗口为严格小于）', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await waitForFileEditor('const x = 1')

    vi.useFakeTimers()
    act(() => bumpTouch(5))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    act(() => bumpTouch(6))
    expect(fileEditorEditable()).toBe(true)
    expect(screen.queryByText('Agent 正在修改此文件，编辑已暂停')).toBeNull()
    vi.useRealTimers()
  })

  it('锁内用户已有编辑保留；逃生口恢复编辑但保存仍禁用，解锁后可保存', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} context={{ agentId: 'agent-test', source: 'ws-a' }} onCloseTab={vi.fn()} />)
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 999')
    await screen.findByText(/未保存/)

    vi.useFakeTimers()
    act(() => bumpTouch(5))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    act(() => bumpTouch(6))
    expect(fileEditorEditable()).toBe(false)
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')

    // 逃生口：恢复编辑（editable true），但保存仍禁用
    fireEvent.click(screen.getByRole('button', { name: '仍要编辑' }))
    expect(fileEditorEditable()).toBe(true)
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.keyDown(fileEditorView().contentDOM, { key: 's', ctrlKey: true })
    expect(invoke).not.toHaveBeenCalledWith('write_workspace_text', expect.anything())

    // 解锁 → 保存恢复可用；编辑内容仍保留（dirty 语义不变）
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(save.disabled).toBe(false)
    expect(fileEditorView().state.doc.toString()).toBe('const x = 999')
    expect(screen.getByText(/未保存/)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('锁内 Ctrl-S 与保存按钮都不触发写盘', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} context={{ agentId: 'agent-test', source: 'ws-a' }} onCloseTab={vi.fn()} />)
    const editor = await waitForFileEditor('const x = 1')
    replaceFileEditorValue(editor, 'const x = 2')

    vi.useFakeTimers()
    act(() => bumpTouch(5))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    act(() => bumpTouch(6))

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.keyDown(fileEditorView().contentDOM, { key: 's', ctrlKey: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(invoke).not.toHaveBeenCalledWith('write_workspace_text', expect.anything())
    vi.useRealTimers()
  })

  it('tab identity 切换重置锁状态', async () => {
    const { rerender } = render(<FileViewHost source="ws-a" tab={fileTab} context={{ agentId: 'agent-test', source: 'ws-a' }} onCloseTab={vi.fn()} />)
    await waitForFileEditor('const x = 1')

    vi.useFakeTimers()
    act(() => bumpTouch(5))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    act(() => bumpTouch(6))
    expect(fileEditorEditable()).toBe(false)

    rerender(<FileViewHost source="ws-a" tab={{ path: 'src/b.ts', mode: 'file' }} context={{ agentId: 'agent-test', source: 'ws-a' }} onCloseTab={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(3600) })
    expect(screen.queryByText('Agent 正在修改此文件，编辑已暂停')).toBeNull()
    vi.useRealTimers()
  })
})
