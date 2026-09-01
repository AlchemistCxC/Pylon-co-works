/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W1-03：侧栏上移（行为敏感）——App 布局段下移、AgentSheetView 只留主区、Sidebar props 收敛 ctx、折叠读 store

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../src/workspace-sheets/SheetLayout.tsx', import.meta.url), 'utf8')
const agentSheet = readFileSync(new URL('../src/sheets/AgentSheetView.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
const registry = readFileSync(new URL('../src/plugins/core/sheet/builtinWorkspacePlugins.ts', import.meta.url), 'utf8')
const slot = readFileSync(new URL('../src/workspace-sheets/SheetSidebarSlot.tsx', import.meta.url), 'utf8')
const rightSlot = readFileSync(new URL('../src/components/right-panel/RightRailHost.tsx', import.meta.url), 'utf8')
const productWorkspace = readFileSync(new URL('../src/plugins/product/builtinPylonWorkspace.ts', import.meta.url), 'utf8')

// 1. App 布局段下移：不再直挂 SheetHost，改挂 SheetLayout
assert.equal(app.includes('import SheetHost from'), false, 'App 不得再 import SheetHost')
assert.match(app, /import SheetLayout from '\.\/workspace-sheets\/SheetLayout'/, 'App 必须挂 SheetLayout')
assert.match(app, /<SheetLayout\s+activeSession=\{activeSession\}/, 'App 布局段下移为 SheetLayout')

// 2. AgentSheetView 只留主区：无 Sidebar import/渲染，props 收敛 { sheet, ctx }
assert.equal(agentSheet.includes("import Sidebar"), false, 'AgentSheetView 不得再 import Sidebar')
assert.equal(agentSheet.includes('<Sidebar'), false, 'AgentSheetView 不得再渲染 Sidebar')
assert.match(agentSheet, /export default function AgentSheetView\(\{ sheet, ctx \}: \{ sheet: SheetRecord; ctx: SheetContext \}\)/, 'AgentSheetView props 收敛为 { sheet, ctx }')
assert.match(agentSheet, /workspaceMode=\{workspaceMode\}/, 'AgentSheetView 必须把 Workspace state mode 传给 ChatView renderer context')
assert.match(agentSheet, /activeSessionId: ctx\.activeSession|activeSessionId=\{ctx\.activeSession\}/, 'AgentSheetView 主区读 ctx.activeSession')

// 3. Sidebar 经 ctx + workspace state 注入：会话行为读 ctx，模式读 state
assert.match(sidebar, /export default function Sidebar\(\{ ctx, state, sheet \}/, 'Sidebar 必须经 ctx/state/sheet 注入')
assert.match(sidebar, /sidebarCollapsed: collapsed/, 'Sidebar 折叠读 ctx.sidebarCollapsed')
assert.match(sidebar, /activeSession, selectSession: onSelectSession/, 'Sidebar 会话/对话框从 ctx 解构')
assert.match(sidebar, /patchSheetState\(sheet\.id, \{ sidebarMode: candidate \}\)/, 'Sidebar mode 必须写 workspace state codec')

// 4. 侧栏挂载点上移：registry entry.sidebar + SheetLayout 经 slot 渲染
assert.match(registry, /kind: 'agent'.*sidebarMode: 'workspace'.*component: lazyWorkspace\(AgentSheetView\).*sidebar: lazyPanel\(Sidebar\)/, 'agent type 必须声明主区 + workspace 左栏')
assert.match(slot, /showSidebar/, 'slot 必须消费 showSidebar 主题开关')
assert.match(layout, /<SheetSidebarSlot sheet=\{activeSheet\} ctx=\{ctx\} \/>/, 'SheetLayout 渲染侧栏壳')
assert.match(rightSlot, /<ContextPanelHost sheet=\{activeSheet\} ctx=\{ctx\} activePanelId=\{effectivePanelId\} \/>/, '全局右栏 host 必须统一挂载贡献 host')
assert.match(productWorkspace, /context\.contextPanel\.register\(\{[\s\S]*workspaceKind: 'agent'/, 'Agent 右栏必须由产品插件注册贡献')
assert.match(productWorkspace, /context\.contextPanel\.register\(\{[\s\S]*workspaceKind: 'file'/, 'File 右栏必须由产品插件注册贡献')

// 5. 折叠由 workspaceStore 全局统一管理，所有 Sheet 共享；宽度同域管理
assert.equal(app.includes('useState(false)\n  const [sidebarCollapsed'), false, 'App 不得再有 sidebarCollapsed useState')
assert.match(app, /const sidebarCollapsed = useRightRailStore\(s => s\.leftRailCollapsed\)/, 'App 折叠状态必须直接订阅 rightRailStore')
assert.match(layout, /const sidebarCollapsed = useRightRailStore\(s => s\.leftRailCollapsed\)/, 'SheetLayout 必须向所有 Sheet 注入同一折叠状态')
assert.match(app, /const sidebarWidth = useRightRailStore\(s => s\.leftRailWidth\)/, 'App 宽度必须读 rightRailStore')
assert.match(app, /setLeftRailCollapsed\(!sidebarCollapsed\)/, '折叠 toggle 必须写全局布局状态')
const workspaceStore = readFileSync(new URL('../src/workspaceStore.ts', import.meta.url), 'utf8')
assert.match(workspaceStore, /setSidebarCollapsed: \(sidebarCollapsed\) => \{[\s\S]*setLeftRailCollapsed\(sidebarCollapsed\)[\s\S]*commitWorkspaceMutation/, '旧折叠 action 必须桥接 rightRailStore 且保留持久化快照')
const snapshot = readFileSync(new URL('../src/domains/theme/themeCssSnapshot.ts', import.meta.url), 'utf8')
assert.match(snapshot, /sidebarEnabled && !layout\.sidebarCollapsed \? sidebarWidth : WORKSPACE_SIDEBAR_COLLAPSED_WIDTH/, '左栏轨道必须按统一展开\/42px 折叠契约派生')
assert.match(snapshot, /sidebarExpandedTrack && !layout\.sidebarCollapsed \? sidebarWidth : WORKSPACE_SIDEBAR_COLLAPSED_WIDTH/, 'titlebar 轨道必须与左栏折叠几何同宽')
const sidebarCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css', import.meta.url), 'utf8')
assert.match(sidebarCss, /\.sidebar\.collapsed\s*\{[^}]*width:var\(--workspace-sidebar-collapsed-width,42px\)/s, 'Agent 公共左栏折叠必须收窄到统一 token')
assert.match(snapshot, /WORKSPACE_SIDEBAR_COLLAPSED_WIDTH = 42/, '折叠宽度必须由单一 token 冻结（D-08：42px）')

// 6. profile 投影 effects 原样搬运到 SheetLayout（行为不变）
assert.match(layout, /setActiveProfile\(memory\.activeProfileId\)/, '启动恢复 effect 必须随布局层')
assert.match(layout, /setSheetAgentState\(activeAgent, \{ activeSessionId: props\.activeSession \|\| undefined \}\)/, '会话记忆持久化 effect 必须随布局层')
assert.match(layout, /belongsToProfile\(props\.activeSession, activeProfileId, sessions\)/, 'profile 越界清理 effect 必须随布局层')
assert.equal(app.includes('belongsToProfile'), false, 'App 不得再持有 profile 越界 effect')

console.log('sheet layout 侧栏上移守卫通过')
