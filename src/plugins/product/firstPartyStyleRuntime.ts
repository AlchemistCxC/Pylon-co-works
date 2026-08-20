import type { PluginScope } from '../../plugin-runtime/pluginScope.ts'

export interface FirstPartyStyleAsset {
  readonly path: string
  readonly css: string
}

function resolveDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

/**
 * 第一方产品样式使用与外置包相同的 PluginScope ownership：激活时插入，
 * disable/reload/rollback 时随当前 runtime instance 回收。
 */
export function mountFirstPartyStyleAssets(
  pluginId: string,
  runtimeInstanceId: string,
  scope: PluginScope,
  assets: readonly FirstPartyStyleAsset[],
  documentTarget: Document | null | undefined = resolveDocument(),
): void {
  if (assets.length === 0) return
  // 第一方插件会在 Node-only 结构/legacy tests 导入组合根；这些进程不渲染 UI，
  // 因而跳过 DOM side effect。浏览器/Tauri 中 document 必然存在，仍走真实生命周期。
  if (!documentTarget) return

  for (const asset of assets) {
    const style = documentTarget.createElement('style')
    style.dataset.pylonPluginStyle = pluginId
    style.dataset.pylonPluginRuntime = runtimeInstanceId
    style.dataset.pylonPluginStylePath = asset.path
    style.textContent = asset.css
    scope.add(() => style.remove())
    documentTarget.head.appendChild(style)
  }
}
