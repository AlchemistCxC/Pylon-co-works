import { beforeEach, describe, expect, it } from 'vitest'
import { useIdentityStore } from '../identityStore.ts'
import { resetStores } from '../test/resetStores.ts'

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
})
