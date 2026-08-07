/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
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
