import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import {
  normalizeConfigOption,
  parseConfigNumberInput,
} from '../src/components/settings/configOptionState.ts'

const fieldSource = await readFile(
  new URL('../src/components/settings/ConfigOptionField.tsx', import.meta.url),
  'utf8',
)

function normalized(option: Parameters<typeof normalizeConfigOption>[0]) {
  return normalizeConfigOption(option)
}

// Every supported editable kind remains editable after normalization.
assert.equal(normalized({
  id: 'model',
  type: 'select',
  currentValue: 'sonnet',
  options: [{ id: 'sonnet', name: 'Sonnet' }],
}).type, 'select')
assert.equal(normalized({ id: 'enabled', type: 'boolean', currentValue: false }).type, 'boolean')
assert.equal(normalized({ id: 'name', type: 'string', currentValue: '' }).type, 'string')
assert.equal(normalized({ id: 'temperature', type: 'number', currentValue: 0 }).type, 'number')

// Unknown values remain a non-editable JSON display rather than being coerced
// into one of the editable scalar controls.
const unknown = normalized({ id: 'future', type: 'future-type', currentValue: { enabled: true, limit: 3 } })
assert.equal(unknown.type, 'unknown')
assert.deepEqual(unknown.currentValue, { enabled: true, limit: 3 })

// Number editing must preserve the empty state and reject invalid/non-finite
// text; valid zero is still submitted as numeric zero.
assert.equal(parseConfigNumberInput(''), undefined)
assert.equal(parseConfigNumberInput('   '), undefined)
assert.equal(parseConfigNumberInput('not-a-number'), undefined)
assert.equal(parseConfigNumberInput('Infinity'), undefined)
assert.equal(parseConfigNumberInput('0'), 0)
assert.equal(parseConfigNumberInput('12.5'), 12.5)

// Structural render contracts: each native editable control is identified and
// associated with its label; unknown values use JSON.stringify in a code node.
assert.match(fieldSource, /if \(option\.type === 'select'\)/)
assert.match(fieldSource, /<select id=\{controlId\}[^>]*value=\{String\(option\.currentValue\)\}/)
assert.match(fieldSource, /onChange=\{event => onChange\(event\.target\.value\)\}/)
assert.match(fieldSource, /option\.options\.map\(choice => <option key=\{choice\.id\} value=\{choice\.id\}>\{choice\.label\}<\/option>\)/)

assert.match(fieldSource, /if \(option\.type === 'boolean'\)/)
assert.match(fieldSource, /<input id=\{controlId\} type="checkbox"[^>]*checked=\{Boolean\(option\.currentValue\)\}/)
assert.match(fieldSource, /onChange=\{event => onChange\(event\.target\.checked\)\}/)

assert.match(fieldSource, /if \(option\.type === 'string'\)/)
assert.match(fieldSource, /<input id=\{controlId\} className="set-input" type="text"[^>]*value=\{String\(option\.currentValue\)\}/)
assert.match(fieldSource, /onChange=\{event => onChange\(event\.target\.value\)\}/)

assert.match(fieldSource, /if \(option\.type === 'number'\)/)
assert.match(fieldSource, /const \[numberInput, setNumberInput\] = useState\(\(\) => option\.currentValue === '' \? '' : String\(option\.currentValue\)\)/)
assert.match(fieldSource, /<input id=\{controlId\} className="set-num" type="number" value=\{numberInput\}/)
assert.match(fieldSource, /setNumberInput\(rawValue\)/)
assert.match(fieldSource, /if \(parsedValue !== undefined\) onChange\(parsedValue\)/)
assert.doesNotMatch(fieldSource, /onChange\(Number\(event\.target\.value\)\)/)

assert.match(fieldSource, /return <label htmlFor=\{controlId\}>[\s\S]*<code id=\{controlId\} className="config-option-raw">\{JSON\.stringify\(option\.currentValue\)\}<\/code>/)
assert.equal((fieldSource.match(/htmlFor=\{controlId\}/g) ?? []).length, 5)
assert.equal((fieldSource.match(/id=\{controlId\}/g) ?? []).length, 5)

// The readable option-id prefix is not the instance identity: useId() is
// incorporated so duplicate option ids still produce distinct control ids.
assert.match(fieldSource, /function safeIdPart\(value: string\): string/)
assert.match(fieldSource, /return `config-option-\$\{safeIdPart\(optionId\)\}-\$\{safeIdPart\(reactId\)\}`/)
assert.match(fieldSource, /const controlId = configOptionControlId\(option\.id, useId\(\)\)/)
assert.match(fieldSource, /export function configOptionControlId\(optionId: string, reactId: string\): string/)

console.log('config option field boundary regression passed')
