// 本文件由 scripts/generate-export-sanitize-vocabulary.mjs 生成，**禁止手改**。
//
// 单源：src-tauri/pylon-foundations/src/sanitize.rs 的 is_export_sensitive_key
//（#444 批次②：export Strip 词表以 Rust 为单源，TS 侧由脚本生成）。
// 改词表请改 Rust 侧，然后跑 `bun run build:export-sanitize-vocabulary`；
// `bun run check:export-sanitize-vocabulary` 会在不同步时报红。
// 值正则有意不生成（Rust regex 与 JS 方言差异），两侧字面量一致性由
// scripts/sanitize-vocabulary.test.mts 门禁看守。
//
// 单源函数文档：
// export 语义 key 表：敏感 key 子树整体剔除（不含 content——markdown 正文结构键）。
// 优化-11：token/apikey/api_key 改为后缀匹配，与 runtime_log 表（O26）对齐——
// tokensTotal/inputTokenCount/tokenStats/tokenCount 等统计键不再误伤；
// `tokenvalue` 精确名保留（按命名即 token 值容器，且为既有基线测试契约）；
// `secret` 保持 contains 语义（无统计键碰撞，且覆盖 client_secret/clientSecret 形态）；
// 值内容仍由 sanitize_value_content 兜底（password/token 等值形态整体 REDACTED）。

/** exact 命中即整个 key 剔除（Strip 策略，大小写不敏感）。
 */
export const EXPORT_SANITIZE_EXACT_KEYS = [
  'rawinput',
  'rawoutput',
  'prompt',
  'persona',
  'headers',
  'env',
  'authorization',
  'password',
  'cookie',
  'credential',
  'tokenvalue',
] as const

/** 后缀命中即剔除（tokensTotal 等统计键不误伤）。
 */
export const EXPORT_SANITIZE_SUFFIXES = [
  'token',
  'apikey',
  'api_key',
] as const

/** contains 命中即剔除（覆盖 client_secret/clientSecret 形态）。
 */
export const EXPORT_SANITIZE_CONTAINS = [
  'secret',
] as const
