// @vitest-environment jsdom
import { createSignal } from 'solid-js'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../../../../components/chat/messageTypes.ts'
import type { WorkbenchAppearanceSnapshot } from '../../../../domains/workbench/appearance.ts'
import { SolidDiffCard } from '../DiffCard.solid.tsx'
import { SolidTaskTree } from '../TaskTree.solid.tsx'
import { SolidToolCard } from '../ToolCard.solid.tsx'

const TOOL_APPEARANCE: Pick<WorkbenchAppearanceSnapshot,
  'toolIndicator' | 'toolIndicatorGlow' | 'toolIndicatorGlowColor'> = {
  toolIndicator: 'diamond',
  toolIndicatorGlow: 4,
  toolIndicatorGlowColor: '#abcdef',
}

afterEach(() => cleanup())

describe('SolidToolCard', () => {
  it('渲染 running/completed/error 状态 contract', () => {
    const running = render(() => <SolidToolCard
      message={toolMessage({ id: 'run', toolStatus: 'in_progress', running: true })}
      appearance={TOOL_APPEARANCE}
    />)
    expect(running.container.querySelector('.term-tool')?.getAttribute('data-status')).toBe('run')
    expect(running.container.querySelector('.term-tool')?.getAttribute('data-tool-state')).toBe('running')
    expect(running.getByRole('img').textContent).toBe('◆')
    running.unmount()

    const completed = render(() => <SolidToolCard
      message={toolMessage({ id: 'ok', toolStatus: 'completed', toolOutput: 'done', toolOutputLines: 1 })}
      appearance={TOOL_APPEARANCE}
    />)
    expect(completed.container.querySelector('.term-tool')?.getAttribute('data-status')).toBe('ok')
    expect(completed.container.textContent).toContain('1 lines')
    completed.unmount()

    const failed = render(() => <SolidToolCard
      message={toolMessage({ id: 'err', toolStatus: 'failed', toolOutput: 'permission denied' })}
      appearance={TOOL_APPEARANCE}
    />)
    expect(failed.container.querySelector('.term-tool')?.getAttribute('data-status')).toBe('err')
    expect(failed.container.querySelector('.term-tool')?.getAttribute('data-tool-state')).toBe('failed')
  })

  it('普通工具摘要继承消息字体，路径摘要才使用代码字体', () => {
    const result = render(() => <>
      <SolidToolCard
        message={toolMessage({ id: 'summary-read', toolName: 'Read', toolKind: 'read', toolInput: 'src/App.tsx' })}
        appearance={TOOL_APPEARANCE}
      />
      <SolidToolCard
        message={toolMessage({ id: 'summary-note', toolName: 'Notice', toolKind: 'other', toolInput: 'ordinary English summary' })}
        appearance={TOOL_APPEARANCE}
      />
    </>)
    const summaries = [...result.container.querySelectorAll('.term-tool-summary')]
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toHaveClass('term-tool-summary-code')
    expect(summaries[1]).not.toHaveClass('term-tool-summary-code')
  })

  it('展开 execute 输出时复用结构化 ANSI block 并安全渲染', async () => {
    const result = render(() => <SolidToolCard
      message={toolMessage({
        id: 'ansi', toolKind: 'execute', toolStatus: 'completed',
        toolOutput: '\u001b[32mPASS\u001b[0m build <script>bad</script>', toolOutputLines: 1,
      })}
      appearance={TOOL_APPEARANCE}
    />)

    await fireEvent.click(result.getByRole('button'))
    expect(result.container.querySelector('.term-ansi-block')).not.toBeNull()
    expect(result.container.querySelector('.term-ansi-block')?.textContent).toContain('PASS build')
    expect(result.container.querySelector('.term-ansi-block script')).toBeNull()
    expect(result.container.querySelector('.term-ansi-block')?.textContent).toContain('<script>bad</script>')
  })

  it('edit tool 复用结构化 diff payload', async () => {
    const result = render(() => <SolidToolCard
      message={toolMessage({
        id: 'diff', toolName: 'Edit', toolKind: 'edit', toolStatus: 'completed',
        toolOutput: '- ReactWorkbench\n+ SolidWorkbench',
        contentBlocks: [{ type: 'tool_diff_content', title: 'AgentSheetView.tsx', oldText: 'ReactWorkbench\n', newText: 'SolidWorkbench\n' }],
      })}
      appearance={TOOL_APPEARANCE}
    />)
    await fireEvent.click(result.getByRole('button'))
    expect(result.container.querySelector('.term-diff-card')).not.toBeNull()
    expect(result.container.textContent).toContain('1 additions · 1 deletions')
  })
})

describe('SolidDiffCard', () => {
  it('相邻 removed/added 使用词级高亮，并可折叠', async () => {
    const result = render(() => <SolidDiffCard
      output={JSON.stringify({ oldText: 'const mode = "react"', newText: 'const mode = "solid"' })}
    />)
    expect(result.container.querySelector('.term-diff-word-removed')).not.toBeNull()
    expect(result.container.querySelector('.term-diff-word-added')).not.toBeNull()
    const button = result.getByRole('button', { name: /变更预览/ })
    await fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(result.container.querySelector('.term-collapse')).toHaveAttribute('data-open', 'false')
    expect(result.container.querySelector('.term-collapse')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('SolidTaskTree', () => {
  it('无 session/无任务不渲染；有任务时摘要和状态 glyph 正确', async () => {
    const empty = render(() => <SolidTaskTree sessionId={null} tasks={[]} />)
    expect(empty.container.querySelector('.task-tree')).toBeNull()
    empty.unmount()

    const result = render(() => <SolidTaskTree sessionId="session-1" tasks={[
      { content: '已完成', status: 'completed' },
      { content: '处理中', status: 'in_progress' },
      { content: '失败项', status: 'failed' },
    ]} />)
    expect(result.getByRole('button').textContent).toContain('3 任务 · 1 完成')
    expect(result.getByRole('progressbar', { name: '任务总体进度' })).toHaveAttribute('value', '1')
    expect(result.getByRole('progressbar', { name: '任务总体进度' })).toHaveAttribute('max', '3')
    expect(result.container.querySelector('.task-tree-summary-ratio')).toHaveTextContent('1/3')
    await fireEvent.click(result.getByRole('button'))
    expect(result.getByRole('list', { name: '任务列表' })).toBeTruthy()
    expect(result.container.querySelector('[data-status="completed"] .task-tree-status')?.textContent).toBe('✓')
    expect(result.container.querySelector('[data-status="in_progress"] .task-tree-status')?.textContent).toBe('◐')
    expect(result.container.querySelector('[data-status="failed"] .task-tree-status')?.textContent).toBe('✕')
    expect(result.container.querySelector('[data-status="in_progress"]')).toHaveAttribute('aria-current', 'step')
  })

  it('响应 pylon:tasks-toggle，并在 session 切换时收起', () => {
    const [sessionId, setSessionId] = createSignal('session-1')
    const result = render(() => <SolidTaskTree sessionId={sessionId()} tasks={[{ content: '任务', status: 'pending' }]} />)
    window.dispatchEvent(new Event('pylon:tasks-toggle'))
    expect(result.getByRole('button').getAttribute('aria-expanded')).toBe('true')

    setSessionId('session-2')
    expect(result.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})

function toolMessage(overrides: Partial<Message>): Message {
  return {
    id: 'tool',
    role: 'tool',
    sender: 'tool:Read',
    content: '',
    time: '10:00',
    toolName: 'Read',
    toolKind: 'read',
    toolInput: 'src/App.tsx',
    ...overrides,
  }
}
