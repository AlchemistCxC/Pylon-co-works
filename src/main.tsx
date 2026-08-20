import React from 'react'
import ReactDOM from 'react-dom/client'
import KernelRoot from './kernel/KernelRoot'
import { bindSkinPersistence, restoreSkinFromStorage } from './infrastructure/skin/skinRuntimeServices'
import { installPylonCliBridge } from './cli/pylonCliBridge'
// 内置终端等宽字体（西文），确保不依赖宿主机是否装 Cascadia Code
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import './index.css'
// 浏览器模式假 Tauri 后端（静态演示全景）。必须在 env.ts（IS_TAURI）求值之后安装：
// 本文件静态 import 已全部求值（App → env.ts 已冻结 IS_TAURI=false），此刻装 globals 安全。
import { installMockTauri } from './demo/mockTauri'

installMockTauri()

// OBS-04：P2 三源导出取证控制台钩子——仅 DEV 构建动态加载（生产 import.meta.env.DEV 恒
// false，分支 tree-shake，零暴露）；内部再按 IS_TAURI 守卫，浏览器 mock 模式 no-op。
if (import.meta.env.DEV) {
  void import('./obs04/devTrigger').then(module => module.installObs04DevTrigger())
}

// OBS-05：P3 冷启动状态快照取证控制台钩子——同 DEV-only 动态加载模式（生产 tree-shake
// 零暴露）；IS_TAURI 守卫 + 防重入；trace 包装在安装时挂载 window.__TAURI_INTERNALS__.invoke。
if (import.meta.env.DEV) {
  void import('./obs05/devTrigger').then(module => module.installObs05DevTrigger())
}

// OBS-06：P4 删除错误与 readiness 采集取证控制台钩子——同 DEV-only 动态加载模式（生产
// tree-shake 零暴露）；IS_TAURI 守卫 + 防重入；安装时只读包裹 invoke 旁观删除路径结算，
// readiness 探测走未包裹原始 transport 直调，不污染删除路径证据。
if (import.meta.env.DEV) {
  void import('./obs06/devTrigger').then(module => module.installObs06DevTrigger())
}

// OBS-07：P5 stderr 样本采集取证控制台钩子——同 DEV-only 动态加载模式（生产 tree-shake
// 零暴露）；IS_TAURI 守卫 + 防重入；采集经一次只读 list_runtime_logs 原始 wire（correlation
// 完整），不复用丢弃 correlation 的前端 normalize 模型。
if (import.meta.env.DEV) {
  void import('./obs07/devTrigger').then(module => module.installObs07DevTrigger())
}

// CSS-01：P6 typography computed style 基线控制台钩子——同 DEV-only 动态加载模式（生产
// tree-shake 零暴露）；只读取证（preset px contract + React/Solid 双 renderer heading
// DOM/class contract + 真实 DOM computed style），不修改任何 CSS（视觉改动属 CSS-02/03）。
if (import.meta.env.DEV) {
  void import('./css01/devTrigger').then(module => module.installCss01DevTrigger())
}

// S5-F：先恢复 pylon-skins（committed skins/bindings/drafts），再挂载 UI。
// 恢复失败只告警，不阻断启动；现有 Theme Store 外观保持不变。
const skinRestoreError = restoreSkinFromStorage()
if (skinRestoreError) console.warn('pylon-skins 恢复失败', skinRestoreError)
bindSkinPersistence()
void installPylonCliBridge().catch(error => console.error('Pylon CLI bridge failed to start', error))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <KernelRoot />
  </React.StrictMode>,
)
