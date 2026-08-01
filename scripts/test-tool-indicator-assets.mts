import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { TOOL_INDICATOR_ASSETS, resolveToolIndicatorAsset, toolIndicatorOptions } from '../src/components/chat/toolIndicatorAssets.ts'

const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../src/components/SettingsPreview.tsx', import.meta.url), 'utf8')
const presets = readFileSync(new URL('../src/presets.ts', import.meta.url), 'utf8')
const customPresets = readFileSync(new URL('../src/themeFields.ts', import.meta.url), 'utf8')

assert.deepEqual(TOOL_INDICATOR_ASSETS.map(asset => asset.id), [
  'circle', 'diamond', 'square', 'triangle', 'play', 'ring', 'double-ring', 'chevron', 'branch', 'node', 'hex',
])
assert.equal(resolveToolIndicatorAsset('circle').glyph, '●')
assert.equal(resolveToolIndicatorAsset('double-ring').glyph, '◎')
assert.equal(resolveToolIndicatorAsset('hex').glyph, '⬡')
assert.equal(resolveToolIndicatorAsset('◆').id, 'diamond', '旧 glyph 持久化值必须继续兼容')
assert.equal(resolveToolIndicatorAsset('自').glyph, '自', '自定义旧 glyph 不得被替换')
assert.equal(resolveToolIndicatorAsset().id, 'circle')
assert.deepEqual(toolIndicatorOptions().map(option => option.value), TOOL_INDICATOR_ASSETS.map(asset => asset.id))
assert.match(toolIndicatorOptions()[0].label, /^● 圆点$/)

assert.match(chatView, /resolveToolIndicatorAsset\(useStore\(s => s\.toolIndicator\)\)/, '真实 Chat 必须从 registry 解析指示器')
assert.match(chatView, /aria-label=\{indicatorAsset\.ariaLabel\[model\.state\]\}/, '真实 Chat 必须消费 registry a11y label')
assert.match(settings, /toolIndicatorOptions\(\)/, 'Settings 必须枚举 registry 选项')
assert.match(settings, /resolveToolIndicatorAsset\(t\.toolIndicator\)\.id/, 'Settings 必须兼容旧 glyph 当前值')
assert.match(preview, /resolveToolIndicatorAsset\(useStore\(s => s\.toolIndicator\)\)/, 'Preview 必须复用 registry')
assert.match(preview, /indicatorAsset\.glyph/, 'Preview 必须渲染 registry glyph')
assert.match(presets, /toolIndicator:/, '内建预设必须保留 toolIndicator 字段')
assert.match(customPresets, /'toolIndicator'/, '自定义预设 allowlist 必须包含 toolIndicator')

console.log('toolIndicator assets registry 契约测试通过')
