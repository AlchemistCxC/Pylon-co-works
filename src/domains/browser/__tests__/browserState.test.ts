// 迁移自 scripts/test-browser-state.mts（P91 A1）；42px/CSS 与组件壳源码 token 段不迁（已有 BrowserSheetView.sidebarSingleState 等覆盖）。
import { describe, expect, it } from 'vitest'
import { browserReducer, createBrowserState, type BrowserState } from '../browserState.ts'

// W4-03：browser 状态机——idle/starting/ready/error、单实例（重复 start no-op）

describe('browserReducer — 状态机（W4-03，迁移自 scripts/test-browser-state.mts，P91 A1）', () => {
  it('状态机转移：idle→starting→ready→idle→starting→error', () => {
    let s: BrowserState = createBrowserState()
    expect(s.phase).toBe('idle')
    s = browserReducer(s, { type: 'start' })
    expect(s.phase).toBe('starting')
    s = browserReducer(s, { type: 'started', instanceId: 'b1' })
    expect(s.phase).toBe('ready')
    expect(s.instanceId).toBe('b1')
    s = browserReducer(s, { type: 'stop' })
    expect(s.phase).toBe('idle')
    s = browserReducer(s, { type: 'start' })
    s = browserReducer(s, { type: 'failed', error: 'boom' })
    expect(s.phase).toBe('error')
    expect(s.error).toBe('boom')
  })

  it('单实例：starting 中重复 start no-op；非 starting 的 started no-op', () => {
    const s = browserReducer(browserReducer(createBrowserState(), { type: 'start' }), { type: 'start' })
    expect(s.phase).toBe('starting')
    const ready = browserReducer(browserReducer(createBrowserState(), { type: 'start' }), { type: 'started' })
    expect(browserReducer(ready, { type: 'started' })).toEqual(ready)
    expect(browserReducer(createBrowserState(), { type: 'started' })).toEqual(createBrowserState())
  })
})
