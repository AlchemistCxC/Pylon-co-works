import { strict as assert } from 'node:assert'
import { highlightCode, scopeForLanguage } from '../src/components/chat/codeHighlight.ts'

assert.equal(scopeForLanguage('ts'), 'source.ts')
assert.equal(scopeForLanguage('python'), 'source.python')
assert.equal(scopeForLanguage('unknown'), undefined)
assert.match(await highlightCode('ts', 'const value: number = 1') || '', /pl-/)
assert.equal(await highlightCode('unknown', 'plain text'), null)

console.log('codeHighlight 回归测试通过')