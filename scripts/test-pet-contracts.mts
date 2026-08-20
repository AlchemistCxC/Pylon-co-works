import { strict as assert } from 'node:assert'
import { normalizePetState, normalizePetStats } from '../src/infrastructure/tauri/petContracts.ts'

// H2：宠物 snake_case DTO 收窄——脏数据按字段类型兜底，杜绝污染 localStorage

const stats = normalizePetStats({ messages: 'bad', prompts_completed: 3, tokens_total: 99 })
assert.equal(stats.messages, 0, '非数字字段回退 0')
assert.equal(stats.prompts_completed, 3)
assert.equal(stats.tokens_total, 99)

const state = normalizePetState({
  happiness: 'high',
  energy: 50,
  xp: 120,
  stage: 'hooper',   // 非法 stage → seed
  stats: { tokens_total: 'x' },
  memories: ['a', 42, 'b'],
  first_chunk_at_ms: null,
})
assert.equal(state.happiness, 0, '非法 happiness 回退 0')
assert.equal(state.energy, 50)
assert.equal(state.stage, 'seed', '非法 stage 回退 seed')
assert.equal(state.stats.tokens_total, 0)
assert.deepEqual(state.memories, ['a', 'b'], 'memories 只留字符串')
assert.equal(state.first_chunk_at_ms, null)
assert.equal(state.name, '宠物', '缺省 name 回退')

// 完全缺失的输入 → 全默认（不崩、可持久化）
const empty = normalizePetState(undefined)
assert.equal(empty.name, '宠物')
assert.equal(empty.stats.messages, 0)

console.log('petContracts 收窄回归测试通过')
