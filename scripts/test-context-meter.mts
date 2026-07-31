import { strict as assert } from 'node:assert'
import { clampContextRatio, resolveContextMeter } from '../src/contextMeter.ts'

const palette = { ok: '#00aa00', warning: '#ffaa00', danger: '#ff0000' }

assert.equal(clampContextRatio(0, 100), 0)
assert.equal(clampContextRatio(50, 100), 0.5)
assert.equal(clampContextRatio(-1, 100), 0)
assert.equal(clampContextRatio(200, 100), 1)
assert.equal(clampContextRatio(20, 0), 0)
assert.equal(clampContextRatio(Number.NaN, 100), 0)

assert.deepEqual(resolveContextMeter({ used: 49, max: 100, palette }), {
  ratio: 0.49,
  percentage: 49,
  color: '#00aa00',
  label: '上下文 49%',
})
assert.deepEqual(resolveContextMeter({ used: 50, max: 100, palette }), {
  ratio: 0.5,
  percentage: 50,
  color: '#ffaa00',
  label: '上下文 50%',
})
assert.deepEqual(resolveContextMeter({ used: 80, max: 100, palette }), {
  ratio: 0.8,
  percentage: 80,
  color: '#ff0000',
  label: '上下文 80%',
})
assert.deepEqual(resolveContextMeter({ used: 25, max: 0, palette: { ok: '', warning: '', danger: '' } }), {
  ratio: 0,
  percentage: 0,
  color: '#34d399',
  label: '上下文 0%',
})

console.log('contextMeter 纯函数回归测试通过')
