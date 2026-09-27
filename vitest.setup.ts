import '@testing-library/jest-dom/vitest'
import { expect } from 'vitest'

// #220：计算核在测试宿主里必须**同步**可用（切分、揭示引擎、投影折叠的调用点全是
// 同步上下文），所以在任何测试文件求值前预初始化 wasm。node:* 只出现在 scripts/
// 侧（tsconfig 的 include 不含它），产品源码里不出现——那是这次重构要消除的耦合。
import { preloadComputeWasm } from './scripts/wasmPreload.ts'

preloadComputeWasm()

// 组件测试（jsdom）所需的最小浏览器 API 垫片
import { afterAll, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

// 阶段 0（报告 §2.3.9）：测试结束断言无未处理 Promise rejection。
// 每个测试文件（setup 每文件执行）注册收集器，afterAll 断言。
const unhandledRejections: unknown[] = []
const onUnhandledRejection = (reason: unknown): void => { unhandledRejections.push(reason) }
process.on('unhandledRejection', onUnhandledRejection)

// #228 批次F（2026-09-22）：console.error 分层从「全局容忍」收窄为「白名单容忍」。
// 全量盘点（bunx vitest run）：75 次 console.error，全部出自下列 36 个文件，分三类：
//   A 错误路径契约——产品把失败写入 console.error 正是用例断言的可见上报链路
//     （错误中心、渲染边界、事务回滚、网关写回、Agent 切换/探测失败等）；
//   B node 环境噪音——canonical feed 兜底监听注册在无 window/Tauri 的 node 工程
//     里失败（「注册 canonical feed user 兜底监听失败 …」）。根因是产品侧注册无
//     环境守卫（src/infrastructure/events/canonicalEventFeed.ts:241 一带）；
//   C Renderer Suite fatal 回退链——「Renderer Suite 回退失败 …（自动重试 N/M）」
//     是回退机制的过程日志，用例正是断言该回退行为。
// 白名单外文件出现任何 console.error 一律 fail（fail 消息带首条原文，便于定性）。
// 回收计划：B 类在产品注册处补 `typeof window`/Tauri 可用性守卫后逐文件移出；
// A/C 类在产品改走诊断通道上报后移出；**名单清零后删除整个白名单机制**，
// afterAll 对 console.error 无条件 throw（即原「阶段 8 硬断言」，届时本注释一并删除）。
const EXPECTED_CONSOLE_ERROR_FILES: readonly string[] = [
  // B 类：canonical feed 兜底监听注册在 node 环境失败的噪音
  'src/__tests__/replay/livenessAuthority.test.ts',
  'src/__tests__/replay/agentWorkbenchSession.batch.test.ts',
  'src/__tests__/replay/agentWorkbenchSession.rebindIndicator.test.ts',
  'src/__tests__/replay/agentWorkbenchSession.snapshotBridge.test.ts',
  // #376-b：与上面三个 agentWorkbenchSession 同族（同一个 feed 注册噪音源）。
  'src/__tests__/replay/agentWorkbenchSession.pagedLoad.test.ts',
  'src/__tests__/replay/documentLayer.test.ts',
  'src/sheets/agent-workbench/__tests__/agentWorkbenchSession.test.ts',
  'src/sheets/agent-workbench/__tests__/agentWorkbenchSession.terminalDelivery.test.ts',
  'src/sheets/agent-workbench/__tests__/agentWorkbenchSession.emptyStateFirstPrompt.test.ts',
  'src/workspace-sheets/__tests__/agentSuiteKeepAlive.integration.test.tsx',
  'src/workspace-sheets/__tests__/sheetLayoutSidebarCollapsedReactive.test.tsx',
  // C 类：Renderer Suite fatal 回退链过程日志（含少量 B 类注册噪音）
  'src/sheets/agent-workbench/__tests__/AgentRendererSuiteWorkbench.fatal.test.tsx',
  'src/sheets/__tests__/AgentSheetView.rendererMode.test.tsx',
  // A 类：错误路径契约
  'src/domains/identity/__tests__/identityStore.hydration.test.ts',
  'src/__tests__/replay/canonicalEventFeed.test.ts',
  'src/application/transactions/__tests__/applyWorkspaceLayoutChange.test.ts',
  'src/application/transactions/__tests__/applyWorkspaceRootChange.test.ts',
  'src/components/chat/__tests__/messageRenderBoundary.test.tsx',
  'src/components/settings/__tests__/AgentRuntimePanel.default.test.tsx',
  'src/components/settings/__tests__/GatewayRiskPanel.test.tsx',
  'src/components/settings/__tests__/PluginManager.test.tsx',
  'src/components/__tests__/ErrorCenter.test.tsx',
  'src/components/__tests__/Settings.pluginManagerDefaultPage.test.tsx',
  'src/components/__tests__/SheetErrorBoundary.test.tsx',
  'src/domains/theme/__tests__/customPresetApply.test.ts',
  'src/infrastructure/acp/__tests__/interactionRejectionController.test.ts',
  'src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx',
  'src/renderers/solid-workbench/__tests__/workbenchHostPort.errorCenter.test.ts',
  'src/renderers/solid-workbench/__tests__/workbenchHostPort.test.ts',
  'src/sheets/file/__tests__/FileTabView.readonly.test.tsx',
  'src/sheets/file/__tests__/gitPanelAcceptance.test.tsx',
  'src/sheets/gateway/__tests__/gatewayRouteSave.integration.test.tsx',
  'src/sheets/gateway/__tests__/gatewaySheetView.ui.test.tsx',
  'src/sheets/__tests__/OverviewSheetView.visual.test.tsx',
  'src/workspace-sheets/__tests__/agentStatusConsumerMatrix.test.tsx',
  'src/workspace-sheets/__tests__/sheetLauncherAgentSwitch.test.tsx',
  'src/workspace-sheets/__tests__/sheetTabStripAgentSwitch.test.tsx',
  'src/workspace-sheets/__tests__/workspaceStore.integration.test.ts',
]

const consoleErrors: unknown[][] = []
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  consoleErrors.push(args)
  originalConsoleError(...args)
}

function currentTestFile(): string {
  // expect.getState().testPath 是正式入口；__vitest_worker__.filepath 是同值的
  // worker 全局，作兜底（两者都归一化为 '/' 分隔再与白名单做 endsWith 匹配）。
  const state = expect.getState() as { testPath?: string }
  const raw = state.testPath ?? (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath ?? ''
  return raw.replaceAll('\\', '/')
}

afterAll(() => {
  console.error = originalConsoleError
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetModules()
  process.removeListener('unhandledRejection', onUnhandledRejection)
  if (consoleErrors.length > 0) {
    const file = currentTestFile()
    const whitelisted = EXPECTED_CONSOLE_ERROR_FILES.some(entry => file.endsWith(entry))
    if (whitelisted) {
      console.log(`[setup] ${file}: ${consoleErrors.length} 次 console.error（白名单内，仅记录）`)
    } else {
      const first = JSON.stringify(consoleErrors[0])
      throw new Error(
        `${file} 出现 ${consoleErrors.length} 次白名单外的 console.error（#228 批次F 起硬断言）。`
        + `先修产品侧错误；确属预期的错误路径契约时，把本文件登记进 vitest.setup.ts 的 EXPECTED_CONSOLE_ERROR_FILES 并注明分类。首条：${first}`,
      )
    }
  }
  if (unhandledRejections.length > 0) {
    console.error(`[setup] 检测到 ${unhandledRejections.length} 个未处理的 Promise rejection`)
    throw new Error(`存在 ${unhandledRejections.length} 个未处理的 Promise rejection`)
  }
})

// Node 26 的全局 localStorage 是实验性 getter：未传 --localstorage-file 时访问即触发
// ExperimentalWarning 并返回 undefined（且会遮蔽 jsdom 的）。无条件用内存垫片覆盖该
// descriptor（configurable: true），消除 warning 并让 zustand persist 可用（仅测试环境）。
const memory = new Map<string, string>()
const storage: Storage = {
  getItem: key => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key, value) => { memory.set(key, String(value)) },
  removeItem: key => { memory.delete(key) },
  clear: () => memory.clear(),
  key: index => [...memory.keys()][index] ?? null,
  get length() { return memory.size },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
if (typeof window !== 'undefined' && Object.getOwnPropertyDescriptor(window, 'localStorage')?.value === undefined) {
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
}

// matchMedia：motion/react 的 useReducedMotion 在 jsdom 下会访问
if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// CodeMirror 6 会测量 Range 几何；jsdom 只实现 Range 数据模型，不提供布局 API。
// 组件测试不验证像素坐标，返回空矩形即可排除测试环境噪音。
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects === 'undefined') {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as DOMRectList
}
if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect === 'undefined') {
  Range.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
    toJSON: () => ({}),
  })
}
// K-3（施工书 09）：Radix Slider 的 use-size 依赖 ResizeObserver；jsdom 未实现。
// 测试环境垫片：立即回调 size 0 即可满足布局观察协议。
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverShim {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverShim as unknown as typeof ResizeObserver
}
// #329：命令面板在展开「全部」后可能超出面板高度，键盘选中的行需要 `scrollIntoView`
// 把它带进视口；jsdom 未实现该方法（调用会抛 TypeError），故在测试环境补空实现。
if (typeof window !== 'undefined' && typeof window.Element.prototype.scrollIntoView !== 'function') {
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}
}
