import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/SessionSettings.tsx', import.meta.url), 'utf8')

assert.match(source, /useEffect\(\(\) => \{[\s\S]*setName\(s\?\.name \|\| ''\)[\s\S]*setPlatform\(s\?\.platform \|\| 'local'\)[\s\S]*setWorkdir\(s\?\.workdir \|\| ''\)[\s\S]*setSessionPrompt\(s\?\.sessionPrompt \|\| ''\)/,
  '会话切换时应重新同步全部表单字段')
assert.match(source, /\[sessionId, s\?\.name, s\?\.platform, s\?\.workdir, s\?\.sessionPrompt\]/,
  '同步 effect 必须订阅 sessionId 和全部表单源字段')

console.log('session settings lifecycle tests passed')
