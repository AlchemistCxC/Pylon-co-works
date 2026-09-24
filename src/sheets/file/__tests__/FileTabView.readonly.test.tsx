// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import FileTabView from '../FileTabView'
import { resetStores } from '../../../test/resetStores'
import { fileEditorEditable, waitForFileEditor } from './codeMirrorTestUtils.ts'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(invoke)
})

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

// 0-A1 内核合一后「只读」= 常驻 CodeMirror 内核的 editable=false 档：文档内容、
// 行号 gutter（CM 自带）与程序化外部刷新仍可用，可编辑面关闭。
describe('FileTabView 只读恒内核（0-A1）', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockResolvedValue(readTextResult('const x = 1\nconsole.log(x)\n'))
  })

  it('只读模式由 CodeMirror 内核承载内容（editable=false，gutter 在）', async () => {
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)

    await waitForFileEditor('const x = 1\nconsole.log(x)\n')
    expect(fileEditorEditable()).toBe(false)
    expect(document.querySelector('.cm-gutters')).not.toBeNull()
  })

  it('文件 provider 返回损坏响应时转入中央错误中心，不永久停在空白视图', async () => {
    invoke.mockResolvedValue({ invalid: true })
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)

    expect(await screen.findByRole('status')).toHaveTextContent('文件读取失败')
    expect(document.querySelector('.file-code-editor')).toBeNull()
  })

  it('markdown 文件同样走源码内核（默认源码态；渲染态切换归阶段一）', async () => {
    invoke.mockResolvedValue(readTextResult('# Title\n'))
    render(<FileTabView source="ws-a" path="src/b.md" onTruncated={vi.fn()} />)

    await waitForFileEditor('# Title\n')
    expect(fileEditorEditable()).toBe(false)
  })
})
