/**
 * MessageRepository 适配器测试（A1-c 后仅 browser/demo 路径）：
 * - browser adapter：localStorage 快照语义（save/load/delete/revision）
 * - wire 映射：toWireRecord / fromWireRecord（OBS/迁移证据用）
 */
import { describe, expect, it } from 'vitest'

import {
  browserMessageRepository,
  fromWireRecord,
  messageStorageKey,
  parseMessageSnapshot,
  toWireRecord,
  type MessageStorage,
} from '../messagePersistence'
import type { Message } from '../messageTypes'

function memoryStorage(): MessageStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

function msg(id: string, role: 'user' | 'assistant' = 'user'): Message {
  return { id, role, sender: role === 'user' ? 'user' : 'assistant', content: `c-${id}`, time: '10:24' }
}

describe('browserMessageRepository', () => {
  it('save 写入 envelope 快照；load 原样读回；revision 恒 0', async () => {
    const storage = memoryStorage()
    const repo = browserMessageRepository(storage)
    const messages = [msg('m1'), msg('m2', 'assistant')]
    await repo.save('s1', messages)
    const parsed = parseMessageSnapshot<Message>(storage.getItem(messageStorageKey('s1')))
    expect(parsed).toEqual(messages)
    expect(await repo.load('s1')).toEqual(messages)
    expect(await repo.revision('s1')).toBe(0)
  })

  it('append 覆盖快照并返回伪 revision；delete 清除 key', async () => {
    const storage = memoryStorage()
    const repo = browserMessageRepository(storage)
    await repo.append('s1', [msg('m1')], null)
    expect(await repo.append('s1', [msg('m1'), msg('m2')], 0)).toBe(0)
    expect((await repo.load('s1'))?.length).toBe(2)
    await repo.delete('s1')
    expect(await repo.load('s1')).toBeNull()
  })

  it('load 对无数据返回 null（不抛）', async () => {
    const repo = browserMessageRepository(memoryStorage())
    expect(await repo.load('s-no-data')).toBeNull()
  })
})

describe('wire 映射', () => {
  it('toWireRecord 映射 id/session/role/content/clientMsgId', () => {
    const message: Message = { ...msg('m1'), clientMsgId: 'cm1' }
    const record = toWireRecord(message, 's1')
    expect(record).toEqual({
      messageId: 'm1',
      sessionId: 's1',
      role: 'user',
      content: 'c-m1',
      clientMsgId: 'cm1',
      createdAt: expect.any(Number),
    })
  })

  it('fromWireRecord 回映射 Message（未知 role 回退 assistant）', () => {
    const restored = fromWireRecord({
      messageId: 'm1', sessionId: 's1', seq: 1, role: 'user', content: 'hi', clientMsgId: null, createdAt: 1000,
    })
    expect(restored.id).toBe('m1')
    expect(restored.role).toBe('user')
    expect(restored.content).toBe('hi')
    expect(restored.time).toBe(new Date(1000).toLocaleTimeString())

    const fallback = fromWireRecord({
      messageId: 'm2', sessionId: 's1', seq: 2, role: 'unknown-role', content: 'x', clientMsgId: null, createdAt: 0,
    })
    expect(fallback.role).toBe('assistant')
  })
})
