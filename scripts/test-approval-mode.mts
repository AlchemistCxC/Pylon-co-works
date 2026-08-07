/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  APPROVAL_MODE_VALUES,
  normalizeApprovalMode,
  nextApprovalMode,
  applyApprovalModeChange,
} from '../src/domains/permission/approvalMode.ts'

// P0-04：ModeWidget 改为 approval mode——循环 bypass/auto/edit/default，invoke set_approval_mode

// 1. 循环值限定与四步循环
assert.deepEqual([...APPROVAL_MODE_VALUES], ['bypass', 'auto', 'edit', 'default'])
assert.equal(nextApprovalMode('bypass'), 'auto')
assert.equal(nextApprovalMode('auto'), 'edit')
assert.equal(nextApprovalMode('edit'), 'default')
assert.equal(nextApprovalMode('default'), 'bypass')
// 未知/空值回退 default 后再循环（default 的下一项是 bypass）
assert.equal(nextApprovalMode('unknown'), 'bypass')
assert.equal(nextApprovalMode(''), 'bypass')

// 2. normalize：合法保留，非法 null
assert.equal(normalizeApprovalMode('bypass'), 'bypass')
assert.equal(normalizeApprovalMode('auto'), 'auto')
assert.equal(normalizeApprovalMode('edit'), 'edit')
assert.equal(normalizeApprovalMode('default'), 'default')
assert.equal(normalizeApprovalMode('plan'), null)
assert.equal(normalizeApprovalMode('code'), null)

// 3. applyApprovalModeChange：成功写新值并 invoke；失败回滚显示值并抛错
{
  const writes: string[] = []
  let invoked: string | null = null
  await applyApprovalModeChange({
    nextMode: 'bypass',
    previousMode: 'default',
    writeMode: mode => writes.push(mode),
    invokeSet: async mode => { invoked = mode },
  })
  assert.deepEqual(writes, ['bypass'])
  assert.equal(invoked, 'bypass')
}
{
  const writes: string[] = []
  let threw: string | null = null
  try {
    await applyApprovalModeChange({
      nextMode: 'auto',
      previousMode: 'edit',
      writeMode: mode => writes.push(mode),
      invokeSet: async () => { throw new Error('protocol_error') },
    })
  } catch (error) {
    threw = String(error)
  }
  assert.equal(threw, 'Error: protocol_error')
  assert.deepEqual(writes, ['auto', 'edit'], '失败必须回滚到 previousMode')
}

// 4. ModeWidget 源码断言：set_approval_mode、不再出现 set_mode、读全局 approvalMode
const widget = readFileSync(new URL('../src/components/chat/ModeWidget.tsx', import.meta.url), 'utf8')
assert.match(widget, /invoke\('set_approval_mode'/, '必须调用 set_approval_mode')
assert.equal(widget.includes("invoke('set_mode'"), false, '不得再出现 set_mode')
assert.equal(widget.includes('setSessionMode'), false, '不得再消费 session mode 链')
assert.match(widget, /useRuntimeStore\(s => s\.approvalMode\)/, '必须读全局 approvalMode')
assert.match(widget, /nextApprovalMode\(mode\)/, '必须经纯域循环')
assert.match(widget, /pylon:mode-error/, '失败必须走现有错误中心')
assert.equal(widget.includes('sessionSource'), false, 'approval mode 无 source，不得再接收 sessionSource')

// 5. session mode 链保留 set_mode（不混用）
const sessionMode = readFileSync(new URL('../src/components/chat/sessionMode.ts', import.meta.url), 'utf8')
assert.match(sessionMode, /invoke\('set_mode'/, 'session mode 链必须继续消费 set_mode')

// 6. registry 不再传 sessionSource
const registry = readFileSync(new URL('../src/components/cc/widgetRegistry.tsx', import.meta.url), 'utf8')
assert.equal(registry.includes('<ModeWidget sessionSource={sessionSource} />'), false, 'registry 不得再传 sessionSource')
assert.match(registry, /return <ModeWidget \/>/, 'registry 直挂全局 approval widget')

// 7. runtimeStore 提供 approvalMode（非持久化）
const runtimeStore = readFileSync(new URL('../src/runtimeStore.ts', import.meta.url), 'utf8')
assert.match(runtimeStore, /approvalMode: 'default'/, 'approvalMode 初始 default')

console.log('approval mode 接线守卫通过')
