import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import { getToolSummary } from '../src/domains/tool/toolPresentation.ts'
import { resolveToolKind, buildToolRenderModel, TOOL_KINDS } from '../src/domains/tool/toolPresentation.ts'
import { buildToolPresentationModel } from '../src/components/chat/toolPresentationModel.ts'
import type { Message } from '../src/components/chat/messageTypes.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

const toolMessage = (name: string, output?: string, contentBlocks?: Message['contentBlocks']): Message => ({
  id: 't1', role: 'tool', sender: `tool:${name}`, content: '', time: '12:00', toolName: name, toolOutput: output, contentBlocks,
})

describe('toolRendererRegistry legacy compat', () => {
  // ── kind 归一（P1-10）：Peri PascalCase 与 Hermes snake_case 同一字典，不再按名字碰运气 ──
  it('resolveToolKind 矩阵：PascalCase/snake_case 同一字典、显式 toolKind 优先、非法回退', () => {
    expect(resolveToolKind('Bash')).toBe('execute')
    expect(resolveToolKind('Read')).toBe('read')
    expect(resolveToolKind('Edit')).toBe('edit')
    expect(resolveToolKind('Write')).toBe('edit')
    expect(resolveToolKind('Grep')).toBe('search')
    expect(resolveToolKind('Glob')).toBe('search')
    // Claude Task 是 delegate 动作，使用可执行工具视觉类别
    expect(resolveToolKind('Task'), 'Claude Task 是 delegate 动作，使用可执行工具视觉类别').toBe('execute')
    expect(resolveToolKind('read_file')).toBe('read')
    expect(resolveToolKind('edit_file')).toBe('edit')
    expect(resolveToolKind('terminal')).toBe('execute')
    // 大小写不敏感
    expect(resolveToolKind('bash'), '大小写不敏感').toBe('execute')
    expect(resolveToolKind('web_search')).toBe('fetch')
    expect(resolveToolKind('http_request')).toBe('fetch')
    expect(resolveToolKind('think')).toBe('think')
    expect(resolveToolKind('custom_tool')).toBe('other')
    // 显式 toolKind 优先
    expect(resolveToolKind('Bash', 'read')).toBe('read')
    // 非法 toolKind 回退名字启发式
    expect(resolveToolKind('whatever', 'weird'), '非法 toolKind 回退名字启发式').toBe('other')
    expect([...TOOL_KINDS]).toEqual(['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other'])
  })

  // ── 摘要：kind 字典提取 + title 直通回退（Hermes snake_case 不再落 FALLBACK） ──
  it('getToolSummary 字典：execute/read/edit/search 提取、other 文本启发式回退', () => {
    expect(getToolSummary('Bash', { command: 'npm run build' })).toBe('npm run build')
    // Hermes terminal 必须走 execute 字典
    expect(getToolSummary('terminal', { command: 'ls' }), 'Hermes terminal 必须走 execute 字典').toBe('ls')
    expect(getToolSummary('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    // Hermes read_file 必须走 read 字典
    expect(getToolSummary('read_file', { file_path: 'src/a.ts' }), 'Hermes read_file 必须走 read 字典').toBe('src/a.ts')
    expect(getToolSummary('Edit', { filePath: 'src/b.ts' })).toBe('src/b.ts')
    expect(getToolSummary('Grep', { pattern: 'TODO' })).toBe('TODO')
    // other 回退首个字符串字段（文本启发式保留）
    expect(getToolSummary('UnknownTool', { id: 1, note: 'hello world' }), 'other 回退首个字符串字段（文本启发式保留）').toBe('hello world')
    expect(getToolSummary('UnknownTool', 'plain input')).toBe('plain input')
  })

  // ── outputLabel / isDiffCandidate 按 kind ──
  it('outputLabel / isDiffCandidate 按 kind 判定', () => {
    expect(buildToolPresentationModel(toolMessage('Grep', 'a\nb')).outputLabel).toBe('2 matches')
    // Hermes fetch 输出使用 lines
    expect(buildToolPresentationModel(toolMessage('web_search', 'a\nb')).outputLabel, 'Hermes fetch 输出使用 lines').toBe('2 lines')
    expect(buildToolPresentationModel(toolMessage('Read', 'l1\nl2\nl3')).outputLabel).toBe('3 lines')
    expect(buildToolPresentationModel(toolMessage('Bash', 'out')).outputLabel).toBe('1 lines')
    // other 回退通用行数
    expect(buildToolPresentationModel(toolMessage('Unknown', 'x')).outputLabel, 'other 回退通用行数').toBe('1 lines')

    const unified = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
    // 可解析 unified diff 必须判定
    expect(buildToolPresentationModel(toolMessage('Edit', unified)).isDiffCandidate, '可解析 unified diff 必须判定').toBe(true)
    // 非 diff 文本不得判定
    expect(buildToolPresentationModel(toolMessage('Write', 'plain text only')).isDiffCandidate, '非 diff 文本不得判定').toBe(false)
    // 非 edit kind 即使含 diff 文本也不判定
    expect(buildToolPresentationModel(toolMessage('Bash', unified)).isDiffCandidate, '非 edit kind 即使含 diff 文本也不判定').toBe(false)
  })

  // ── contentBlocks：tool_diff_content → diffPayload（camel/snake 兼容），kind 由显式字段优先 ──
  it('contentBlocks：tool_diff_content 解析为 diffPayload，kind 由显式字段优先', () => {
    const withDiffBlock = buildToolPresentationModel(toolMessage('read_file', '', [
      { type: 'tool_diff_content', old_content: 'a = 1', new_content: 'a = 2' },
    ]))
    // contentBlocks diff 必须解析为 DiffPayload
    expect(withDiffBlock.diffPayload?.lines.length, 'contentBlocks diff 必须解析为 DiffPayload').toBe(2)
    expect(withDiffBlock.isDiffCandidate).toBe(true)
    expect(withDiffBlock.kind).toBe('read')
  })

  // ── 三份 wire mock 输出统一模型（Peri/Hermes/第三方；未知 kind/type 不抛错） ──
  it('三份 wire mock 输出统一模型：Peri/Hermes/第三方，未知 kind 不抛错', () => {
    const peri = buildToolRenderModel({ name: 'Bash', toolKind: 'execute', input: { command: 'ls' }, output: 'a\nb' })
    const hermes = buildToolRenderModel({ name: 'read_file', toolKind: 'read', input: { file_path: 'x.ts' }, contentBlocks: [{ type: 'tool_diff_content', old_content: '1', new_content: '2' }] })
    const thirdParty = buildToolRenderModel({ name: 'custom_thing', toolKind: 'weird', input: { note: 'hello' }, output: 'x' })
    for (const model of [peri, hermes, thirdParty]) {
      expect(typeof model.kind).toBe('string')
      expect(typeof model.name).toBe('string')
      expect(typeof model.summary).toBe('string')
      expect(typeof model.outputLabel).toBe('string')
      expect(typeof model.isDiffCandidate).toBe('boolean')
      expect(model.diffPayload === null || typeof model.diffPayload === 'object').toBe(true)
      expect(typeof model.hasDiffContentBlock).toBe('boolean')
    }
    expect(peri.kind).toBe('execute')
    expect(hermes.kind).toBe('read')
    // 未知 kind/工具名 → other 不抛错
    expect(thirdParty.kind, '未知 kind/工具名 → other 不抛错').toBe('other')
    expect(hermes.isDiffCandidate).toBe(true)
    expect(hermes.diffPayload?.lines[1]?.kind).toBe('added')
    expect(thirdParty.diffPayload).toBeNull()
  })

  // ── 状态/摘要/输出保持既有语义 ──
  it('状态/摘要/输出保持既有语义', () => {
    const unified = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
    const model = buildToolPresentationModel(toolMessage('Edit', unified), 'completed')
    // 无输入时 summary 为空，title 由 name 承担（不再把工具名当参数）
    expect(model.summary, '无输入时 summary 为空，title 由 name 承担（不再把工具名当参数）').toBe('')
    expect(model.statusLabel).toBe('已完成')
    expect(model.outputText).toBe(unified)
    expect(model.hasOutput).toBe(true)
    expect(model.kind).toBe('edit')
  })
})
