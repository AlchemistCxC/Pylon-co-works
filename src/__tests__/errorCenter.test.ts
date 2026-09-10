/**
 * ErrorCenter 指纹去重行为测试（报告 8.3）：
 * 同指纹聚合（count/首次/最后时间）、不同指纹独立、dismiss/clear。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { addError, clearErrors, dismissError, getDiagnosticErrors, getErrorHistory, getErrors, resolveRuntimeErrors } from '../errorCenter'

describe('ErrorCenter 指纹去重（报告 8.3）', () => {
  beforeEach(() => {
    clearErrors()
    // clearErrors intentionally hides only global presentation entries;
    // retire diagnostic entries as well so each store contract test starts
    // from an empty active index while preserving history semantics.
    resolveRuntimeErrors(() => true)
  })

  it('同指纹聚合：count 递增，不新增条目', () => {
    addError({ action: '读取 Agent 列表', message: 'down' })
    addError({ action: '读取 Agent 列表', message: 'down' })
    addError({ action: '读取 Agent 列表', message: 'down' })
    const entries = getErrors()
    expect(entries.length).toBe(1)
    expect(entries[0]?.count).toBe(3)
    expect(entries[0]?.firstAt).toBeLessThanOrEqual(entries[0]?.lastAt ?? 0)
  })

  it('不同指纹独立成条', () => {
    addError({ action: '读取 Agent 列表', message: 'down' })
    addError({ action: '保存网关配置', message: 'up' })
    expect(getErrors().length).toBe(2)
  })

  it('无显式 key 时不同来源的同文案不错误聚合或互相 resolve', () => {
    addError({ action: '读取状态', message: 'down', source: 'bootstrap' })
    addError({ action: '读取状态', message: 'down', source: 'runtime-sheet' })
    expect(getErrors()).toHaveLength(2)

    resolveRuntimeErrors({ source: 'bootstrap' })
    expect(getErrors()).toHaveLength(1)
    expect(getErrors()[0]?.source).toBe('runtime-sheet')
  })

  it('dismiss 单条后其余保留；clear 清空', () => {
    addError({ action: 'a', message: '1' })
    addError({ action: 'b', message: '2' })
    const latest = getErrors()[0]!  // 前插：最新（b）在首位
    dismissError(latest.id)
    expect(getErrors().length).toBe(1)
    expect(getErrors()[0]?.action).toBe('a')
    clearErrors()
    expect(getErrors().length).toBe(0)
  })

  it('全部清除只隐藏展示，不删除历史；同 key 新事件建立新的 active 记录', () => {
    addError({ action: '读取', message: 'down', key: 'read:one' })
    const first = getErrorHistory()[0]!
    clearErrors()
    expect(getErrors()).toHaveLength(0)
    expect(getErrorHistory()).toContainEqual(expect.objectContaining({ id: first.id, state: 'dismissed' }))

    addError({ action: '读取', message: 'down', key: 'read:one' })
    expect(getErrors()).toHaveLength(1)
    expect(getErrors()[0]?.id).not.toBe(first.id)
    expect(getErrorHistory().filter(entry => entry.key === 'read:one')).toHaveLength(2)
  })

  it('diagnostic 不进入全局 active 列表，但仍可查询', () => {
    addError({
      action: '恢复会话', message: '远端 replay 不可用',
      visibility: 'diagnostic', severity: 'warning',
      scope: { kind: 'session', id: 's1' },
    })
    expect(getErrors()).toHaveLength(0)
    expect(getDiagnosticErrors()).toHaveLength(1)
    expect(getErrorHistory()[0]).toMatchObject({ state: 'active', visibility: 'diagnostic' })
  })

  it('诊断事件不会把同 key 的可见失败降级为静默项', () => {
    addError({
      action: '恢复会话', message: '本地历史不可用', key: 'session-recovery:s1',
      source: 'chat.session-recovery', scope: { kind: 'session', id: 's1' },
    })
    addError({
      action: '恢复会话', message: '远端补充失败', key: 'session-recovery:s1',
      source: 'chat.session-recovery', scope: { kind: 'session', id: 's1' },
      visibility: 'diagnostic', severity: 'warning',
    })
    expect(getErrors()).toHaveLength(1)
    expect(getErrors()[0]?.message).toBe('本地历史不可用')
    expect(getDiagnosticErrors()).toHaveLength(1)
  })

  it('按 scope resolve，不误清另一会话；再次发生建立新 active 记录', () => {
    addError({ action: '恢复会话', message: 'down', scope: { kind: 'session', id: 's1' } })
    addError({ action: '恢复会话', message: 'down', scope: { kind: 'session', id: 's2' } })
    resolveRuntimeErrors({ action: '恢复会话', scope: { kind: 'session', id: 's1' } })
    expect(getErrors()).toHaveLength(1)
    expect(getErrors()[0]?.scope).toEqual({ kind: 'session', id: 's2' })
    expect(getErrorHistory().find(entry => entry.scope?.id === 's1')?.state).toBe('resolved')

    addError({ action: '恢复会话', message: 'down', scope: { kind: 'session', id: 's1' } })
    expect(getErrors()).toHaveLength(2)
    expect(getErrors().find(entry => entry.scope?.id === 's1')?.count).toBe(1)
  })
})
