/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { pagePersistedSessions, validateExportPath, HISTORY_PAGE_SIZE } from '../src/domains/history/persistedHistory.ts'

// W4-01：历史列表分页/排序 + 导出参数校验

// 1. 分页/排序：复用 overview normalize；updatedAt 倒序 + page/pageSize
{
  const raw = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, updatedAt: i * 10 }))
  const p1 = pagePersistedSessions(raw, 1, HISTORY_PAGE_SIZE)
  assert.equal(p1.entries.length, HISTORY_PAGE_SIZE)
  assert.equal(p1.total, 45)
  assert.equal(p1.pages, 3)
  assert.deepEqual(p1.entries.map(e => e.id), Array.from({ length: 20 }, (_, i) => `s${44 - i}`), '倒序第一页')
  const p2 = pagePersistedSessions(raw, 2)
  assert.equal(p2.entries[0]?.id, 's24')
  const p3 = pagePersistedSessions(raw, 99, HISTORY_PAGE_SIZE)
  assert.equal(p3.page, 3, '越界页 clamp 到末页')
  assert.deepEqual(pagePersistedSessions([], 1), { entries: [], total: 0, page: 1, pages: 1 })
}

// 2. 导出参数校验：绝对路径预检
assert.equal(validateExportPath(''), '导出路径不能为空')
assert.equal(validateExportPath('relative/path.md'), '导出路径必须是绝对路径')
assert.equal(validateExportPath('G:/work/out.md'), null)

// 3. 组件接线：list_persisted_sessions 分页 + export_session 绝对路径参数 + 错误明确展示
const view = readFileSync(new URL('../src/sheets/history/HistorySheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /invoke<unknown>\('list_persisted_sessions'\)/, '必须调 list_persisted_sessions')
assert.match(view, /pagePersistedSessions\(raw, page\)/, '必须经分页纯函数')
assert.match(view, /invoke\('export_session', \{ periId, format: 'markdown', outputPath \}\)/, '导出必须带绝对路径参数')
assert.match(view, /validateExportPath\(outputPath\)/, '导出前必须预检路径')
assert.match(view, /role="alert"/, '导出错误必须明确展示')
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /history: \{ render: \(sheet, ctx\) => <HistorySheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry history 必须渲染')

console.log('history sheet 守卫通过')
