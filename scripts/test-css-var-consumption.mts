import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// CSS 消费审计回归门禁（2026-08-04）：
// 主题系统不变量 = "Settings 每个字段都有真实渲染效果"。字段注入的 CSS var 必须被 var()
// 消费；CSS 消费的 var 必须已注入/声明，否则必须带 fallback（悬空引用会静默回退）。
// 防再犯：新增字段若注入 var 却无人消费，或组件引用悬空 var，本测试即红。
//
// 注入集 = THEME_CSS_VAR_MAP（defs 中 color/number 且非 noCssVar 的字段，cssVar 显式或
// kebab 派生）+ App.tsx 手写注入 var。与 src/themeFieldDefs.ts:264 的生成规则保持一致。

const ROOT = fileURLToPath(new URL('../src', import.meta.url))
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const cssFiles: string[] = []
const tsxFiles: string[] = []
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (name.endsWith('.css')) cssFiles.push(p)
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) tsxFiles.push(p)
  }
}
walk(ROOT)
const cssAll = cssFiles.map(read).join('\n')
const tsxAll = tsxFiles.map(read).join('\n')
const kebab = (k: string) => `--${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`

// ── 注入集（复刻 THEME_CSS_VAR_MAP 生成规则）──
const defs = read(join(ROOT, 'themeFieldDefs.ts'))
const defsBlock = defs.slice(defs.indexOf('export const THEME_FIELD_DEFS'))
const matches = [...defsBlock.matchAll(/^\s{2}([A-Za-z0-9]+): \{/gm)]
const injected = new Set<string>()
const injectedFields = new Set<string>()
for (let i = 0; i < matches.length; i += 1) {
  const key = matches[i][1]
  const start = matches[i].index + matches[i][0].length
  const end = i + 1 < matches.length ? matches[i + 1].index : defsBlock.length
  const body = defsBlock.slice(start, end)
  if (/\bnoCssVar:\s*true/.test(body)) continue
  // type 经辅助函数表达：C=color N=number（可注入）；显式 type 字段兜底
  if (!(/\btype:\s*'(color|number)'/.test(body) || /\.\.\.(?:C|N)\(/.test(body))) continue
  const explicit = body.match(/cssVar:\s*'(--[a-z0-9-]+)'/)
  injected.add(explicit ? explicit[1] : kebab(key))
  injectedFields.add(key)
}
// App.tsx 手写注入 var（cssVars 对象键）
const app = read(join(ROOT, 'App.tsx'))
for (const m of app.matchAll(/'((?:--[a-z0-9-]+))':/g)) injected.add(m[1])

// ── F：App 订阅集必须精确覆盖注入集（缺订阅 = var 不注入 → 主题值落 fallback；
//    死订阅 = 无谓重渲染。两侧都不允许）──
const appSelectorStart = app.indexOf('const s = useStore(useShallow(s => ({')
const appSelector = app.slice(appSelectorStart, app.indexOf('})))', appSelectorStart))
const subscribed = new Set<string>()
for (const m of appSelector.matchAll(/s\.([A-Za-z0-9]+)/g)) subscribed.add(m[1])
// 手写/data 属性字段（App 直读，不经 THEME_CSS_VAR_MAP）
const DATA_ATTR_FIELDS = new Set([
  'uiScheme', 'msgStyle', 'messageLayout', 'footerLayout', 'cliOverflowMode',
  'globalBgImage', 'globalBgColor', 'globalFont', 'chatFont', 'msgFont', 'msgTextColor',
  'sidebarBgImage', 'chatBgImage', 'inputBgImage', 'statusBgImage', 'rightBgImage',
])
const missingSub = [...injectedFields].filter(f => !subscribed.has(f)).sort()
assert.deepEqual(missingSub, [], `缺订阅（var 不注入，主题值落 fallback）：\n${missingSub.join('\n')}`)
const deadSub = [...subscribed].filter(f => !injectedFields.has(f) && !DATA_ATTR_FIELDS.has(f)).sort()
assert.deepEqual(deadSub, [], `死订阅（订阅但无消费）：\n${deadSub.join('\n')}`)

// ── 消费集 / 声明集 ──
const consumed = new Set<string>()
const consumedWithFallback = new Set<string>()
for (const f of cssFiles) {
  const s = read(f)
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) consumed.add(m[1])
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*,/g)) consumedWithFallback.add(m[1])
}
for (const f of tsxFiles) {
  const s = read(f)
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) consumed.add(m[1])
  for (const m of s.matchAll(/var\((--[a-zA-Z0-9-]+)\s*,/g)) consumedWithFallback.add(m[1])
}
const declared = new Set<string>()
for (const m of cssAll.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(m[1])
for (const f of tsxFiles) {
  const s = read(f)
  // style 对象键 '--x': … / ['--x' as never]: …；setProperty('--x', …) 单独捕获
  for (const m of s.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*(?:as never\s*\]\s*)?:/g)) declared.add(m[1])
  for (const m of s.matchAll(/setProperty\(['"](--[a-zA-Z0-9-]+)/g)) declared.add(m[1])
}

// ── A：注入必消费（死注入 = 字段无渲染效果）──
const deadInjected = [...injected].filter(v => !consumed.has(v)).sort()
assert.deepEqual(deadInjected, [], `以下注入 var 从未被 var() 消费（字段改了没效果）：\n${deadInjected.join('\n')}`)

// ── B：悬空引用必须有 fallback（否则静默回退到 initial）──
const dangling = [...consumed]
  .filter(v => !injected.has(v) && !declared.has(v) && !consumedWithFallback.has(v))
  .sort()
assert.deepEqual(dangling, [], `以下 var 既未注入/声明也无 fallback（悬空引用）：\n${dangling.join('\n')}`)

console.log(`CSS 消费审计通过（注入 ${injected.size} / 消费 ${consumed.size} / 声明 ${declared.size}，死注入与悬空引用均为 0）`)
