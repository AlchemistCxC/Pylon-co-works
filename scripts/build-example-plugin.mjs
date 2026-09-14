/**
 * build-example-plugin.mjs — 构建 examples/plugins/example.solid-renderer 的运行时产物。
 *
 * 背景：dist/entry.js 是这个 example 插件被真实加载的真身
 * （pylon-plugin.json 的 web.entry 指向它，kinds/slots/suite/profile 全在其中）。
 * 它原先靠手工维护——于是产生一个静默风险：src/ 改了、dist 没重建时，
 * 集成测试会对着陈旧 bundle 断言并通过。曾经的守卫用文件 mtime 判新鲜度，
 * 但 checkout 会重写 mtime 且 mtime 顺序取决于 git 索引写入顺序，
 * 导致同一份内容在 CI 上一轮绿一轮红（非确定性门禁）。
 *
 * 现在改为构建产出：dist 与 src 恒定同源，守卫随之下线。
 *
 * entry.d.ts 是面向插件消费方的接口契约（非运行时产物），随源码入库于
 * src/entry.d.ts，由本脚本复制到 dist/ 供 TS 在 dist/entry.js 旁解析——
 * 内容不生成（手写契约比 tsc 从 any-typed context 推出的更精确）。
 *
 * solid-js / solid-js/web 由宿主提供，必须 external——打进来会造成
 * 双实例（signal 与宿主不同源，Solid 响应性失效）。
 */
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import console from 'node:console'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repoRoot, 'examples', 'plugins', 'example.solid-renderer')
const distDir = join(pluginDir, 'dist')

mkdirSync(distDir, { recursive: true })

await build({
  entryPoints: [join(pluginDir, 'src', 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2021',
  legalComments: 'inline',
  outfile: join(distDir, 'entry.js'),
  external: ['solid-js', 'solid-js/web'],
  logLevel: 'info',
})

copyFileSync(join(pluginDir, 'src', 'styles.css'), join(distDir, 'styles.css'))
// entry.d.ts 是面向插件消费方的接口契约（与 src/entry.ts 同源入库），
// 复制到 dist 供 TypeScript 在 dist/entry.js 旁解析。
copyFileSync(join(pluginDir, 'src', 'entry.d.ts'), join(distDir, 'entry.d.ts'))

console.log('[build-example-plugin] dist/entry.js + dist/styles.css + dist/entry.d.ts 已由 src/ 重建')
