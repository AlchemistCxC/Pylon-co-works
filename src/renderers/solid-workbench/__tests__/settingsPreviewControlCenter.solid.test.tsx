// @vitest-environment jsdom
/**
 * P52 D4：设置页中控预览挂真实 SolidControlCenter 的回归锁。
 * 锁定：loader 可加载、挂载产出真实中控 DOM（输入栏 + 状态槽）、主题同步
 * 生效（外观 store 快照变化）、destroy 清理宿主。
 */
import { describe, expect, it } from 'vitest'
import { loadSettingsPreviewControlCenter } from '../settingsPreviewControlCenterLoader.ts'

describe('settingsPreviewControlCenter（P52 D4 Solid 中控预览）', () => {
  it('挂载真实 SolidControlCenter：输入域进入 DOM，会话态不渲染旧状态槽（A6-3）', async () => {
    const { mountSettingsPreviewControlCenter } = await loadSettingsPreviewControlCenter()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const handle = mountSettingsPreviewControlCenter(host)

    expect(host.querySelector('.control-center')).toBeTruthy()
    // 真实中控结构：输入栏（fixture 提供会话 composer）
    expect(host.querySelector('textarea, input, .cc-input, [class*="input" i]')).toBeTruthy()
    // A6-3 更新（2026-09-14）：模型控件常态显示（每轮对话都要看的当前状态）；
    // 2026-09-15 起：思考强度、权限模式控件一并常态显示；其余旧状态控件在会话态仍然隐藏。
    const statusWidgetIds = [...host.querySelectorAll(
      '.cc-status-primary [data-widget-id], .cc-status-secondary [data-widget-id], .cc-actions [data-widget-id]',
    )].map(el => el.getAttribute('data-widget-id'))
    expect(statusWidgetIds).toEqual(['model', 'reasoning', 'mode'])

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
