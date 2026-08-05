import { strict as assert } from 'node:assert'
import { extractToolKind, extractContentBlocks, extractPlanEntries, type ContentBlock } from '../src/components/chat/acpTypes.ts'

// P1-03：三份 wire mock（Peri/Hermes/第三方漂移）均可解析——kind/content/plan 提取宽容不抛错

// 样本 1：Peri（PascalCase 工具名，kind/content 齐备）
const periToolCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 't1',
  title: 'Bash',
  kind: 'execute',
  content: [{ type: 'text', text: 'ls -la' }],
  rawInput: { command: 'ls -la' },
}
assert.equal(extractToolKind(periToolCall), 'execute')
assert.deepEqual(extractContentBlocks(periToolCall), [{ type: 'text', text: 'ls -la' }])

// 样本 2：Hermes（snake_case 工具名，content 含 diff 块）
const hermesToolUpdate = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 't2',
  title: 'read_file',
  kind: 'read',
  content: [{ type: 'tool_diff_content', path: 'a.ts', oldContent: 'x', newContent: 'y' }],
  status: 'completed',
}
assert.equal(extractToolKind(hermesToolUpdate), 'read')
const hermesBlocks = extractContentBlocks(hermesToolUpdate)
assert.equal(hermesBlocks?.[0]?.type, 'tool_diff_content')
assert.equal(hermesBlocks?.[0]?.path, 'a.ts')

// 样本 3：第三方漂移——kind 非字符串 → undefined（宽容）；未知 content type 保留通用对象不抛错
const thirdParty = {
  sessionUpdate: 'tool_call',
  toolCallId: 't3',
  title: 'custom',
  kind: 123,
  content: [{ type: 'weird-type', someFlag: true, nested: { a: 1 } }],
}
assert.equal(extractToolKind(thirdParty), undefined, '非字符串 kind 必须宽容返回 undefined')
assert.deepEqual(extractContentBlocks(thirdParty), [{ type: 'weird-type', someFlag: true, nested: { a: 1 } }], '未知 content type 保留通用对象')

// plan entries 提取：空快照 [] 与缺失 undefined 区分
assert.deepEqual(extractPlanEntries({ sessionUpdate: 'plan', entries: [{ content: '初始化', status: 'in_progress' }] }), [
  { content: '初始化', status: 'in_progress' },
])
assert.deepEqual(extractPlanEntries({ sessionUpdate: 'plan', entries: [] }), [])
assert.equal(extractPlanEntries({ sessionUpdate: 'plan' }), undefined)
assert.equal(extractPlanEntries(null), undefined)

// 提取对非对象/缺字段全部宽容
assert.equal(extractToolKind(null), undefined)
assert.equal(extractToolKind('str'), undefined)
assert.equal(extractContentBlocks({}), undefined)
assert.equal(extractContentBlocks({ content: 'not-array' }), undefined)
assert.deepEqual(extractContentBlocks({ content: [null, 'str', { type: 'text' }] }), [{ type: 'text' }], '非对象项丢弃')

// 类型层验证：三份 mock 均可赋给 SessionUpdate（编译期不抛错）
const _check: import('../src/components/chat/acpTypes.ts').SessionUpdate[] = [periToolCall, hermesToolUpdate, thirdParty]
void _check

console.log('normalizer（三份 wire mock 解析）守卫通过')
