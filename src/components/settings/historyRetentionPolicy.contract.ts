// 本文件由 scripts/generate-retention-policy.mjs 生成，**禁止手改**。
//
// 单源：src-tauri/pylon-session/src/retention.rs 的档位/默认值常量
//（#331/U3 裁决：成对 wire 契约以 Rust 为单源，TS 由脚本生成）。
// 改档位请改 Rust 侧，然后跑 `bun run build:retention-policy`；
// `bun run check:retention-policy` 会在不同步时报红。

/**
 * 按时间保留的档位（天）。档位即契约：越档值视为非法 → 回退永久保存。
 */
export const RETENTION_TIME_DAYS = [7, 30, 90, 180, 365] as const
/**
 * 按数量保留的档位（每 Session 消息条数）。
 */
export const RETENTION_COUNT_LIMITS = [100, 500, 1000, 5000, 10000] as const
/**
 * 选择按时间保留时的默认档位（天）。Rust 单源定义（#331/U3 裁决）：TS 侧
 * 同名常量由 scripts/generate-retention-policy.mjs 从本文件生成并经
 * check:retention-policy 门禁校验；Rust 运行时无直接消费者（UI 展示读 TS 侧），
 * 保留为单源锚点。
 */
export const DEFAULT_TIME_DAYS = 30
/**
 * 选择按数量保留时的默认档位（条）。单源定义（同 DEFAULT_TIME_DAYS）。
 */
export const DEFAULT_COUNT_LIMIT = 1000
