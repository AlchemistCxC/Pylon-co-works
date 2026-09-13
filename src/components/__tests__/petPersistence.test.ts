// 迁移自 scripts/test-pet-persistence.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { clearPetPosition, PET_POSITION_KEY, persistPetState, readPetPosition, writePetPosition, type PetStorage } from '../petPersistence.ts'

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

describe('petPersistence 位置/快照持久化（迁移自 scripts/test-pet-persistence.mts，P91 A1）', () => {
  it('固定位置写入并恢复；使用稳定 storage key', () => {
    const storage = new MemoryStorage()
    const position = { x: 128.5, y: 64 }
    writePetPosition(storage, position)
    expect(readPetPosition(storage)).toEqual(position) // 固定位置应能写入并恢复
    expect(storage.getItem(PET_POSITION_KEY)).toBe(JSON.stringify(position)) // 位置快照应使用稳定 storage key
  })

  it('清除位置后不得恢复旧位置', () => {
    const storage = new MemoryStorage()
    writePetPosition(storage, { x: 1, y: 2 })
    clearPetPosition(storage)
    expect(readPetPosition(storage)).toBeNull()
  })

  it('损坏 JSON / 非法位置字段应安全回退为空位置', () => {
    const storage = new MemoryStorage()
    storage.setItem(PET_POSITION_KEY, '{损坏 json')
    expect(readPetPosition(storage)).toBeNull()

    storage.setItem(PET_POSITION_KEY, JSON.stringify({ x: 'bad', y: 2 }))
    expect(readPetPosition(storage)).toBeNull()
  })

  it('persistPetState 派生字段不得写入持久化快照', () => {
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
    expect(persistPetState(state)).toEqual({ name: '微栖', xp: 12 }) // 派生 stage/title/progress/msg 不得写入持久化快照
  })
})
