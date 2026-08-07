/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS } from '../src/domains/cc/widgetDefinitions.ts'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'
import { resolveTaskPill } from '../src/domains/activity/taskPill.ts'

// P1-07：tasks widget 双点登记（defs + registry）+ pill 显隐 + 跨区桥展开

// 1. 双点登记完整：defs 单一真值含 tasks、空属性表；默认布局 status-primary
assert.equal(CC_WIDGET_IDS.includes('tasks'), true, 'CC_WIDGET_IDS 必须含 tasks')
assert.deepEqual(WIDGET_PROPERTY_FIELDS.tasks, [], 'tasks 必须补空属性表')
assert.deepEqual(DEFAULT_CC_LAYOUT.placements.tasks, { slot: 'status-primary', order: 3, offsetX: 0, offsetY: 0 }, '默认排布 status-primary（ekg/pct/tokens 旁）')

// 2. registry 登记项 + 渲染器接线
const registry = readFileSync(new URL('../src/components/cc/widgetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /id: 'tasks', label: '任务', category: 'status', defaultPlacement: placement\('status-primary', 3\)/, 'registry 必须登记 tasks 到 status-primary')
assert.match(registry, /resolveTaskPill\(tasks\)/, 'pill 必须经 taskPill 纯函数')
assert.match(registry, /pylon:tasks-toggle/, '点击必须 dispatch 跨区桥事件')
assert.match(registry, /if \(!pill\.visible\) return null/, '无任务必须返回 null')

// 3. pill 显隐（复用 P1-02 纯函数语义，双点消费一致）
assert.deepEqual(resolveTaskPill([]), { visible: false, label: '' })
assert.deepEqual(resolveTaskPill([{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }]), { visible: true, label: '⇅ 2 任务 · 1 完成' })

// 4. ccLayout/hidden/scale 仍由现有机制自动覆盖（widget 机制零新增）
const widgetDefinitions = readFileSync(new URL('../src/domains/cc/widgetDefinitions.ts', import.meta.url), 'utf8')
assert.match(widgetDefinitions, /'tasks'/, 'defs 单一真值必须含 tasks')
// isWidgetVisible 不特判 tasks（走通用 hidden/排布/缩放机制）
const controlCenter = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')
assert.equal(controlCenter.includes("id === 'tasks'"), false, 'ControlCenter 不得特判 tasks（白拿机制）')

console.log('task widget 守卫通过')
