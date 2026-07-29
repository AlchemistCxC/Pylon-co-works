import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { normalizeConfigOption, normalizeConfigOptions, parseConfigNumberInput, resolveSessionSource } from '../src/components/settings/configOptionState.ts'

assert.deepEqual(normalizeConfigOption({ id: 'model', type: 'select', currentValue: 'sonnet', options: [{ id: 'sonnet', name: 'Sonnet' }] }), {
  id: 'model', label: 'model', type: 'select', currentValue: 'sonnet',
  options: [{ id: 'sonnet', label: 'Sonnet' }], raw: { id: 'model', type: 'select', currentValue: 'sonnet', options: [{ id: 'sonnet', name: 'Sonnet' }] },
})
assert.equal(normalizeConfigOption({ id: 'enabled', currentValue: true }).type, 'boolean')
assert.equal(normalizeConfigOption({ id: 'temperature', currentValue: 0.7 }).type, 'number')
assert.equal(normalizeConfigOption({ id: 'name', currentValue: 'x' }).type, 'string')
assert.equal(normalizeConfigOption({ id: 'unknown', currentValue: { x: 1 } }).type, 'unknown')
assert.equal(normalizeConfigOptions(null).length, 0)
assert.equal(parseConfigNumberInput(''), undefined)
assert.equal(parseConfigNumberInput('   '), undefined)
assert.equal(parseConfigNumberInput('12.5'), 12.5)
assert.equal(parseConfigNumberInput('0'), 0)
assert.equal(parseConfigNumberInput('not-a-number'), undefined)
assert.equal(resolveSessionSource('local-id', [{ id: 'local-id', source: 'backend-source' }]), 'backend-source')
assert.equal(resolveSessionSource('missing', [{ id: 'local-id', source: 'backend-source' }]), undefined)
assert.equal(resolveSessionSource(null, [{ id: 'local-id', source: 'backend-source' }]), undefined)

const fieldSource = await readFile(new URL('../src/components/settings/ConfigOptionField.tsx', import.meta.url), 'utf8')
assert.match(fieldSource, /useId\(\)/)
assert.match(fieldSource, /function safeIdPart\(value: string\): string/)
assert.match(fieldSource, /return `config-option-\$\{safeIdPart\(optionId\)\}-\$\{safeIdPart\(reactId\)\}`/)
assert.match(fieldSource, /<select id=\{controlId\}/)
assert.match(fieldSource, /<input id=\{controlId\} type="checkbox"/)
assert.match(fieldSource, /<input id=\{controlId\} className="set-num"/)
assert.match(fieldSource, /const \[numberInput, setNumberInput\] = useState\(\(\) => option\.currentValue === '' \? '' : String\(option\.currentValue\)\)/)
assert.match(fieldSource, /value=\{numberInput\}/)
assert.match(fieldSource, /setNumberInput\(rawValue\)/)
assert.match(fieldSource, /if \(parsedValue !== undefined\) onChange\(parsedValue\)/)
assert.match(fieldSource, /<input id=\{controlId\} className="set-input"/)
assert.match(fieldSource, /<code id=\{controlId\} className="config-option-raw"/)
assert.equal((fieldSource.match(/htmlFor=\{controlId\}/g) ?? []).length, 5)
assert.match(fieldSource, /const controlId = configOptionControlId\(option\.id, useId\(\)\)/)

console.log('config option state 回归测试通过')
