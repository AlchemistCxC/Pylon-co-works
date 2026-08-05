import { strict as assert } from 'node:assert'
import { applyChatEvent, createSourceChatRuntime, type ChatEvent, type ChatRuntimeState } from '../src/components/chat/sessionRuntimeStore.ts'

const SOURCE = 'local:demo'
const OTHER = 'local:other'

function ctx(now = 1_000_000, rendered: string | null = null) {
  return { knownSources: [SOURCE, OTHER], renderedSource: rendered, now }
}

function initialState(): ChatRuntimeState {
  return { [SOURCE]: createSourceChatRuntime(SOURCE) }
}

function apply(state: ChatRuntimeState, event: ChatEvent, now = 1_000_000): ChatRuntimeState {
  return applyChatEvent(state, event, { knownSources: [SOURCE, OTHER], renderedSource: null, now })
}

// ── user 事件 ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: '你好' })
  const r = s[SOURCE]
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].role, 'user')
  assert.equal(r.messages[0].content, '你好')
  assert.equal(r.messages[0].id, 'user-1')
  assert.equal(r.generating, true)
  assert.equal(r.cancelState.status, 'generating')
  assert.equal(r.seq, 1)
  // 旧消息 running 清 false
  s = apply(s, { type: 'user', source: SOURCE, content: '第二条' })
  assert.equal(s[SOURCE].messages.every(m => !m.running), true)
  assert.equal(s[SOURCE].messages.length, 2)
  assert.equal(s[SOURCE].messages[1].id, 'user-2')
}

// ── user 事件 loadInProgress（buffer 模式）──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'replay-user', loadInProgress: true })
  const r = s[SOURCE]
  assert.equal(r.messages.length, 0)
  assert.equal(r.replaying?.length, 1)
  assert.equal(r.generating, false)
}

// ── user 事件显式 replay（late 模式）──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'late-user', eventReplay: true })
  const r = s[SOURCE]
  assert.equal(r.replaying?.length, 1)
  assert.equal(r.generating, false)
}

// ── message-chunk：rendered live 走 streaming ──
{
  let s = initialState()
  s = applyChatEvent(s, { type: 'user', source: SOURCE, content: 'hi' }, { knownSources: [SOURCE], renderedSource: SOURCE, now: 1_000_000 })
  s = applyChatEvent(s, { type: 'message-chunk', source: SOURCE, text: 'A' }, { knownSources: [SOURCE], renderedSource: SOURCE, now: 1_000_100 })
  s = applyChatEvent(s, { type: 'message-chunk', source: SOURCE, text: 'B' }, { knownSources: [SOURCE], renderedSource: SOURCE, now: 1_000_200 })
  const r = s[SOURCE]
  assert.equal(r.streamingText, 'AB')
  assert.equal(r.messages.length, 1) // user 消息
}

// ── message-chunk：非 rendered 或 replay 落消息 ──
{
  let s = initialState()
  s = apply(s, { type: 'message-chunk', source: SOURCE, text: 'X' })
  assert.equal(s[SOURCE].messages.length, 1)
  assert.equal(s[SOURCE].messages[0].role, 'assistant')
  assert.equal(s[SOURCE].messages[0].running, true)
  assert.equal(s[SOURCE].messages[0].id, 'msg-1')
  // 合并到 last running assistant
  s = apply(s, { type: 'message-chunk', source: SOURCE, text: 'Y' })
  assert.equal(s[SOURCE].messages.length, 1)
  assert.equal(s[SOURCE].messages[0].content, 'XY')
  // replay 落 replaying 且 running=false
  let s2 = initialState()
  s2 = apply(s2, { type: 'message-chunk', source: SOURCE, text: 'R', replay: true })
  assert.equal(s2[SOURCE].messages.length, 0)
  assert.equal(s2[SOURCE].replaying?.length, 1)
  assert.equal(s2[SOURCE].replaying![0].running, false)
}

// ── thought-chunk ──
{
  let s = initialState()
  s = apply(s, { type: 'thought-chunk', source: SOURCE, text: '思考' })
  const r = s[SOURCE]
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].role, 'reasoning')
  assert.equal(r.messages[0].running, true)
  assert.equal(r.thinkingStart, 1_000_000)
  s = apply(s, { type: 'thought-chunk', source: SOURCE, text: '中' })
  assert.equal(s[SOURCE].messages[0].content, '思考中')
}

// ── tool-call：live flush streaming + tool 行 ──
{
  let s = initialState()
  s = apply(s, { type: 'thought-chunk', source: SOURCE, text: 't' })
  s = apply(s, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Read', rawInput: { path: 'a.ts' } })
  const r = s[SOURCE]
  assert.equal(r.streamingThinking, '', 'tool-call 必须 flush streaming')
  assert.equal(r.messages.length, 2)
  assert.equal(r.messages[1].role, 'tool')
  assert.equal(r.messages[1].id, 'tool-c1')
  assert.equal(r.messages[1].running, true)
  assert.equal(r.messages[1].toolInput, 'a.ts')
  assert.equal(r.seq, 1, '有 toolId 不消耗序列')
  // tool-missing 消耗序列
  s = apply(s, { type: 'tool-call', source: SOURCE, title: 'X' })
  assert.equal(s[SOURCE].messages[2].id, 'tool-tool-missing-2')
  // replay 去重
  let s2 = initialState()
  s2 = apply(s2, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Read', replay: true })
  s2 = apply(s2, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Read', replay: true })
  assert.equal(s2[SOURCE].replaying?.filter(m => m.role === 'tool').length, 1, '重复 toolCallId 必须忽略')
}

// ── tool-call-update ──
{
  let s = initialState()
  s = apply(s, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Bash', rawInput: 'ls' })
  s = apply(s, { type: 'tool-call-update', source: SOURCE, toolCallId: 'c1', rawOutput: 'a\nb', status: 'completed' })
  const tool = s[SOURCE].messages[0]
  assert.equal(tool.toolOutput, 'a\nb')
  assert.equal(tool.toolOutputLines, 2)
  assert.equal(tool.toolStatus, 'completed')
  assert.equal(tool.running, false)
}

// ── usage-update ──
{
  let s = initialState()
  s = apply(s, { type: 'usage-update', source: SOURCE, tokensUsed: 42 })
  assert.equal(s[SOURCE].tokenCount, 42)
}

// ── done：live ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'thought-chunk', source: SOURCE, text: '想' }, 1_000_100)
  s = apply(s, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Bash' }, 1_000_200)
  s = apply(s, { type: 'done', source: SOURCE }, 2_000_000)
  const r = s[SOURCE]
  assert.equal(r.generating, false)
  assert.equal(r.streamingThinking, '', 'done 必须 flush streaming')
  assert.equal(r.lastSummary?.reason, 'done')
  assert.equal(r.lastSummary?.elapsedMs, 1_000_000)
  // thought 与 tool 均已 settle
  const thought = r.messages.find(m => m.role === 'reasoning')
  const tool = r.messages.find(m => m.role === 'tool')
  assert.equal(thought?.running, false)
  assert.equal(thought?.thoughtDurationMs, 999_900)
  assert.equal(tool?.running, false)
  assert.equal(tool?.toolStatus, 'completed')
}

// ── done：replay 只 settle replaying ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'r', loadInProgress: true })
  s = apply(s, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Bash', replay: true })
  s = apply(s, { type: 'done', source: SOURCE, replay: true })
  const r = s[SOURCE]
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary, undefined, 'replay 不产生 summary')
  assert.equal(r.replaying?.find(m => m.role === 'tool')?.running, false)
}

// ── error：cancelled=true ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'begin-cancel', source: SOURCE })
  assert.equal(s[SOURCE].cancelState.status, 'canceling')
  s = apply(s, { type: 'error', source: SOURCE, error: 'cancelled', cancelled: true }, 2_000_000)
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'cancelled')
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary?.reason, 'cancelled')
  assert.equal(r.messages.at(-1)?.content, 'cancelled')
  assert.equal(r.messages.at(-1)?.sender, 'system')
}

// ── error：普通错误（非 canceling）──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'error', source: SOURCE, error: 'boom' }, 2_000_000)
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'generating', '非 canceling 时 applyCancelEvent 不改变状态（user 后为 generating）')
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary?.reason, 'error')
}

// ── error：cancellationFailed（canceling + cancelled=false）──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'begin-cancel', source: SOURCE })
  s = apply(s, { type: 'error', source: SOURCE, error: 'cancel failed', cancelled: false }, 2_000_000)
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'generating', '取消失败回滚为 generating')
  assert.equal(r.generating, false, 'cancellationFailed 必须收敛 generating（2026-08-03 修复：否则 spinner 常转）')
  assert.equal(r.lastSummary?.reason, 'error', 'cancellationFailed 必须写 error summary')
  assert.equal(r.streamingThinking, '', 'streaming 已落盘')
  assert.equal(r.messages.at(-1)?.content, 'cancel failed')
}

// ── cancel 链路：begin → success ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'message-chunk', source: SOURCE, text: 'part' }, 1_000_100)
  s = apply(s, { type: 'begin-cancel', source: SOURCE })
  s = apply(s, { type: 'cancel-success', source: SOURCE }, 1_500_000)
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'cancelled')
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary?.reason, 'cancelled')
  assert.equal(r.lastSummary?.elapsedMs, 500_000)
  assert.equal(r.streamingText, '', 'cancel-success 必须 flush streaming')
  assert.equal(r.messages.at(-1)?.content, 'part', 'streaming 内容必须落盘为 assistant 消息')
}

// ── cancel 链路：begin → rejected ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'begin-cancel', source: SOURCE })
  s = apply(s, { type: 'cancel-rejected', source: SOURCE, error: 'invoke failed' }, 1_100_000)
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'generating')
  assert.equal(r.cancelState.error, 'invoke failed')
  assert.equal(r.generating, true)
}

// ── begin-cancel 状态守卫 ──
{
  let s = initialState()
  s = apply(s, { type: 'begin-cancel', source: SOURCE })
  assert.equal(s[SOURCE].cancelState.status, 'idle', '非 generating 不允许 begin-cancel')
}

// ── clear：只清消息、summary 与 planEntries（D4 同生命周期）；不动 cancelState/seq ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'plan', source: SOURCE, entries: [{ content: '任务', status: 'in_progress' }] }, 1_000_100)
  assert.equal(s[SOURCE].planEntries.length, 1)
  s = apply(s, { type: 'clear', source: SOURCE })
  const r = s[SOURCE]
  assert.equal(r.messages.length, 0)
  assert.equal(r.lastSummary, undefined)
  assert.deepEqual(r.planEntries, [], 'clear 必须清 planEntries')
  assert.equal(r.cancelState.status, 'generating', 'clear 不动 cancelState（与现状一致）')
  assert.equal(r.seq, 1, 'clear 不动 seq')
}

// ── plan：D1 全量替换；空快照清空；replay/live 一致；深等返回原引用 ──
{
  let s = initialState()
  s = apply(s, { type: 'plan', source: SOURCE, entries: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'in_progress' }] }, 1_000_000)
  assert.deepEqual(s[SOURCE].planEntries.map(e => e.content), ['A', 'B'])
  // 全量替换（无合并）
  s = apply(s, { type: 'plan', source: SOURCE, entries: [{ content: 'C', status: 'completed' }] }, 1_000_100)
  assert.deepEqual(s[SOURCE].planEntries.map(e => e.content), ['C'])
  // 空快照清空
  s = apply(s, { type: 'plan', source: SOURCE, entries: [] }, 1_000_200)
  assert.deepEqual(s[SOURCE].planEntries, [])
  // replay 与 live 输入一致输出一致
  const live = apply(initialState(), { type: 'plan', source: SOURCE, entries: [{ content: 'X', status: 'pending' }] }, 1_000_000)
  const replay = apply(initialState(), { type: 'plan', source: SOURCE, entries: [{ content: 'X', status: 'pending' }], replay: true }, 1_000_000)
  assert.deepEqual(live[SOURCE].planEntries, replay[SOURCE].planEntries)
  // 深等快照返回原状态引用（供 P1-05 横向版本戳）
  const before = s
  const unchanged = apply(s, { type: 'plan', source: SOURCE, entries: [] }, 1_000_300)
  assert.equal(unchanged, before, 'plan 深等时必须返回原状态引用')
}

// ── tool-call/tool-call-update：toolKind/contentBlocks 携带与补丁 ──
{
  let s = initialState()
  s = apply(s, { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Bash', toolKind: 'execute', contentBlocks: [{ type: 'text', text: 'ls' }] })
  const tool = s[SOURCE].messages[0]
  assert.equal(tool.toolKind, 'execute')
  assert.deepEqual(tool.contentBlocks, [{ type: 'text', text: 'ls' }])
  // update 携带 diff content → 补丁到既有消息
  s = apply(s, { type: 'tool-call-update', source: SOURCE, toolCallId: 'c1', rawOutput: 'out', status: 'completed', contentBlocks: [{ type: 'tool_diff_content', path: 'a.ts' }] })
  const updated = s[SOURCE].messages[0]
  assert.equal(updated.toolStatus, 'completed')
  assert.deepEqual(updated.contentBlocks, [{ type: 'tool_diff_content', path: 'a.ts' }])
  assert.equal(updated.toolKind, 'execute', 'update 无 kind 时保留 tool-call 的 kind')
  // update 无 contentBlocks 时保留既有（undefined 回退，旧消息兼容）
  s = apply(initialState(), { type: 'tool-call', source: SOURCE, toolCallId: 'c2', title: 'Read' })
  s = apply(s, { type: 'tool-call-update', source: SOURCE, toolCallId: 'c2', rawOutput: 'ok', status: 'completed' })
  assert.equal(s[SOURCE].messages[0].contentBlocks, undefined)
  assert.equal(s[SOURCE].messages[0].toolKind, undefined, '旧消息无字段必须保持 undefined（向后兼容）')
}

// ── 双路径修复：非 rendered 期间 chunks 直写 + rendered 缓冲，done flush 合并不拆条 ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  // rendered 缓冲一段
  s = applyChatEvent(s, { type: 'message-chunk', source: SOURCE, text: '前半' }, { knownSources: [SOURCE], renderedSource: SOURCE, now: 1_000_100 })
  assert.equal(s[SOURCE].streamingText, '前半')
  // 切走后直写 messages（running assistant）
  s = applyChatEvent(s, { type: 'message-chunk', source: SOURCE, text: '后半' }, { knownSources: [SOURCE], renderedSource: null, now: 1_000_200 })
  const r1 = s[SOURCE]
  assert.equal(r1.messages.at(-1)?.content, '后半', '非 rendered 直写为 running assistant 消息')
  assert.equal(r1.streamingText, '前半', 'rendered 缓冲保留')
  // done flush：缓冲并入 running 消息，同一回复只有一条
  s = apply(s, { type: 'done', source: SOURCE }, 2_000_000)
  const r2 = s[SOURCE]
  const assistantMsgs = r2.messages.filter(m => m.role === 'assistant')
  assert.equal(assistantMsgs.length, 1, '同一回复不得拆成两条 assistant 消息')
  assert.equal(assistantMsgs[0].content, '后半前半', '缓冲文本必须并入直写消息')
  assert.equal(r2.streamingText, '')
}

// ── done 解析 cancelState：cancel 在途时 done 到达置 cancelled，cancel-success 不再覆盖 ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'begin-cancel', source: SOURCE })
  assert.equal(s[SOURCE].cancelState.status, 'canceling')
  s = apply(s, { type: 'done', source: SOURCE }, 1_500_000)
  const afterDone = s[SOURCE]
  assert.equal(afterDone.cancelState.status, 'cancelled', 'done 必须解析在途 cancel 为 cancelled')
  assert.equal(afterDone.lastSummary?.reason, 'done', 'summary 保持 done（不被晚到 cancel-success 覆盖）')
  // 晚到 cancel-success 必须 no-op（不覆盖 summary/清 generationStart）
  s = apply(s, { type: 'cancel-success', source: SOURCE }, 2_000_000)
  const afterCancel = s[SOURCE]
  assert.equal(afterCancel.cancelState.status, 'cancelled')
  assert.equal(afterCancel.lastSummary?.reason, 'done', 'cancel-success 不得把 summary 改成 cancelled')
}

// ── 未知 source 忽略 ──
{
  const s = initialState()
  const next = applyChatEvent(s, { type: 'user', source: 'local:unknown', content: 'x' }, { knownSources: [SOURCE], renderedSource: null, now: 1 })
  assert.equal(next, s, '未知 source 必须返回原状态（引用相等）')
}

// ── 终态收敛：replay 作用域 done 也必须复位 generating（2026-08-03 修复）──
{
  let s = initialState()
  // user 事件先置 generating=true（load 期间 replaying 未初始化时被判 live）
  s = apply(s, { type: 'user', source: SOURCE, content: 'live-during-load' }, 1_000_000)
  assert.equal(s[SOURCE].generating, true)
  // replay 标记的 done（replay 缓冲已初始化）不得把 generating 留在 true
  s = applyChatEvent(s, { type: 'done', source: SOURCE, explicitReplay: true }, { knownSources: [SOURCE], renderedSource: null, now: 2_000_000 })
  const r = s[SOURCE]
  assert.equal(r.generating, false, 'replay 作用域 done 必须收敛 generating')
  assert.equal(r.lastSummary, undefined, 'replay 作用域不写 live summary')
}

console.log('sessionRuntimeStore reducer 等价回归测试通过')
