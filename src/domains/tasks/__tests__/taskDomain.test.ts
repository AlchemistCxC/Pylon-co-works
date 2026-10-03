// 迁移自 scripts/test-task-domain.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { normalizePlanEntries } from '../planTypes.ts'

// P1-01：plan 任务纯域——normalize 容错、顺序保持。
// （taskStatusMachine / taskSelectors 两段随 #520 死代码二批退役删除——对应模块零生产消费。）

describe('planTypes normalizePlanEntries（迁移自 scripts/test-task-domain.mts，P91 A1）', () => {
  it('合法 entry 收窄；顺序保持；priority 保留（D2）', () => {
    const entries = normalizePlanEntries([
      { content: 'A', status: 'in_progress', priority: 1 },
      { content: 'B', status: 'pending' },
      { content: 'C', status: 'completed', priority: 3 },
    ])
    expect(entries.length).toBe(3)
    expect(entries.map(e => e.content)).toEqual(['A', 'B', 'C']) // 数组顺序必须保持（D2）
    expect(entries[0]?.status).toBe('in_progress')
    expect(entries[0]?.priority).toBe(1)
    expect(entries[2]?.priority).toBe(3)
  })

  it('容错：非数组 → []；缺 content 丢弃；未知 status → unknown；priority 非数字丢弃；非对象项丢弃', () => {
    expect(normalizePlanEntries(null)).toEqual([])
    expect(normalizePlanEntries('x')).toEqual([])
    expect(normalizePlanEntries([{ status: 'in_progress' }])).toEqual([])
    expect(normalizePlanEntries([null, 'str', 42])).toEqual([])
    const entries = normalizePlanEntries([{ content: 'X', status: 'weird-status' }, { content: 'Y', status: 'done', priority: 'high' }])
    expect(entries.length).toBe(2)
    expect(entries[0]?.status).toBe('unknown')
    expect(entries[1]?.status).toBe('unknown')
    expect(entries[1]?.priority).toBeUndefined()
  })
})
