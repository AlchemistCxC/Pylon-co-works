/**
 * deferrableDisposable — 「先造占位、后补实现」的 AsyncDisposable 工厂。
 *
 * #228 批次D 收敛：applicationRuntime / plugin-runtime reactiveRegistry /
 * workspace-sheets workspaceRegistry 三处注册事务的 staged 条目共用同一形态——
 * 注册路径必须先构造宿主条目（entry/cancelled），再以闭包补齐 proxy（dispose
 * 需要回读宿主条目状态），于是 proxy 字段先以占位初始化、紧接同一同步块内覆写。
 * 占位只在条目构造语句与覆写赋值之间存活，宿主条目进入 staged（或返回调用方）
 * 前真实实现必然就位，因此占位的 dispose 永不可达。工厂把这一处类型骇法
 * 集中化并文档化，调用方语义与原内联写法逐字等价。
 */
// 类型权威在 plugin-runtime/registry/types.ts（结构类型 { dispose(): void | Promise<void> }）；
// type-only 引用编译期擦除，本模块保持运行时零依赖叶。
import type { AsyncDisposable } from '../plugin-runtime/registry/types.ts'

export function createDeferrableDisposable(): AsyncDisposable {
  return undefined as unknown as AsyncDisposable
}
