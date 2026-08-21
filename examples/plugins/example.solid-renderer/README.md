# Example Solid Renderer

这是一个 API 1.0 第三方 `kind=renderer` 范例。安装时由 native package store stage，`PackagePluginRuntimeService` 通过 `pylon-plugin://` resource URL 加载 `dist/entry.js`，再交给唯一 `PluginRuntime`。

范例只使用公开的 renderer/presentation API 与 `WorkbenchHostPort`：

- `example.solid-renderer.note` kind、`example.solid-renderer.suite` Suite、base/fallback Slot；
- choice、palette+picker、slider+input、toggle、text 与 Slot option 设置声明；
- Solid factory 只读取 HostPort，不读取宿主 store、controller、journal 或 Tauri invoke；
- 插件卸载由 scope 回收 registry contributions、Suite DOM 与事件监听；热更新遵循 parallel candidate → ready → atomic swap。

构建输出必须包含 `dist/entry.js` 与 `dist/styles.css`，并保持 manifest 的 `web.entry` / `web.styles` 路径。插件不应 import `src/components` 或复制宿主设置 JSX。
