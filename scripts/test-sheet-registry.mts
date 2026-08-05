import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { SHEET_KINDS, type SheetKind } from '../src/workspace-sheets/sheetTypes.ts'
import { SHEET_REGISTRY } from '../src/workspace-sheets/sheetRegistry.ts'

// W1-02：渲染注册表完整性——纯数据表（可实际 import 全表）+ 渲染表（源码提取）同 key 防漂移

// 1. 纯数据表：9 kind 全部有 entry；每 entry 持 renderKey/singleton/getSingletonKey
assert.equal(Object.keys(SHEET_REGISTRY).length, SHEET_KINDS.length, '注册表必须精确覆盖 SHEET_KINDS')
for (const kind of SHEET_KINDS) {
  const entry = SHEET_REGISTRY[kind]
  assert.ok(entry, `${kind} 必须有 registry entry`)
  assert.ok(typeof entry.renderKey === 'string' && entry.renderKey.length > 0, `${kind} 必须保留 renderKey`)
  assert.ok(typeof entry.singleton === 'boolean')
  assert.ok(typeof entry.getSingletonKey === 'function')
}

// 2. 渲染表完整性：SHEET_RENDER_REGISTRY 的 key 集合与纯数据表一致（源码提取，防两张表漂移）
const registryTsx = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
const renderKeys = [...registryTsx.matchAll(/^\s{2}([a-z-]+): \{ render:/gm)].map(match => match[1]).sort()
assert.deepEqual(renderKeys, [...SHEET_KINDS].sort(), 'SHEET_RENDER_REGISTRY 必须与纯数据表同 key 集合')

// 3. 渲染表满足 Record<SheetKind, SheetRenderEntry> 类型守卫（satisfies，tsc 层兜底）
assert.match(registryTsx, /satisfies Record<SheetKind, SheetRenderEntry>/, '渲染表必须带 satisfies 类型守卫')

// 4. SheetHost 无 switch(renderKey)：查表调用
const sheetHost = readFileSync(new URL('../src/workspace-sheets/SheetHost.tsx', import.meta.url), 'utf8')
assert.equal(sheetHost.includes('switch (renderKey)'), false, 'SheetHost 不得再有 switch(renderKey)')
assert.equal(sheetHost.includes('switch ('), false, 'SheetHost 不得有任何 switch 语句')
assert.match(sheetHost, /resolveSheetRender\(activeSheet\.kind\)/, 'SheetHost 必须查渲染注册表调用')
assert.match(sheetHost, /entry\.render\(activeSheet, buildSheetContext\(props\)\)/, 'SheetHost 必须经 ctx 调用 entry.render')

// 5. SheetContext 13 字段齐备（源码断言）
const sheetTypes = readFileSync(new URL('../src/workspace-sheets/sheetTypes.ts', import.meta.url), 'utf8')
for (const field of ['openSheet', 'focusSheet', 'closeSheet', 'activeSession', 'selectSession', 'openProfileEdit', 'openSessionSettings', 'sidebarCollapsed', 'rightInset', 'ccEditMode', 'sessionSource', 'sessionBySource']) {
  assert.match(sheetTypes, new RegExp(`${field}:`), `SheetContext 必须含 ${field}`)
}
assert.match(sheetTypes, /interface SheetContext/, '必须定义 SheetContext')

// 6. 渲染注册表持 render/sidebar/rightPanel 声明（W1-03/04 消费位）
assert.match(sheetTypes, /render: \(sheet: SheetRecord, ctx: SheetContext\) => ReactNode/, 'entry.render 签名必须是 (sheet, ctx)')
assert.match(sheetTypes, /sidebar\?: ComponentType/, 'entry 必须预留 sidebar 声明')
assert.match(sheetTypes, /rightPanel\?: 'none' \| ComponentType/, 'entry 必须预留 rightPanel 声明')

// 7. agent 直挂（非 lazy）；其余 lazy+Suspense
assert.match(registryTsx, /import AgentSheetView from '\.\.\/sheets\/AgentSheetView'/, 'agent 必须直挂（非 lazy）')
assert.match(registryTsx, /lazy\(\(\) => import\('\.\.\/sheets\/PrismManagerSheetView'\)\)/, 'prism 必须 lazy')

console.log('sheet registry 渲染表完整性守卫通过')
