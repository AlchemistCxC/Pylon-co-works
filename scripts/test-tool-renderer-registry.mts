import { strict as assert } from 'node:assert'
import { resolveToolRenderer, getToolSummary, TOOL_RENDERER_NAMES } from '../src/components/chat/toolPresentation.ts'
import { buildToolPresentationModel } from '../src/components/chat/toolPresentationModel.ts'
import type { Message } from '../src/components/chat/messageTypes.ts'

// ── 注册表覆盖与回退 ──
assert.equal(getToolSummary('Bash', { command: 'npm run build' }), 'npm run build')
assert.equal(getToolSummary('Read', { file_path: 'src/a.ts' }), 'src/a.ts')
assert.equal(getToolSummary('Edit', { filePath: 'src/b.ts' }), 'src/b.ts')
assert.equal(getToolSummary('Grep', { pattern: 'TODO' }), 'TODO')
assert.equal(getToolSummary('UnknownTool', { id: 1, note: 'hello world' }), 'hello world', '未知工具回退首个字符串字段')
assert.equal(getToolSummary('UnknownTool', 'plain input'), 'plain input', '字符串输入回退')
assert.deepEqual([...TOOL_RENDERER_NAMES].sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Task', 'Write'].sort())

// ── outputLabel 按工具注册 ──
const toolMessage = (name: string, output?: string): Message => ({
  id: 't1', role: 'tool', sender: `tool:${name}`, content: '', time: '12:00', toolName: name, toolOutput: output,
})
assert.equal(buildToolPresentationModel(toolMessage('Grep', 'a\nb')).outputLabel, '2 matches')
assert.equal(buildToolPresentationModel(toolMessage('Read', 'l1\nl2\nl3')).outputLabel, '3 lines')
assert.equal(buildToolPresentationModel(toolMessage('Bash', 'out')).outputLabel, '1 lines')
assert.equal(buildToolPresentationModel(toolMessage('Unknown', 'x')).outputLabel, '1 lines', '未注册工具回退通用行数')

// ── isDiffCandidate：Edit/Write 用真实 diff 解析判定 ──
const unified = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
assert.equal(buildToolPresentationModel(toolMessage('Edit', unified)).isDiffCandidate, true, '可解析 unified diff 必须判定')
assert.equal(buildToolPresentationModel(toolMessage('Write', 'plain text only')).isDiffCandidate, false, '非 diff 文本不得判定为 diff candidate')
assert.equal(buildToolPresentationModel(toolMessage('Bash', unified)).isDiffCandidate, false, '非 Edit/Write 工具即使含 diff 文本也不判定')

// ── 状态/摘要/输出保持既有语义 ──
const model = buildToolPresentationModel(toolMessage('Edit', unified), 'completed')
assert.equal(model.summary, '', 'summary 保持 inputText 语义')
assert.equal(model.statusLabel, '已完成')
assert.equal(model.outputText, unified)
assert.equal(model.hasOutput, true)

console.log('toolRenderer 注册表回归测试通过')
