import { strict as assert } from 'node:assert'
import { normalizeConfigOptionUpdatePayload } from '../src/components/settings/configOptionEventState.ts'

const full = normalizeConfigOptionUpdatePayload({
  source: 'source-a',
  update: {
    sessionUpdate: 'config_option_update',
    configOptions: [{ id: 'model', currentValue: 'sonnet' }],
  },
})
assert.deepEqual(full, {
  source: 'source-a',
  kind: 'full',
  configOptions: [{ id: 'model', currentValue: 'sonnet' }],
})

const single = normalizeConfigOptionUpdatePayload({
  source: 'source-b',
  update: { sessionUpdate: 'config_option_update', id: 'model', currentValue: 'opus' },
})
assert.deepEqual(single, {
  source: 'source-b',
  kind: 'single',
  configOption: { id: 'model', currentValue: 'opus' },
})

const direct = normalizeConfigOptionUpdatePayload({
  source: 'source-c',
  sessionUpdate: 'config_option_update',
  key: 'temperature',
  value: 0.7,
})
assert.deepEqual(direct, {
  source: 'source-c',
  kind: 'single',
  configOption: { key: 'temperature', value: 0.7 },
})

assert.equal(normalizeConfigOptionUpdatePayload({ source: 'source-a', update: { sessionUpdate: 'config_option_update', configOptions: [] } }), null)
assert.equal(normalizeConfigOptionUpdatePayload({ source: 'source-a', update: { sessionUpdate: 'config_option_update', id: 'model' } }), null)
assert.equal(normalizeConfigOptionUpdatePayload({ update: { sessionUpdate: 'config_option_update', id: 'model', value: 'x' } }), null)
assert.equal(normalizeConfigOptionUpdatePayload({ source: 'source-a', update: { sessionUpdate: 'usage_update', id: 'model', value: 'x' } }), null)
assert.equal(normalizeConfigOptionUpdatePayload(null), null)
assert.equal(normalizeConfigOptionUpdatePayload({ source: 'source-a', update: 'config_option_update' }), null)

console.log('config option event adapter 回归测试通过')
