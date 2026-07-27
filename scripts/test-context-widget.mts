import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/ControlCenter.tsx', import.meta.url), 'utf8')

assert.equal(source.includes("ccStyle === 'numeric'"), true)
assert.equal(source.includes("'--bar-h': `${barHeight}px`"), true)
assert.equal(source.includes('theme.tokenDisplay ==='), false, 'PropertyPanel 不应再用第二套显示模式覆盖 ccStyle')

console.log('contextWidget 回归测试通过')