import { strict as assert } from 'node:assert'
import { removeSessionTransaction } from '../src/application/transactions/removeSessionTransaction.ts'
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

const session = {
  id: 's1', source: 'local:x', name: 'x', profileId: 'p', createdAt: 0,
  lastActiveAt: 0, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}
const baseDeps = {
  findSession: () => session,
  closeSession: async () => undefined,
  // DEL-03（§5.13 本地优先）：本地删除/标记删除/终态化；legacy 脚本用无操作实现
  deleteSessionLocal: async () => undefined,
  markSessionDeleted: () => {},
  finalizeSessionDelete: async () => undefined,
  removeSession: () => {},
  clearMessages: () => {},
  reportError: () => {},
}

let removed = 0
let cleared = 0
const ok = await removeSessionTransaction('s1', {
  ...baseDeps,
  removeSession: () => { removed++ },
  clearMessages: () => { cleared++ },
})
assert.equal(ok.ok, true)
assert.equal(removed, 1, '成功后必须清本地会话')
assert.equal(cleared, 1, '成功后必须清消息缓存')

removed = 0
cleared = 0
const failed = await removeSessionTransaction('s1', {
  ...baseDeps,
  closeSession: async () => { throw new Error('close failed') },
  removeSession: () => { removed++ },
  clearMessages: () => { cleared++ },
  reportError: (action, error) => {
    assert.equal(action, '关闭会话')
    assert.equal((error as Error).message, 'close failed')
  },
})
assert.equal(failed.ok, true, 'DEL-03 本地优先：close_session 失败仅报告，不阻断本地删除')
assert.equal(removed, 1, '本地删除成功必须清本地会话')
assert.equal(cleared, 1, '本地删除成功必须清消息缓存')

console.log('runtimeError 回归测试通过')
