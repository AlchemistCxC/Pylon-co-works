// P91 A4 收编：组件接线与入口边界的静态守卫合并检查
// （原 scripts/test-context-panel-selector.mts / test-context-panel.mts /
//   test-kernel-application-entry.mts 三脚本并入；对应行为已由
//   ContextPanelHost.test.tsx、contextPanelRegistry.test.ts、kernel/__tests__ 锁定，
//   本检查只锁接线结构与 selector 稳定性）。

// ── 1. 右栏 selector 稳定引用（zustand v5 死循环防线）──
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W2-12 右栏修复（2026-08-06，用户报选 agent 后 Maximum update depth）：
// zustand v5 useStore 的 selector 返回值即 useSyncExternalStore 快照——selector 返回
// 新引用（`?? []` 每次新数组）→ Object.is 不等 → forceStoreRerender 死循环。
// 守卫：touchedFiles 必须选整个 record（引用稳定），派生留组件体。

for (const path of ['src/components/right-panel/AgentContextPanel.tsx', 'src/components/right-panel/FileContextPanel.tsx']) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  assert.match(source, /useWorkspaceStore\(s => s\.touchedFiles\)/, `${path} 必须选整个 touchedFiles record（稳定引用）`)
  assert.equal(
    /useWorkspaceStore\([^)]*touchedFiles\[source\] \?\? \[\]/.test(source),
    false,
    `${path} selector 不得含 \`?? []\`（新引用死循环）`,
  )
  assert.equal(
    /useWorkspaceStore\([^)]*touchedFiles\[source\][^)]*\]/.test(source),
    false,
    `${path} 不得在 selector 内做数组派生`,
  )
  if (path.includes('AgentContextPanel')) {
    assert.match(source, /touchedFilesRecord\[toAgentContextKey\(touchedContext\)\]/, `${path} 派生必须留组件体（I01-W3 context key）`)
  } else {
    // FileContextPanel（FE-AUD-022 反查）：activeFile 稳定 selector + sourcesForPath 组件体派生
    assert.match(source, /useWorkspaceStore\(state => \{/, `${path} activeFile 必须经稳定 selector`)
    assert.match(source, /sourcesForPath\(touchedFilesRecord, activeFile\)/, `${path} 反查必须在组件体（sourcesForPath）`)
  }
}


// ── 2. 右栏贡献 Host/Registry 接线 ──
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../src/components/right-panel/ContextPanelHost.tsx', import.meta.url), 'utf8')
const slot = readFileSync(new URL('../src/components/right-panel/RightRailHost.tsx', import.meta.url), 'utf8')
const productWorkspace = readFileSync(new URL('../src/plugins/product/builtinPylonWorkspace.ts', import.meta.url), 'utf8')
const activation = readFileSync(new URL('../src/plugin-runtime/pluginActivationContext.ts', import.meta.url), 'utf8')
const shadow = readFileSync(new URL('../src/plugin-runtime/shadowUpdate.ts', import.meta.url), 'utf8')

assert.match(slot, /useRightRailStore\(state => state\.collapsed\)/, '全局右栏宿主必须读统一折叠状态')
assert.match(slot, /if \(entries\.length === 0\) return null/, '无贡献时不得挂载')
assert.match(slot, /right-rail-host\$\{collapsed/, '折叠状态必须由右栏外壳承担，以支持宽度/透明度动画')
assert.match(slot, /data-collapsed=\{collapsed \? 'true' : 'false'\}/, '右栏外壳必须暴露折叠状态')
assert.match(slot, /<ContextPanelHost sheet=\{activeSheet\} ctx=\{ctx\} activePanelId=\{effectivePanelId\} \/>/, '宿主必须挂统一贡献 Host')
assert.match(host, /role="tablist"/, '多贡献必须以可访问标签切换')
assert.match(host, /PluginContributionBoundary/, '每个右栏贡献必须有独立错误边界')
assert.match(host, /renderKind === 'isolated-surface'/, '外置 UI 必须走隔离 surface')
assert.match(host, /event === 'host:collapse'/, '隔离 surface 只能通过受控事件请求宿主动作')
assert.match(productWorkspace, /workspaceKind: 'agent'/, 'Agent 右栏必须注册贡献')
assert.match(productWorkspace, /workspaceKind: 'file'/, 'File 右栏必须注册贡献')
assert.match(activation, /contextPanel: createPluginContextPanelApi/, '激活上下文必须暴露右栏贡献 API')
assert.match(shadow, /contextPanel: registries\.contextPanelRegistry\.beginShadowTransaction/, '右栏贡献必须参与 shadow hot-swap')

const agentPanel = readFileSync(new URL('../src/components/right-panel/AgentContextPanel.tsx', import.meta.url), 'utf8')
assert.match(agentPanel, /useSessionUiState\(sessionId, 'search-query'/, 'Agent 搜索必须复用 sessionUiState')
assert.match(agentPanel, /useHostDocument\(hostPort\)/, '消息快照必须经当前 Workbench Host Port')
assert.match(agentPanel, /useWorkspaceStore\(s => s\.touchedFiles\)/, 'Agent 关联必须读 touchedFiles')
assert.match(agentPanel, /touchedFilesRecord\[toAgentContextKey\(touchedContext\)\]/, 'Agent 关联必须使用 context key')
assert.match(agentPanel, /import MessageSearchBar/, 'Agent 搜索必须复用 MessageSearchBar')
const filePanel = readFileSync(new URL('../src/components/right-panel/FileContextPanel.tsx', import.meta.url), 'utf8')
assert.match(filePanel, /useWorkspaceStore\(s => s\.touchedFiles\)/, 'File 右栏必须反查 touchedFiles')


// ── 3. Kernel 入口边界（React Root 永久由 KernelRoot 持有）──
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const kernelRoot = readFileSync(new URL('../src/kernel/KernelRoot.tsx', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../src/application/applicationRuntime.ts', import.meta.url), 'utf8')
const bootstrap = readFileSync(new URL('../src/kernel/kernelBootstrap.ts', import.meta.url), 'utf8')
const shellPlugin = readFileSync(new URL('../src/plugins/product/builtinPylonShell.ts', import.meta.url), 'utf8')

assert.match(main, /import KernelRoot from '\.\/kernel\/KernelRoot'/, 'main 必须导入 KernelRoot')
assert.match(main, /ReactDOM\.createRoot\(document\.getElementById\('root'\)!\)\.render\([\s\S]*?<KernelRoot \/>/, 'React Root 必须挂载 KernelRoot')
assert.doesNotMatch(main, /<App \/>/, 'main 不得直接挂载 App')
assert.match(kernelRoot, /BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID/, '内置 Pylon Application 必须由 shell plugin 标识')
assert.match(shellPlugin, /lazy\(\(\) => import\('\.\.\/\.\.\/App\.tsx'\)\)/, 'App 必须由 shell plugin 延迟加载')
assert.match(shellPlugin, /application\.register\(\{ id: BUILTIN_PYLON_SHELL_ID, component: PylonApplication \}\)/, 'App 必须经 plugin-owned Application API 注册')
assert.match(kernelRoot, /bootstrap\.startNormal\(\)/, '启动时必须进入 Kernel bootstrap')
assert.match(bootstrap, /mountApplication\(BUILTIN_PYLON_SHELL_ID\)/, 'bootstrap 激活内置 shell 后必须挂载 Pylon Application')
assert.match(kernelRoot, /<ErrorBoundary>/, 'Kernel 必须永久持有 ErrorBoundary')
assert.match(runtime, /getSnapshot:/, 'ApplicationRuntime 必须提供 snapshot')
assert.match(runtime, /subscribe:/, 'ApplicationRuntime 必须提供响应式 subscribe')


console.log('context panel 接线与 kernel 入口边界守卫通过')
