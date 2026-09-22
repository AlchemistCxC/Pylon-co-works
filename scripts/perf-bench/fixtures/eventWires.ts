// events 域的原始 wire 输入面（`normalizeRawEvent` 的入参）。
//
// 两路来源，都取「真实存在过的形状」：
// 1. **自造**：形状逐字抄自 `src/__tests__/replay/harness.ts` 的 `raw*()` 构造器
//    （`{ source, update }` 信封 + ACP session-update 载荷），注释里的形状说明一并保留。
// 2. **真机捕获**：`src/domains/workbench/normalizers/__tests__/fixtures/*.json`
//    （claude / hermes 两家的真实载荷）。缺一个 wire 信封，按生产形状补上
//    ——与 `src/__tests__/replay/realFixtures.ts` 的 `asWire` 同语义。
//
// 为什么不用「只造一种 wire 跑一万遍」：`normalizeRawEvent` 的成本随 update 形状变
// （工具卡要解析 rawInput/content 数组，纯文本 delta 不用），单一形状的均值没有代表性。

import { readFileSync } from 'node:fs'

const FIXTURE_DIR = new URL('../../../src/domains/workbench/normalizers/__tests__/fixtures/', import.meta.url)

/** 真机捕获载荷缺一个 wire 信封——按生产形状补上。 */
function asWire(update: unknown): unknown {
  return { source: 'local:bench', update }
}

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8')) as Record<string, unknown>
}

export function rawText(text: string, messageId = 'msg-1'): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId } }
}
export function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId } }
}
export function rawUser(text: string): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}
export function rawToolStart(toolCallId: string, title = 'Read'): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'read' } }
}
/** markdown 内容类型：落盘侧按 `"type":"markdown"` 判定 run 的 markdown 标记。 */
export function rawMarkdown(text: string, messageId = 'msg-1'): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'markdown', text }, messageId } }
}
/** 回合中途的状态行（真实库里存在：usage.updated / session.commands-updated）——必须切断 delta run。 */
export function rawUsage(size: number, used: number): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'usage_update', size, used } }
}
export function rawCommands(): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help' }] } }
}
export function rawDone(): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'done' } }
}
export function rawFailed(): unknown {
  return { source: 'local:bench', update: { sessionUpdate: 'error', error: 'provider failed' } }
}

/** 真机捕获：claude bash 工具卡 pending → in_progress → completed 三步生命周期。 */
export function claudeBashLifecycleWires(): readonly unknown[] {
  const fixture = loadFixture('claude-acp-wire')
  return [fixture.start, fixture.progress, fixture.complete].map(asWire)
}

/** 真机捕获：hermes 四条结构化工具结果（search / skill / terminal / memory）。 */
export function hermesStructuredResultWires(): readonly unknown[] {
  const fixture = loadFixture('hermes-structured-results')
  return Object.keys(fixture).map(key => asWire(fixture[key]))
}

/** 真机捕获：hermes 工具卡起（terminal）与单条更新（search），两个不同 toolCallId。 */
export function hermesToolCardWires(): readonly unknown[] {
  return [loadFixture('hermes-tool-call-start'), loadFixture('hermes-tool-call-complete')].map(asWire)
}

/**
 * 一个完整回合的 wire 序列（自造）：user 提问 → 思考 → markdown 正文 → 文本补充 →
 * 工具卡起止 → 工具结果 → 状态行 → 终态。重复 `turns` 轮即得规模档。
 *
 * 形状取自 `src/__tests__/replay/harness.ts` 的 `COMPOSED_WIRES` / `IN_FLIGHT_WIRES`
 * 与 `realFixtures.ts` 的真实场景组合（「工具类非 delta 行切断 run」的真实字段组合）。
 */
export function turnWires(turns: number): unknown[] {
  const wires: unknown[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    const toolCallId = `tool-${turn}`
    const messageId = `m-${turn}`
    wires.push(
      rawUser(`第 ${turn} 个问题`),
      rawThinking(`第 ${turn} 轮思考内容，含中文与 ASCII。`),
      rawMarkdown(`**答案 ${turn}**\n\n正文段落。`, messageId),
      rawText('补充一句。', messageId),
      rawToolStart(toolCallId, `读取文件 ${turn}`),
      ...claudeBashLifecycleWires(),
      ...hermesStructuredResultWires(),
      rawUsage(200_000, 12_345 + turn),
      rawCommands(),
      rawDone(),
    )
  }
  return wires
}

/** 畸形/非 ACP 形状（`malformed` 分支）：不可能出现的载荷必须与合法载荷一样被计入成本。 */
export function malformedWires(): unknown[] {
  return [
    null,
    42,
    'not-an-object',
    [],
    {},
    { source: 'local:bench' },
    { source: 'local:bench', update: null },
    { source: 'local:bench', update: { sessionUpdate: 42 } },
    { source: 'local:bench', update: { sessionUpdate: 'totally_unknown_update', payload: { deep: [1, 2, 3] } } },
    { params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP params 信封' } } } },
    { params: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '扁平 params' } } },
  ]
}
