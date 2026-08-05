import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { SPINNER_ASSET_PRESETS, SPINNER_VERB_PRESETS } from '../src/components/chat/spinnerAssets.ts'
import { frameAt, resolveSpinnerFrames } from '../src/components/chat/spinnerFrames.ts'
import { resolveSpinnerVerbs } from '../src/components/chat/spinnerVerbs.ts'
import { resolveFrameIndex } from '../src/components/chat/spinnerMotion.ts'

assert.deepEqual(SPINNER_ASSET_PRESETS.map(asset => asset.id), [
  'sparkles', 'ascii-line', 'braille', 'dots', 'orbit', 'clock', 'wave', 'blocks', 'scan', 'cc', 'custom',
])
assert.deepEqual(SPINNER_VERB_PRESETS.map(preset => preset.id), ['zh', 'en', 'analysis', 'engineering', 'cc', 'custom'])
assert.deepEqual(resolveSpinnerFrames('cc', ''), ['·', '✢', '*', '✶', '✻', '✽'])
assert.deepEqual(resolveSpinnerFrames('orbit', ''), ['◜', '◝', '◞', '◟'])
assert.deepEqual(resolveSpinnerFrames('custom', ''), resolveSpinnerFrames('sparkles', ''))
assert.deepEqual(resolveSpinnerVerbs('analysis', ''), ['解析', '推演', '归纳', '校验', '定位', '拆解', '复核'])
assert.deepEqual(resolveSpinnerVerbs('custom', ''), resolveSpinnerVerbs('zh', ''))
assert.equal(resolveFrameIndex({ frameCount: 0, elapsedMs: 100, intervalMs: 120, motion: 'cycle' }), 0)
assert.equal(frameAt(['a', 'b', 'c'], 120, 120, 'bounce'), 'b')
assert.equal(frameAt(['a', 'b', 'c'], 240, 120, 'bounce'), 'c')
assert.equal(frameAt(['a', 'b', 'c'], 360, 120, 'bounce'), 'b')
assert.equal(frameAt(['a', 'b', 'c'], 1000, 120, 'static'), 'a')

const themeDefs = readFileSync(new URL('../src/themeFieldDefs.ts', import.meta.url), 'utf8')
const footer = readFileSync(new URL('../src/components/chat/GenerationFooter.tsx', import.meta.url), 'utf8')
assert.match(themeDefs, /\bspinnerFramePreset\b[\s\S]*?'orbit', 'clock', 'wave', 'blocks', 'scan', 'cc', 'custom'/)
assert.match(themeDefs, /\bspinnerVerbSet\b[\s\S]*?'zh', 'en', 'analysis', 'engineering', 'cc', 'custom'/)
assert.match(footer, /getSpinnerAssetPreset/)
// P1-08：motion policy 移入 SpinnerFrame 叶子（frameAsset.motion 由父级传入）
assert.match(footer, /motion=\{frameAsset\.motion\}/)
assert.match(footer, /reduceMotion \? 'static' : motion/)

console.log('spinner asset registry 与 motion policy 回归测试通过')
