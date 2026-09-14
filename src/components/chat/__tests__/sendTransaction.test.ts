// 迁移自 scripts/test-send-transaction.mts（P91 A1）。
// 成败清理契约：成功路径恰好一次 onSuccess 清理；失败路径不清理且 onError
// 收到原始错误。逐断言平移。
import { describe, expect, it } from 'vitest'
import { runSendTransaction } from '../sendTransaction.ts'

describe('runSendTransaction 成败清理（原 test-send-transaction.mts）', () => {
  it('成功路径：返回 true 且恰好执行一次清理', async () => {
    let successCleanup = 0
    let errors = 0
    await expect(runSendTransaction({
      send: async () => undefined,
      onSuccess: () => { successCleanup++ },
      onError: () => { errors++ },
    })).resolves.toBe(true)
    expect(successCleanup).toBe(1)
    expect(errors).toBe(0)
  })

  it('失败路径：返回 false、不得执行清空输入/附件、onError 收到原始错误', async () => {
    let successCleanup = 0
    let errors = 0
    await expect(runSendTransaction({
      send: async () => { throw new Error('send failed') },
      onSuccess: () => { successCleanup++ },
      onError: error => {
        errors++
        expect((error as Error).message).toBe('send failed')
      },
    })).resolves.toBe(false)
    expect(successCleanup).toBe(0)
    expect(errors).toBe(1)
  })
})
