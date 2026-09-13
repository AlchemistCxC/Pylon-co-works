// 迁移自 scripts/test-browser-state.mts（P91 A1）；按被测模块落位至此（W4-04 启动错误分类段）。
import { describe, expect, it } from 'vitest'
import { classifyBrowserStartError } from '../browserContracts.ts'

describe('classifyBrowserStartError — 启动错误分类（W4-04，迁移自 scripts/test-browser-state.mts，P91 A1）', () => {
  it('命令不存在 → blocked；其余 → error 带消息', () => {
    expect(classifyBrowserStartError(new Error('Command not found: browser_start'))).toEqual({ kind: 'blocked' })
    expect(classifyBrowserStartError('browser_start 不存在')).toEqual({ kind: 'blocked' })
    expect(classifyBrowserStartError('protocol_error')).toEqual({ kind: 'error', message: 'protocol_error' })
  })
})
