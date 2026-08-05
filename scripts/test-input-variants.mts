import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
const input = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const attachWidget = readFileSync(new URL('../src/components/chat/AttachWidget.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/InputBar.css', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const store = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../src/domains/theme/migration.ts', import.meta.url), 'utf8')
const presets = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')
const customPresets = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')

assert.match(customPresets, /inputVariant: \{[\s\S]*?default: 'cli'/)
assert.match(customPresets, /inputShowPlaceholder: \{[\s\S]*?default: true/)
assert.match(customPresets, /inputShowHistoryHint: \{[\s\S]*?default: true/)
assert.match(customPresets, /inputSubmitButtonMode: \{[\s\S]*?default: 'inline'/)
assert.match(migration, /state\.inputVariant = state\.inputVariant === 'cli'/, '旧主题必须迁移 inputVariant')
assert.match(migration, /state\.inputMode = resolveInputMode\(String\(state\.inputVariant\)\)/, 'inputMode 必须从 variant 归一化（MEDIUM 5 收敛至域函数）')
assert.match(input, /input-variant-\$\{inputVariant\}/, 'InputBar 必须输出 variant class')
assert.match(input, /inputVariant === 'command' && <div className="input-command-kicker">COMMAND<\/div>/)
assert.match(input, /showPlaceholder \? \(inputVariant === 'cli'/)
assert.match(input, /showHistoryHint && historyIndex >= 0/)
assert.match(input, /submitButtonMode !== 'hidden'/)
assert.match(css, /\.input-bar\.input-variant-compact/)
assert.match(css, /\.input-bar\.input-variant-command/)
assert.match(customPresets, /\binputVariant\b[\s\S]*?'cli', 'composer', 'compact', 'command'/)
for (const field of ['inputVariant', 'inputShowPlaceholder', 'inputShowHistoryHint', 'inputSubmitButtonMode']) {
  assert.match(presets, new RegExp(`\\b${field}\\b`), `${field} 必须进入 cc zone`)
  assert.match(customPresets, new RegExp(`\\b${field}\\b`), `${field} 必须进入 custom preset allowlist`)
}

// P2-03：附件入口能力降级——gate 拦截 + filters 动态 accept + 图片提示 title/aria
assert.match(input, /resolveAttachGate\(attachCapabilities\)/, 'InputBar 附件必须经 gate 拦截未连接')
assert.match(input, /reportRuntimeError\('打开附件选择器'/, 'InputBar 附件拦截必须走 reportRuntimeError')
assert.match(input, /filters: resolveAttachFilters\(attachCapabilities\)/, 'InputBar 必须按快照动态设 accept filters')
assert.match(input, /当前 Agent 不支持图片（文本附件可用）\(Ctrl\+O\)/, 'InputBar 内联附件按钮必须写图片能力提示到 title')
assert.match(attachWidget, /当前 Agent 不支持图片（文本附件可用）/, 'AttachWidget 必须写图片能力提示到 title')
assert.match(attachWidget, /aria-label=\{imageUnsupported \?/, 'AttachWidget 降级时必须写 aria-label')

console.log('input variants 契约测试通过')
