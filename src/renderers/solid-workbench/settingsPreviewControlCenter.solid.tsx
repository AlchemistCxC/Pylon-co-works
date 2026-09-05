/**
 * settingsPreviewControlCenter — 设置页中控预览的 Solid 挂载点（P52 D4）。
 *
 * 由 settingsPreviewControlCenterLoader 经 import.meta.glob 加载（React 宿主
 * 不直接 import 本文件，保持双框架类型隔离）。数据来自 preview fixture
 * 服务（与 RendererSettingsPreview 同源）；主题由宿主经 setTheme 同步。
 */
import { render } from 'solid-js/web'
import { SolidWorkbenchContext } from './SolidWorkbenchContext.solid.tsx'
import { SolidControlCenter } from './input/ControlCenter.solid.tsx'
import { createPreviewWorkbenchServices } from './__fixtures__/previewWorkbenchServices.ts'

export function mountSettingsPreviewControlCenter(host: HTMLElement) {
  const services = createPreviewWorkbenchServices()
  const input = () => ({
    sheetId: 'settings-preview',
    sessionId: 'preview-session',
    preview: true,
    workspaceMode: 'work' as const,
    visibility: 'active' as const,
    reducedMotion: true,
    availableWorkspaces: [],
  })
  const dispose = render(() => (
    <SolidWorkbenchContext.Provider value={{
      input,
      runtime: services.runtime,
      runtimeSnapshot: () => services.runtime.getSnapshot(),
      appearance: services.appearance,
      appearanceSnapshot: () => services.appearance.getSnapshot(),
      sessionUi: services.sessionUi,
      commands: services.commands,
      paused: () => false,
    }}>
      <SolidControlCenter />
    </SolidWorkbenchContext.Provider>
  ), host)
  return {
    setTheme: (theme: Record<string, unknown>) => { services.appearance.setTheme(theme as never) },
    destroy() {
      dispose()
      services.destroy()
      host.replaceChildren()
    },
  }
}
