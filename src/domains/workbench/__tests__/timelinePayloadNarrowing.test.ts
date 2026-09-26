/**
 * #375-a：`timeline.data` 的事件族收窄——载荷单一持有。
 *
 * 载荷的消费者只有 `toolInvocationSnapshot`（读 `activities[]`）；timeline 里那份整份
 * 语义事件没有任何生产读者（只有 session 族的 `type`/`status`/`options` 被读）。本文件
 * 钉住：tool / activity 两族的 `timeline.data` 只留标量面 + 被省略的键名清单，载荷仍完整
 * 归 `activities[]`；逃生口（`setTimelinePayloadNarrowing(false)`）能回到整份事件。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  reduceWorkbenchEvent,
  setTimelinePayloadNarrowing,
  toolInvocationSnapshot,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'
import { withoutEnvelopeRaw } from '../../../sheets/agent-workbench/agentWorkbenchProjection.ts'

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(sequence: number, event: WorkbenchSemanticEvent, toolCallId: string): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity: { toolCallId },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

const bigParts = [{ kind: 'text' as const, text: 'x'.repeat(4096) }]

function toolDocument(): WorkbenchDocument {
  return reduce([
    envelope(1, {
      type: 'tool.started',
      tool: {
        name: 'Bash',
        title: '跑构建',
        status: 'running',
        input: { command: 'bun run build' },
        rawInput: { command: 'bun run build' },
        parts: bigParts,
      },
    }, 'call-a'),
  ])
}

afterEach(() => { setTimelinePayloadNarrowing(true) })

describe('#375-a timeline.data 收窄（tool / activity 族）', () => {
  it('tool 族的 timeline.data 只留标量，载荷键名如实列出', () => {
    const document = toolDocument()
    const entry = document.timeline.find(item => item.kind === 'tool')
    expect(entry).toBeDefined()
    const data = entry!.data as Record<string, unknown>
    expect(data.type).toBe('tool.started')
    // 一层内嵌对象的标量面保留（插件读的 name/title/status 就在这一层）
    const tool = data.tool as Record<string, unknown>
    expect(tool.name).toBe('Bash')
    expect(tool.title).toBe('跑构建')
    expect(tool.status).toBe('running')
    // 载荷载体（第三层对象 / 数组）被省略，键名以点分路径如实列出
    expect(tool.input).toBeUndefined()
    expect(tool.parts).toBeUndefined()
    expect(tool.rawInput).toBeUndefined()
    expect(data.payloadKeys).toEqual(['tool.input', 'tool.rawInput', 'tool.parts'])
  })

  it('载荷仍完整归 activities[]，且 toolInvocationSnapshot 照旧读得到', () => {
    const document = toolDocument()
    const node = document.activities.find(item => item.kind === 'tool')
    expect(node).toBeDefined()
    expect(node!.parts).toEqual(bigParts)
    expect(node!.input).toEqual({ command: 'bun run build' })
    const snapshot = toolInvocationSnapshot(document, 'call-a')
    expect(snapshot?.input).toEqual({ command: 'bun run build' })
    expect(snapshot?.result?.parts).toEqual(bigParts)
  })

  it('session 族不收窄：终态判定与协商守卫读的字段逐字保留', () => {
    const document = reduce([
      envelope(1, { type: 'session.started', options: [{ id: 'model', value: 'm' }] } as unknown as WorkbenchSemanticEvent, 'call-a'),
    ])
    const entry = document.timeline.find(item => item.kind === 'session')
    expect((entry!.data as { options?: unknown }).options).toEqual([{ id: 'model', value: 'm' }])
  })

  it('逃生口关掉收窄后 timeline.data 回到整份语义事件', () => {
    setTimelinePayloadNarrowing(false)
    try {
      const document = toolDocument()
      const data = document.timeline.find(item => item.kind === 'tool')!.data as Record<string, unknown>
      expect((data.tool as Record<string, unknown>).parts).toEqual(bigParts)
      expect(data.payloadKeys).toBeUndefined()
    } finally {
      setTimelinePayloadNarrowing(true)
    }
  })
})

describe('#375-c / #375-e 载荷单一持有的另外两半', () => {
  it('#375-e 载荷不再克隆：活动节点与信封事件共享同一批对象，且已冻结（写即抛）', () => {
    const parts = [{ kind: 'text' as const, text: 'x'.repeat(64) }]
    const env = envelope(1, { type: 'tool.started', tool: { name: 'Bash', parts } }, 'call-a')
    const document = reduce([env])
    const node = document.activities.find(item => item.kind === 'tool')!
    // 同一批对象（引用同一性），不是 structuredClone 出来的第二份
    expect(node.parts).toBe((env.event as unknown as { tool: { parts: unknown } }).tool.parts)
    expect(Object.isFrozen(node.parts)).toBe(true)
    expect(() => { (node.parts as unknown[]).push({ kind: 'text', text: 'y' }) }).toThrow()
    // 输入的那份数组本身也被冻结（冻结发生在边界，不产生第七份副本）
    expect(Object.isFrozen(parts)).toBe(true)
  })

  it('#375-c fold.log 副本剥掉 wire 原始 JSON，原信封契约不变', () => {
    const env = createWorkbenchEnvelope({
      ...base,
      sequence: 1,
      source: { provider: base.provider, sourceId: 'wire-1' },
      identity: { toolCallId: 'call-a' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'tool.started', tool: { name: 'Bash' } },
      raw: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-a' } },
    })
    expect(env.raw).toBeDefined()
    const logged = withoutEnvelopeRaw(env)
    expect(logged.raw).toBeUndefined()
    expect(logged.rawMetadata).toBeUndefined()
    // 其余字段逐字段保留（回滚重折算的就是这些）
    expect(logged.eventId).toBe(env.eventId)
    expect(logged.event).toBe(env.event)
    expect(logged.identity).toEqual(env.identity)
    expect(logged.coverage).toEqual(env.coverage)
    // 原信封未被改写
    expect(env.raw).toBeDefined()
    // 幂等：已剥过的再剥返回自身
    expect(withoutEnvelopeRaw(logged)).toBe(logged)
  })
})

  it('#375-a 长正文（rawOutput.text 这类）不进 timeline.data，短身份标量照留', () => {
    const document = reduce([
      envelope(1, {
        type: 'tool.completed',
        tool: { name: 'Bash', status: 'completed', rawOutput: { type: 'text', text: 'x'.repeat(4096) } },
      }, 'call-a'),
    ])
    const data = document.timeline.find(item => item.kind === 'tool')!.data as Record<string, unknown>
    const tool = data.tool as Record<string, unknown>
    expect(tool.name).toBe('Bash')
    expect(tool.status).toBe('completed')
    expect(tool.rawOutput).toBeUndefined()
    expect(data.payloadKeys).toEqual(['tool.rawOutput'])
  })

describe('#375-d 同内容元数据快照复用', () => {
  const commands = Array.from({ length: 40 }, (_, index) => ({ name: `cmd-${index}`, description: 'x'.repeat(200) }))
  const commandsEnvelope = (sequence: number, payload: unknown) => createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `wire-${sequence}` },
    identity: {},
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'session.commands-updated', commands: payload } as unknown as WorkbenchSemanticEvent,
  })

  it('内容相同的 commands-updated 复用同一事件对象（N 行 → 一份，timeline 与信封共享）', () => {
    const envelopes = [1, 2, 3, 4, 5].map(sequence => commandsEnvelope(sequence, commands))
    for (const envelope of envelopes) expect(envelope.event).toBe(envelopes[0].event)
    const document = envelopes.reduce(reduceWorkbenchEvent, createWorkbenchDocument('s'))
    const entries = document.timeline.filter(item => item.kind === 'session')
    expect(entries).toHaveLength(5)
    for (const entry of entries) expect(entry.data).toBe(envelopes[0].event)
  })

  it('内容不同不合并（同一类型、不同快照各留一份）', () => {
    const first = commandsEnvelope(1, commands)
    const second = commandsEnvelope(2, commands.slice(0, 3))
    expect(second.event).not.toBe(first.event)
  })
})

describe('#375-c 接线守卫（这条曾经静默失效过）', () => {
  it('foldPage 入日志走 withoutEnvelopeRaw，而不是直接 push 原信封', () => {
    // 为什么用源码断言：`fold.log` 是运行时内部状态，没有观测面；而「helper 写了但没接线」
    // 恰恰是本批真实发生过的一次错误（一次失败的脚本编辑只落了 import、没落调用点，
    // 类型检查也不报错——import 有使用点即可）。这条守卫让那种静默失效无法通过测试。
    const source = readFileSync(
      fileURLToPath(new URL('../../../sheets/agent-workbench/agentWorkbenchSession.ts', import.meta.url)),
      'utf8',
    )
    const pushLines = source.split('\n').filter(line => line.includes('fold.log.push('))
    expect(pushLines).toHaveLength(1)
    expect(pushLines[0]).toContain('withoutEnvelopeRaw(')
  })
})
