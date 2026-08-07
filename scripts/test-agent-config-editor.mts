/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { classifyAgentConfigSaveError, validateAgentConfig } from '../src/components/settings/agentConfigStatus.ts'

// W1-07（桩化）：Agent 配置入口——command missing/成功/配置错误三路径 + 不冒充写回

// 1. command missing → blocked（待后端）
assert.deepEqual(classifyAgentConfigSaveError(new Error('Command not found: update_agents_config')), { kind: 'blocked' })
assert.deepEqual(classifyAgentConfigSaveError('unknown command: update_agents_config'), { kind: 'blocked' })
assert.deepEqual(classifyAgentConfigSaveError('no such command'), { kind: 'blocked' })
assert.deepEqual(classifyAgentConfigSaveError('update_agents_config 不存在'), { kind: 'blocked' })

// 2. 配置错误 → error 带消息
assert.deepEqual(classifyAgentConfigSaveError(new Error('config_error: 非法 agent 配置')), { kind: 'error', message: 'config_error: 非法 agent 配置' })
assert.deepEqual(classifyAgentConfigSaveError('protocol_error'), { kind: 'error', message: 'protocol_error' })
assert.deepEqual(classifyAgentConfigSaveError('[object Object]'), { kind: 'error', message: '保存 Agent 配置失败' }, '对象错误回退通用文案')

// 3. 前端校验：非空
assert.equal(validateAgentConfig(''), '配置不能为空')
assert.equal(validateAgentConfig('  \n  '), '配置不能为空')
assert.equal(validateAgentConfig('agents:\n  peri:\n    exe: peri'), null)

// 4. 组件接线：invoke update_agents_config；不调 reload_agents 冒充写回；blocked 明确展示
const editor = readFileSync(new URL('../src/components/settings/AgentConfigEditor.tsx', import.meta.url), 'utf8')
assert.match(editor, /invoke\('update_agents_config'/, '必须调用 update_agents_config 契约')
assert.equal(editor.includes("invoke('reload_agents'"), false, '不得用 reload_agents 冒充写回')
assert.equal(editor.includes("invoke('reload_gateway'"), false, '不得冒充 gateway 写回')
assert.match(editor, /classifyAgentConfigSaveError\(error\)/, '保存失败必须经分类')
assert.match(editor, /待后端：update_agents_config 命令尚未提供/, '命令缺失必须明确展示「待后端」')
assert.match(editor, /validateAgentConfig\(config\)/, '保存前必须前端校验')

// 5. overview 接线：配置入口打开编辑器
const overview = readFileSync(new URL('../src/sheets/OverviewSheetView.tsx', import.meta.url), 'utf8')
assert.match(overview, /<AgentConfigEditor agentId=\{activeAgent\} \/>/, 'overview 配置入口必须渲染编辑器')

console.log('agent config editor（桩化）守卫通过')
