import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// This is intentionally a source contract, not a browser/runtime acceptance test.
// SettingsPreview imports React/store-backed components that are not dependency-free
// in the native Node runner, so the browser-API boundary is checked directly here.
const preview = readFileSync(new URL('../src/components/SettingsPreview.tsx', import.meta.url), 'utf8')

function sectionBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken)
  assert.ok(start >= 0, `missing source section: ${startToken}`)
  const end = source.indexOf(endToken, start + startToken.length)
  assert.ok(end >= 0, `missing source section terminator: ${endToken}`)
  return source.slice(start, end)
}

// SSR/no-window initial state must use deterministic dimensions without touching
// window during module/component initialization when it is unavailable.
assert.match(preview, /w: typeof window === 'undefined' \? 1200 : window\.innerWidth/)
assert.match(preview, /h: typeof window === 'undefined' \? 760 : window\.innerHeight - 32/)
assert.match(preview, /useState\(\(\) => typeof window === 'undefined' \? 1200 : window\.innerWidth\)/)

const resizeEffect = sectionBetween(preview, '  useEffect(() => {\n    if (typeof window === \'undefined\') return', '  }, [])')
assert.match(resizeEffect, /if \(typeof window === 'undefined'\) return/)
assert.match(resizeEffect, /window\.addEventListener\('resize', update\)/)
assert.match(resizeEffect, /return \(\) => window\.removeEventListener\('resize', update\)/)
assert.ok(
  resizeEffect.indexOf("if (typeof window === 'undefined') return") < resizeEffect.indexOf("window.addEventListener('resize', update)"),
  'window guard must run before registering the resize listener',
)

const observerEffect = sectionBetween(preview, '  useEffect(() => {\n    const element = wrapRef.current', '  }, [])')
assert.match(observerEffect, /if \(!element \|\| typeof ResizeObserver === 'undefined'\) return/)
assert.match(observerEffect, /const observer = new ResizeObserver\(\(\[entry\]\) => \{/)
assert.match(observerEffect, /observer\.observe\(element\)/)
assert.match(observerEffect, /return \(\) => observer\.disconnect\(\)/)
assert.ok(
  observerEffect.indexOf("if (!element || typeof ResizeObserver === 'undefined') return") < observerEffect.indexOf('new ResizeObserver'),
  'ResizeObserver guard must run before constructing the observer',
)

console.log('settings-preview-browser-fallback contract: PASS')
