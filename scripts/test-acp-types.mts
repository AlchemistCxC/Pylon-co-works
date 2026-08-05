import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { extractMode, extractModelConfig, sessionResponseObject } from '../src/infrastructure/acp/chatContracts.ts'

const response = sessionResponseObject({
  sessionId: 'peri-a',
  modes: { currentModeId: 'edit' },
  configOptions: [{ id: 'model', currentValue: 'sonnet', options: [{ id: 'sonnet' }, { id: 'opus' }] }],
})
assert.equal(response.sessionId, 'peri-a')
assert.deepEqual(extractModelConfig(response.configOptions), { model: 'sonnet', models: ['sonnet', 'opus'] })
assert.equal(extractMode(response), 'edit')
assert.deepEqual(sessionResponseObject('legacy-id'), { sessionId: 'legacy-id' })
assert.deepEqual(extractModelConfig(undefined), {})

// P1-03：契约扩展——SessionUpdate 联合含 plan 变体、tool_call/update 补 kind/content（真实定义在 chatContracts）
const src = readFileSync(new URL('../src/infrastructure/acp/chatContracts.ts', import.meta.url), 'utf8')
assert.match(src, /sessionUpdate: 'plan'/, 'SessionUpdate 必须含 plan 变体')
assert.match(src, /interface ContentBlock/, '必须定义 ContentBlock')
assert.match(src, /sessionUpdate: 'tool_call'[\s\S]*?kind\?: string/, 'tool_call 必须补 kind')
assert.match(src, /sessionUpdate: 'tool_call_update'[\s\S]*?kind\?: string/, 'tool_call_update 必须补 kind')
assert.match(src, /extractToolKind/, '必须提供 kind 提取（多键兜底）')
assert.match(src, /extractContentBlocks/, '必须提供 content 提取')

console.log('acpTypes 回归测试通过')