import { strict as assert } from 'node:assert'
import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { getToolSummary } from '../src/domains/tool/toolPresentation.ts'
import { resolveToolKind, buildToolRenderModel, TOOL_KINDS } from '../src/domains/tool/toolPresentation.ts'
import { buildToolPresentationModel } from '../src/components/chat/toolPresentationModel.ts'
import type { Message } from '../src/components/chat/messageTypes.ts'

// ── kind 归一（P1-10）：Peri PascalCase 与 Hermes snake_case 同一字典，不再按名字碰运气 ──
assert.equal(resolveToolKind('Bash'), 'execute')
assert.equal(resolveToolKind('Read'), 'read')
assert.equal(resolveToolKind('Edit'), 'edit')
assert.equal(resolveToolKind('Write'), 'edit')
assert.equal(resolveToolKind('Grep'), 'search')
assert.equal(resolveToolKind('Glob'), 'search')
assert.equal(resolveToolKind('Task'), 'other')
assert.equal(resolveToolKind('read_file'), 'read')
assert.equal(resolveToolKind('edit_file'), 'edit')
assert.equal(resolveToolKind('terminal'), 'execute')
assert.equal(resolveToolKind('bash'), 'execute', '大小写不敏感')
assert.equal(resolveToolKind('web_search'), 'fetch')
assert.equal(resolveToolKind('http_request'), 'fetch')
assert.equal(resolveToolKind('think'), 'think')
assert.equal(resolveToolKind('custom_tool'), 'other')
// 显式 toolKind 优先
assert.equal(resolveToolKind('Bash', 'read'), 'read')
assert.equal(resolveToolKind('whatever', 'weird'), 'other', '非法 toolKind 回退名字启发式')
assert.deepEqual([...TOOL_KINDS], ['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other'])

// ── 摘要：kind 字典提取 + title 直通回退（Hermes snake_case 不再落 FALLBACK） ──
assert.equal(getToolSummary('Bash', { command: 'npm run build' }), 'npm run build')
assert.equal(getToolSummary('terminal', { command: 'ls' }), 'ls', 'Hermes terminal 必须走 execute 字典')
assert.equal(getToolSummary('Read', { file_path: 'src/a.ts' }), 'src/a.ts')
assert.equal(getToolSummary('read_file', { file_path: 'src/a.ts' }), 'src/a.ts', 'Hermes read_file 必须走 read 字典')
assert.equal(getToolSummary('Edit', { filePath: 'src/b.ts' }), 'src/b.ts')
assert.equal(getToolSummary('Grep', { pattern: 'TODO' }), 'TODO')
assert.equal(getToolSummary('UnknownTool', { id: 1, note: 'hello world' }), 'hello world', 'other 回退首个字符串字段（文本启发式保留）')
assert.equal(getToolSummary('UnknownTool', 'plain input'), 'plain input')

// ── outputLabel / isDiffCandidate 按 kind ──
const toolMessage = (name: string, output?: string, contentBlocks?: Message['contentBlocks']): Message => ({
  id: 't1', role: 'tool', sender: `tool:${name}`, content: '', time: '12:00', toolName: name, toolOutput: output, contentBlocks,
})
assert.equal(buildToolPresentationModel(toolMessage('Grep', 'a\nb')).outputLabel, '2 matches')
assert.equal(buildToolPresentationModel(toolMessage('web_search', 'a\nb')).outputLabel, '2 lines', 'Hermes fetch 输出使用 lines')
assert.equal(buildToolPresentationModel(toolMessage('Read', 'l1\nl2\nl3')).outputLabel, '3 lines')
assert.equal(buildToolPresentationModel(toolMessage('Bash', 'out')).outputLabel, '1 lines')
assert.equal(buildToolPresentationModel(toolMessage('Unknown', 'x')).outputLabel, '1 lines', 'other 回退通用行数')

const unified = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
assert.equal(buildToolPresentationModel(toolMessage('Edit', unified)).isDiffCandidate, true, '可解析 unified diff 必须判定')
assert.equal(buildToolPresentationModel(toolMessage('Write', 'plain text only')).isDiffCandidate, false, '非 diff 文本不得判定')
assert.equal(buildToolPresentationModel(toolMessage('Bash', unified)).isDiffCandidate, false, '非 edit kind 即使含 diff 文本也不判定')

// ── contentBlocks：tool_diff_content → diffPayload（camel/snake 兼容），kind 由显式字段优先 ──
{
  const withDiffBlock = buildToolPresentationModel(toolMessage('read_file', '', [
    { type: 'tool_diff_content', old_content: 'a = 1', new_content: 'a = 2' },
  ]))
  assert.equal(withDiffBlock.diffPayload?.lines.length, 2, 'contentBlocks diff 必须解析为 DiffPayload')
  assert.equal(withDiffBlock.isDiffCandidate, true)
  assert.equal(withDiffBlock.kind, 'read')
}

// ── 三份 wire mock 输出统一模型（Peri/Hermes/第三方；未知 kind/type 不抛错） ──
{
  const peri = buildToolRenderModel({ name: 'Bash', toolKind: 'execute', input: { command: 'ls' }, output: 'a\nb' })
  const hermes = buildToolRenderModel({ name: 'read_file', toolKind: 'read', input: { file_path: 'x.ts' }, contentBlocks: [{ type: 'tool_diff_content', old_content: '1', new_content: '2' }] })
  const thirdParty = buildToolRenderModel({ name: 'custom_thing', toolKind: 'weird', input: { note: 'hello' }, output: 'x' })
  for (const model of [peri, hermes, thirdParty]) {
    assert.ok(typeof model.kind === 'string')
    assert.ok(typeof model.name === 'string')
    assert.ok(typeof model.summary === 'string')
    assert.ok(typeof model.outputLabel === 'string')
    assert.ok(typeof model.isDiffCandidate === 'boolean')
    assert.ok(model.diffPayload === null || typeof model.diffPayload === 'object')
    assert.ok(typeof model.hasDiffContentBlock === 'boolean')
  }
  assert.equal(peri.kind, 'execute')
  assert.equal(hermes.kind, 'read')
  assert.equal(thirdParty.kind, 'other', '未知 kind/工具名 → other 不抛错')
  assert.equal(hermes.isDiffCandidate, true)
  assert.equal(hermes.diffPayload?.lines[1]?.kind, 'added')
  assert.equal(thirdParty.diffPayload, null)
}

// ── 状态/摘要/输出保持既有语义 ──
const model = buildToolPresentationModel(toolMessage('Edit', unified), 'completed')
assert.equal(model.summary, '', '无输入时 summary 为空，title 由 name 承担（不再把工具名当参数）')
assert.equal(model.statusLabel, '已完成')
assert.equal(model.outputText, unified)
assert.equal(model.hasOutput, true)
assert.equal(model.kind, 'edit')

console.log('toolRenderer 注册表（kind 归一）回归测试通过')
