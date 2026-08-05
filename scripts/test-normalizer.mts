import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { extractToolKind, extractContentBlocks, extractPlanEntries, type ContentBlock } from '../src/infrastructure/acp/chatContracts.ts'

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
const _check: import('../src/infrastructure/acp/chatContracts.ts').SessionUpdate[] = [periToolCall, hermesToolUpdate, thirdParty]
void _check

// P1-09：归一化层归属——wire 类型与 extract 真实定义在 infrastructure/acp/chatContracts；
// acpTypes 仅为兼容 re-export；组件不直接解析 _meta/content 私有键
const chatContracts = readFileSync(new URL('../src/infrastructure/acp/chatContracts.ts', import.meta.url), 'utf8')
assert.match(chatContracts, /export interface ContentBlock/, 'chatContracts 必须持有 ContentBlock 真实定义')
assert.match(chatContracts, /export type SessionUpdate/, 'chatContracts 必须持有 SessionUpdate 真实定义')
assert.match(chatContracts, /export function extractToolKind/, 'chatContracts 必须持有 extract 函数真实定义')
const acpTypes = readFileSync(new URL('../src/components/chat/acpTypes.ts', import.meta.url), 'utf8')
assert.match(acpTypes, /export \* from '\.\.\/\.\.\/infrastructure\/acp\/chatContracts\.ts'/, 'acpTypes 必须仅为兼容 re-export')
assert.equal(acpTypes.includes('export interface'), false, 'acpTypes 不得再有真实定义')
const chatController = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
assert.match(chatController, /infrastructure\/acp\/chatContracts/, 'controller 必须消费 chatContracts')
// 渲染组件不直接解析 wire 私有键（_meta 只由边界层经 extract 读取）
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.equal(chatView.includes('_meta'), false, 'ChatView 不得直接解析 _meta 私有键')

// P1-04：controller 接线——plan 分支 + tool_call/update 传 kind/content 不丢
const controller = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')
assert.match(controller, /case 'plan':/, 'controller 必须映射 plan 变体')
assert.match(controller, /extractPlanEntries\(upd\)/, 'controller 必须经 extractPlanEntries 提取')
assert.match(controller, /type: 'plan', source, entries, replay/, 'controller 必须 dispatch plan 事件')
assert.match(controller, /toolKind: upd\.kind/, 'tool_call 必须携带 kind')
assert.match(controller, /contentBlocks: upd\.content/, 'tool_call 必须携带 content')
assert.match(controller, /type: 'tool-call-update'[\s\S]*?contentBlocks: upd\.content/, 'tool_call_update 必须携带 content')

// reducer：plan 全量替换 + clear 清空 + 旧消息字段 undefined 兼容
const reducer = readFileSync(new URL('../src/components/chat/sessionRuntimeStore.ts', import.meta.url), 'utf8')
assert.match(reducer, /case 'plan':/, 'reducer 必须处理 plan 事件')
assert.match(reducer, /applyPlanEntries\(/, 'reducer 必须经 applyPlanEntries 全量替换')
assert.match(reducer, /planEntries: \[\]/, 'clear 必须清空 planEntries')
const messageTypes = readFileSync(new URL('../src/components/chat/messageTypes.ts', import.meta.url), 'utf8')
assert.match(messageTypes, /toolKind\?: string/, 'Message 持久模型必须补可选 toolKind')
assert.match(messageTypes, /contentBlocks\?: ContentBlock\[\]/, 'Message 持久模型必须补可选 contentBlocks')

console.log('normalizer（三份 wire mock 解析 + P1-04 接线）守卫通过')
