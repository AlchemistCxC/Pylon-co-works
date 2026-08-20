import { strict as assert } from 'node:assert'
import {
  normalizeConfigOption,
  normalizeConfigOptions,
} from '../src/components/settings/configOptionState.ts'

function normalized(option: Parameters<typeof normalizeConfigOption>[0]) {
  return normalizeConfigOption(option)
}

// Candidate collections are accepted through each protocol spelling and preserve
// the first available collection as the user's selectable options.
assert.deepEqual(normalized({
  id: 'from-options',
  options: [
    { id: 'alpha', name: 'Alpha' },
    { value: 'beta', label: 'Beta' },
  ],
}).options, [
  { id: 'alpha', label: 'Alpha' },
  { id: 'beta', label: 'Beta' },
])
assert.deepEqual(normalized({ id: 'from-choices', choices: [{ name: 'named' }] }).options, [
  { id: 'named', label: 'named' },
])
assert.deepEqual(normalized({ id: 'from-values', values: [{ value: 'value-id' }] }).options, [
  { id: 'value-id', label: 'value-id' },
])
assert.deepEqual(normalized({ id: 'from-available', available: [{ label: 'label-id' }] }).options, [
  { id: 'label-id', label: 'label-id' },
])
assert.deepEqual(normalized({ id: 'empty-candidates', options: [] }).options, [])
assert.deepEqual(normalized({ id: 'missing-candidates' }).options, [])

// The current value follows the protocol's aliases in priority order, while
// false and zero remain valid values rather than being replaced by the fallback.
assert.equal(normalized({ id: 'current-value', currentValue: 'preferred', value: 'fallback' }).currentValue, 'preferred')
assert.equal(normalized({ id: 'value', value: 'from-value' }).currentValue, 'from-value')
assert.equal(normalized({ id: 'current', current: 'from-current' }).currentValue, 'from-current')
assert.equal(normalized({ id: 'selected', selected: 'from-selected' }).currentValue, 'from-selected')
assert.equal(normalized({ id: 'false', currentValue: false }).currentValue, false)
assert.equal(normalized({ id: 'zero', currentValue: 0 }).currentValue, 0)
assert.equal(normalized({ id: 'empty' }).currentValue, '')

// Explicit type normalization supports the documented scalar and select forms.
assert.equal(normalized({ id: 'flag', type: 'boolean', currentValue: false }).type, 'boolean')
assert.equal(normalized({ id: 'flag-alias', type: 'bool', currentValue: true }).type, 'boolean')
assert.equal(normalized({ id: 'count', type: 'number', currentValue: 2 }).type, 'number')
assert.equal(normalized({ id: 'count-alias', type: 'integer', currentValue: 2 }).type, 'number')
assert.equal(normalized({ id: 'text', type: 'string', currentValue: '' }).type, 'string')
assert.equal(normalized({ id: 'text-alias', type: 'text', currentValue: 'hello' }).type, 'string')
assert.equal(normalized({ id: 'choice', type: 'select', options: [] }).type, 'select')
assert.equal(normalized({ id: 'enum', type: 'enum', options: [{ id: 'one' }] }).type, 'select')

// When type is absent or unfamiliar, the value shape provides a useful scalar
// classification; otherwise the option remains unknown.
assert.equal(normalized({ id: 'inferred-boolean', current: true }).type, 'boolean')
assert.equal(normalized({ id: 'inferred-number', value: 1.5 }).type, 'number')
assert.equal(normalized({ id: 'inferred-string', selected: 'plain' }).type, 'string')
assert.equal(normalized({ id: 'unknown', type: 'future-type', currentValue: { raw: true } }).type, 'unknown')
assert.equal(normalized({ id: 'empty-unknown', type: 'future-type' }).type, 'unknown')

// Invalid collection input is treated as no config options, and invalid
// entries do not make the normalizer throw or leak non-options.
assert.deepEqual(normalizeConfigOptions(null), [])
assert.deepEqual(normalizeConfigOptions(undefined), [])
assert.deepEqual(normalizeConfigOptions({}), [])
assert.deepEqual(normalizeConfigOptions([null, undefined, 1, 'bad', { id: 'valid' }]).map(option => option.id), ['valid'])

console.log('config option normalization contract tests passed')
