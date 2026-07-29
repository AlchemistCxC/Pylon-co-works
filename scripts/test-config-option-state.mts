import { strict as assert } from 'node:assert'
import { normalizeConfigOption, normalizeConfigOptions } from '../src/components/settings/configOptionState.ts'

assert.deepEqual(normalizeConfigOption({ id: 'model', type: 'select', currentValue: 'sonnet', options: [{ id: 'sonnet', name: 'Sonnet' }] }), {
  id: 'model', label: 'model', type: 'select', currentValue: 'sonnet',
  options: [{ id: 'sonnet', label: 'Sonnet' }], raw: { id: 'model', type: 'select', currentValue: 'sonnet', options: [{ id: 'sonnet', name: 'Sonnet' }] },
})
assert.equal(normalizeConfigOption({ id: 'enabled', currentValue: true }).type, 'boolean')
assert.equal(normalizeConfigOption({ id: 'temperature', currentValue: 0.7 }).type, 'number')
assert.equal(normalizeConfigOption({ id: 'name', currentValue: 'x' }).type, 'string')
assert.equal(normalizeConfigOption({ id: 'unknown', currentValue: { x: 1 } }).type, 'unknown')
assert.equal(normalizeConfigOptions(null).length, 0)

console.log('config option state 回归测试通过')
