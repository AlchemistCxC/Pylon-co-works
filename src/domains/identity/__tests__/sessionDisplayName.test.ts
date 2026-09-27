import { describe, expect, it } from 'vitest'
import { resolveSessionDisplayName } from '../identityStore.ts'

/**
 * #393：显示名与存储名分口径——存储始终以 Agent 为准（`autoName`），显示优先用户
 * 改名（`renamedByUser`）。旧数据没有 `renamedByUser` 键，缺省必须是「未改名」。
 */
describe('resolveSessionDisplayName', () => {
  const generated = { name: 'session-mujptjer', autoName: '' }

  it('无 Agent 标题、未改名 → 本地生成名', () => {
    expect(resolveSessionDisplayName(generated)).toBe('session-mujptjer')
  })

  it('有 Agent 标题 → 显示 Agent 标题（不改写存储里的 name）', () => {
    expect(resolveSessionDisplayName({ ...generated, autoName: 'Riccati 助手介绍' })).toBe('Riccati 助手介绍')
  })

  it('用户改过名 → 恒显示用户的名字，Agent 后续标题不顶替显示', () => {
    expect(resolveSessionDisplayName({ name: '我的排障会话', autoName: 'Riccati 助手介绍', renamedByUser: true }))
      .toBe('我的排障会话')
  })

  it('改名标记只在 true 时生效（false/缺省 = 未改名）', () => {
    expect(resolveSessionDisplayName({ name: 'x', autoName: 'agent 标题', renamedByUser: false })).toBe('agent 标题')
    expect(resolveSessionDisplayName({ name: 'x', autoName: 'agent 标题', renamedByUser: undefined })).toBe('agent 标题')
  })
})
