// 本文件由 scripts/generate-canonical-event-types.mjs 生成，**禁止手改**。
//
// 单源：src-tauri/pylon-canonical-types/src/lib.rs 的 canonical_event_types! 宏调用
// （enum / as_str / from_wire / 词表数组由同一份 `Variant => "wire"` 列表展开）。
// 改词表请改 Rust 侧，然后跑 `bun run build:canonical-types`；
// `bun run check:canonical-types` 会在不同步时报红。

export const CANONICAL_EVENT_TYPES = [
  'user.message',
  'assistant.text.delta',
  'assistant.thinking.delta',
  'assistant.text.delta.batch',
  'assistant.thinking.delta.batch',
  'tool.call.started',
  'tool.call.updated',
  'tool.call.completed',
  'tool.call.failed',
  'interaction.requested',
  'interaction.answered',
  'turn.completed',
  'turn.failed',
  'turn.unit',
  'usage.updated',
  'plan.replaced',
  'session.mode-updated',
  'session.model-updated',
  'session.config-updated',
  'session.commands-updated',
  'history.snapshot',
  'unknown',
] as const
