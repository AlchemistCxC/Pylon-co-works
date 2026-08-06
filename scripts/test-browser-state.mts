import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { browserReducer, createBrowserState, type BrowserState } from '../src/domains/browser/browserState.ts'
import { classifyBrowserStartError } from '../src/infrastructure/tauri/browserContracts.ts'

// W4-03：browser 状态机——idle/starting/ready/error、单实例（重复 start no-op）

// 1. 状态机转移
{
  let s: BrowserState = createBrowserState()
  assert.equal(s.phase, 'idle')
  s = browserReducer(s, { type: 'start' })
  assert.equal(s.phase, 'starting')
  s = browserReducer(s, { type: 'started', instanceId: 'b1' })
  assert.equal(s.phase, 'ready')
  assert.equal(s.instanceId, 'b1')
  s = browserReducer(s, { type: 'stop' })
  assert.equal(s.phase, 'idle')
  s = browserReducer(s, { type: 'start' })
  s = browserReducer(s, { type: 'failed', error: 'boom' })
  assert.equal(s.phase, 'error')
  assert.equal(s.error, 'boom')
}

// 2. 单实例：starting 中重复 start no-op；非 starting 的 started/failed no-op
{
  let s = browserReducer(browserReducer(createBrowserState(), { type: 'start' }), { type: 'start' })
  assert.equal(s.phase, 'starting', '重复 start 无操作')
  const ready = browserReducer(browserReducer(createBrowserState(), { type: 'start' }), { type: 'started' })
  assert.deepEqual(browserReducer(ready, { type: 'started' }), ready, 'ready 后 started no-op')
  assert.deepEqual(browserReducer(createBrowserState(), { type: 'started' }), createBrowserState(), 'idle 的 started no-op')
}

// 3. 组件壳：不虚构 CDP 命令名；明确「待后端」；单实例 start
const view = readFileSync(new URL('../src/sheets/browser/BrowserSheetView.tsx', import.meta.url), 'utf8')
assert.equal(view.includes("invoke('cdp"), false, '不得虚构 CDP 命令名')
assert.match(view, /浏览器 WebView 命令不可用|WebView2 子进程由 Browser Sheet 生命周期管理/, '必须明确 WebView 生命周期状态')
assert.match(view, /browserReducer, undefined, createBrowserState/, '必须经纯状态机')
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /browser: \{ render: \(sheet, ctx\) => <BrowserSheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry browser 必须渲染')

console.log('browser state 守卫通过')
// ── W4-04（桩化）：启动调用点 + 命令缺失 blocked ──

// 4. 启动错误分类
assert.deepEqual(classifyBrowserStartError(new Error('Command not found: browser_start')), { kind: 'blocked' })
assert.deepEqual(classifyBrowserStartError('browser_start 不存在'), { kind: 'blocked' })
assert.deepEqual(classifyBrowserStartError('protocol_error'), { kind: 'error', message: 'protocol_error' })

// 5. 组件接线：启动 invoke 调用点就位；命令缺失明确「待后端」
assert.match(view, /invoke(?:<[^>]+>)?\('browser_start'/, '必须接入 browser_start invoke')
assert.match(view, /classifyBrowserStartError\(error\)/, '失败必须经分类')
assert.match(view, /浏览器 WebView 命令不可用|WebView2 子进程由 Browser Sheet 生命周期管理/, '命令错误必须明确 WebView 生命周期状态')
