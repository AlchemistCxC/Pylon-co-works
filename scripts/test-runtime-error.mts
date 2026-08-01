import { strict as assert } from 'node:assert'
import { runCloseSessionTransaction } from '../src/components/chat/closeSessionTransaction.ts'
import { formatRuntimeError } from '../src/runtimeError.ts'

assert.deepEqual(formatRuntimeError('取消生成', new Error('ACP connection closed')), {
  action: '取消生成',
  message: 'ACP connection closed',
})
assert.deepEqual(formatRuntimeError('关闭会话', 'session not found: local:a'), {
  action: '关闭会话',
  message: 'session not found: local:a',
})
assert.equal(formatRuntimeError('切换 Agent', {}).message, '未知错误')

let deleted = 0
let errors = 0
assert.equal(await runCloseSessionTransaction({
  close: async () => undefined,
  onSuccess: () => { deleted++ },
  onError: () => { errors++ },
}), true)
assert.equal(deleted, 1)
assert.equal(errors, 0)

deleted = 0
errors = 0
assert.equal(await runCloseSessionTransaction({
  close: async () => { throw new Error('close failed') },
  onSuccess: () => { deleted++ },
  onError: error => {
    errors++
    assert.equal((error as Error).message, 'close failed')
  },
}), false)
assert.equal(deleted, 0, 'close_session 失败不得删除本地会话')
assert.equal(errors, 1)

console.log('runtimeError 回归测试通过')
