/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createSessionSettingsValues, isSessionSettingsDirty } from '../src/components/sessionSettingsForm.ts'

const initial = createSessionSettingsValues({
  name: 'A',
  platform: 'local',
  workdir: 'G:/Work/A',
  sessionPrompt: '保持简洁',
})

assert.deepEqual(initial, {
  name: 'A',
  platform: 'local',
  workdir: 'G:/Work/A',
  sessionPrompt: '保持简洁',
})
assert.equal(isSessionSettingsDirty(initial, initial), false, '初始值不应标记为 dirty')
assert.equal(isSessionSettingsDirty({ ...initial, workdir: 'G:/Work/B' }, initial), true, '任一字段变化应标记为 dirty')
assert.deepEqual(createSessionSettingsValues(), {
  name: '',
  platform: 'local',
  workdir: '',
  sessionPrompt: '',
})

const source = readFileSync(new URL('../src/components/SessionSettings.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-shell/styles/components/SessionSettings.css', import.meta.url), 'utf8')

assert.match(source, /beforeClose/, '关闭入口应统一经过 dirty 丢弃确认')
assert.match(source, /session-settings-section/, '会话设置应按信息层级分区')
assert.match(source, /session-settings-danger/, '删除操作应位于独立危险区域')
assert.equal(source.includes('session-settings-advanced'), false, '未接入能力区已从精简表单移除')
assert.match(source, /disabled=\{!dirty\}/, '未修改时保存按钮应禁用')
assert.match(source, /aria-describedby="session-settings-description"/, 'Dialog 应提供可访问的说明关联')
assert.match(css, /\.session-settings-footer/, '应有独立 sticky footer 样式')
assert.match(css, /\.session-settings-danger/, '应有独立危险区域样式')

console.log('session settings form tests passed')
