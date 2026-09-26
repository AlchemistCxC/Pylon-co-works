import { beforeEach, describe, expect, it } from 'vitest'
import { useIdentityStore } from '../identityStore.ts'
import { resetStores } from '../../../test/resetStores.ts'

describe('Agent registry reconciliation', () => {
  beforeEach(() => resetStores())

  it('list_agents 标出的 backend active Agent 会成为前端 active Agent', () => {
    useIdentityStore.setState({ activeAgent: 'embedded-peri' })

    useIdentityStore.getState().setAgents([
      { id: 'ready-agent', name: 'Ready Agent', active: true },
      { id: 'other-agent', name: 'Other Agent', active: false },
    ])

    expect(useIdentityStore.getState().activeAgent).toBe('ready-agent')
  })

  // #326：零 Agent 首跑（内嵌兜底即零 Agent）必须把 activeAgent 清空——否则它会一直停在
  // store 初值的 'peri'，界面上凭空多出一个不存在的 Agent（设置卡片、权限切片、会话归属都按它算）。
  it('list_agents 为空时清空 activeAgent，不保留 store 初值的占位 Agent', () => {
    expect(useIdentityStore.getState().activeAgent).toBe('peri')

    useIdentityStore.getState().setAgents([])

    expect(useIdentityStore.getState().activeAgent).toBe('')
  })

  it('当前 Agent 已不在列表里时同样清空（配置里删掉/换掉了它）', () => {
    useIdentityStore.setState({ activeAgent: 'gone-agent' })

    useIdentityStore.getState().setAgents([{ id: 'other-agent', name: 'Other Agent', active: false }])

    expect(useIdentityStore.getState().activeAgent).toBe('')
  })

  it('列表里有当前 Agent 但未标 active 时保留当前值（browser fixture 口径）', () => {
    useIdentityStore.setState({ activeAgent: 'peri' })

    useIdentityStore.getState().setAgents([{ id: 'peri', name: 'Peri' }])

    expect(useIdentityStore.getState().activeAgent).toBe('peri')
  })
})
