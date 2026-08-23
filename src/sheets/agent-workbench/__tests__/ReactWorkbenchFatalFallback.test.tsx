// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  it('keeps canonical C14 usage/config/commands/assist visible after Solid failure', () => {
    const base = document(15, '')
    const current: WorkbenchDocument = {
      ...base,
      session: {
        ...base.session,
        usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.01, currency: 'USD', budget: { used: 9, limit: 10, remaining: 1, exhausted: false } },
        options: [{ id: 'model', label: 'Model', value: 'gpt-5', valueType: 'select', editable: true, version: 2 }],
        commands: [{ id: 'review', name: '/review', description: '审查改动', availability: true }],
      },
      assist: { prediction: { placeholder: '继续审计', actions: [] }, files: ['src/a.ts'], queuedCommand: '/compact' },
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'solid failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()} />)
    expect(screen.getByLabelText('C14 用量 fallback')).toHaveTextContent('input 20')
    expect(screen.getByLabelText('C14 用量 fallback')).toHaveTextContent('0.01 USD')
    expect(screen.getByLabelText('C14 预算 fallback')).toHaveTextContent('remaining 1')
    expect(screen.getByLabelText('C14 配置 fallback')).toHaveTextContent('Model')
    expect(screen.getByLabelText('C14 配置 fallback')).toHaveTextContent('gpt-5')
    expect(screen.getByLabelText('C14 命令 fallback')).toHaveTextContent('/review')
    expect(screen.getByLabelText('C14 输入辅助 fallback')).toHaveTextContent('继续审计')
    expect(screen.getByLabelText('C14 输入辅助 fallback')).toHaveTextContent('src/a.ts')
  })

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

  it('keeps C04 canonical tool lifecycle readable when the Solid Suite fails', () => {
    const current: WorkbenchDocument = {
      ...document(7, ''),
      activities: [{
        id: 'tool-fallback', kind: 'tool', title: 'ProviderRead', displayName: '读取文件',
        canonicalName: 'read_file', providerName: 'ProviderRead', semanticKind: 'tool.read',
        status: 'failed', input: { path: '/workspace/a.ts' }, progress: { completed: 1, total: 2 },
        parts: [{ kind: 'text', text: 'partial body' }],
        error: { userSummary: 'permission denied', technicalMessage: 'EACCES /workspace/a.ts', code: 'EACCES', recoverability: 'none' },
        durationMs: 950,
        orphan: false, sequence: 7,
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
      failure={{ suiteId: 'builtin.solid', phase: 'slot', message: 'tool slot failed' }}
      onRetry={vi.fn()}
      onSelectSuite={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />)

    const card = screen.getByRole('status', { name: '工具 fallback：读取文件，失败' })
    expect(card).toHaveTextContent('ProviderRead')
    expect(card).toHaveTextContent('/workspace/a.ts')
    expect(card).toHaveTextContent('1 / 2')
    expect(card).toHaveTextContent('partial body')
    expect(card).toHaveTextContent('permission denied')
    expect(card).toHaveTextContent('EACCES')
    expect(card).toHaveTextContent('950ms')
    expect(container.textContent).not.toContain('undefined')
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

  it('keeps pending normalized interactions actionable when the Solid Suite fails', () => {
    const current: WorkbenchDocument = {
      ...document(8, ''),
      interactions: [{
        id: 'fallback-approval', status: 'requested', sequence: 8,
        request: {
          surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'request-8', sessionId: 'session', clientGeneration: 2 },
          questions: [{ id: 'approval', question: '允许 fallback 修改？', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow_once', label: '仅本次允许' }, { id: 'reject_once', label: '拒绝' }] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    const onRespondInteraction = vi.fn()
    render(<ReactWorkbenchFatalFallback
      document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onRespondInteraction={onRespondInteraction}
    />)

    expect(screen.getByText('允许 fallback 修改？')).toBeInTheDocument()
    screen.getByRole('button', { name: '仅本次允许' }).click()
    expect(onRespondInteraction).toHaveBeenCalledWith(
      'fallback-approval', { optionId: 'allow_once' }, { expectedRevision: 8 },
    )
  })

  it('shows normalized danger context in the React fallback before action', () => {
    const current: WorkbenchDocument = {
      ...document(13, ''), interactions: [{
        id: 'fallback-danger', status: 'requested', sequence: 13,
        request: { surface: 'interaction', kind: 'permission', state: 'waiting',
          reason: '需要修改构建产物', scope: 'workspace', command: 'rm -rf dist', path: '/workspace/dist',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'request-13', sessionId: 'session', clientGeneration: 2 },
          questions: [{ id: 'approval', question: '允许？', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow', label: '允许' }] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()} />)
    const fallback = screen.getByRole('region', { name: '交互 fallback' })
    expect(fallback).toHaveTextContent('需要修改构建产物')
    expect(fallback).toHaveTextContent('workspace')
    expect(fallback).toHaveTextContent('rm -rf dist')
    expect(fallback).toHaveTextContent('/workspace/dist')
  })

  it('submits multi-question, multi-select, and free-text answers as one fallback response', () => {
    const current: WorkbenchDocument = {
      ...document(9, ''),
      interactions: [{
        id: 'fallback-questions', status: 'requested', sequence: 9,
        request: {
          surface: 'interaction', kind: 'questions', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'request-9', sessionId: 'session', clientGeneration: 2 },
          questions: [
            { id: 'mode', question: '运行模式？', allowMultiple: false, allowFreeform: false,
              options: [{ id: 'safe', label: '安全' }, { id: 'fast', label: '快速' }] },
            { id: 'scope', question: '影响范围？', allowMultiple: true, allowFreeform: true,
              options: [{ id: 'repo', label: '仓库' }, { id: 'docs', label: '文档' }], placeholder: '补充范围' },
          ],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    const onRespondInteraction = vi.fn()
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onRespondInteraction={onRespondInteraction} />)

    fireEvent.click(screen.getByRole('radio', { name: '安全' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '仓库' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '文档' }))
    fireEvent.input(screen.getByPlaceholderText('补充范围'), { target: { value: '配置文件' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    expect(onRespondInteraction).toHaveBeenCalledWith('fallback-questions', {
      values: { mode: 'safe', scope: ['repo', 'docs', '配置文件'] },
    }, { expectedRevision: 9 })
  })

  it('keeps fallback input and allows retry after an interaction command failure', async () => {
    const current: WorkbenchDocument = {
      ...document(10, ''), interactions: [{
        id: 'fallback-freeform', status: 'requested', sequence: 10,
        request: { surface: 'interaction', kind: 'questions', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'request-10', sessionId: 'session', clientGeneration: 2 },
          questions: [{ id: 'answer', question: '补充说明？', allowMultiple: false, allowFreeform: true, options: [] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    const onRespondInteraction = vi.fn()
      .mockRejectedValueOnce(new Error('host rejected'))
      .mockResolvedValueOnce(undefined)
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onRespondInteraction={onRespondInteraction} />)

    const input = screen.getByPlaceholderText('补充回答')
    fireEvent.input(input, { target: { value: '保留我的回答' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    expect(await screen.findByRole('alert', { name: '交互提交失败' })).toHaveTextContent('host rejected')
    expect(input).toHaveValue('保留我的回答')

    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await waitFor(() => expect(onRespondInteraction).toHaveBeenCalledTimes(2))
  })

  it('ignores a second fallback submit while the interaction command is pending', () => {
    const current: WorkbenchDocument = {
      ...document(11, ''), interactions: [{
        id: 'fallback-double', status: 'requested', sequence: 11,
        request: { surface: 'interaction', kind: 'approval', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'request-11', sessionId: 'session', clientGeneration: 2 },
          questions: [{ id: 'approval', question: '允许？', allowMultiple: false, allowFreeform: false,
            options: [{ id: 'allow', label: '允许' }] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    const onRespondInteraction = vi.fn(() => new Promise<void>(() => {}))
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onRespondInteraction={onRespondInteraction} />)

    const allow = screen.getByRole('button', { name: '允许' })
    fireEvent.click(allow)
    fireEvent.click(allow)
    expect(onRespondInteraction).toHaveBeenCalledTimes(1)
    expect(allow).toBeDisabled()
  })

  it('keeps malformed fallback questions visible without crashing on a missing question id', () => {
    const current: WorkbenchDocument = {
      ...document(12, ''), interactions: [{
        id: 'fallback-malformed', status: 'requested', sequence: 12,
        request: { surface: 'interaction', kind: 'questions', state: 'waiting',
          identity: { provider: null, agentId: null, requestId: null, sessionId: null, toolCallId: null, clientGeneration: null },
          questions: [{ question: '仍需可见', allowMultiple: false, allowFreeform: true, options: [] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    expect(() => render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()} />)).not.toThrow()
    expect(screen.getAllByText('仍需可见').length).toBeGreaterThan(0)
  })

  it('keeps secret fallback input password-only and clears it even when submit fails', async () => {
    const credential = 'c12-fallback-secret'
    const current: WorkbenchDocument = {
      ...document(13, ''), interactions: [{
        id: 'fallback-secret', status: 'requested', sequence: 13,
        request: {
          surface: 'interaction', kind: 'secret', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'secret-13', sessionId: 'session', toolCallId: null, clientGeneration: 2 },
          questions: [{ id: 'secret', question: '输入凭据', allowMultiple: false, allowFreeform: true, options: [] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onRespondInteraction={vi.fn().mockRejectedValue(new Error('host rejected'))} />)

    const input = screen.getByPlaceholderText('输入凭据') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('off')
    fireEvent.input(input, { target: { value: credential } })
    fireEvent.click(screen.getByRole('button', { name: '提交凭据' }))
    expect(input).toHaveValue('')
    expect(await screen.findByRole('alert', { name: '交互提交失败' })).toHaveTextContent('凭据提交失败，请重试')
    expect(window.document.body.textContent).not.toContain(credential)
  })

  it('routes fallback OAuth open/copy through Host-provided actions and hides rejected URLs', () => {
    const current: WorkbenchDocument = {
      ...document(14, ''), interactions: [{
        id: 'fallback-oauth', status: 'requested', sequence: 14,
        request: {
          surface: 'interaction', kind: 'oauth', state: 'waiting',
          identity: { provider: 'peri', agentId: 'agent', requestId: 'oauth-14', sessionId: 'session', toolCallId: null, clientGeneration: 2 },
          url: 'https://example.com/oauth', stateSummary: '等待授权',
          questions: [{ id: 'oauth', question: '连接账号', allowMultiple: false, allowFreeform: false, options: [] }],
        },
      }],
    }
    const reader: WorkbenchDocumentReader = {
      getSnapshot: () => current, subscribe: () => () => {},
      getSlice: () => undefined as never, subscribeSlice: () => () => {},
    }
    const onOpenInteractionUrl = vi.fn()
    const onCopyInteractionUrl = vi.fn()
    render(<ReactWorkbenchFatalFallback document={reader}
      failure={{ suiteId: 'builtin.solid', phase: 'mount', message: 'interaction slot failed' }}
      onRetry={vi.fn()} onSelectSuite={vi.fn()} onOpenDiagnostics={vi.fn()}
      onOpenInteractionUrl={onOpenInteractionUrl} onCopyInteractionUrl={onCopyInteractionUrl} />)
    fireEvent.click(screen.getByRole('button', { name: '打开授权页' }))
    fireEvent.click(screen.getByRole('button', { name: '复制授权链接' }))
    expect(onOpenInteractionUrl).toHaveBeenCalledWith('https://example.com/oauth')
    expect(onCopyInteractionUrl).toHaveBeenCalledWith('https://example.com/oauth')
    expect(screen.getByText('等待授权')).toBeTruthy()
  })
})
