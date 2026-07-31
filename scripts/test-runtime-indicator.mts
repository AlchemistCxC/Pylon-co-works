import { strict as assert } from 'node:assert'
import { resolveRuntimeIndicator } from '../src/runtimeIndicator.ts'

assert.deepEqual(resolveRuntimeIndicator({ generating: false, prismOn: true }), {
  state: 'ready', label: '就绪', colorToken: 'ok',
})
assert.deepEqual(resolveRuntimeIndicator({ generating: true, prismOn: true }), {
  state: 'running', label: '运行中', colorToken: 'run',
})
assert.deepEqual(resolveRuntimeIndicator({ generating: true, prismOn: false }), {
  state: 'offline', label: '离线', colorToken: 'dim',
})
assert.deepEqual(resolveRuntimeIndicator({ generating: false, prismOn: false }), {
  state: 'offline', label: '离线', colorToken: 'dim',
})

console.log('runtimeIndicator 纯函数回归测试通过')
