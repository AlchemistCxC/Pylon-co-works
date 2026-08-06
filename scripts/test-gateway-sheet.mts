import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeGatewayStatus } from '../src/infrastructure/tauri/gatewayContracts.ts'

// W3-01：gateway 概览——损坏 route 容错、适配器/平台会话两分区、inject 只读归 Prism

// 1. normalize：完整 DTO 收窄；损坏 route（缺字段/非对象）跳过不崩
{
  const status = normalizeGatewayStatus({
    adapters: ['qq', 42, null],
    routes: [
      { source: 'qq:group:123', agentId: 'peri', profileId: 'trpg', reset: 'idle', idleMinutes: 1440 },
      { source: 'qq:group:2', agentId: 'peri', reset: 'weird' },
      { source: 'no-agent' },
      { agentId: 'peri' },
      null,
      'str',
    ],
    qq: { groupAllowFrom: ['group-a', 1] },
    inject: { enabled: true, scenario: 'trpg', sources: ['vein'], persist: 'skip' },
  })
  assert.deepEqual(status.adapters, ['qq'])
  assert.equal(status.routes.length, 2, '损坏 route 跳过')
  assert.equal(status.routes[0]?.profileId, 'trpg')
  assert.equal(status.routes[0]?.reset, 'idle')
  assert.equal(status.routes[1]?.reset, 'idle', '非法 reset 归 idle')
  assert.deepEqual(status.qq?.groupAllowFrom, ['group-a'])
  assert.equal(status.inject?.enabled, true)
  assert.deepEqual(normalizeGatewayStatus(null), { adapters: [], routes: [], qq: null, inject: null })
  assert.deepEqual(normalizeGatewayStatus('str').routes, [])
}

// 2. 组件接线：gateway_status 只读概览；适配器/平台会话两分区；inject 归 Prism 不编辑
const view = readFileSync(new URL('../src/sheets/gateway/GatewaySheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /invoke<unknown>\('gateway_status'\)/, '必须调 gateway_status')
assert.match(view, /normalizeGatewayStatus\(raw\)/, '必须经宽容 normalize')
assert.match(view, /平台会话流（W3-02 接线，待 gateway_sessions）/, '平台会话分区为桩（W3-02）')
assert.match(view, /归 Prism 管理，只读/, 'inject 必须只读提示归 Prism')
assert.equal(view.includes("invoke('update_agents_config'"), false, '本 commit 不写回（W3-02 桩化）')
assert.equal(view.includes('rightPanel'), false, 'gateway 无右栏')
const css = readFileSync(new URL('../src/sheets/gateway/GatewaySheet.css', import.meta.url), 'utf8')
assert.ok(css.length > 0, '必须有样式')

// 3. registry gateway 条目渲染
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /gateway: \{ render: \(sheet, ctx\) => <GatewaySheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry gateway 必须渲染')

console.log('gateway sheet 守卫通过')
