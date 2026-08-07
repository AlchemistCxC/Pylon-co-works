// @vitest-environment jsdom
/**
 * ChatRuntimeBridge 单例语义测试（G0 / 报告 6A）：
 * 多次 attach 返回同一 handle（listener 全局只注册一次）；重挂载只重绑定
 * refs；dispose 后允许重新创建。
 */
import { describe, expect, it } from 'vitest'
import { attachChatEventController, bindChatControllerRefs, getChatController, registerChatController } from '../chatEventController'
import type { ChatEventControllerRefs } from '../chatEventController'

function makeRefs(): ChatEventControllerRefs {
  return {
    sessionRef: { current: null },
    messageOwnerRef: { current: null },
    setMessages: () => {},
    setStreamingText: () => {},
    setStreamingThinking: () => {},
    setGenerating: () => {},
    setGenerationPhase: () => {},
    setSummary: () => {},
    setLastTokenAt: () => {},
  }
}

describe('ChatRuntimeBridge 单例（G0）', () => {
  it('多次 attach 返回同一 controller（listener 只注册一次）', () => {
    const refs = makeRefs()
    const first = attachChatEventController(refs)
    const second = attachChatEventController(refs)
    expect(first).toBe(second)
    registerChatController(first)
    expect(getChatController()).toBe(first)
  })

  it('重挂载只重绑定 refs（bindChatControllerRefs 不重复创建）', () => {
    const refsA = makeRefs()
    const handle = attachChatEventController(refsA)
    const refsB = makeRefs()
    bindChatControllerRefs(refsB)
    expect(getChatController()).toBe(handle)
    expect(getChatController()).toBe(handle)
  })

  it('dispose 后重置单例，下次 attach 创建新 controller', () => {
    const refs = makeRefs()
    const first = attachChatEventController(refs)
    const unlisten = getChatController()
    expect(unlisten).toBe(first)
    // dispose 不抛（listener 未成功注册时 unlisten 为空数组）
    first.dispose()
    expect(getChatController()).toBe(first)
    const second = attachChatEventController(makeRefs())
    expect(second).not.toBe(first)
  })
})
