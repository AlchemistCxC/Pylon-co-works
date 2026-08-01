import { strict as assert } from 'node:assert'
import { applyChatEvent, createSourceChatRuntime, type ChatEvent, type ChatRuntimeState } from '../src/components/chat/sessionRuntimeStore.ts'

const SOURCE = 'local:demo'
const OTHER = 'local:other'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function ctx(now: number, rendered: string | null = null) {
  return { knownSources: [SOURCE, OTHER], renderedSource: rendered, now }
}

// ── 场景 fixture：真实会话序列 → 期望的消息形状 ──

// 1. 正常生成：user → thought → tool → tool update → thought → message → done
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, content: '检查一下' },
    { type: 'thought-chunk', source: SOURCE, text: '先读' },
    { type: 'thought-chunk', source: SOURCE, text: '源码' },
    { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Read', rawInput: { path: 'a.ts' } },
    { type: 'tool-call-update', source: SOURCE, toolCallId: 'c1', rawOutput: 'const a = 1', status: 'completed' },
    { type: 'thought-chunk', source: SOURCE, text: '接下来' },
    { type: 'message-chunk', source: SOURCE, text: '结果是：' },
    { type: 'message-chunk', source: SOURCE, text: '正常' },
    { type: 'done', source: SOURCE },
  ]
  let s: ChatRuntimeState = {}
  let now = 1_000_000
  for (const e of events) {
    now += 100
    s = applyChatEvent(s, e, ctx(now))
  }
  const r = s[SOURCE]
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'reasoning', 'tool', 'reasoning', 'assistant'])
  assert.equal(r.messages[0].content, '检查一下')
  assert.equal(r.messages[1].content, '先读源码')
  assert.equal(r.messages[2].id, 'tool-c1')
  assert.equal(r.messages[2].toolStatus, 'completed')
  assert.equal(r.messages[2].running, false)
  assert.equal(r.messages[3].content, '接下来')
  assert.equal(r.messages[4].content, '结果是：正常')
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary?.reason, 'done')
  assert.equal(r.lastSummary?.elapsedMs, 800)
  assert.equal(r.messages.every(m => !m.running), true)
}

// 2. 取消链路：user → streaming → begin-cancel → cancel-success
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, content: 'hi' },
    { type: 'thought-chunk', source: SOURCE, text: '想' },
    { type: 'message-chunk', source: SOURCE, text: '在写' },
    { type: 'begin-cancel', source: SOURCE },
    { type: 'cancel-success', source: SOURCE },
  ]
  let s: ChatRuntimeState = {}
  let now = 1_000_000
  for (const e of events) {
    now += 50
    s = applyChatEvent(s, e, ctx(now))
  }
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'cancelled')
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary?.reason, 'cancelled')
  assert.equal(r.messages.at(-1)?.content, '在写', 'streaming 必须落盘')
  assert.equal(r.messages.at(-2)?.role, 'reasoning', 'thought 也必须落盘')
}

// 3. 取消失败：user → begin-cancel → error(cancelled=false)
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, content: 'hi' },
    { type: 'begin-cancel', source: SOURCE },
    { type: 'error', source: SOURCE, error: 'cancel rejected', cancelled: false },
  ]
  let s: ChatRuntimeState = {}
  for (const e of events) {
    s = applyChatEvent(s, e, ctx(1_000_000))
  }
  const r = s[SOURCE]
  assert.equal(r.cancelState.status, 'generating')
  assert.equal(r.generating, true)
  assert.equal(r.lastSummary, undefined)
}

// 4. 普通错误：user → thought → error → 错误消息追加
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, content: 'hi' },
    { type: 'thought-chunk', source: SOURCE, text: '想' },
    { type: 'error', source: SOURCE, error: 'backend down' },
  ]
  let s: ChatRuntimeState = {}
  for (const e of events) {
    s = applyChatEvent(s, e, ctx(1_000_000))
  }
  const r = s[SOURCE]
  assert.equal(r.lastSummary?.reason, 'error')
  assert.equal(r.messages.at(-1)?.sender, 'system')
  assert.equal(r.messages.at(-1)?.content, 'backend down')
  assert.equal(r.messages.at(-2)?.role, 'reasoning')
  assert.equal(r.messages.every(m => !m.running), true)
}

// 5. replay 加载：buffer 期事件进 replaying，done 后 settle
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, content: 'r', loadInProgress: true },
    { type: 'thought-chunk', source: SOURCE, text: '旧思考', replay: true },
    { type: 'tool-call', source: SOURCE, toolCallId: 'c1', title: 'Bash', replay: true },
    { type: 'tool-call-update', source: SOURCE, toolCallId: 'c1', rawOutput: 'ok', status: 'completed', replay: true },
    { type: 'done', source: SOURCE, replay: true },
  ]
  let s: ChatRuntimeState = {}
  for (const e of events) {
    s = applyChatEvent(s, e, ctx(1_000_000))
  }
  const r = s[SOURCE]
  assert.equal(r.messages.length, 0, 'replay 事件不得污染 messages')
  assert.equal(r.replaying?.length, 3)
  assert.equal(r.replaying?.every(m => !m.running), true)
  assert.equal(r.replaying?.find(m => m.role === 'tool')?.toolStatus, 'completed')
  assert.equal(r.lastSummary, undefined)
}

// 6. 多 source 隔离：A 生成中，B 的事件不干扰 A
{
  let s: ChatRuntimeState = {}
  s = applyChatEvent(s, { type: 'user', source: SOURCE, content: 'A 问题' }, ctx(1_000_000))
  s = applyChatEvent(s, { type: 'message-chunk', source: OTHER, text: 'B 的消息' }, ctx(1_000_100))
  s = applyChatEvent(s, { type: 'message-chunk', source: SOURCE, text: 'A 回复' }, ctx(1_000_200))
  assert.equal(s[SOURCE].messages.length, 2)
  assert.equal(s[OTHER].messages.length, 1)
  assert.equal(s[OTHER].messages[0].content, 'B 的消息')
  assert.equal(s[SOURCE].generating, true)
}

// 7. 会话删除清理：clearChatSource 清状态；事件过滤由 knownSources（接线层从 sessions 派生）决定
{
  const { clearChatSource } = await import('../src/components/chat/sessionRuntimeStore.ts')
  let s: ChatRuntimeState = { [SOURCE]: createSourceChatRuntime(SOURCE) }
  s = applyChatEvent(s, { type: 'user', source: SOURCE, content: 'hi' }, ctx(1_000_000))
  s = clearChatSource(s, SOURCE)
  assert.equal(s[SOURCE], undefined)
  // 会话已删除：knownSources 不含该 source → 事件忽略，引用不变
  const next = applyChatEvent(s, { type: 'user', source: SOURCE, content: 'x' }, { knownSources: [OTHER], renderedSource: null, now: 2_000_000 })
  assert.equal(next, s, '已知 source 集合外的事件返回原状态')
  // 会话仍存在（仅本地清空）：事件正常重建 runtime
  const rebuilt = applyChatEvent(s, { type: 'user', source: SOURCE, content: 'y' }, ctx(3_000_000))
  assert.equal(rebuilt[SOURCE].messages.length, 1)
}

// ── 确定性 fuzz：随机事件序列 + 不变量 ──

function randomEvent(rng: () => number, activeSources: string[], toolSeq: Map<string, number>): ChatEvent {
  const source = rng() < 0.7 ? SOURCE : OTHER
  const roll = rng()
  if (roll < 0.25) return { type: 'user', source, content: `q${Math.floor(rng() * 100)}`, loadInProgress: rng() < 0.1, eventReplay: rng() < 0.1 }
  if (roll < 0.4) return { type: 'thought-chunk', source, text: `t${Math.floor(rng() * 10)}`, replay: rng() < 0.2 }
  if (roll < 0.55) return { type: 'message-chunk', source, text: `m${Math.floor(rng() * 10)}`, replay: rng() < 0.2 }
  if (roll < 0.7) {
    // 真实后端同 toolCallId 不重复发 tool_call：每 source 单调序列
    const seq = (toolSeq.get(source) ?? 0) + 1
    toolSeq.set(source, seq)
    return { type: 'tool-call', source, toolCallId: `c${seq}`, title: 'Bash', rawInput: 'ls', replay: rng() < 0.2 }
  }
  if (roll < 0.8) {
    const seq = toolSeq.get(source) ?? 0
    if (seq === 0) return { type: 'message-chunk', source, text: `m${Math.floor(rng() * 10)}`, replay: rng() < 0.2 }
    return { type: 'tool-call-update', source, toolCallId: `c${1 + Math.floor(rng() * seq)}`, rawOutput: 'out', status: 'completed', replay: rng() < 0.2 }
  }
  if (roll < 0.9) {
    const cancelled = rng() < 0.3
    return { type: 'error', source, error: cancelled ? 'cancelled' : 'err', cancelled, replay: rng() < 0.2, explicitReplay: rng() < 0.1 }
  }
  if (roll < 0.95) return { type: 'done', source, replay: rng() < 0.2, explicitReplay: rng() < 0.1 }
  return { type: 'begin-cancel', source }
}

function assertInvariants(s: ChatRuntimeState) {
  for (const [source, r] of Object.entries(s)) {
    // id 唯一（messages 与 replaying 各自）
    const ids = new Set<string>()
    for (const m of r.messages) {
      assert.equal(ids.has(m.id), false, `${source}: 消息 id 重复 ${m.id}`)
      ids.add(m.id)
    }
    const replayIds = new Set<string>()
    for (const m of r.replaying ?? []) {
      assert.equal(replayIds.has(m.id), false, `${source}: replay id 重复 ${m.id}`)
      replayIds.add(m.id)
    }
    // cancelState 状态机合法
    assert.ok(['idle', 'generating', 'canceling', 'cancelled', 'error'].includes(r.cancelState.status), `${source}: 非法 cancelState ${r.cancelState.status}`)
    // 消息 id 与 seq 的关系：seq 单调（seq 至少不小于最大消息序号）
    const maxSeq = Math.max(0, ...[...r.messages, ...(r.replaying ?? [])].map(m => {
      const n = Number(/-(?:tool-missing-)?(\d+)$/.exec(m.id)?.[1] ?? 0)
      return Number.isFinite(n) ? n : 0
    }))
    assert.ok(r.seq >= maxSeq, `${source}: seq ${r.seq} < 最大消息序号 ${maxSeq}`)
    // tool 行：running 的 tool 行必须有 toolInput；被打断（user 清 running）的 tool 行
    // 允许无 status——与原文 `prev.map(m => ({...m, running:false}))` 语义一致
    for (const m of r.messages) {
      if (m.role === 'tool' && m.running) {
        assert.ok(m.toolInput !== undefined, `${source}: running tool 行缺 toolInput ${m.id}`)
      }
    }
  }
}

{
  const rng = mulberry32(20260801)
  let s: ChatRuntimeState = { [SOURCE]: createSourceChatRuntime(SOURCE), [OTHER]: createSourceChatRuntime(OTHER) }
  let now = 1_000_000
  const toolSeq = new Map<string, number>()
  for (let i = 0; i < 3000; i += 1) {
    now += Math.floor(rng() * 500)
    const event = randomEvent(rng, [SOURCE, OTHER], toolSeq)
    const next = applyChatEvent(s, event, ctx(now, rng() < 0.5 ? SOURCE : null))
    assertInvariants(next)
    s = next
  }
  console.log('fuzz 3000 轮不变量通过')
}

console.log('sessionRuntimeStore 场景 fixture + fuzz 测试通过')
