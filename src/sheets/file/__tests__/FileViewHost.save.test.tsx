// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import FileViewHost from '../FileViewHost'
import type { FileTabRecord } from '../fileSheetState'
import { resetStores } from '../../../test/resetStores'
import { fileEditorView, replaceFileEditorValue, waitForFileEditor } from './codeMirrorTestUtils.ts'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function editAndType(value = 'const x = 2') {
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  const editor = await waitForFileEditor('const x = 1')
  replaceFileEditorValue(editor, value)
  return editor
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

  it('编辑开关：只读 → 点编辑 → CodeMirror + 保存按钮；truncated 时禁用编辑', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    await waitForFileEditor('const x = 1')
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
    await editAndType()
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

  it('CodeMirror 内 Ctrl/Cmd+S 复用保存按钮的基线校验事务', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    const editor = await editAndType()

    fireEvent.keyDown(editor.contentDOM, { key: 's', ctrlKey: true })

    await screen.findByText('已保存')
    expect(invoke).toHaveBeenCalledWith('write_workspace_text', expect.objectContaining({
      content: 'const x = 2',
      expectedBaseline: 'const x = 1',
      force: false,
    }))
  })

  it('保存冲突：外部修改 → 拒绝且保留 dirty（不静默覆盖），出覆盖/重新加载冲突条', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') return Promise.reject(new Error('conflict: 磁盘文件已被外部修改，保存已拒绝'))
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    await editAndType()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/磁盘文件已被外部修改/)
    expect(invoke).toHaveBeenCalledWith('write_workspace_text', expect.objectContaining({ force: false }))
    expect(fileEditorView().state.doc.toString()).toBe('const x = 2')
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
    await editAndType()
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
    await editAndType()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/磁盘文件已被外部修改/)
    const readsBefore = invoke.mock.calls.filter(([cmd]) => cmd === 'read_workspace_text').length
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'read_workspace_text').length).toBeGreaterThan(readsBefore))
    await waitFor(() => expect(document.querySelector('.file-code-editor')).toBeNull())
    expect(screen.getByText('const x = 1')).toBeTruthy()
    expect(screen.queryByText(/磁盘文件已被外部修改/)).toBeNull()
  })

  it('working-diff：编辑中显示未保存统计 + 变更预览面板（additions/deletions）', async () => {
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    await editAndType()
    await screen.findByText(/未保存/)
    expect(screen.getByText('+1 −1 未保存')).toBeTruthy()
    expect(screen.getByText('变更预览')).toBeTruthy()
    expect(screen.getByText('1 additions · 1 deletions')).toBeTruthy()
    expect(fileEditorView().state.doc.toString()).toBe('const x = 2')
  })

  it('保存响应损坏（normalize 为 null）→ 置 error 态并给通用文案，可重试（不卡 saving）', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') return Promise.resolve({ nope: true }) // 损坏 DTO → normalizeWorkspaceText 返回 null
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    await editAndType()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存响应异常，请重试')
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    expect(screen.queryByText('保存中…')).toBeNull()
  })

  it('tab 切换重置编辑瞬态（退出编辑、dirty 清除、保存态归 idle）', async () => {
    const { rerender } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    await editAndType()
    await screen.findByText(/未保存/)
    rerender(<FileViewHost source="ws-a" tab={otherTab} onCloseTab={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.file-code-editor')).toBeNull())
    await screen.findByText('const x = 1')
    expect(screen.queryByText(/未保存/)).toBeNull()
    expect(screen.queryByText('已保存')).toBeNull()
  })

  it('workspace identity 切换会立即退出旧 workspace 的编辑态，不等待新文件读取完成', async () => {
    const nextRead = deferred<ReturnType<typeof readTextResult>>()
    invoke.mockImplementation((cmd: string, args: { source?: string } | undefined) => {
      if (cmd === 'read_workspace_text' && args?.source === 'ws-a') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'read_workspace_text' && args?.source === 'ws-b') return nextRead.promise
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    const { rerender } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    await editAndType('unsaved from workspace a')

    rerender(<FileViewHost source="ws-b" tab={fileTab} onCloseTab={vi.fn()} />)

    await waitFor(() => expect(document.querySelector('.file-code-editor')).toBeNull())
    expect(screen.queryByText(/未保存/)).toBeNull()
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
  })

  it('旧 workspace 的迟到保存结果不能污染新 workspace 的保存状态', async () => {
    const write = deferred<ReturnType<typeof readTextResult>>()
    invoke.mockImplementation((cmd: string, args: { source?: string } | undefined) => {
      if (cmd === 'read_workspace_text') {
        return Promise.resolve(readTextResult(args?.source === 'ws-b' ? 'workspace b' : 'const x = 1'))
      }
      if (cmd === 'write_workspace_text') return write.promise
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    const { rerender } = render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    await editAndType('workspace a edit')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存中…')

    rerender(<FileViewHost source="ws-b" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('workspace b')
    await act(async () => { write.resolve(readTextResult('workspace a saved')); await write.promise })

    expect(screen.queryByText('已保存')).toBeNull()
    expect(screen.getByText('workspace b')).toBeTruthy()
  })

  it('保存进行中继续输入时，保存回执只推进磁盘基线且不覆盖后续编辑', async () => {
    const write = deferred<ReturnType<typeof readTextResult>>()
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_workspace_text') return Promise.resolve(readTextResult('const x = 1'))
      if (cmd === 'write_workspace_text') return write.promise
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
    render(<FileViewHost source="ws-a" tab={fileTab} onCloseTab={vi.fn()} />)
    await screen.findByText('const x = 1')
    const editor = await editAndType('const x = 2')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('保存中…')

    replaceFileEditorValue(editor, 'const x = 3')
    await act(async () => { write.resolve(readTextResult('const x = 2')); await write.promise })

    expect(editor.state.doc.toString()).toBe('const x = 3')
    expect(screen.getByText(/未保存/)).toBeTruthy()
    expect(screen.getByText('+1 −1 未保存')).toBeTruthy()
  })
})
