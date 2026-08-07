/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeGatewayStatus, classifyGatewayWriteError } from '../src/infrastructure/tauri/gatewayContracts.ts'

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
assert.match(view, /\.status\(\)/, '必须经 gateway client 调 gateway_status')
assert.match(view, /raw as GatewayStatus/, '状态必须 typed 消费')
assert.match(view, /\.sessions\(\)/, '必须经 gateway client 调 gateway_sessions（Phase 2 接线）')
assert.match(view, /raw as PlatformSession\[\]/, '平台会话必须 typed 消费')
assert.match(view, /归 Prism 管理，只读/, 'inject 必须只读提示归 Prism')
assert.equal(view.includes('rightPanel'), false, 'gateway 无右栏')
const css = readFileSync(new URL('../src/sheets/gateway/GatewaySheet.css', import.meta.url), 'utf8')
assert.ok(css.length > 0, '必须有样式')

// 3. registry gateway 条目渲染
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /gateway: \{ render: lazyRender\(GatewaySheetView\) \}/, 'registry gateway 必须渲染')

console.log('gateway sheet 守卫通过')
// ── W3-02（桩化）：写回分类 + update→reload 顺序 + 锁中毒 ──

// 4. 写回错误分类
assert.deepEqual(classifyGatewayWriteError(new Error('Command not found: update_agents_config')), { kind: 'blocked' })
assert.deepEqual(classifyGatewayWriteError('gateway_config_lock_poisoned'), { kind: 'lock-poisoned' })
assert.deepEqual(classifyGatewayWriteError('锁中毒'), { kind: 'lock-poisoned' })
assert.deepEqual(classifyGatewayWriteError(new Error('protocol_error')), { kind: 'error', message: 'protocol_error' })

// 5. 组件接线：update→reload 顺序（显式 scope 契约）；命令缺失明确「待后端」；锁中毒展示失败
const gatewayTxn = readFileSync(new URL('../src/application/transactions/saveGatewayRouteTransaction.ts', import.meta.url), 'utf8')
assert.match(gatewayTxn, /\{ scope: 'gateway', config: \{ gateway: \{ routes \} \} \}/, 'scope=gateway 显式契约必须在保存事务（Phase 3 拍板）')
assert.match(view, /saveGatewayRouteTransaction\(/, '保存必须经 gateway 路由事务（合并→保存→reload→read-back）')
assert.match(view, /待后端：update_agents_config 命令尚未提供/, '写回缺失必须明确「待后端」')
assert.match(view, /磁盘已更新、运行态仍旧配置|setWriteStatus\(\{ kind: 'lock-poisoned' \}\)/, '锁中毒必须展示部分成功')
