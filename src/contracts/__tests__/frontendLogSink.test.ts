import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installFrontendLogSink,
  logError,
  logWarn,
  resetFrontendLogSinkForTest,
  type FrontendLogSink,
} from '../frontendLogSink.ts'

describe('frontendLogSink（#488 批⑦）', () => {
  afterEach(() => {
    resetFrontendLogSinkForTest()
    vi.restoreAllMocks()
  })

  it('缺省出口是 console：warn/error 原样透传（含 detail）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    logWarn('无详情告警')
    logWarn('带详情告警', { code: 1 })
    logError('无详情错误')
    logError('带详情错误', new Error('boom'))
    expect(warn.mock.calls).toEqual([['无详情告警'], ['带详情告警', { code: 1 }]])
    expect(error.mock.calls[0]).toEqual(['无详情错误'])
    expect((error.mock.calls[1]![1] as Error).message).toBe('boom')
  })

  it('换装后调用进入新出口，且出口抛错不得上浮（日志故障不影响功能）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const received: Array<[string, unknown] | [string]> = []
    const sink: FrontendLogSink = {
      warn: (message, detail) => {
        received.push(detail === undefined ? [message] : [message, detail])
        if (message === 'poison') throw new Error('sink 内部故障')
      },
      error: () => {},
    }
    installFrontendLogSink(sink)
    logWarn('第一条款')
    logWarn('带详情', 42)
    expect(received).toEqual([['第一条款'], ['带详情', 42]])
    // 出口自身抛错：静默回落 console，调用方不感知（约束：不得因日志故障影响功能）。
    expect(() => logWarn('poison')).not.toThrow()
    expect(warn).toHaveBeenCalledWith('poison')
  })
})
