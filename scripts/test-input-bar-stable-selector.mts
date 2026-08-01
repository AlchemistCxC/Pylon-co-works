import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')

assert.match(source, /const EMPTY_COMMANDS[^=]*= Object\.freeze\(\[\]\)/,
  'InputBar 应使用模块级稳定空数组作为 commands fallback')
assert.doesNotMatch(source, /sessionLiveStats\[sessionSource\]\?\.commands \|\| \[\]/,
  'Zustand selector 内不得创建新的空数组 snapshot')
assert.match(source, /\? \(state\.sessionLiveStats\[sessionSource\]\?\.commands \?\? EMPTY_COMMANDS\)\s*: EMPTY_COMMANDS/,
  '有会话和无会话分支都应返回稳定的 EMPTY_COMMANDS')

console.log('InputBar stable selector tests passed')
