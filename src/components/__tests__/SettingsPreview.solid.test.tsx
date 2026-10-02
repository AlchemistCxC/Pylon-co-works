// @vitest-environment jsdom
// #515：迁移自 SettingsPreview.test.tsx（React RTL → Solid 实体直连；断言集原样保留，
// 无改写点）。下沉自 scripts/test-preview-browser-fallback.mts（P91 A2）：
// 行为可锁的是 resize 监听接线——视口尺寸变化必须驱动预览画布尺寸。
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsPreview from '../SettingsPreview.solid.tsx'

function scaledFrame(): HTMLElement {
  return document.querySelector<HTMLElement>('.set-preview-scaled')!
}

describe('SettingsPreview 视口自适应', () => {
  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('预览画布按 window 尺寸初始化（innerHeight −32 留边）', () => {
    window.innerWidth = 1024
    window.innerHeight = 768
    render(() => <SettingsPreview zone="cc" />)
    expect(scaledFrame().style.width).toBe('1024px')
    expect(scaledFrame().style.height).toBe('736px')
  })

  it('window resize 后画布尺寸跟随更新', () => {
    render(() => <SettingsPreview zone="cc" />)
    window.innerWidth = 800
    window.innerHeight = 600
    fireEvent(window, new Event('resize'))
    expect(scaledFrame().style.width).toBe('800px')
    expect(scaledFrame().style.height).toBe('568px')
  })

  it('卸载时移除 resize 监听（不泄漏 window 监听器）', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(() => <SettingsPreview zone="cc" />)
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})
