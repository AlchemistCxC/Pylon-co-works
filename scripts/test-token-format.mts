import { strict as assert } from 'node:assert'
import { formatCacheReadTokens, formatTokenCount } from '../src/tokenFormat.ts'

assert.equal(formatTokenCount(0), '0')
assert.equal(formatTokenCount(950), '950')
assert.equal(formatTokenCount(1500), '1.5K')
assert.equal(formatTokenCount(12000), '12K')
assert.equal(formatTokenCount(1_500_000), '1.5M')
assert.equal(formatCacheReadTokens(3200), '3.2K cached')
assert.equal(formatCacheReadTokens(42), '42 cached')

console.log('tokenFormat 回归测试通过')
