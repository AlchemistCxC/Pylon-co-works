/**
 * #315 P2-8：Peri 扩展 wire 契约单源（对照上游 peri-acp-types/src/peri_caps.rs
 * `PeriCaps` 与 peri-acp/src/event/mapper.rs LlmCallEnd 的 tokenStats `_meta` 载荷）。
 *
 * 契约键名改动必须双侧（peri 上游 / Pylon 消费端）同步，并由
 * `periWireContract.test.ts` 钉住；消费端（acpNormalizer.normalizeUsageUpdate、
 * skillNamesOf）一律引用本模块常量，禁止散写字符串。
 */

/** `clientCapabilities._meta` 协商开关（Pylon 声明面：pylon-core default_initialize_caps）。 */
export const PERI_CAPS_KEYS = {
  tokenStats: 'peri.tokenStats',
  skillNames: 'peri.skillNames',
  replay: 'peri.replay',
  agentEvent: 'peri.agentEvent',
  agentEventDone: 'peri.agentEventDone',
  unstableEvent: 'peri.unstableEvent',
  prediction: 'peri.prediction',
} as const

/** `UsageUpdate._meta` tokenStats 载荷字段（peri mapper.rs LlmCallEnd 臂）。
 *  cacheCreationTokens 为 #315 新增消费；requestId/model/stopReason 是调用/轮次
 *  身份证据，收窄为字符串后随 usage 快照保留，不参与终态判定。 */
export const PERI_USAGE_META_KEYS = {
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  cacheCreationTokens: 'cacheCreationTokens',
  cacheReadTokens: 'cacheReadTokens',
  requestId: 'requestId',
  model: 'model',
  stopReason: 'stopReason',
} as const

/** `AvailableCommandsUpdate._meta.skillNames` 载荷键。 */
export const PERI_SKILL_NAMES_META_KEY = 'skillNames'
