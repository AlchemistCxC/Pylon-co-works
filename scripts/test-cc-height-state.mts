import { strict as assert } from 'node:assert'
import { clampCcHeight, resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../src/ccHeightState.ts'

// P1-07：tasks widget 登记进 STATUS_WIDGET_IDS（由 CC_WIDGET_IDS 派生），计数 +1；
// 走通用 isWidgetVisible（hidden/numeric/外部按钮机制自动覆盖）
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', ccStyle: 'wave' }), 6)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: ['model', 'mode'], inputMode: 'cli', ccStyle: 'wave' }), 4)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: [], inputMode: 'cli', ccStyle: 'numeric' }), 5)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: ['pct'], inputMode: 'cli', ccStyle: 'numeric' }), 5)
assert.equal(resolveVisibleStatusWidgetCount({ hiddenIds: ['tasks'], inputMode: 'cli', ccStyle: 'wave' }), 5)

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
