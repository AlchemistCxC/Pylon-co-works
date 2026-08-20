/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { agentStatusLight } from '../src/domains/agent/statusLight.ts'

// W2-10：侧栏平铺（F2-C，行为敏感）——删平台分组、按 lastActiveAt、运行点读 liveGeneratingSources

const sidebar = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8')
const chatPanel = readFileSync(new URL('../src/components/sidebar/ChatSessionsPanel.tsx', import.meta.url), 'utf8')
const workPanel = readFileSync(new URL('../src/components/sidebar/WorkspacesPanel.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-workspace/styles/components/Sidebar.css', import.meta.url), 'utf8')

// 1. 删除平台分组
assert.equal(sidebar.includes('PLATFORM_LABELS'), false, '不得再有平台标签分组')
assert.equal(sidebar.includes('details'), false, '不得再有分组 details')
assert.equal(sidebar.includes('.group-header'), false, '组件内不得再引用分组头')

// 2. 平铺 + 按 lastActiveAt 倒序
assert.match(sidebar, /\.sort\(\(a, b\) => \(b\.lastActiveAt \|\| 0\) - \(a\.lastActiveAt \|\| 0\)\)/, '必须按 lastActiveAt 倒序')
assert.match(sidebar, /\.filter\(s => s\.profileId === activeProfileId && s\.agentId === activeAgent\)/, '必须按当前 profile 与当前 agent 过滤')

// 3. 运行点：读 liveGeneratingSources（periId 存在不再等于 running）
assert.match(sidebar, /liveGeneratingSources = useRuntimeStore\(s => s\.liveGeneratingSources \?\? NO_GENERATING_SOURCES\)/, '必须读 liveGeneratingSources（稳定引用）')
assert.match(chatPanel, /data-running=\{props\.liveGeneratingSources\.includes\(session\.source\) \? 'true' : undefined\}/, '聊天运行点必须按 source 的 liveGeneratingSources')
assert.match(workPanel, /data-running=\{props\.liveGeneratingSources\.includes\(session\.source\) \? 'true' : undefined\}/, '工作运行点必须按 source 的 liveGeneratingSources')
assert.equal(sidebar.includes('s.periId ?'), false, 'periId 存在不得再着色运行点')

// 4. 保留搜索/重命名/删除/设置交互
assert.match(chatPanel, /props\.query\.toLowerCase\(\)/, '聊天搜索保留')
assert.match(chatPanel, /setRenaming\(session\.id\)/, '聊天重命名保留')
assert.match(chatPanel, /props\.onDeleteSession\(session\.id\)/, '聊天删除保留')
assert.match(chatPanel, /props\.onOpenSessionSettings\(session\.id\)/, '聊天设置保留')

// 5. CSS：运行点色 + 死分组样式清理
assert.match(css, /\.session-dot\[data-running="true"\]/, '运行点必须读 data-running 着色')
assert.equal(css.includes('.group-header'), false, '死分组样式必须清理')

console.log('agent sidebar 平铺守卫通过')
// ── W2-11：三色状态灯 + showPet toggle ──

// 6. 六 status → 三灯状态纯断言
assert.equal(agentStatusLight('connected'), 'ok')
assert.equal(agentStatusLight('connecting'), 'warn')
assert.equal(agentStatusLight('reconnecting'), 'warn')
assert.equal(agentStatusLight('crashed'), 'error')
assert.equal(agentStatusLight('disconnected'), 'error')
assert.equal(agentStatusLight('error'), 'error')
assert.equal(agentStatusLight('inactive'), 'off')
assert.equal(agentStatusLight('unknown'), 'off')
assert.equal(agentStatusLight(''), 'off')

// 7. 状态灯接线（视觉调整：灯移 Titlebar 左上角）：agentStatuses + 纯函数 + 辉光模式
const titlebar = readFileSync(new URL('../src/workspace-sheets/WorkspaceTitlebar.tsx', import.meta.url), 'utf8')
const statusLight = readFileSync(new URL('../src/domains/agent/statusLight.ts', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-shell/styles/App.css', import.meta.url), 'utf8')
assert.match(titlebar, /selectAgentStatus\(activeAgent, activeAgent, agentStatuses\)/, 'Titlebar 必须经统一 selector 读取当前 agent 状态')
assert.match(statusLight, /agentLightDisplay\(status: string\)/, '必须提供三灯辉光展示模型')
assert.match(appCss, /data-mode="cascade"/, 'ok 必须 cascade 辉光（左→右传播）')
assert.match(appCss, /data-mode="sync"/, 'error 必须 sync 辉光')
assert.match(appCss, /data-mode="steady"/, 'warn 必须 steady 辉光（黄常亮）')
assert.match(appCss, /--tool-ok/, '灯色必须沿现有变量')
assert.equal(appCss.includes('--sidebar-status-ok-color'), false, '零新主题字段')

// 8. showPet toggle 写 workspaceStore（非主题）；换主题后不变
assert.match(sidebar, /useWorkspaceStore\(s => s\.showPet\)/, 'toggle 必须读 workspaceStore.showPet')
assert.match(sidebar, /setShowPet\(!showPet\)/, 'toggle 必须写 workspaceStore')
assert.match(sidebar, /aria-pressed=\{showPet\}/, 'toggle 必须有 aria-pressed')
const agentSheet = readFileSync(new URL('../src/sheets/AgentSheetView.tsx', import.meta.url), 'utf8')
assert.match(agentSheet, /useWorkspaceStore\(s => s\.showPet\)/, '消费点必须切 workspaceStore（防双真值）')
assert.equal(agentSheet.includes('useStore(s => s.showPet'), false, '消费点不得再读主题 showPet')
