/**
 * MessageRepository 适配器测试（A1-c 后仅 browser/demo 路径）：
 * - browser adapter：localStorage 快照语义（save/load/delete/revision）
 * - wire 映射：toWireRecord / fromWireRecord（OBS/迁移证据用）
 */
import { describe, expect, it } from 'vitest'

import {
  browserMessageRepository,
  canPersistMessages,
  clearMessageStorage,
  fromWireRecord,
  messageStorageKey,
  parseMessageSnapshot,
  persistMessageSnapshot,
  toWireRecord,
  type MessageStorage,
} from '../messagePersistence.ts'
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

// ── 以下两个 describe 迁移自 scripts/test-message-persistence.mts 与
// scripts/test-message-persistence-clear.mts（P91 A1）──

describe('messagePersistence 持久化门槛与 envelope（迁移自 scripts/test-message-persistence.mts，P91 A1）', () => {
  it('canPersistMessages：owner、source 与当前 render 一致时应允许持久化', () => {
    expect(canPersistMessages({
      ownerId: 'session-a',
      source: 'local:a',
      renderedSessionId: 'session-a',
      renderedSource: 'local:a',
    })).toBe(true)
  })

  it('canPersistMessages：A 的旧消息不得以 B 的 sessionId 持久化', () => {
    expect(canPersistMessages({
      ownerId: 'session-a',
      source: 'local:a',
      renderedSessionId: 'session-b',
      renderedSource: 'local:b',
    })).toBe(false)
  })

  it('canPersistMessages：owner 正确但 source 不一致时不得持久化', () => {
    expect(canPersistMessages({
      ownerId: 'session-a',
      source: 'local:a',
      renderedSessionId: 'session-a',
      renderedSource: 'local:b',
    })).toBe(false)
  })

  it('canPersistMessages：会话切换清理 owner 后不得持久化', () => {
    expect(canPersistMessages({
      ownerId: null,
      source: null,
      renderedSessionId: 'session-b',
      renderedSource: 'local:b',
    })).toBe(false)
  })

  it('persistMessageSnapshot 写稳定 key + envelope；空列表清除 key', () => {
    const writes: Array<[string, string]> = []
    const removes: string[] = []
    const storage = {
      getItem: (_key: string): string | null => null,
      setItem: (key: string, value: string) => writes.push([key, value]),
      removeItem: (key: string) => removes.push(key),
    }

    persistMessageSnapshot('session-a', [{ id: 'm1' }], storage)
    expect(writes).toEqual([['pylon-msgs-session-a', '{"version":1,"messages":[{"id":"m1"}]}']])
    persistMessageSnapshot('session-a', [], storage)
    expect(removes).toEqual(['pylon-msgs-session-a'])
  })

  it('parseMessageSnapshot：2026-08-02 版本 envelope，读取兼容旧裸数组，损坏返回 null', () => {
    expect(parseMessageSnapshot('{"version":1,"messages":[{"id":"m1"}]}')).toEqual([{ id: 'm1' }])
    expect(parseMessageSnapshot('[{"id":"m1"}]')).toEqual([{ id: 'm1' }]) // 旧裸数组格式必须兼容
    expect(parseMessageSnapshot('{"version":1,"messages":"not-array"}')).toBeNull()
    expect(parseMessageSnapshot('{not json')).toBeNull()
    expect(parseMessageSnapshot(null)).toBeNull()
  })
})

describe('messageStorage key 格式与 clearMessageStorage（迁移自 scripts/test-message-persistence-clear.mts，P91 A1）', () => {
  it('key 格式 pylon-msgs-<sessionId>', () => {
    expect(messageStorageKey('session-a')).toBe('pylon-msgs-session-a')
  })

  it('clearMessageStorage 移除对应 key', () => {
    const removed: string[] = []
    clearMessageStorage('session-a', { removeItem: key => removed.push(key) })
    expect(removed).toEqual(['pylon-msgs-session-a'])
  })
})
