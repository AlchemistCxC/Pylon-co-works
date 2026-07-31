import { strict as assert } from 'node:assert'
import {
  buildToolPresentationModel,
  TOOL_PRESENTATION_LIMITS,
  toolPresentationStatus,
  truncateToolSummary,
} from '../src/components/chat/toolPresentationModel.ts'

const base = {
  id: 'tool-abc',
  role: 'tool' as const,
  sender: 'tool:Read',
  content: '',
  time: '10:00',
  toolName: 'Read',
  toolInput: 'src/main.ts',
}

const running = buildToolPresentationModel({ ...base, running: true })
assert.equal(running.toolId, 'abc')
assert.equal(running.name, 'Read')
assert.equal(running.summary, 'src/main.ts')
assert.equal(running.state, 'running')
assert.equal(running.hasOutput, false)
assert.equal(running.canCollapseOutput, false)
assert.equal(toolPresentationStatus(running), 'run')

const completed = buildToolPresentationModel({
  ...base,
  toolOutput: 'line 1\nline 2',
  toolOutputLines: 2,
  toolStatus: 'completed',
}, 'completed')
assert.equal(completed.state, 'completed')
assert.equal(completed.outputLines, 2)
assert.equal(completed.hasOutput, true)
assert.equal(completed.isDiffCandidate, false)
assert.equal(completed.statusLabel, '已完成')
assert.equal(completed.outputLabel, '2 lines')
assert.equal(toolPresentationStatus(completed), 'ok')

const longOutput = Array.from({ length: TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1 }, (_, i) => `line ${i}`).join('\n')
const edit = buildToolPresentationModel({
  ...base,
  toolName: 'Edit',
  sender: 'tool:Edit',
  toolOutput: longOutput,
  toolStatus: 'success',
})
assert.equal(edit.state, 'completed')
assert.equal(edit.outputLines, TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1)
assert.equal(edit.canCollapseOutput, true)
assert.equal(edit.isDiffCandidate, true)
assert.equal(edit.statusLabel, '已完成')
assert.equal(edit.outputLabel, `${TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1} lines changed`)

const shortRead = buildToolPresentationModel({
  ...base,
  toolOutput: 'line 1\nline 2',
  toolOutputLines: 2,
})
assert.equal(shortRead.canCollapseOutput, false)
assert.equal(shortRead.outputLabel, '2 lines')

const failed = buildToolPresentationModel({
  ...base,
  toolName: 'Bash',
  sender: 'tool:Bash',
  toolStatus: 'failed',
  toolOutput: 'permission denied',
})
assert.equal(failed.state, 'failed')
assert.equal(failed.errorText, 'permission denied')
assert.equal(failed.statusLabel, '失败')
assert.equal(toolPresentationStatus(failed), 'err')

const fallback = buildToolPresentationModel({
  ...base,
  id: 'unexpected',
  toolName: undefined,
  sender: 'tool:FutureTool',
  toolInput: '',
  toolOutput: '',
  toolStatus: 'future-status',
})
assert.equal(fallback.toolId, null)
assert.equal(fallback.name, 'FutureTool')
assert.equal(fallback.state, 'unknown')
assert.equal(fallback.statusLabel, '状态未知')
assert.equal(fallback.outputLabel, '')
assert.equal(fallback.hasOutput, false)
assert.equal(toolPresentationStatus(fallback), 'run')

assert.equal(truncateToolSummary('short'), 'short')
assert.equal(truncateToolSummary('abcdefgh', 6), 'abcde…')
assert.equal(truncateToolSummary('中文摘要内容', 6), '中文…')
assert.equal(truncateToolSummary('✅完成状态', 5), '✅完…')

console.log('ToolPresentationModel 回归测试通过')
