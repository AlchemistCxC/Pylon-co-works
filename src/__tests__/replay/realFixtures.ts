/**
 * 真实捕获的 wire fixture → 重放场景。
 *
 * ## 为什么必须接进来
 *
 * 本目录此前的 31 个场景**全部是我自己写的**。仓库里其实已有真实捕获的 ACP 载荷
 * （`src/domains/workbench/normalizers/__tests__/fixtures/`，hermes 与 claude 两家的
 * 真机样本），但它们只被 normalizer 测试使用。把真样本喂进不变量，才能覆盖我从没
 * 想到的字段组合。
 *
 * ## 接入后立刻发现的一处脆弱（已修）
 *
 * 真样本**同时使用两种键名约定**：claude 的 `tool_call` 用驼峰 `sessionUpdate` /
 * `toolCallId`，hermes 的结构化结果用蛇形 `session_update` / `tool_call_id`。
 * 而绝对 oracle 的 `expectedAssistantText` 原本只认 `agent_message_chunk` 驼峰形式，
 * 在真实数据上会**静默少数文本**（断言仍绿，因为期望值也被少数了）。这就是"接入真实
 * 形态"的直接价值：它暴露了只靠自造 fixture 永远发现不了的脆弱。
 *
 * ## 刻意只用工具类样本
 *
 * 真样本里的 `tool_call*` 类载荷不含正文，因此可以安全地与自造文本 run 交错——用来
 * 检验"工具卡切断 run"这一真实形态，而不会干扰正文期望值。
 */
import { readFileSync } from 'node:fs'
import type { Scenario } from './fixtures.ts'
import { scenarioOf } from './fixtures.ts'
import { rawDone, rawText, rawUser } from './harness.ts'

const FIXTURE_DIR = new URL('../../domains/workbench/normalizers/__tests__/fixtures/', import.meta.url)

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), 'utf8')) as Record<string, unknown>
}

/** 真样本是 ACP 的 session-update 载荷，缺一个 wire 信封——按生产形状补上。 */
function asWire(update: unknown): unknown {
  return { source: 'local:s1', update }
}

/** claude 真样本：同一工具卡（cc-bash-1）的 pending → in_progress → completed 三步生命周期。 */
export function claudeBashLifecycleWires(): readonly unknown[] {
  const fixture = loadFixture('claude-acp-wire')
  return [fixture.start, fixture.progress, fixture.complete].map(asWire)
}

/** hermes 真样本：四条结构化工具结果（search / skill / terminal / memory）。 */
export function hermesStructuredResultWires(): readonly unknown[] {
  const fixture = loadFixture('hermes-structured-results')
  return Object.keys(fixture).map(key => asWire(fixture[key]))
}

/** hermes 真样本：单条工具卡起（terminal）与单条更新（search）。 */
export function hermesToolCardWires(): readonly unknown[] {
  return [loadFixture('hermes-tool-call-start'), loadFixture('hermes-tool-call-complete')].map(asWire)
}

/**
 * 真实载荷场景：把真样本与自造文本 run 交错，检验"工具类非 delta 行切断 run"在真实
 * 字段组合下依然成立（含蛇形键名、content 数组、structured rawOutput）。
 */
export const REAL_FIXTURE_SCENARIOS: readonly Scenario[] = [
  scenarioOf('真实·claude bash 工具卡三步生命周期切断 run', [
    rawUser('问题'),
    rawText('前段'),
    ...claudeBashLifecycleWires(),
    rawText('后段'),
    rawDone(),
  ]),
  scenarioOf('真实·hermes 四条结构化工具结果连续切断', [
    rawUser('问题'),
    rawText('甲'),
    ...hermesStructuredResultWires(),
    rawText('乙'),
    rawDone(),
  ]),
  scenarioOf('真实·hermes 工具卡起止（不同 toolCallId）', [
    rawUser('问题'),
    ...hermesToolCardWires(),
    rawText('中间文本'),
    rawDone(),
  ]),
  scenarioOf('真实·两回合各带真实工具卡', [
    rawUser('第一问'),
    rawText('一答'),
    ...claudeBashLifecycleWires(),
    rawDone(),
    rawUser('第二问'),
    ...hermesStructuredResultWires(),
    rawText('二答'),
    rawDone(),
  ]),
]
