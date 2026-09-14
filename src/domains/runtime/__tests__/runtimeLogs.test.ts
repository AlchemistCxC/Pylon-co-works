// 迁移自 scripts/test-runtime-sheet.mts（P91 A1）。
// 按点名清单 A.14 处置只迁 runtimeLogs.ts 纯函数断言：merge 按 id 去重/上限截断、
// filter 纯过滤、facets 集合、deriveCrashMarkers 去重与 generation 新增。
// 不迁段：原脚本 4/4.6 的 runtimeLogContracts normalize 段（归 runtimeLogContracts
// 测试，test-logs-api-normalization 的迁移去向）；5/5.5/6 的 RuntimeSheetView 与
// registry 源码接线段（已被行为测试锁，处置行点名「折叠壳已被行为测试锁」）。
import { describe, expect, it } from 'vitest'
import { collectRuntimeLogFacets, deriveCrashMarkers, filterRuntimeLogs, mergeRuntimeLogs, RUNTIME_LOG_LIMIT, type RuntimeLogEntry } from '../runtimeLogs.ts'

const entry = (id: number, message: string, level = 'info', source = 'acp'): RuntimeLogEntry => ({ id, timestamp: id * 1000, level, source, message })

describe('runtimeLogs merge（原 test-runtime-sheet.mts §1，W1-08）', () => {
  it('list 回放 + 增量按 id 去重（不按 message 文本）、保持 id 倒序、固定上限', () => {
    const listed = [entry(5, 'a'), entry(3, 'b')]
    const incremental = [entry(4, 'c'), entry(3, 'b'), entry(6, 'd')]
    const merged = mergeRuntimeLogs(listed, incremental)
    expect(merged.map(e => e.id)).toEqual([6, 5, 4, 3])
    expect(merged.filter(e => e.id === 3).length).toBe(1)
    const many = Array.from({ length: RUNTIME_LOG_LIMIT + 50 }, (_, i) => entry(i, `m${i}`))
    const capped = mergeRuntimeLogs(many, [])
    expect(capped.length).toBe(RUNTIME_LOG_LIMIT)
  })
})

describe('runtimeLogs filter（原 test-runtime-sheet.mts §2）', () => {
  it('level 精确、source 精确、search 大小写不敏感包含、空 filter 全量', () => {
    const logs = [entry(1, 'Agent started', 'info', 'acp'), entry(2, 'CONFIG reloaded', 'warn', 'config'), entry(3, 'agent error', 'error', 'acp')]
    expect(filterRuntimeLogs(logs, { level: 'error' }).map(e => e.id)).toEqual([3])
    expect(filterRuntimeLogs(logs, { source: 'acp' }).map(e => e.id)).toEqual([1, 3])
    expect(filterRuntimeLogs(logs, { search: 'CONFIG' }).map(e => e.id)).toEqual([2])
    expect(filterRuntimeLogs(logs, { search: 'zzz' })).toEqual([])
    expect(filterRuntimeLogs(logs, {}).length).toBe(3)
  })
})

describe('runtimeLogs facets（原 test-runtime-sheet.mts §3）', () => {
  it('去重后 level/source 集合，level 按严重度排序', () => {
    const { levels, sources } = collectRuntimeLogFacets([entry(1, 'a', 'error'), entry(2, 'b', 'warn'), entry(3, 'c', 'info'), entry(4, 'd', 'info', 'config')])
    expect(levels).toEqual(['error', 'warn', 'info'])
    expect(sources).toEqual(['acp', 'config'])
    expect(collectRuntimeLogFacets([])).toEqual({ levels: [], sources: [] })
  })
})

describe('deriveCrashMarkers（原 test-runtime-sheet.mts §4.5，W1-09）', () => {
  it('crashed/error → marker，按 agentId:status:generation 去重，generation 变化才新增', () => {
    const statuses = {
      peri: { status: 'crashed', generation: 3, recentError: '进程崩溃' },
      hermes: { status: 'error', generation: 1 },
      ok: { status: 'connected' },
    }
    const markers = deriveCrashMarkers([], statuses, 1000)
    expect(markers.length).toBe(2)
    expect(markers.some(m => m.agentId === 'peri' && m.status === 'crashed' && m.key === 'peri:crashed:3')).toBe(true)
    expect(markers.some(m => m.agentId === 'hermes' && m.detail === undefined)).toBe(true)
    const again = deriveCrashMarkers(markers, { peri: { status: 'crashed', generation: 3 } }, 2000)
    expect(again.length).toBe(2)
    const newGen = deriveCrashMarkers(markers, { peri: { status: 'crashed', generation: 4 } }, 3000)
    expect(newGen.length).toBe(3)
  })
})
