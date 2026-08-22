// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchDocument, type WorkbenchDocument } from '../../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchDocumentReader } from '../../../renderers/solid-workbench/workbenchHostPort.ts'
import ReactWorkbenchFatalFallback from '../ReactWorkbenchFatalFallback.tsx'

function document(revision: number, text: string): WorkbenchDocument {
  const empty = createWorkbenchDocument('local:a')
  return {
    ...empty,
    revision,
    messages: [{
      id: `message-${revision}`, role: 'assistant', content: text, parts: [], identity: {},
      source: { provider: 'peri', sourceId: `source-${revision}` }, sequence: revision,
      running: false, time: '2026-08-22T00:00:00.000Z',
    }],
  }
}

describe('React Workbench fatal fallback', () => {
  it('直接订阅同一 document revision，不创建 replay/message store', () => {
    let current = document(1, 'before failure')
    const listeners = new Set<() => void>()
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      getSlice: () => undefined as never,
      subscribeSlice: (_slice, listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'solid failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)
    expect(screen.getByRole('alert')).toHaveAttribute('data-document-revision', '1')
    expect(screen.getByText('before failure')).toBeInTheDocument()

    act(() => {
      current = document(2, 'after failure')
      for (const listener of listeners) listener()
    })
    expect(screen.getByRole('alert')).toHaveAttribute('data-document-revision', '2')
    expect(screen.getByText('after failure')).toBeInTheDocument()
  })

  it('keeps canonical C02 file, document, and resource parts visible without exposing binary raw', () => {
    const current: WorkbenchDocument = {
      ...document(3, ''),
      messages: [{
        ...document(3, '').messages[0]!,
        parts: [
          { kind: 'file-reference', path: 'C:\\work\\report.md', displayName: 'report.md' },
          { kind: 'file-selection', path: '/workspace/main.ts', selection: { start: { line: 4, column: 2 }, end: { line: 7 } }, language: 'ts', previewText: 'selected fallback text' },
          { kind: 'document', title: 'inline-spec.md', text: 'safe inline body', mimeType: 'text/markdown' },
          { kind: 'resource', uri: 'file:///docs/private.pdf', mimeType: 'application/pdf', hasBlob: true },
        ],
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    const { container } = render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'content slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)

    expect(screen.getByText('report.md')).toBeInTheDocument()
    expect(screen.getByText('C:\\work\\report.md')).toBeInTheDocument()
    expect(screen.getByText('L4:2–L7')).toBeInTheDocument()
    expect(screen.getByText('selected fallback text')).toBeInTheDocument()
    expect(screen.getByText('inline-spec.md')).toBeInTheDocument()
    expect(screen.getByText('safe inline body')).toBeInTheDocument()
    expect(screen.getByText('file:///docs/private.pdf')).toBeInTheDocument()
    expect(screen.getByText('二进制内容不内联展示')).toBeInTheDocument()
    expect(container.textContent).not.toContain('JVBERi0xLjQK')
    expect(container.querySelectorAll('[data-react-content-kind]')).toHaveLength(4)
  })

  it('keeps C03 media identity and command-gated actions visible without loading unsafe sources', () => {
    const current: WorkbenchDocument = {
      ...document(4, ''),
      messages: [{
        ...document(4, '').messages[0]!,
        parts: [
          {
            kind: 'image', source: 'https://cdn.example.com/architecture.png', mimeType: 'image/png',
            alt: '架构图', caption: '系统拓扑', width: 1280, height: 720,
          },
          {
            kind: 'audio', source: 'C:\\media\\voice.wav', sourceKind: 'path', mimeType: 'audio/wav',
            alt: '语音回复', durationMs: 12_300, transcript: '独立转写',
          },
          {
            kind: 'video', source: 'javascript:alert(1)', sourceKind: 'url', mimeType: 'video/mp4',
            alt: '危险视频',
          },
        ],
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    const onOpenMedia = vi.fn()
    const onDownloadMedia = vi.fn()
    const { container } = render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'media slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
      onOpenMedia={onOpenMedia}
      onDownloadMedia={onDownloadMedia}
    />)

    expect(screen.getByText('图片')).toBeInTheDocument()
    expect(screen.getByText('架构图')).toBeInTheDocument()
    expect(screen.getByText('系统拓扑')).toBeInTheDocument()
    expect(screen.getByText('1280×720 · image/png')).toBeInTheDocument()
    expect(screen.getByText('C:\\media\\voice.wav')).toBeInTheDocument()
    expect(screen.getByText('独立转写')).toBeInTheDocument()
    expect(screen.getByText('媒体来源不可用')).toBeInTheDocument()
    expect(container.querySelector('[src="javascript:alert(1)"]')).toBeNull()

    screen.getByRole('button', { name: '打开媒体：架构图' }).click()
    screen.getByRole('button', { name: '下载媒体：架构图' }).click()
    expect(onOpenMedia).toHaveBeenCalledWith(current.messages[0]!.parts[0])
    expect(onDownloadMedia).toHaveBeenCalledWith(current.messages[0]!.parts[0])
    expect(screen.getByRole('button', { name: '打开媒体：危险视频' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '下载媒体：危险视频' })).toBeDisabled()
  })

  it('keeps canonical C08 plan and goal readable when the Solid Suite fails', () => {
    const current: WorkbenchDocument = {
      ...document(5, ''),
      plan: {
        sessionId: 'local:a', revision: 1,
        entries: [
          { id: 'cancelled', content: '[cancelled] 用户原文', status: 'cancelled' },
          { id: 'blocked', content: '等待依赖', status: 'blocked', blockedReason: 'C07 未完成' },
          { id: 'unknown', content: '供应商状态', status: 'unknown', rawStatus: 'paused-by-provider' },
        ],
      },
      goal: {
        current: {
          goalId: 'goal-1', objective: '闭环 C08', status: 'blocked', tokenBudget: 1000, tokensUsed: 250,
          blockedReason: '等待依赖', accounting: { tokensUsed: 250, timeUsedSeconds: 45, metadata: { cost: 0.3 } },
        },
      },
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'plan slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)

    const plan = screen.getByRole('region', { name: '计划 fallback' })
    expect(plan).toHaveTextContent('[cancelled] [cancelled] 用户原文')
    expect(plan).toHaveTextContent('[blocked] 等待依赖 — C07 未完成')
    expect(plan).toHaveTextContent('[unknown (paused-by-provider)] 供应商状态')
    expect(screen.getByRole('status', { name: '目标 fallback' })).toHaveTextContent('[blocked] 闭环 C08 — 预算 25%（250/1000） — 等待依赖')
    expect(screen.getByText('耗时 45 秒')).toBeInTheDocument()
  })

  it('keeps C13 lifecycle history and structured recovery actions readable when the Suite fails', () => {
    const current: WorkbenchDocument = {
      ...document(6, ''),
      lifecycle: {
        retry: {
          attempt: 2, maxAttempts: 3, delayMs: 4000,
          error: { userSummary: 'Provider 过载', technicalMessage: '429 overloaded', recoverability: 'retry' },
        },
        history: [
          { kind: 'retry', attempt: 1, maxAttempts: 3, error: { userSummary: '第一次失败', recoverability: 'retry' } },
          { kind: 'retry', attempt: 2, maxAttempts: 3, error: { userSummary: 'Provider 过载', recoverability: 'retry' } },
        ],
      },
      systemErrors: [
        { userSummary: '可重试错误', technicalMessage: 'retry detail', code: 'retryable', recoverability: 'retry' },
        { userSummary: '插件错误', technicalMessage: 'plugin detail', pluginId: 'plugin.example', recoverability: 'reload-plugin' },
        { userSummary: '文案里写了重试但不可执行', technicalMessage: 'no action', recoverability: 'none' },
      ],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current,
      subscribe: () => () => {},
      getSlice: () => undefined as never,
      subscribeSlice: () => () => {},
    }
    const onRetryMessage = vi.fn()
    const onRecoverSession = vi.fn()
    const { container } = render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'lifecycle slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
      onRetryMessage={onRetryMessage}
      onRecoverSession={onRecoverSession}
    />)

    expect(screen.getByRole('region', { name: '生命周期 fallback' })).toHaveTextContent('[retry] 第 2/3 次重试')
    expect(screen.getByText('[retry] 第 1/3 次重试 — 第一次失败')).toBeInTheDocument()
    expect(screen.getByRole('alert', { name: '系统错误 fallback：插件错误' })).toHaveTextContent('plugin detail')
    expect(container.querySelectorAll('details.react-workbench-error-technical[open]')).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: '重试错误' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '重新加载插件' })).toHaveLength(1)

    screen.getByRole('button', { name: '重试错误' }).click()
    screen.getByRole('button', { name: '重新加载插件' }).click()
    expect(onRetryMessage).toHaveBeenCalledOnce()
    expect(onRecoverSession).toHaveBeenCalledWith('reload-plugin')
  })
})
