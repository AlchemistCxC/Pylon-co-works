import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W1-03：侧栏上移（行为敏感）——App 布局段下移、AgentSheetView 只留主区、Sidebar props 收敛 ctx、折叠读 store

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../src/workspace-sheets/SheetLayout.tsx', import.meta.url), 'utf8')
const agentSheet = readFileSync(new URL('../src/sheets/AgentSheetView.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
const slot = readFileSync(new URL('../src/workspace-sheets/SheetSidebarSlot.tsx', import.meta.url), 'utf8')

// 1. App 布局段下移：不再直挂 SheetHost，改挂 SheetLayout
assert.equal(app.includes('import SheetHost from'), false, 'App 不得再 import SheetHost')
assert.match(app, /import SheetLayout from '\.\/workspace-sheets\/SheetLayout'/, 'App 必须挂 SheetLayout')
assert.match(app, /<SheetLayout\s+activeSession=\{activeSession\}/, 'App 布局段下移为 SheetLayout')

// 2. AgentSheetView 只留主区：无 Sidebar import/渲染，props 收敛 { sheet, ctx }
assert.equal(agentSheet.includes("import Sidebar"), false, 'AgentSheetView 不得再 import Sidebar')
assert.equal(agentSheet.includes('<Sidebar'), false, 'AgentSheetView 不得再渲染 Sidebar')
assert.match(agentSheet, /export default function AgentSheetView\(\{ ctx \}: \{ sheet: SheetRecord; ctx: SheetContext \}\)/, 'AgentSheetView props 收敛为 { sheet, ctx }')
assert.match(agentSheet, /<ChatView sessionId=\{ctx\.activeSession\} \/>/, 'AgentSheetView 主区读 ctx.activeSession')

// 3. Sidebar props 收敛为 ctx：内部行为不变（读 ctx.*）
assert.match(sidebar, /export default function Sidebar\(\{ ctx \}: \{ ctx: SheetContext \}\)/, 'Sidebar 必须经 ctx 注入')
assert.match(sidebar, /sidebarCollapsed: collapsed/, 'Sidebar 折叠读 ctx.sidebarCollapsed')
assert.match(sidebar, /activeSession, selectSession: onSelectSession/, 'Sidebar 会话/对话框从 ctx 解构')

// 4. 侧栏挂载点上移：registry entry.sidebar + SheetLayout 经 slot 渲染
assert.match(registry, /agent: \{ render: agentRender, sidebar: Sidebar, rightPanel: AgentContextPanel \}/, 'agent entry 必须声明 sidebar + 右栏（W2-12）')
assert.match(slot, /showSidebar/, 'slot 必须消费 showSidebar 主题开关')
assert.match(layout, /<SheetSidebarSlot sheet=\{activeSheet\} ctx=\{ctx\} \/>/, 'SheetLayout 渲染侧栏壳')

// 5. 折叠读 store（F2-B）：App 折叠/宽度状态从 workspaceStore 读，toggle 写 store
assert.equal(app.includes('useState(false)\n  const [sidebarCollapsed'), false, 'App 不得再有 sidebarCollapsed useState')
assert.match(app, /const sidebarCollapsed = useWorkspaceStore\(s => s\.sidebarCollapsed\)/, 'App 折叠状态必须读 workspaceStore')
assert.match(app, /const sidebarWidth = useWorkspaceStore\(s => s\.sidebarWidth\)/, 'App 宽度必须读 workspaceStore')
assert.match(app, /setSidebarCollapsed\(!useWorkspaceStore\.getState\(\)\.sidebarCollapsed\)/, '折叠 toggle 必须写 workspaceStore')
assert.match(app, /'--titlebar-sidebar-width': `\$\{sidebarCollapsed \? 42 : sidebarWidth\}px`/, 'titlebar 宽度读 workspaceStore')

// 6. profile 投影 effects 原样搬运到 SheetLayout（行为不变）
assert.match(layout, /setActiveProfile\(memory\.activeProfileId\)/, '启动恢复 effect 必须随布局层')
assert.match(layout, /setSheetAgentState\(activeAgent, \{ activeSessionId: props\.activeSession \|\| undefined \}\)/, '会话记忆持久化 effect 必须随布局层')
assert.match(layout, /belongsToProfile\(props\.activeSession, activeProfileId, sessions\)/, 'profile 越界清理 effect 必须随布局层')
assert.equal(app.includes('belongsToProfile'), false, 'App 不得再持有 profile 越界 effect')

console.log('sheet layout 侧栏上移守卫通过')
