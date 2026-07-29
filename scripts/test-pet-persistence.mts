import assert from 'node:assert/strict'
import { clearPetPosition, PET_POSITION_KEY, persistPetState, readPetPosition, writePetPosition, type PetStorage } from '../src/components/petPersistence.ts'

class MemoryStorage implements PetStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()
const position = { x: 128.5, y: 64 }
writePetPosition(storage, position)
assert.deepEqual(readPetPosition(storage), position, '固定位置应能写入并恢复')
assert.equal(storage.getItem(PET_POSITION_KEY), JSON.stringify(position), '位置快照应使用稳定 storage key')

clearPetPosition(storage)
assert.equal(readPetPosition(storage), null, '清除位置后不得恢复旧位置')

storage.setItem(PET_POSITION_KEY, '{损坏 json')
assert.equal(readPetPosition(storage), null, '损坏 JSON 应安全回退为空位置')

storage.setItem(PET_POSITION_KEY, JSON.stringify({ x: 'bad', y: 2 }))
assert.equal(readPetPosition(storage), null, '非法位置字段应安全回退为空位置')

const state = {
  name: '微栖',
  xp: 12,
  stage: 'sprout',
  title: '新芽种',
  age_days: 3,
  next_stage_xp: 25,
  growth_progress: 0.48,
  msg: '测试消息',
}
assert.deepEqual(persistPetState(state), { name: '微栖', xp: 12 },
  '派生 stage/title/progress/msg 不得写入持久化快照')

console.log('pet persistence tests passed')
