/**
 * STRUCTURE GUARD：生产入口必须由 KernelRoot 永久持有 React Root，
 * 当前 Pylon App 只能作为 builtin Application contribution 注册。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const kernelRoot = readFileSync(new URL('../src/kernel/KernelRoot.tsx', import.meta.url), 'utf8')
const runtime = readFileSync(new URL('../src/kernel/applicationRuntime.ts', import.meta.url), 'utf8')
const shellPlugin = readFileSync(new URL('../src/plugins/product/builtinPylonShell.ts', import.meta.url), 'utf8')

assert.match(main, /import KernelRoot from '\.\/kernel\/KernelRoot'/, 'main 必须导入 KernelRoot')
assert.match(main, /ReactDOM\.createRoot\(document\.getElementById\('root'\)!\)\.render\([\s\S]*?<KernelRoot \/>/, 'React Root 必须挂载 KernelRoot')
assert.doesNotMatch(main, /<App \/>/, 'main 不得直接挂载 App')
assert.match(kernelRoot, /BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID/, '内置 Pylon Application 必须由 shell plugin 标识')
assert.match(shellPlugin, /lazy\(\(\) => import\('\.\.\/\.\.\/App\.tsx'\)\)/, 'App 必须由 shell plugin 延迟加载')
assert.match(shellPlugin, /application\.register\(\{ id: BUILTIN_PYLON_SHELL_ID, component: PylonApplication \}\)/, 'App 必须经 plugin-owned Application API 注册')
assert.match(kernelRoot, /applicationRuntime\.mount\(BUILTIN_PYLON_APPLICATION_ID\)/, '启动时必须挂载内置 Pylon Application')
assert.match(kernelRoot, /<ErrorBoundary>/, 'Kernel 必须永久持有 ErrorBoundary')
assert.match(runtime, /getSnapshot:/, 'ApplicationRuntime 必须提供 snapshot')
assert.match(runtime, /subscribe:/, 'ApplicationRuntime 必须提供响应式 subscribe')

console.log('KernelRoot/ApplicationMount 入口结构回归测试通过')
