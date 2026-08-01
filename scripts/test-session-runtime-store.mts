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
  assert.equal(r.generating, true, 'cancellationFailed 不收敛 generating（与现状一致）')
  assert.equal(r.lastSummary, undefined)
  assert.equal(r.streamingThinking, '', 'cancellationFailed 不 flush streaming（与现状一致）')
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

// ── clear：只清消息与 summary ──
{
  let s = initialState()
  s = apply(s, { type: 'user', source: SOURCE, content: 'hi' }, 1_000_000)
  s = apply(s, { type: 'clear', source: SOURCE })
  const r = s[SOURCE]
  assert.equal(r.messages.length, 0)
  assert.equal(r.lastSummary, undefined)
  assert.equal(r.cancelState.status, 'generating', 'clear 不动 cancelState（与现状一致）')
  assert.equal(r.seq, 1, 'clear 不动 seq')
}

// ── 未知 source 忽略 ──
{
  const s = initialState()
  const next = applyChatEvent(s, { type: 'user', source: 'local:unknown', content: 'x' }, { knownSources: [SOURCE], renderedSource: null, now: 1 })
  assert.equal(next, s, '未知 source 必须返回原状态（引用相等）')
}

console.log('sessionRuntimeStore reducer 等价回归测试通过')
