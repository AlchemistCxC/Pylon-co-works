import { strict as assert } from 'node:assert'
import { clampCcHeight, resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../src/ccHeightState.ts'

assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', ccStyle: 'wave' }), 7)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: ['model', 'mode'], inputMode: 'cli', ccStyle: 'wave' }), 5)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', ccStyle: 'numeric' }), 6)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: ['pct'], inputMode: 'cli', ccStyle: 'numeric' }), 6)

assert.equal(resolveCcMinHeight({
  inputMode: 'default', footerLayout: 'free', hintMode: 'full', visibleStatusWidgets: 7, cliOverflowMode: 'fixed-scroll',
}), 64)
assert.equal(resolveCcMinHeight({
  inputMode: 'cli', footerLayout: 'free', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
}), 64)
assert.equal(resolveCcMinHeight({
  inputMode: 'cli', footerLayout: 'peri', hintMode: 'hidden', visibleStatusWidgets: 4, cliOverflowMode: 'fixed-scroll',
}), 64)
assert.equal(resolveCcMinHeight({
  inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 4, cliOverflowMode: 'fixed-scroll',
}), 84)
assert.equal(resolveCcMinHeight({
  inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
}), 109)
assert.equal(resolveCcMinHeight({
  inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 7, cliOverflowMode: 'grow',
}), 64)
assert.equal(clampCcHeight(20, {
  inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
}), 109)
assert.equal(clampCcHeight(999, {
  inputMode: 'cli', footerLayout: 'peri', hintMode: 'full', visibleStatusWidgets: 5, cliOverflowMode: 'fixed-scroll',
}), 400)

console.log('ccHeightState 回归测试通过')
