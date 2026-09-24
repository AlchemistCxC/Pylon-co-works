import React from 'react'
import ReactDOM from 'react-dom/client'
import KernelRoot from './kernel/KernelRoot'
import { bindSkinPersistence, restoreSkinFromStorage } from './infrastructure/skin/skinRuntimeServices'
import { installPylonCliBridge } from './cli/pylonCliBridge'
import { installPylonHookBridge } from './infrastructure/hooks/hookBridgeDispatcher'
import { installCanonicalHookProjection } from './application/hooks/canonicalHookProjection'
import { installCanonicalTouchedFileProjection } from './application/hooks/canonicalTouchedFileProjection'
import './index.css'
// Tailwind v4 utilities 基线（TW 施工书 20260914）：无 preflight，@theme inline
// 只读消费 index.css token；必须在 index.css 之后引入。
import './styles/tailwind.css'
import { startupMark } from './app/startupTiming'

// #269：前端最早可插桩点（模块求值起点）——import 求值成本不计入，
// 与 performance.timeOrigin 的差值即脚本求值前开销。
startupMark('main_module_eval')
// 浏览器模式假 Tauri 后端（静态演示全景）——开发脚手架，仅 DEV 构建动态加载（生产
// import.meta.env.DEV 恒 false，分支 tree-shake，生产 bundle 不携带 demo/mockTauri）。
// 安装时序语义不变：动态 import 发生在本文件全部静态 import 求值之后（App → env.ts 的
// IS_TAURI 已冻结为 false），此刻装 globals 安全——比原来的静态 import + 顶层调用更晚，
// env.ts 的冻结前提依然满足。同 obs04~07/css01 的 DEV-only 动态加载模式。
if (import.meta.env.DEV) {
  void import('./demo/mockTauri').then(module => module.installMockTauri())
}

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
// P55-D1：kernel hook 桥 dispatcher（Rust 锚点 → 插件 handler 应答回路）。
void installPylonHookBridge().catch(error => console.error('Pylon hook bridge failed to start', error))
// API 1.3：canonical 事实 → turn.*/tool.* 观察锚点投影（durable-before-publish 订阅）。
installCanonicalHookProjection()
// 0-A0（#282）：canonical tool_call 事实 → 触碰文件管线（recordTouchedFile 生产端重接）。
installCanonicalTouchedFileProjection()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <KernelRoot />
  </React.StrictMode>,
)
