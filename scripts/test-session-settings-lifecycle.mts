/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/SessionSettings.tsx', import.meta.url), 'utf8')

assert.match(source, /useEffect\(\(\) => \{[\s\S]*setName\(session\?\.name \|\| ''\)[\s\S]*setPlatform\(session\?\.platform \|\| 'local'\)[\s\S]*setWorkdir\(session\?\.workdir \|\| ''\)[\s\S]*setSessionPrompt\(session\?\.sessionPrompt \|\| ''\)/,
  '会话切换时应重新同步全部表单字段')
assert.match(source, /\[sessionId, session\?\.name, session\?\.platform, session\?\.workdir, session\?\.sessionPrompt\]/,
  '同步 effect 必须订阅 sessionId 和全部表单源字段')

console.log('session settings lifecycle tests passed')
