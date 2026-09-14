/**
 * 只读诊断注册表（验收/开发期接缝，台账 P89 / 施工书 S0）。
 *
 * 背景：真机会话里的子系统读数（流式发布节奏、行几何……）需要能被验收桥**按需拉取**，
 * 而子系统只在挂载时才存在。本注册表让子系统登记一个**纯读回调**，由验收桥在调用时懒取：
 * 不新增 window 协议、不让子系统写全局（守住 S0 的 I5）。
 *
 * 载荷形态：子系统给出 **JSON 文本**，宿主在边界解码成 `RendererDiagnosticsValue`——
 * JSON 文本能表达的只有 JSON 值，所以解码结果天然是"可复制、可粘贴进台账"的纯数据，
 * 且宿主不需要知道任何子系统的具体类型（层次不反向依赖）。
 *
 * 约束：
 * - reader 必须是纯读：不得改任何状态、不得有副作用；抛错会被收敛成 `failed`，不影响调用方，
 *   也不允许让诊断把业务打挂。
 * - 本模块**刻意不进** `plugin-runtime/renderers/index.ts` 的公开导出面：它是宿主内部接缝，
 *   不是给插件用的 API。
 */

/** JSON 可表达的诊断载荷（普通数据，无函数/DOM/循环引用）。 */
export type RendererDiagnosticsValue =
  | string
  | number
  | boolean
  | null
  | readonly RendererDiagnosticsValue[]
  | { readonly [key: string]: RendererDiagnosticsValue }

/** 子系统登记的回调：返回 JSON 文本。 */
export type RendererDiagnosticsReader = () => string

/** 拉取结果：三态显式，调用方无需猜。 */
export type RendererDiagnosticsResult =
  | { readonly status: 'ok'; readonly key: string; readonly value: RendererDiagnosticsValue }
  | { readonly status: 'missing'; readonly key: string }
  | { readonly status: 'failed'; readonly key: string; readonly message: string }

const readers = new Map<string, RendererDiagnosticsReader>()

/** 登记一个只读读数；返回幂等注销函数。 */
export function registerRendererDiagnostics(key: string, reader: RendererDiagnosticsReader): () => void {
  readers.set(key, reader)
  return () => {
    if (readers.get(key) === reader) readers.delete(key)
  }
}

/**
 * 按 key 拉取读数：未登记 → `missing`；reader 抛错或产物不是合法 JSON → `failed`。
 * 边界解码保证返回值是命名域类型（`RendererDiagnosticsValue`），而不是 unknown。
 */
export function readRendererDiagnostics(key: string): RendererDiagnosticsResult {
  const reader = readers.get(key)
  if (reader === undefined) return { status: 'missing', key }
  let text: string
  try {
    text = reader()
  } catch (error) {
    return { status: 'failed', key, message: error instanceof Error ? error.message : String(error) }
  }
  try {
    // JSON 文本 → JSON 值：解码即边界，载荷由子系统自描述。
    const value: RendererDiagnosticsValue = JSON.parse(text)
    return { status: 'ok', key, value }
  } catch (error) {
    return { status: 'failed', key, message: `not json: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 已登记的读数 key，供验收桥列出可用项。 */
export function listRendererDiagnosticsKeys(): readonly string[] {
  return [...readers.keys()]
}
