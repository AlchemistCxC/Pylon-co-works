import assert from 'node:assert/strict'
import { runAgentSwitchTransaction } from '../src/components/agentSwitchTransaction.ts'

let successCount = 0
let errorCount = 0
const succeeded = await runAgentSwitchTransaction({
  switchAgent: async () => {},
  onSuccess: () => { successCount += 1 },
  onError: () => { errorCount += 1 },
})
assert.equal(succeeded, true)
assert.equal(successCount, 1)
assert.equal(errorCount, 0)

successCount = 0
errorCount = 0
const failed = await runAgentSwitchTransaction({
  switchAgent: async () => { throw new Error('连接失败') },
  onSuccess: () => { successCount += 1 },
  onError: error => {
    assert.equal((error as Error).message, '连接失败')
    errorCount += 1
  },
})
assert.equal(failed, false)
assert.equal(successCount, 0, '切换失败不得提交成功状态')
assert.equal(errorCount, 1)

console.log('agent switch transaction tests passed')
