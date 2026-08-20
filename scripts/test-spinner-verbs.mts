/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeSpinnerVerbs } from '../src/components/chat/spinnerVerbs.ts'

const fallback = ['格物致知', '见微知著']

assert.deepEqual(
  normalizeSpinnerVerbs('  Thinking  \n\n Reading\r\nThinking \n  ', fallback),
  ['Thinking', 'Reading'],
)
assert.deepEqual(normalizeSpinnerVerbs('   \n\r\n  ', fallback), fallback)
assert.deepEqual(normalizeSpinnerVerbs('', fallback), fallback)
assert.deepEqual(normalizeSpinnerVerbs('one\none\n two \n\ntwo', ['fallback']), ['one', 'two'])

const footer = readFileSync(new URL('../src/components/chat/GenerationFooter.tsx', import.meta.url), 'utf8')
assert.match(footer, /import \{ normalizeSpinnerVerbs \} from '\.\/spinnerVerbs'/)
assert.match(footer, /normalizeSpinnerVerbs\(spinnerCustomVerbs, IDIOMS\)/)
assert.doesNotMatch(footer, /function normalizeVerbs\(/)

console.log('spinnerVerbs 回归测试通过')
