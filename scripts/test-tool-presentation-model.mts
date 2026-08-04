import { strict as assert } from 'node:assert'
import {
  buildToolPresentationModel,
  TOOL_PRESENTATION_LIMITS,
  truncateToolSummary,
} from '../src/components/chat/toolPresentationModel.ts'
import { toolStatePresentation } from '../src/domains/tool/status.ts'

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
assert.equal(toolStatePresentation(running.state, running.hasOutput).tone, 'run')

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
assert.equal(toolStatePresentation(completed.state, completed.hasOutput).tone, 'ok')

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
assert.equal(edit.isDiffCandidate, false, '普通多行文本不得判定为 diff candidate（需真实可解析 diff）')
assert.equal(edit.statusLabel, '已完成')
assert.equal(edit.outputLabel, `${TOOL_PRESENTATION_LIMITS.collapsibleOutputLineLimit + 1} lines changed`)

const diffEdit = buildToolPresentationModel({
  ...base,
  toolName: 'Edit',
  sender: 'tool:Edit',
  toolOutput: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
  toolStatus: 'success',
})
assert.equal(diffEdit.isDiffCandidate, true, '可解析 unified diff 必须判定为 diff candidate')

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
assert.equal(toolStatePresentation(failed.state, failed.hasOutput).tone, 'err')

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
assert.equal(toolStatePresentation(fallback.state, fallback.hasOutput).tone, 'run')

assert.equal(truncateToolSummary('short'), 'short')
assert.equal(truncateToolSummary('abcdefgh', 6), 'abcde…')
assert.equal(truncateToolSummary('中文摘要内容', 6), '中文…')
assert.equal(truncateToolSummary('✅完成状态', 5), '✅完…')

console.log('ToolPresentationModel 回归测试通过')
