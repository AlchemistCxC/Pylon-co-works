/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolvePermissionButtons } from '../src/domains/permission/permissionButtons.ts'

// P0-03：权限弹窗守卫——按钮映射纯函数（2/5 options 数量与 optionId）+ 组件接线源码断言

const request = (options: Array<{ optionId: string; label?: string; kind?: string }>) => ({
  requestId: 1,
  options,
})

// 1. 2 options：数量与 optionId 原值、顺序保持；label 缺省回退 optionId
{
  const buttons = resolvePermissionButtons(request([
    { optionId: 'allow_once' },
    { optionId: 'reject_once' },
  ]))
  assert.equal(buttons.length, 2)
  assert.deepEqual(buttons.map(b => b.optionId), ['allow_once', 'reject_once'])
  assert.deepEqual(buttons.map(b => b.label), ['allow_once', 'reject_once'], 'label 缺省必须回退 optionId')
}

// 2. 5 options：数量与 optionId 原值
{
  const buttons = resolvePermissionButtons(request([
    { optionId: 'allow_once' },
    { optionId: 'allow_session' },
    { optionId: 'allow_always' },
    { optionId: 'deny' },
    { optionId: 'deny_always' },
  ]))
  assert.equal(buttons.length, 5)
  assert.deepEqual(buttons.map(b => b.optionId), ['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_always'])
}

// 3. label 存在则用 label；kind 保留（编辑审批特化展示用）
{
  const buttons = resolvePermissionButtons(request([
    { optionId: 'allow_edit', label: '允许编辑', kind: 'edit' },
    { optionId: 'deny', label: '拒绝' },
  ]))
  assert.deepEqual(buttons.map(b => b.label), ['允许编辑', '拒绝'])
  assert.equal(buttons[0]?.kind, 'edit')
  assert.equal(buttons[1]?.kind, undefined)
}

// 4. 组件接线源码断言：动态按钮（key=optionId）、answering 禁用、choose 回传原值
const dialog = readFileSync(new URL('../src/components/PermissionDialog.tsx', import.meta.url), 'utf8')
assert.match(dialog, /resolvePermissionButtons\(request\)/, '弹窗必须经按钮映射纯函数')
assert.match(dialog, /buttons\.map\(button =>/, '必须按 options 动态生成按钮')
assert.match(dialog, /key=\{button\.optionId\}/, '按钮 key 必须用 optionId 原值')
assert.match(dialog, /disabled=\{answering\}/, 'answering 必须禁用全部按钮防双击')
assert.match(dialog, /onChoose\(button\.optionId\)/, '按钮点击必须回传 optionId 原值')
assert.match(dialog, /getPermissionController\(\)\?\.choose\(request\.requestId, optionId\)/, 'choose 必须原样回传 requestId 与 optionId')
assert.match(dialog, /role="dialog"/, '弹窗必须有 dialog 语义')
assert.match(dialog, /request\.prompt/, '必须展示 prompt')
assert.match(dialog, /request\.toolCallId/, '必须展示 toolCallId 供审计')
assert.match(dialog, /if \(!active\) return null/, '无 active 请求必须返回 null')

// 5. 弹窗挂载在 App 单例（不随 sheet 卸载）
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
assert.match(app, /<PermissionDialog \/>/, 'App 必须挂载 PermissionDialog')

console.log('permission dialog 守卫通过')
