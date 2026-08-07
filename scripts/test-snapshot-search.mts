/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { snapshotSearch, SNAPSHOT_SCAN_LIMIT, isMessageSnapshotKey, parseMessageSnapshotRaw } from '../src/domains/search/snapshotSearch.ts'

// W3-03：快照搜索——复用 messagePersistence key/parse、扫描上限纯常量、结果定位组合 action

// 1. 纯搜索：envelope/裸数组都解析；匹配大小写不敏感；损坏快照不崩
{
  const raw: Record<string, string> = {
    'pylon-msgs-s1': JSON.stringify({ version: 1, messages: [{ id: 'm1', content: '你好世界', time: '12:00' }, { id: 'm2', content: 'hello world' }] }),
    'pylon-msgs-s2': JSON.stringify([{ id: 'm3', content: 'Hello Again' }]),
    'pylon-msgs-s3': '{broken',
    'other-key': 'x',
  }
  const storage = { getItem: (key: string) => raw[key] ?? null }
  const keys = Object.keys(raw)
  const r = snapshotSearch(storage, 'hello', keys)
  assert.equal(r.results.length, 2, '大小写不敏感匹配')
  assert.ok(r.results.some(x => x.sessionId === 's1' && x.messageId === 'm2'))
  assert.ok(r.results.some(x => x.sessionId === 's2' && x.messageId === 'm3'))
  assert.equal(isMessageSnapshotKey('pylon-msgs-s1'), true)
  assert.equal(isMessageSnapshotKey('other-key'), false)
  assert.deepEqual(parseMessageSnapshotRaw(storage['pylon-msgs-s3']), [], '损坏快照返回空')
  assert.deepEqual(snapshotSearch(storage, '', keys).results, [], '空查询无结果')
  assert.deepEqual(snapshotSearch(storage, 'zzz', keys).results, [])
}

// 2. 扫描上限纯常量：超限截断标记
{
  const keys = Array.from({ length: 5 }, (_, i) => `pylon-msgs-s${i}`)
  const raw: Record<string, string> = {}
  for (const key of keys) raw[key] = JSON.stringify([{ id: 'm', content: 'needle' }])
  const r = snapshotSearch({ getItem: (key: string) => raw[key] ?? null }, 'needle', keys, { limit: 3 })
  assert.equal(r.results.length, 3, '上限截断')
  assert.equal(r.truncated, true)
  assert.equal(SNAPSHOT_SCAN_LIMIT, 2000)
}

// 3. 组件接线：扫描本地会话快照；结果点击 open agent + selectSession + 定位 CustomEvent；范围仅本地
const view = readFileSync(new URL('../src/sheets/search/SearchSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /isMessageSnapshotKey\(key\)/, '必须扫 pylon-msgs-* 快照')
assert.match(view, /snapshotSearch\(localStorage, query, snapshotKeys\)/, '必须经纯域搜索')
assert.match(view, /pylon:locate-message/, '必须发定位 message id 事件')
assert.match(view, /ctx\.selectSession\(session\.id\)/, '结果点击必须 selectSession')
assert.match(view, /ctx\.openSheet\(\{ kind: 'agent'/, '结果点击必须 open agent')
assert.match(view, /仅本地会话/, '范围必须标注仅本地（平台未决）')
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /search: \{ render: \(sheet, ctx\) => <SearchSheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry search 必须渲染')

console.log('snapshot search 守卫通过')
