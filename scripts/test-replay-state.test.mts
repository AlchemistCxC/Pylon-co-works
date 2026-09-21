import { describe, expect, it } from 'vitest'
import {
  isCurrentLoadGeneration,
  nextLoadGeneration,
  resolveLoadedMessages,
  serializeLoadedMessages,
} from '../src/components/chat/replayState.ts'

// #228 批次F：自旧 runner（顶层 assert + console.log）迁移为 vitest 用例。
describe('replay 状态与 load generation 回归（legacy 迁移）', () => {
  it('nextLoadGeneration：undefined 起步为 1，否则在现值上加一', () => {
    expect(nextLoadGeneration(undefined)).toBe(1)
    expect(nextLoadGeneration(4)).toBe(5)
  })

  it('isCurrentLoadGeneration：严格相等才视为当前代', () => {
    expect(isCurrentLoadGeneration(5, 5)).toBe(true)
    expect(isCurrentLoadGeneration(4, 5)).toBe(false)
  })

  it('resolveLoadedMessages：仅 loadSucceeded 且有 replayed 时采用重放，否则回落缓存', () => {
    expect(resolveLoadedMessages({ loadSucceeded: true, cached: ['cached'], replayed: [] })).toEqual(['cached'])
    expect(resolveLoadedMessages({ loadSucceeded: true, cached: ['cached'], replayed: ['replayed'] })).toEqual(['replayed'])
    expect(resolveLoadedMessages({ loadSucceeded: false, cached: ['cached'], replayed: ['replayed'] })).toEqual(['cached'])
  })

  it('serializeLoadedMessages：空数组折叠为 null，非空按 JSON 序列化', () => {
    expect(serializeLoadedMessages([])).toBeNull()
    expect(serializeLoadedMessages(['message'])).toBe('["message"]')
  })
})
