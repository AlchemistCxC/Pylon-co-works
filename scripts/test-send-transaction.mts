import { strict as assert } from 'node:assert'
import { runSendTransaction } from '../src/components/chat/sendTransaction.ts'

let successCleanup = 0
let errors = 0
assert.equal(await runSendTransaction({
  send: async () => undefined,
  onSuccess: () => { successCleanup++ },
  onError: () => { errors++ },
}), true)
assert.equal(successCleanup, 1)
assert.equal(errors, 0)

successCleanup = 0
errors = 0
assert.equal(await runSendTransaction({
  send: async () => { throw new Error('send failed') },
  onSuccess: () => { successCleanup++ },
  onError: error => {
    errors++
    assert.equal((error as Error).message, 'send failed')
  },
}), false)
assert.equal(successCleanup, 0, '发送失败不得执行清空输入/附件')
assert.equal(errors, 1)

console.log('sendTransaction 回归测试通过')
