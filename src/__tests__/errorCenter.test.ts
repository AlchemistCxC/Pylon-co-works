/**
 * ErrorCenter 指纹去重行为测试（报告 8.3）：
 * 同指纹聚合（count/首次/最后时间）、不同指纹独立、dismiss/clear。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { addError, clearErrors, dismissError, getErrors } from '../errorCenter'

describe('ErrorCenter 指纹去重（报告 8.3）', () => {
  beforeEach(() => {
    clearErrors()
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
})
