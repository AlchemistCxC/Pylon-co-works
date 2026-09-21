/**
 * wireGuards — wire 值（unknown payload）判型/收敛共享叶帮手。
 *
 * #228 批次D 收敛：此前 isRecord / record / text 以复制粘贴形式散布在
 * domains/rendererContent、plugins/core/*、renderers/solid-workbench/chat、
 * infrastructure/acp 等处；本模块是唯一权威版本，签名与被收敛的多数派逐字一致。
 * 纯叶子模块：零依赖，任何层均可安全引用。
 *
 * 已知存活的本地变体（有意不收敛，签名/语义有微妙差异）：
 * - chat/markdownRenderModel.ts 的 isRecord 不含 !Array.isArray 检查（数组按对象放行）；
 * - infrastructure/tauri/petContracts.ts 的 record 不含 !Array.isArray 检查；
 * - plugins/core/file/builtinFileCommands.ts 的 text 带 optional 参数（错误文案也不同）；
 * - plugins/core/renderer/builtinPresentationCommands.ts 的同逻辑帮手名为 id。
 */

/** wire 对象判型：普通对象（非 null、非数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** wire 对象收敛：合法对象原样返回，其余落空对象（读侧宽容，不抛）。 */
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 非空字符串字段提取：空串/非字符串抛带字段名的错（命令参数校验语义）。 */
export function text(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空字符串`)
  return value.trim()
}
