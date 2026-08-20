/**
 * ISSUE-13 W6（T13-7）保留策略进配置导出/导入测试（browser 模式）：
 * - 导出含保留策略（localStorage RETENTION_STORAGE_KEY 进入 envelope.data）
 * - 导入 preflight：损坏策略拒绝、越档策略拒绝、合法策略通过（policy 先 validate）
 * - CONFIG_STORAGE_KEYS 含保留策略 key
 */
import { describe, expect, it } from 'vitest'
import { buildExportPayload, CONFIG_STORAGE_KEYS, preflightImportPayload } from '../configExportImport'
import { RETENTION_STORAGE_KEY } from '../components/settings/historyRetentionPolicy'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

const envelope = (data: Record<string, string>) =>
  JSON.stringify({ app: 'pylon', version: 1, exportedAt: 'x', data })

describe('I13-W6 导出含保留策略', () => {
  it('CONFIG_STORAGE_KEYS 含保留策略 key', () => {
    expect(CONFIG_STORAGE_KEYS).toContain(RETENTION_STORAGE_KEY)
  })

  it('browser 导出含 localStorage 的保留策略', () => {
    const storage = memoryStorage({
      [RETENTION_STORAGE_KEY]: '{"mode":"by_time","days":90}',
    })
    const envelopeJson = JSON.parse(buildExportPayload(storage)) as { data: Record<string, string> }
    expect(envelopeJson.data[RETENTION_STORAGE_KEY]).toBe('{"mode":"by_time","days":90}')
  })
})

describe('I13-W6 导入 preflight 策略 validate（T13-7）', () => {
  it('损坏策略拒绝导入', () => {
    const result = preflightImportPayload(envelope({ [RETENTION_STORAGE_KEY]: 'not-json' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('保留策略')
  })

  it('字面 null 策略值拒绝导入（CR-002，不抛 TypeError）', () => {
    const result = preflightImportPayload(envelope({ [RETENTION_STORAGE_KEY]: 'null' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('保留策略')
  })

  it('越档/缺档位策略拒绝导入', () => {
    const bad = preflightImportPayload(envelope({ [RETENTION_STORAGE_KEY]: '{"mode":"by_time","days":25}' }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('越档')
    const missing = preflightImportPayload(envelope({ [RETENTION_STORAGE_KEY]: '{"mode":"by_count"}' }))
    expect(missing.ok).toBe(false)
  })

  it('合法策略（含永久/时间/数量）通过', () => {
    for (const payload of [
      '{"mode":"permanent"}',
      '{"mode":"by_time","days":30}',
      '{"mode":"by_count","count":1000}',
    ]) {
      const result = preflightImportPayload(envelope({ [RETENTION_STORAGE_KEY]: payload }))
      expect(result.ok, payload).toBe(true)
    }
  })
})
