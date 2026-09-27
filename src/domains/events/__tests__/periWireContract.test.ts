import { describe, expect, it } from 'vitest'
import { PERI_CAPS_KEYS, PERI_SKILL_NAMES_META_KEY, PERI_USAGE_META_KEYS } from '../periWireContract.ts'

/** #315 P2-8：Peri 扩展 wire 契约钉子——键名与上游 peri-acp-types
 * peri_caps.rs / peri-acp event mapper.rs 的 wire 形状逐字对照。上游契约
 * 变更时本测试先红，防止消费端静默漂移。 */
describe('Peri wire 契约单源（对照 peri_caps.rs / mapper.rs）', () => {
  it('caps 协商开关键名与 PeriCaps::from_client_meta 逐字一致', () => {
    expect(PERI_CAPS_KEYS).toEqual({
      tokenStats: 'peri.tokenStats',
      skillNames: 'peri.skillNames',
      replay: 'peri.replay',
      agentEvent: 'peri.agentEvent',
      agentEventDone: 'peri.agentEventDone',
      unstableEvent: 'peri.unstableEvent',
      prediction: 'peri.prediction',
    })
  })

  it('UsageUpdate._meta tokenStats 载荷键名与 mapper.rs LlmCallEnd 臂一致', () => {
    expect(PERI_USAGE_META_KEYS).toEqual({
      inputTokens: 'inputTokens',
      outputTokens: 'outputTokens',
      cacheCreationTokens: 'cacheCreationTokens',
      cacheReadTokens: 'cacheReadTokens',
      requestId: 'requestId',
      model: 'model',
      stopReason: 'stopReason',
    })
  })

  it('AvailableCommandsUpdate._meta.skillNames 键名一致', () => {
    expect(PERI_SKILL_NAMES_META_KEY).toBe('skillNames')
  })
})
