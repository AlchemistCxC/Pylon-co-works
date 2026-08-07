/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// W1-05：overview 空态接管——三入口壳、选择 Agent 成功后 open agent、失败保持并报错、虚拟不持久化

const overview = readFileSync(new URL('../src/sheets/OverviewSheetView.tsx', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../src/workspace-sheets/SheetLayout.tsx', import.meta.url), 'utf8')
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')

// 1. 三入口壳
assert.match(overview, /选择 Agent/, '必须含选择 Agent 入口')
assert.match(overview, /配置 Agent/, '必须含配置 Agent 入口')
assert.match(overview, /继续会话/, '必须含继续会话入口')

// 2. 选择 Agent：list → switch_agent → 成功后 open agent sheet（无缝进 sheet）
assert.match(overview, /invoke\('switch_agent', \{ name: agent\.id \}\)/, '选择 Agent 必须调 switch_agent')
assert.match(overview, /switchAgentTransaction\(agent\.id, agent\.name, \{/, '必须经 switch 事务（application/transactions）')
assert.match(overview, /ctx\.openSheet\(\{ kind: 'agent', title, agentId: id \}\)/, '成功后必须 open agent sheet')
assert.match(overview, /pylon:agent-switched/, '切换后必须广播 agent-switched')
assert.match(overview, /useRuntimeStore\.getState\(\)\.resetAll\(\)/, '切换必须清运行时状态')

// 3. 失败：保持 overview 并报错
assert.match(overview, /reportRuntimeError\(action, err\)/, '失败必须走错误中心')
assert.match(overview, /setError\(err instanceof Error \? err\.message : String\(err\)\)/, '失败必须记录错误')
assert.match(overview, /if \(!result\.ok\) setSwitchingId\(null\)/, '失败必须恢复可再选（保持 overview）')
assert.match(overview, /role="alert"/, '错误必须可审计展示')

// 4. 虚拟空态：不把 overview 写入持久 sheet 数组
assert.equal(overview.includes("kind: 'overview'"), false, 'overview 组件不得自行 open overview sheet')
assert.match(layout, /VIRTUAL_OVERVIEW_SHEET/, '空态用虚拟 overview sheet（不持久化）')
assert.match(layout, /overviewEntry\.render\(VIRTUAL_OVERVIEW_SHEET, ctx\)/, '空态必须渲染 overview 而非占位空态')

// 5. registry overview 条目渲染 OverviewSheetView
assert.match(registry, /overview: \{ render: \(sheet, ctx\) => <OverviewSheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry overview 必须渲染 OverviewSheetView')

console.log('overview sheet 空态接管守卫通过')
