// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FileViewHost from '../FileViewHost'
import type { FileTabRecord } from '../fileSheetState'
import { resetStores } from '../../../test/resetStores'

// I08-A-FE-02：真实保存垂直切片——编辑开关、保存（基线校验）、冲突流程（不静默覆盖）、
// 覆盖保存、重新加载、working-diff 面板。

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../../components/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))

const fileTab: FileTabRecord = { path: 'src/a.ts', mode: 'file' }
const otherTab: FileTabRecord = { path: 'src/b.ts', mode: 'file' }

function readTextResult(content: string, truncated = false) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated }
}

function editAndType(value = 'const x = 2') {
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  const textarea = document.querySelector('.file-edit-textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value } })
  return textarea
}

describe('FileViewHost 真实编辑/save/working-diff（I08-A-FE-02）', () => {
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

  it('编辑开关：只读 → 点编辑 → textarea + 保存按钮；truncated 时禁用编辑', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    await waitFor(() => expect(document.querySelector('.file-edit-textarea')).not.toBeNull())
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出编辑' })).toBeTruthy()
  })

  it('truncated 文件：编辑按钮禁用（内容不完整不可编辑）', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1', true))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('内容不完整（truncated）')
    const toggle = screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
  })

  it('保存成功：write 带 source/relativePath/content/expectedBaseline=基线/force=false，状态栏已保存、dirty 清除', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    editAndType()
    await screen.findByText(/未保存/)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存')
    expect(invoke).toHaveBeenCalledWith('write_workspace_text', {
      source: 'ws-a',
      relativePath: 'src/a.ts',
      content: 'const x = 2',
      expectedBaseline: 'const x = 1',
      force: false,
    })
    await waitFor(() => expect(screen.queryByText(/未保存/)).toBeNull())
    expect(screen.queryByText('变更预览')).toBeNull()
  })

  it('保存冲突：外部修改 → 拒绝且保留 dirty（不静默覆盖），出覆盖/重新加载冲突条', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') return Promise.reject(new Error('conflict: 磁盘文件已被外部修改，保存已拒绝'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    editAndType()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/磁盘文件已被外部修改/)
    expect(invoke).toHaveBeenCalledWith('write_workspace_text', expect.objectContaining({ force: false }))
    const textarea = document.querySelector('.file-edit-textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('const x = 2')
    expect(screen.getByRole('button', { name: '覆盖保存' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy()
  })

  it('覆盖保存：force=true 显式跳过基线检查，成功后冲突条消失', async () => {
    let writeCalls = 0
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') {
        writeCalls += 1
        return writeCalls === 1
          ? Promise.reject(new Error('conflict: 磁盘文件已被外部修改，保存已拒绝'))
          : Promise.resolve(readTextResult('const x = 2'))
      }
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    editAndType()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/磁盘文件已被外部修改/)
    fireEvent.click(screen.getByRole('button', { name: '覆盖保存' }))
    await screen.findByText('已保存')
    const writeCallsLog = invoke.mock.calls.filter(([cmd]) => cmd === 'write_workspace_text')
    expect(writeCallsLog[writeCallsLog.length - 1]).toEqual(['write_workspace_text', {
      source: 'ws-a',
      relativePath: 'src/a.ts',
      content: 'const x = 2',
      expectedBaseline: null,
      force: true,
    }])
    await waitFor(() => expect(screen.queryByText(/磁盘文件已被外部修改/)).toBeNull())
  })

  it('重新加载：丢弃本地编辑，重拉磁盘内容并退出编辑', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') return Promise.reject(new Error('conflict: 磁盘文件已被外部修改，保存已拒绝'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    editAndType()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/磁盘文件已被外部修改/)
    const readsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'read_workspace_text').length
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'read_workspace_text').length).toBeGreaterThan(readsBefore))
    await waitFor(() => expect(document.querySelector('.file-edit-textarea')).toBeNull())
    expect(screen.getByText('const x = 1')).toBeTruthy()
    expect(screen.queryByText(/磁盘文件已被外部修改/)).toBeNull()
  })

  it('working-diff：编辑中显示未保存统计 + 变更预览面板（additions/deletions）', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    editAndType()
    await screen.findByText(/未保存/)
    expect(screen.getByText('+1 −1 未保存')).toBeTruthy()
    expect(screen.getByText('变更预览')).toBeTruthy()
    expect(screen.getByText('1 additions · 1 deletions')).toBeTruthy()
    const textarea = document.querySelector('.file-edit-textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('const x = 2')
  })

  it('tab 切换重置编辑瞬态（退出编辑、dirty 清除、保存态归 idle）', async () => {
    const { rerender } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    editAndType()
    await screen.findByText(/未保存/)
    rerender(<FileViewHost source="ws-a" tab={otherTab} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.file-edit-textarea')).toBeNull())
    await screen.findByText('const x = 1')
    expect(screen.queryByText(/未保存/)).toBeNull()
    expect(screen.queryByText('已保存')).toBeNull()
  })
})
