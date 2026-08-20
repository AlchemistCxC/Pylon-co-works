/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { SHEET_KINDS } from '../src/workspace-sheets/sheetTypes.ts'
import { getSheetRegistryEntry } from '../src/workspace-sheets/sheetRegistry.ts'
import { getWorkspaceRegistrySnapshot } from '../src/workspace-sheets/workspaceRegistry.ts'

// 阶段 6：metadata + renderer/type definition 同一 Workspace Registry。

// 1. v2 内置插件激活后 9 kind 全部有完整 type definition。
const workspaceSnapshot = getWorkspaceRegistrySnapshot()
assert.equal(workspaceSnapshot.workspaces.length, SHEET_KINDS.length, '注册表必须精确覆盖 SHEET_KINDS')
for (const kind of SHEET_KINDS) {
  const entry = getSheetRegistryEntry(kind)
  assert.ok(entry, `${kind} 必须有 registry entry`)
  assert.ok(typeof entry.singleton === 'boolean')
  assert.ok(typeof entry.getSingletonKey === 'function')
  assert.ok(entry.component, `${kind} 必须注册 component`)
  assert.ok(typeof entry.createInitialState === 'function')
  assert.ok(typeof entry.serialize === 'function')
  assert.ok(typeof entry.deserialize === 'function')
}

// 2. 旧静态渲染表必须删除，兼容门面只查询 Workspace Registry。
const registryTsx = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.equal(registryTsx.includes('SHEET_RENDER_REGISTRY'), false, '不得保留静态 SHEET_RENDER_REGISTRY')
assert.match(registryTsx, /resolveWorkspace\(kind\)/, '兼容门面必须查询 Workspace Registry')

// 4. SheetHost 无 switch(renderKey)：查表调用（W1-03：activeSheet 解析/ctx 构建上移 SheetLayout）
const sheetHost = readFileSync(new URL('../src/workspace-sheets/SheetHost.tsx', import.meta.url), 'utf8')
assert.equal(sheetHost.includes('switch (renderKey)'), false, 'SheetHost 不得再有 switch(renderKey)')
assert.equal(sheetHost.includes('switch ('), false, 'SheetHost 不得有任何 switch 语句')
assert.match(sheetHost, /resolveSheetRender\(sheet\.kind\)/, 'SheetHost 必须查渲染注册表调用')
assert.match(sheetHost, /<Component sheet=\{sheet\} ctx=\{ctx\}/, 'SheetHost 必须渲染 type definition component')
// SheetLayout 负责 activeSheet 解析 + ctx 构建 + 侧栏/右栏壳
const sheetLayout = readFileSync(new URL('../src/workspace-sheets/SheetLayout.tsx', import.meta.url), 'utf8')
assert.match(sheetLayout, /<SheetSidebarSlot sheet=\{activeSheet\} ctx=\{ctx\} \/>/, 'SheetLayout 必须渲染侧栏壳')
assert.match(sheetLayout, /<SheetRightSlot sheet=\{activeSheet\} ctx=\{ctx\} \/>/, 'SheetLayout 必须渲染右栏壳')
assert.match(sheetLayout, /<SheetHost sheet=\{activeSheet\} ctx=\{ctx\} \/>/, 'SheetLayout 必须渲染主区')

// 5. SheetContext 13 字段齐备（源码断言）
const sheetTypes = readFileSync(new URL('../src/workspace-sheets/sheetTypes.ts', import.meta.url), 'utf8')
for (const field of ['openSheet', 'focusSheet', 'closeSheet', 'activeSession', 'selectSession', 'openProfileEdit', 'openSessionSettings', 'sidebarCollapsed', 'rightInset', 'ccEditMode', 'sessionSource', 'sessionBySource']) {
  assert.match(sheetTypes, new RegExp(`${field}:`), `SheetContext 必须含 ${field}`)
}
assert.match(sheetTypes, /interface SheetContext/, '必须定义 SheetContext')

// 6. 完整 type definition 契约包含主区、侧栏、右栏与状态编解码。
const workspaceTypes = readFileSync(new URL('../src/workspace-sheets/workspaceTypes.ts', import.meta.url), 'utf8')
for (const field of ['component:', 'sidebar?:', 'contextPanel?:', 'createInitialState', 'serialize(', 'deserialize(']) {
  assert.ok(workspaceTypes.includes(field), `WorkspaceTypeDefinition 必须包含 ${field}`)
}

console.log('sheet registry 渲染表完整性守卫通过')
