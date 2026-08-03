import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// Node 无法解析 codeHighlight.ts 顶层 `onig.wasm?url` 导入：Node 把 .wasm 当 ES 模块
// 加载，其 import 段引用 'env' → ERR_MODULE_NOT_FOUND。高亮引擎运行时只能在浏览器
// （Vite 把 ?url 打包为 asset，getOnigurumaUrlFetch 走本地）验证 → 本测试改为源码级契约。
const source = readFileSync(new URL('../src/components/chat/codeHighlight.ts', import.meta.url), 'utf8')

// ── 语言 → scope 映射（scopeForLanguage 纯函数由该常量表驱动）──
const table = source.match(/const LANGUAGE_SCOPES[\s\S]*?= \{([\s\S]*?)\n\}/)?.[1] ?? ''
assert.ok(table.length > 0, '必须能截取 LANGUAGE_SCOPES 常量表')
const scopes = new Map([...table.matchAll(/([a-z]+): '([^']+)'/g)].map(([, k, v]) => [k, v]))
assert.equal(scopes.get('ts'), 'source.ts')
assert.equal(scopes.get('python'), 'source.python')
assert.equal(scopes.get('sh'), 'source.shell')
assert.equal(scopes.get('jsx'), 'source.js')
assert.equal(scopes.get('html'), 'text.html.basic')
assert.ok(!scopes.has('unknown'), '未知语言不得在映射表中')
// 未知语言路径：scope 或 loader 缺失 → highlightCode 返回 null
assert.match(source, /if \(!scope \|\| !load\) return cacheResult\(cacheKey\(language, code\), null\)/)

// ── GRAMMAR_LOADERS：每个 scope 都有语法包 ──
const loaderLines = source.match(/^\s{2}'([^']+)': \(\) => import\('@wooorm\/starry-night\/[^']+'\),$/gm) ?? []
assert.equal(loaderLines.length, 14, 'GRAMMAR_LOADERS 必须覆盖全部 14 个 scope')
const loadedScopes = loaderLines.map(line => line.trim().match(/^'([^']+)'/)![1])
for (const scope of ['source.js', 'source.ts', 'source.tsx', 'source.python', 'source.rust', 'source.go', 'source.java', 'source.c', 'source.c++', 'source.css', 'source.json', 'source.yaml', 'source.shell', 'text.html.basic']) {
  assert.ok(loadedScopes.includes(scope), `缺少 grammar loader: ${scope}`)
}

// ── S1-CSP：onig.wasm 本地化（?url 打包为 asset，getOnigurumaUrlFetch 指向本地）──
assert.match(source, /import onigWasmUrl from 'vscode-oniguruma\/release\/onig\.wasm\?url'/)
assert.match(source, /getOnigurumaUrlFetch: \(\) => new URL\(onigWasmUrl, window\.location\.href\)/)

// ── 缓存语义：128 上限 / 命中刷新 / pending 去重 ──
assert.match(source, /MAX_HIGHLIGHT_CACHE_ENTRIES = 128/)
assert.match(source, /highlightCache\.has\(key\)/)
assert.match(source, /highlightPending\.get\(key\)/)
assert.match(source, /highlightPending\.delete\(key\)/)

console.log('codeHighlight 回归测试通过（源码级契约，运行时高亮仅在浏览器验证）')
