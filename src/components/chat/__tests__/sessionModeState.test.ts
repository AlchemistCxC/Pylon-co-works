// 迁移自 scripts/test-session-context-mode.mts 与 scripts/test-session-mode.mts（P91 A1，
// 施工书处置：两脚本同被测 sessionModeState.ts，合入本文件分别 describe）。
import { describe, expect, it } from 'vitest'
import { extractMode, extractUsage, sessionResponseObject } from '../acpTypes.ts'
import { applySessionModeChange, nextSessionMode, normalizeSessionMode, resolvePreviousSessionMode } from '../sessionModeState.ts'

describe('session mode 轮换与 ACP usage 提取（原 test-session-context-mode.mts）', () => {
  it('sessionResponseObject + extractMode 应保留 Peri 的 accept_edit mode ID', () => {
    const response = sessionResponseObject({
      sessionId: 'peri-a',
      modes: { currentModeId: 'accept_edit' },
    })
    expect(extractMode(response)).toBe('accept_edit')
  })

  it('nextSessionMode 轮换：default→accept_edit→auto→bypass→default；兼容旧 edit 但不得再发出 edit', () => {
    expect(nextSessionMode('default')).toBe('accept_edit')
    expect(nextSessionMode('accept_edit')).toBe('auto')
    expect(nextSessionMode('auto')).toBe('bypass')
    expect(nextSessionMode('bypass')).toBe('default')
    expect(nextSessionMode('edit')).toBe('auto')
  })

  it('extractUsage 应读取 ACP UsageUpdate 的标准 used/size 字段', () => {
    expect(extractUsage({
      sessionUpdate: 'usage_update',
      used: 3210,
      size: 200000,
      _meta: { cacheReadTokens: 987 },
    })).toEqual({
      tokensUsed: 3210,
      tokensMax: 200000,
      cacheReadTokens: 987,
    })
  })

  it('extractUsage 应兼容旧 value 字段', () => {
    expect(extractUsage({
      sessionUpdate: 'usage_update',
      value: 123,
      size: 1000,
    })).toEqual({
      tokensUsed: 123,
      tokensMax: 1000,
      cacheReadTokens: 0,
    })
  })
})

describe('applySessionModeChange 变更与回滚（原 test-session-mode.mts）', () => {
  it('成功路径：写新 mode 并按 Session.source 调用 set_mode', async () => {
    const writes: string[] = []
    const calls: Array<{ source: string; mode: string }> = []
    await applySessionModeChange({
      source: 'local:a',
      nextMode: 'edit',
      previousMode: 'auto',
      writeMode: mode => writes.push(mode),
      invokeSet: async (source, mode) => { calls.push({ source, mode }) },
    })
    expect(writes).toEqual(['edit'])
    expect(calls).toEqual([{ source: 'local:a', mode: 'edit' }])
  })

  it('set_mode 失败必须回滚旧 mode', async () => {
    const writes: string[] = []
    await expect(applySessionModeChange({
      source: 'local:b',
      nextMode: 'bypass',
      previousMode: 'default',
      writeMode: mode => writes.push(mode),
      invokeSet: async () => { throw new Error('set mode failed') },
    })).rejects.toThrow(/set mode failed/)
    expect(writes).toEqual(['bypass', 'default'])
  })

  it('缺省 previousMode 时必须回滚到明确 default', async () => {
    const writes: string[] = []
    await expect(applySessionModeChange({
      source: 'local:c',
      nextMode: 'auto',
      writeMode: mode => writes.push(mode),
      invokeSet: async () => { throw new Error('set mode failed without previous') },
    })).rejects.toThrow(/set mode failed without previous/)
    expect(writes).toEqual(['auto', 'default'])
  })

  it('resolvePreviousSessionMode / nextSessionMode / normalizeSessionMode 边界', () => {
    expect(resolvePreviousSessionMode(undefined)).toBe('default')
    expect(resolvePreviousSessionMode('edit')).toBe('accept_edit')
    expect(nextSessionMode('unknown')).toBe('accept_edit')
    expect(normalizeSessionMode('edit')).toBe('accept_edit')
    expect(normalizeSessionMode('invalid')).toBe(null)
  })
})
