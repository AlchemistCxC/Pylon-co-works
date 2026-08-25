// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import FileTabView from '../FileTabView'
import { resetStores } from '../../../test/resetStores'

const { invoke, highlightCode } = vi.hoisted(() => ({ invoke: vi.fn(), highlightCode: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../../components/chat/codeHighlight', () => ({ highlightCode }))

function readTextResult(content: string) {
  return { relativePath: 'src/a.ts', content, bytesRead: content.length, totalBytes: content.length, truncated: false }
}

describe('FileTabView 只读代码反馈缝', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    highlightCode.mockReset()
    invoke.mockResolvedValue(readTextResult('const x = 1\nconsole.log(x)\n'))
  })

  it('高亮器返回 null 时仍保留逐行代码与完整行号 gutter', async () => {
    highlightCode.mockResolvedValue(null)
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)

    await screen.findByText('console.log(x)')
    const code = document.querySelector('.file-tab-code')
    expect(code?.getAttribute('data-highlighted')).toBe('false')
    expect(document.querySelectorAll('.file-tab-gutter-line')).toHaveLength(3)
    expect([...document.querySelectorAll('.file-tab-line')].map(line => line.textContent)).toEqual([
      'const x = 1',
      'console.log(x)',
      '',
    ])
  })

  it('高亮器抛错时安全降级且不丢行号；成功时继续消费安全 HTML', async () => {
    highlightCode.mockRejectedValueOnce(new Error('worker unavailable'))
    const { unmount } = render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)
    await screen.findByText('console.log(x)')
    expect(document.querySelectorAll('.file-tab-gutter-line')).toHaveLength(3)
    unmount()

    highlightCode.mockResolvedValueOnce('<span class="pl-k">const</span> x = 1\nconsole.log(x)\n')
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.file-tab-code')?.getAttribute('data-highlighted')).toBe('true'))
    expect(document.querySelector('.pl-k')?.textContent).toBe('const')
    expect(document.querySelectorAll('.file-tab-gutter-line')).toHaveLength(3)
  })

  it('文件 provider 返回损坏响应时显示可诊断错误，不永久停在空白视图', async () => {
    invoke.mockResolvedValue({ invalid: true })
    render(<FileTabView source="ws-a" path="src/a.ts" onTruncated={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('文件读取响应异常')
    expect(document.querySelector('.file-tab-code')).toBeNull()
  })
})
