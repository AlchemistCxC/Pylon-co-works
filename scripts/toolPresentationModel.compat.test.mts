import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import {
  buildToolPresentationModel,
  TOOL_PRESENTATION_LIMITS,
  truncateToolSummary,
} from '../src/components/chat/toolPresentationModel.ts'
import { toolStatePresentation } from '../src/domains/tool/status.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

const base = {
  id: 'tool-abc',
  role: 'tool' as const,
  sender: 'tool:Read',
  content: '',
  time: '10:00',
  toolName: 'Read',
  toolInput: 'src/main.ts',
}

describe('toolPresentationModel legacy compat', () => {
  it('running 模型：toolId/name/summary/state 与 run tone', () => {
    const running = buildToolPresentationModel({ ...base, running: true })
    expect(running.toolId).toBe('abc')
    expect(running.name).toBe('Read')
    expect(running.summary).toBe('src/main.ts')
    expect(running.state).toBe('running')
    expect(running.hasOutput).toBe(false)
    expect(running.canCollapseOutput).toBe(false)
    expect(toolStatePresentation(running.state, running.hasOutput).tone).toBe('run')
  })

  it('completed 模型：outputLines/hasOutput/statusLabel/outputLabel 与 ok tone', () => {
    const completed = buildToolPresentationModel({
      ...base,
      toolOutput: 'line 1\nline 2',
      toolOutputLines: 2,
      toolStatus: 'completed',
    }, 'completed')
    expect(completed.state).toBe('completed')
    expect(completed.outputLines).toBe(2)
    expect(completed.hasOutput).toBe(true)
    expect(completed.isDiffCandidate).toBe(false)
    expect(completed.statusLabel).toBe('已完成')
    expect(completed.outputLabel).toBe('2 lines')
    expect(toolStatePresentation(completed.state, completed.hasOutput).tone).toBe('ok')
  })

  it('多行输出折叠阈值与 diff candidate 判定', () => {
    const longOutput = Array.from({ length: TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1 }, (_, i) => `line ${i}`).join('\n')
    const edit = buildToolPresentationModel({
      ...base,
      toolName: 'Edit',
      sender: 'tool:Edit',
      toolOutput: longOutput,
      toolStatus: 'success',
    })
    expect(edit.state).toBe('completed')
    expect(edit.outputLines).toBe(TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1)
    expect(edit.canCollapseOutput).toBe(true)
    // 普通多行文本不得判定为 diff candidate（需真实可解析 diff）
    expect(edit.isDiffCandidate, '普通多行文本不得判定为 diff candidate（需真实可解析 diff）').toBe(false)
    expect(edit.statusLabel).toBe('已完成')
    expect(edit.outputLabel).toBe(`${TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1} lines changed`)

    const diffEdit = buildToolPresentationModel({
      ...base,
      toolName: 'Edit',
      sender: 'tool:Edit',
      toolOutput: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
      toolStatus: 'success',
    })
    // 可解析 unified diff 必须判定为 diff candidate
    expect(diffEdit.isDiffCandidate, '可解析 unified diff 必须判定为 diff candidate').toBe(true)

    const shortRead = buildToolPresentationModel({
      ...base,
      toolOutput: 'line 1\nline 2',
      toolOutputLines: 2,
    })
    expect(shortRead.canCollapseOutput).toBe(false)
    expect(shortRead.outputLabel).toBe('2 lines')
  })

  it('failed 模型：errorText/statusLabel 与 err tone', () => {
    const failed = buildToolPresentationModel({
      ...base,
      toolName: 'Bash',
      sender: 'tool:Bash',
      toolStatus: 'failed',
      toolOutput: 'permission denied',
    })
    expect(failed.state).toBe('failed')
    expect(failed.errorText).toBe('permission denied')
    expect(failed.statusLabel).toBe('失败')
    expect(toolStatePresentation(failed.state, failed.hasOutput).tone).toBe('err')
  })

  it('未知工具/状态 fallback：toolId 为 null、state unknown、run tone', () => {
    const fallback = buildToolPresentationModel({
      ...base,
      id: 'unexpected',
      toolName: undefined,
      sender: 'tool:FutureTool',
      toolInput: '',
      toolOutput: '',
      toolStatus: 'future-status',
    })
    expect(fallback.toolId).toBeNull()
    expect(fallback.name).toBe('FutureTool')
    expect(fallback.state).toBe('unknown')
    expect(fallback.statusLabel).toBe('状态未知')
    expect(fallback.outputLabel).toBe('')
    expect(fallback.hasOutput).toBe(false)
    expect(toolStatePresentation(fallback.state, fallback.hasOutput).tone).toBe('run')
  })

  it('truncateToolSummary：短文本直通、按长度与全角/emoji 截断', () => {
    expect(truncateToolSummary('short')).toBe('short')
    expect(truncateToolSummary('abcdefgh', 6)).toBe('abcde…')
    expect(truncateToolSummary('中文摘要内容', 6)).toBe('中文…')
    expect(truncateToolSummary('✅完成状态', 5)).toBe('✅完…')
  })
})
