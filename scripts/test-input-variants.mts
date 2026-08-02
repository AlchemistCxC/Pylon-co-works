import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
const input = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/InputBar.css', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const presets = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')
const customPresets = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')

assert.match(store, /inputVariant: 'cli'/)
assert.match(store, /inputShowPlaceholder: true/)
assert.match(store, /inputShowHistoryHint: true/)
assert.match(store, /inputSubmitButtonMode: 'inline'/)
assert.match(store, /state\.inputVariant = state\.inputVariant === 'cli'/, '旧主题必须迁移 inputVariant')
assert.match(store, /state\.inputMode = state\.inputVariant === 'cli' \? 'cli' : 'default'/, 'inputMode 必须从 variant 归一化')
assert.match(input, /input-variant-\$\{inputVariant\}/, 'InputBar 必须输出 variant class')
assert.match(input, /inputVariant === 'command' && <div className="input-command-kicker">COMMAND<\/div>/)
assert.match(input, /showPlaceholder \? \(inputVariant === 'cli'/)
assert.match(input, /showHistoryHint && historyIndex >= 0/)
assert.match(input, /submitButtonMode !== 'hidden'/)
assert.match(css, /\.input-bar\.input-variant-compact/)
assert.match(css, /\.input-bar\.input-variant-command/)
assert.match(settings, /options=\{\['cli','composer','compact','command'\]\}/)
for (const field of ['inputVariant', 'inputShowPlaceholder', 'inputShowHistoryHint', 'inputSubmitButtonMode']) {
  assert.match(presets, new RegExp(`\\b${field}\\b`), `${field} 必须进入 cc zone`)
  assert.match(customPresets, new RegExp(`\\b${field}\\b`), `${field} 必须进入 custom preset allowlist`)
}

console.log('input variants 契约测试通过')
