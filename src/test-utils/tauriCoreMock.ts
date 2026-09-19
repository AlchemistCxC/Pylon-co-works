import { vi } from 'vitest'

export type TauriInvokeHandler = (cmd: string, args?: Record<string, unknown>) => unknown

/**
 * #193：`@tauri-apps/api/core` 测试 mock 的单一来源。
 *
 * 52 个测试文件此前各自内联 `vi.mock` 工厂：invoke 实现各文件不同（合法——
 * 行为本就该 per-file），但 mock 形状（Channel 类、invoke 的 vi.fn 包装）与
 * 惯用法反复拷贝。本工厂只统一**形状**，**行为**由各文件以 handler 传入，
 * 迁移不改变任何文件的语义。
 *
 * 用法（vi.mock 调用会被 vitest 提升，工厂内引用顶层 import 会踩 TDZ，
 * 因此在工厂内部用动态 import 拿本模块）：
 *
 *   vi.mock('@tauri-apps/api/core', async () => {
 *     const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
 *     return tauriCoreMock((cmd, args) => { ...本文件行为... })
 *   })
 *
 * invoke 返回值是 vi.fn，测试体可直接 `import { invoke } from '@tauri-apps/api/core'`
 * 后对它断言（mockImplementationOnce / toHaveBeenCalled 等原习惯用法不变）。
 */
export function tauriCoreMock(handler: TauriInvokeHandler): Record<string, unknown> {
  return {
    invoke: vi.fn(handler),
    Channel: class {
      id = 0
      onmessage = () => {}
    },
  }
}
