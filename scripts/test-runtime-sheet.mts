import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { filterRuntimeLogs, mergeRuntimeLogs, collectRuntimeLogFacets, RUNTIME_LOG_LIMIT, type RuntimeLogEntry } from '../src/domains/runtime/runtimeLogs.ts'
import { normalizeRuntimeLogEntry, normalizeRuntimeLogList } from '../src/infrastructure/tauri/runtimeLogContracts.ts'

// W1-08：runtime 日志——list 回放 + 增量去重排序、纯过滤、上限、normalize 容错

const entry = (id: number, message: string, level = 'info', source = 'acp'): RuntimeLogEntry => ({ id, timestamp: id * 1000, level, source, message })

// 1. merge：按 id 去重（不按 message 文本）、保持 id 倒序、固定上限
{
  const listed = [entry(5, 'a'), entry(3, 'b')]
  const incremental = [entry(4, 'c'), entry(3, 'b'), entry(6, 'd')]
  const merged = mergeRuntimeLogs(listed, incremental)
  assert.deepEqual(merged.map(e => e.id), [6, 5, 4, 3], 'id 倒序且去重（3 只保留一次）')
  assert.equal(merged.filter(e => e.id === 3).length, 1)
  // 上限
  const many = Array.from({ length: RUNTIME_LOG_LIMIT + 50 }, (_, i) => entry(i, `m${i}`))
  const capped = mergeRuntimeLogs(many, [])
  assert.equal(capped.length, RUNTIME_LOG_LIMIT, '固定上限截断')
}

// 2. filter：level 精确、source 精确、search 大小写不敏感包含
{
  const logs = [entry(1, 'Agent started', 'info', 'acp'), entry(2, 'CONFIG reloaded', 'warn', 'config'), entry(3, 'agent error', 'error', 'acp')]
  assert.deepEqual(filterRuntimeLogs(logs, { level: 'error' }).map(e => e.id), [3])
  assert.deepEqual(filterRuntimeLogs(logs, { source: 'acp' }).map(e => e.id), [1, 3])
  assert.deepEqual(filterRuntimeLogs(logs, { search: 'CONFIG' }).map(e => e.id), [2], '大小写不敏感')
  assert.deepEqual(filterRuntimeLogs(logs, { search: 'zzz' }), [])
  assert.equal(filterRuntimeLogs(logs, {}).length, 3)
}

// 3. facets：去重后 level/source 集合
{
  const { levels, sources } = collectRuntimeLogFacets([entry(1, 'a', 'error'), entry(2, 'b', 'warn'), entry(3, 'c', 'info'), entry(4, 'd', 'info', 'config')])
  assert.deepEqual(levels, ['error', 'warn', 'info'], 'level 按严重度排序')
  assert.deepEqual(sources, ['acp', 'config'])
  assert.deepEqual(collectRuntimeLogFacets([]), { levels: [], sources: [] })
}

// 4. normalize 容错：非法 level 归 info、timestamp 字符串、缺 message → null
{
  assert.equal(normalizeRuntimeLogEntry(null), null)
  assert.equal(normalizeRuntimeLogEntry({ id: 1, message: '' }), null, '空 message 丢弃')
  assert.equal(normalizeRuntimeLogEntry({ message: 'x' }), null, '缺 id 丢弃')
  const normalized = normalizeRuntimeLogEntry({ id: 7, timestamp: '1722500000000', level: 'weird', source: 'acp', message: 'm', fields: { a: '1', b: 2 } })
  assert.equal(normalized?.level, 'info', '非法 level 归 info')
  assert.equal(normalized?.timestamp, 1722500000000, '字符串数字时间戳解析')
  assert.deepEqual(normalized?.fields, { a: '1' }, '非字符串 field 丢弃')
  assert.equal(normalizeRuntimeLogList('not-array').length, 0)
  assert.equal(normalizeRuntimeLogList([{ id: 1, message: 'ok' }, null]).length, 1)
}

// 5. RuntimeSheetView 接线：list 回放 + 增量 listen + unmount 清理 + clear
const sheet = readFileSync(new URL('../src/sheets/RuntimeSheetView.tsx', import.meta.url), 'utf8')
assert.match(sheet, /invoke<unknown>\('list_runtime_logs'\)/, '必须 list 回放')
assert.match(sheet, /listen<unknown>\('pylon:runtime-log'/, '必须订阅实时增量')
assert.match(sheet, /mergeRuntimeLogs\(previous, normalizeRuntimeLogList\(raw\)\)/, 'list 必须经去重合并')
assert.match(sheet, /mergeRuntimeLogs\(previous, \[entry\]\)/, '增量必须经去重合并')
assert.match(sheet, /unlisten\.then\(stop => stop\(\)\)/, 'unmount 必须清理 listener')
assert.match(sheet, /invoke\('clear_runtime_logs'\)/, '必须支持 clear')
assert.match(sheet, /filterRuntimeLogs\(entries, filter\)/, '必须纯过滤')
assert.equal(sheet.includes('rightPanel'), false, 'runtime 无右栏')

// 6. registry runtime 条目渲染 RuntimeSheetView
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /runtime: \{ render: \(sheet, ctx\) => <RuntimeSheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry runtime 必须渲染 RuntimeSheetView')

console.log('runtime sheet 守卫通过')
