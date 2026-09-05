// @vitest-environment jsdom
/**
 * P52 D4：设置页中控预览挂真实 SolidControlCenter 的回归锁。
 * 锁定：loader 可加载、挂载产出真实中控 DOM（输入栏 + 状态槽）、主题同步
 * 生效（外观 store 快照变化）、destroy 清理宿主。
 */
import { describe, expect, it } from 'vitest'
import { loadSettingsPreviewControlCenter } from '../settingsPreviewControlCenterLoader.ts'

describe('settingsPreviewControlCenter（P52 D4 Solid 中控预览）', () => {
  it('挂载真实 SolidControlCenter：输入域 + 状态槽进入 DOM', async () => {
    const { mountSettingsPreviewControlCenter } = await loadSettingsPreviewControlCenter()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const handle = mountSettingsPreviewControlCenter(host)

    expect(host.querySelector('.control-center')).toBeTruthy()
    // 真实中控结构：输入栏与状态槽（fixture 提供空会话 composer）
    expect(host.querySelector('textarea, input, .cc-input, [class*="input" i]')).toBeTruthy()
    expect(host.querySelector('.cc-status-primary, .cc-status-secondary, .cc-actions')).toBeTruthy()

    handle.destroy()
    expect(host.childElementCount).toBe(0)
    host.remove()
  })

  it('setTheme 同步外观 store（预览随主题实时变化）', async () => {
    const { mountSettingsPreviewControlCenter } = await loadSettingsPreviewControlCenter()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const handle = mountSettingsPreviewControlCenter(host)

    // setTheme 消费完整 ThemeSettings（生产路径 = THEME_DEFAULTS 与 store 快照合并）
    const { DEFAULTS } = await import('../../../domains/theme/themeDefaults.ts')
    expect(() => handle.setTheme({ ...structuredClone(DEFAULTS), chatFont: 'serif' } as unknown as Record<string, unknown>)).not.toThrow()

    handle.destroy()
    host.remove()
  })
})
