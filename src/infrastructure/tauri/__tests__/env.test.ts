// 迁移自 scripts/test-background-image.mts（P91 A1）；hasTauriRuntime 部分按被测模块落位至此。
import { describe, expect, it } from 'vitest'
import { hasTauriRuntime } from '../env.ts'

describe('hasTauriRuntime — Tauri 运行时探测（迁移自 scripts/test-background-image.mts，P91 A1）', () => {
  it('双探测字段任一命中即为 Tauri runtime，否则 false', () => {
    expect(hasTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true)
    expect(hasTauriRuntime({ __TAURI__: {} })).toBe(true)
    expect(hasTauriRuntime({})).toBe(false)
  })
})
