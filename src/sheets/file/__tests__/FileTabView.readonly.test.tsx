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

// 0-A2 默认可写：FileTabView 缺省即内核可编辑档；只读仅物理例外（writable=false）。
// 文档内容、行号 gutter（CM 自带）与程序化外部刷新恒可用。
describe('FileTabView 内核承载（0-A2）', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockResolvedValue(readTextResult('const x = 1\nconsole.log(x)\n'))
  })

  it('默认可写：CodeMirror 内核承载内容（editable=true，gutter 在）', async () => {
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)

    await waitForFileEditor('const x = 1' + String.fromCharCode(10) + 'console.log(x)' + String.fromCharCode(10))
    expect(fileEditorEditable()).toBe(true)
    expect(document.querySelector('.cm-gutters')).not.toBeNull()
  })

  it('文件 provider 返回损坏响应时转入中央错误中心，不永久停在空白视图', async () => {
    invoke.mockResolvedValue({ invalid: true })
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)

    // #279 登记改写：Solid 桥下 loading 态（同为 role=status）先于错误微任务落 DOM，
    // findByRole 首轮轮询会捕获瞬态 loading——改 waitFor 轮询至错误态呈现，断言语义不变。
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('文件读取失败'))
    expect(document.querySelector('.file-code-editor')).toBeNull()
  })

  it('writable=false（物理例外）→ 内核只读档', async () => {
    render(<FileTabView source="ws-a" path="src/a.ts" writable={false} onTruncated={vi.fn()} />)

    await waitForFileEditor('const x = 1' + String.fromCharCode(10) + 'console.log(x)' + String.fromCharCode(10))
    expect(fileEditorEditable()).toBe(false)
  })

  it('markdown 文件同样走源码内核（默认源码态；渲染态切换归阶段一）', async () => {
    invoke.mockResolvedValue(readTextResult('# Title' + String.fromCharCode(10)))
    render(<FileTabView source="ws-a" path="src/b.md" onTruncated={vi.fn()} />)

    await waitForFileEditor('# Title' + String.fromCharCode(10))
    expect(fileEditorEditable()).toBe(true)
  })
})
