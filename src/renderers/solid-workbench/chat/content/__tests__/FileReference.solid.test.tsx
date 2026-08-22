// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SolidFileReferenceCard } from '../FileReference.solid.tsx'
import type { ContentPart } from '../../../../../domains/workbench/content/contentPartSchema.ts'

/**
 * C02 RED：Solid 文件卡契约。
 *
 * 卡面要求：路径/范围/metadata 可见；动作经 capability gate——不可用 disabled + 原因；
 * 资源卡不渲染 blob；路径原样呈现。
 */

function card(part: ContentPart, actions?: Parameters<typeof SolidFileReferenceCard>[0]['actions']) {
  return render(() => <SolidFileReferenceCard part={part} actions={actions} />)
}

describe('C02 SolidFileReferenceCard', () => {
  it('shows file name and raw path without URI rewriting', () => {
    const result = card({ kind: 'file-reference', path: 'C:\\Users\\demo\\report.md', displayName: 'report.md' })
    expect(result.container.textContent).toContain('report.md')
    expect(result.container.textContent).toContain('C:\\Users\\demo\\report.md')
    // 不做 file:/// 猜测互转
    expect(result.container.textContent).not.toContain('file://')
  })

  it('shows selection range and language', () => {
    const result = card({
      kind: 'file-selection',
      path: '/workspace/src/main.ts',
      selection: { start: { line: 10, column: 4 }, end: { line: 24 } },
      language: 'ts',
    })
    expect(result.container.textContent).toContain('L10:4–L24')
    expect(result.container.textContent).toContain('ts')
  })

  it('disables actions with reasons when capabilities are missing', () => {
    const result = card({ kind: 'file-reference', path: '/a/b.txt' }, {})
    const buttons = result.container.querySelectorAll('button.term-file-action')
    expect(buttons.length).toBe(3)
    for (const button of buttons) {
      expect(button.hasAttribute('disabled')).toBe(true)
      expect(button.getAttribute('title')).toContain('未接入')
    }
  })

  it('invokes command port actions only when enabled', async () => {
    const open = vi.fn()
    const copyPath = vi.fn()
    const result = card(
      { kind: 'file-reference', path: '/a/b.txt' },
      { canOpen: true, canCopy: true, canReveal: false, open, copyPath },
    )
    const buttons = [...result.container.querySelectorAll('button.term-file-action')] as HTMLButtonElement[]
    const byLabel = (label: string) => buttons.find(button => button.textContent === label)!
    await byLabel('打开').click()
    expect(open).toHaveBeenCalled()
    await byLabel('复制路径').click()
    expect(copyPath).toHaveBeenCalledWith('/a/b.txt')
    // reveal 未启用——disabled 且点击无效
    const reveal = byLabel('定位')
    expect(reveal.hasAttribute('disabled')).toBe(true)
  })

  it('renders resource metadata without exposing blob content', () => {
    const result = card({
      kind: 'resource' as never,
      uri: 'file:///docs/spec.pdf',
      mimeType: 'application/pdf',
      hasBlob: true,
    } as ContentPart)
    expect(result.container.textContent).toContain('spec.pdf')
    expect(result.container.textContent).toContain('application/pdf')
    expect(result.container.textContent).toContain('二进制内容不内联展示')
    expect(result.container.textContent).not.toContain('JVBERi0xLjQK')
  })
})
