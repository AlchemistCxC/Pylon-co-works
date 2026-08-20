import assert from 'node:assert/strict'
import { switchAgentTransaction } from '../src/application/transactions/switchAgentTransaction.ts'

const baseDeps = {
  switchAgent: async () => {},
  resetRuntime: () => {},
  setActiveAgent: () => {},
  reportError: () => {},
  dispatchSwitched: () => {},
}

let commitCount = 0
const successDeps = {
  ...baseDeps,
  setActiveAgent: (id: string) => { if (id !== 'peri') throw new Error('agent 不一致') },
  dispatchSwitched: () => { commitCount += 1 },
  openAgentSheet: (id: string, name: string) => {
    assert.equal(id, 'peri')
    assert.equal(name, 'Peri')
  },
}
const ok = await switchAgentTransaction('peri', 'Peri', successDeps)
assert.equal(ok.ok, true)
if (ok.ok) assert.equal(ok.value, 'peri')
assert.equal(commitCount, 1, '成功路径必须完成 agent-switched 广播')

let errorReported = ''
const failed = await switchAgentTransaction('peri', 'Peri', {
  ...baseDeps,
  switchAgent: async () => { throw new Error('连接失败') },
  setActiveAgent: () => { throw new Error('失败路径不得切 Agent') },
  reportError: (_action, error) => { errorReported = (error as Error).message },
})
assert.equal(failed.ok, false)
if (!failed.ok) {
  assert.equal(failed.kind, 'transport')
  assert.equal(failed.message, '连接失败')
}
assert.equal(errorReported, '连接失败', '失败必须报告错误')
assert.equal(commitCount, 1, '失败不得提交成功状态')

console.log('agent switch transaction tests passed')
