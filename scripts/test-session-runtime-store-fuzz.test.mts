import { strict as assert } from 'node:assert'
import { applyChatEvent, createSourceChatRuntime, type ChatEvent, type ChatRuntimeState } from '../src/components/chat/sessionRuntimeStore.ts'
import { test } from 'vitest'

test('sessionRuntimeStore 场景 fixture + fuzz（legacy 迁移）', async () => {

const SOURCE = 'local:demo'
const OTHER = 'local:other'
const AGENT = 'demo-agent'
const SKEY = JSON.stringify([AGENT, SOURCE])
const OKEY = JSON.stringify([AGENT, OTHER])

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
    { type: 'user', source: SOURCE, agentId: AGENT, content: '检查一下' },
    { type: 'thought-chunk', source: SOURCE, agentId: AGENT, text: '先读' },
    { type: 'thought-chunk', source: SOURCE, agentId: AGENT, text: '源码' },
    { type: 'tool-call', source: SOURCE, agentId: AGENT, toolCallId: 'c1', title: 'Read', rawInput: { path: 'a.ts' } },
    { type: 'tool-call-update', source: SOURCE, agentId: AGENT, toolCallId: 'c1', rawOutput: 'const a = 1', status: 'completed' },
    { type: 'thought-chunk', source: SOURCE, agentId: AGENT, text: '接下来' },
    { type: 'message-chunk', source: SOURCE, agentId: AGENT, text: '结果是：' },
    { type: 'message-chunk', source: SOURCE, agentId: AGENT, text: '正常' },
    { type: 'done', source: SOURCE, agentId: AGENT },
  ]
  let s: ChatRuntimeState = {}
  let now = 1_000_000
  for (const e of events) {
    now += 100
    s = applyChatEvent(s, e, ctx(now))
  }
  const r = s[SKEY]
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
    { type: 'user', source: SOURCE, agentId: AGENT, content: 'hi' },
    { type: 'thought-chunk', source: SOURCE, agentId: AGENT, text: '想' },
    { type: 'message-chunk', source: SOURCE, agentId: AGENT, text: '在写' },
    { type: 'begin-cancel', source: SOURCE, agentId: AGENT },
    { type: 'cancel-success', source: SOURCE, agentId: AGENT },
  ]
  let s: ChatRuntimeState = {}
  let now = 1_000_000
  for (const e of events) {
    now += 50
    s = applyChatEvent(s, e, ctx(now))
  }
  const r = s[SKEY]
  assert.equal(r.cancelState.status, 'cancelled')
  assert.equal(r.generating, false)
  assert.equal(r.lastSummary?.reason, 'cancelled')
  assert.equal(r.messages.at(-1)?.content, '在写', 'streaming 必须落盘')
  assert.equal(r.messages.at(-2)?.role, 'reasoning', 'thought 也必须落盘')
}

// 3. 取消失败：user → begin-cancel → error(cancelled=false)
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, agentId: AGENT, content: 'hi' },
    { type: 'begin-cancel', source: SOURCE, agentId: AGENT },
    { type: 'error', source: SOURCE, agentId: AGENT, error: 'cancel rejected', cancelled: false },
  ]
  let s: ChatRuntimeState = {}
  for (const e of events) {
    s = applyChatEvent(s, e, ctx(1_000_000))
  }
  const r = s[SKEY]
  assert.equal(r.cancelState.status, 'generating')
  assert.equal(r.generating, false, '取消失败必须收敛 generating（2026-08-03 修复）')
  assert.equal(r.lastSummary?.reason, 'error')
}

// 4. 普通错误：user → thought → error → 错误消息追加
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, agentId: AGENT, content: 'hi' },
    { type: 'thought-chunk', source: SOURCE, agentId: AGENT, text: '想' },
    { type: 'error', source: SOURCE, agentId: AGENT, error: 'backend down' },
  ]
  let s: ChatRuntimeState = {}
  for (const e of events) {
    s = applyChatEvent(s, e, ctx(1_000_000))
  }
  const r = s[SKEY]
  assert.equal(r.lastSummary?.reason, 'error')
  assert.equal(r.messages.at(-1)?.sender, 'system')
  assert.equal(r.messages.at(-1)?.content, 'backend down')
  assert.equal(r.messages.at(-2)?.role, 'reasoning')
  assert.equal(r.messages.every(m => !m.running), true)
}

// 5. replay 加载：replay 事件直写 messages（U2-C），done 后 settle
{
  const events: ChatEvent[] = [
    { type: 'user', source: SOURCE, agentId: AGENT, content: 'r', eventReplay: true },
    { type: 'thought-chunk', source: SOURCE, agentId: AGENT, text: '旧思考', replay: true },
    { type: 'tool-call', source: SOURCE, agentId: AGENT, toolCallId: 'c1', title: 'Bash', replay: true },
    { type: 'tool-call-update', source: SOURCE, agentId: AGENT, toolCallId: 'c1', rawOutput: 'ok', status: 'completed', replay: true },
    { type: 'done', source: SOURCE, agentId: AGENT, replay: true },
  ]
  let s: ChatRuntimeState = {}
  for (const e of events) {
    s = applyChatEvent(s, e, ctx(1_000_000))
  }
  const r = s[SKEY]
  assert.deepEqual(r.messages.map(m => m.role), ['user', 'reasoning', 'tool'])
  assert.equal(r.messages.every(m => !m.running), true)
  assert.equal(r.messages.find(m => m.role === 'tool')?.toolStatus, 'completed')
  assert.equal(r.lastSummary, undefined)
}

// 6. 多 source 隔离：A 生成中，B 的事件不干扰 A
{
  let s: ChatRuntimeState = {}
  s = applyChatEvent(s, { type: 'user', source: SOURCE, agentId: AGENT, content: 'A 问题' }, ctx(1_000_000))
  s = applyChatEvent(s, { type: 'message-chunk', source: OTHER, agentId: AGENT, text: 'B 的消息' }, ctx(1_000_100))
  s = applyChatEvent(s, { type: 'message-chunk', source: SOURCE, agentId: AGENT, text: 'A 回复' }, ctx(1_000_200))
  assert.equal(s[SKEY].messages.length, 2)
  assert.equal(s[OKEY].messages.length, 1)
  assert.equal(s[OKEY].messages[0].content, 'B 的消息')
  assert.equal(s[SKEY].generating, true)
}

// 7. 会话删除清理：clearChatSource 清状态；事件过滤由 knownSources（接线层从 sessions 派生）决定
{
  const { clearChatSource } = await import('../src/components/chat/sessionRuntimeStore.ts')
  let s: ChatRuntimeState = { [SKEY]: createSourceChatRuntime(SOURCE) }
  s = applyChatEvent(s, { type: 'user', source: SOURCE, agentId: AGENT, content: 'hi' }, ctx(1_000_000))
  s = clearChatSource(s, SKEY)
  assert.equal(s[SKEY], undefined)
  // 会话已删除：knownSources 不含该 source → 事件忽略，引用不变
  const next = applyChatEvent(s, { type: 'user', source: SOURCE, agentId: AGENT, content: 'x' }, { knownSources: [OTHER], renderedSource: null, now: 2_000_000 })
  assert.equal(next, s, '已知 source 集合外的事件返回原状态')
  // 会话仍存在（仅本地清空）：事件正常重建 runtime
  const rebuilt = applyChatEvent(s, { type: 'user', source: SOURCE, agentId: AGENT, content: 'y' }, ctx(3_000_000))
  assert.equal(rebuilt[SKEY].messages.length, 1)
}

// ── 确定性 fuzz：随机事件序列 + 不变量 ──

function randomEvent(rng: () => number, activeSources: string[], toolSeq: Map<string, number>): ChatEvent {
  const source = rng() < 0.7 ? SOURCE : OTHER
  const roll = rng()
  if (roll < 0.25) return { type: 'user', source, agentId: AGENT, content: `q${Math.floor(rng() * 100)}`, eventReplay: rng() < 0.1 }
  if (roll < 0.4) return { type: 'thought-chunk', source, agentId: AGENT, text: `t${Math.floor(rng() * 10)}`, replay: rng() < 0.2 }
  if (roll < 0.55) return { type: 'message-chunk', source, agentId: AGENT, text: `m${Math.floor(rng() * 10)}`, replay: rng() < 0.2 }
  if (roll < 0.7) {
    // 真实后端同 toolCallId 不重复发 tool_call：每 source 单调序列
    const seq = (toolSeq.get(source) ?? 0) + 1
    toolSeq.set(source, seq)
    return { type: 'tool-call', source, agentId: AGENT, toolCallId: `c${seq}`, title: 'Bash', rawInput: 'ls', replay: rng() < 0.2 }
  }
  if (roll < 0.8) {
    const seq = toolSeq.get(source) ?? 0
    if (seq === 0) return { type: 'message-chunk', source, agentId: AGENT, text: `m${Math.floor(rng() * 10)}`, replay: rng() < 0.2 }
    return { type: 'tool-call-update', source, agentId: AGENT, toolCallId: `c${1 + Math.floor(rng() * seq)}`, rawOutput: 'out', status: 'completed', replay: rng() < 0.2 }
  }
  if (roll < 0.9) {
    const cancelled = rng() < 0.3
    return { type: 'error', source, agentId: AGENT, error: cancelled ? 'cancelled' : 'err', cancelled, replay: rng() < 0.2, explicitReplay: rng() < 0.1 }
  }
  if (roll < 0.95) return { type: 'done', source, agentId: AGENT, replay: rng() < 0.2, explicitReplay: rng() < 0.1 }
  if (roll < 0.975) {
    // P1-04：plan 全量替换事件（含空快照清空）
    const count = Math.floor(rng() * 4)
    return {
      type: 'plan',
      source,
      entries: Array.from({ length: count }, (_, i) => ({
        content: `任务${i}`,
        status: rng() < 0.3 ? 'pending' : rng() < 0.5 ? 'in_progress' : 'completed',
      })),
      replay: rng() < 0.2,
    }
  }
  return { type: 'begin-cancel', source, agentId: AGENT }
}

function assertInvariants(s: ChatRuntimeState) {
  for (const [source, r] of Object.entries(s)) {
    // id 唯一（U2-C：只有 messages 一条路径）
    const ids = new Set<string>()
    for (const m of r.messages) {
      assert.equal(ids.has(m.id), false, `${source}: 消息 id 重复 ${m.id}`)
      ids.add(m.id)
    }
    // cancelState 状态机合法
    assert.ok(['idle', 'generating', 'canceling', 'cancelled', 'error'].includes(r.cancelState.status), `${source}: 非法 cancelState ${r.cancelState.status}`)
    // 消息 id 与 seq 的关系：seq 单调（seq 至少不小于最大消息序号）
    const maxSeq = Math.max(0, ...r.messages.map(m => {
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
    // P1-04：planEntries 恒为数组（替换语义不变量，含初值）
    assert.ok(Array.isArray(r.planEntries), `${source}: planEntries 必须是数组`)
  }
}

{
  const rng = mulberry32(20260801)
  let s: ChatRuntimeState = { [SKEY]: createSourceChatRuntime(SOURCE), [OTHER]: createSourceChatRuntime(OTHER) }
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

})
