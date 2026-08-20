/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { lineFromDataNode, normalizeSelectionRange } from '../src/sheets/file/selectionCapture.ts'

// W2-08：DispatchBar——1-based selection 捕获 fixture、send_message 显式 source/persona、错误内联

// 1. selection 行号归一（fixture 断言防 off-by-one）
assert.deepEqual(normalizeSelectionRange(3, 5), { startLine: 3, endLine: 5 })
assert.deepEqual(normalizeSelectionRange(5, 3), { startLine: 3, endLine: 5 }, 'anchor 在后也排序')
assert.deepEqual(normalizeSelectionRange(4, 4), { startLine: 4, endLine: 4 }, '单行选区')
assert.equal(normalizeSelectionRange(null, 3), null)
assert.equal(normalizeSelectionRange(undefined as unknown as number | null, 3), null)

// 2. DOM data-line 查找：节点本身/父级；无 data-line → null
{
  const el = { getAttribute: (name: string) => name === 'data-line' ? '42' : null, parentNode: null }
  assert.equal(lineFromDataNode(el as unknown as Node), 42)
  const parent = { getAttribute: () => null, parentNode: el }
  assert.equal(lineFromDataNode(parent as unknown as Node), 42, '向上找最近 data-line')
  const noLine = { getAttribute: () => null, parentNode: null }
  assert.equal(lineFromDataNode(noLine as unknown as Node), null)
  assert.equal(lineFromDataNode(null), null)
}

// 3. DispatchBar：send_message 显式 source + persona:''；发出后清 instruction 保留选区；错误内联；生成中仅提示
const bar = readFileSync(new URL('../src/sheets/file/DispatchBar.tsx', import.meta.url), 'utf8')
assert.match(bar, /\.sendMessage\(\{ agentId, source: targetSource, content: message, persona: ''/, '必须经 typed client 显式 source + persona 空串')
assert.match(bar, /buildDispatchMessage\(\{/, '必须经纯函数组装消息')
assert.match(bar, /onInstructionChange\(''\)/, '发出后清 instruction')
assert.equal(bar.includes("onSelectionChange(null)"), false, '发出后保留选区')
assert.match(bar, /setError\(messageText\)/, '错误内联展示')
assert.match(bar, /reportRuntimeError\('发送指令', err\)/, '错误走错误中心')
assert.match(bar, /生成中，消息将排队/, '生成中仅提示')
assert.equal(bar.includes('disabled={!targetSource || !instruction.trim()}'), true, '发送 disabled 条件')
assert.match(bar, /window\.addEventListener\('selectionchange', capture\)/, '必须监听选区变化')

// 4. FileTabView 代码行带 data-line（DOM selection→行号依据）
const tabView = readFileSync(new URL('../src/sheets/file/FileTabView.tsx', import.meta.url), 'utf8')
assert.match(tabView, /data-line=\{index \+ 1\}/, '代码行必须带 1-based data-line')
assert.match(tabView, /onContentReady\?\.\(loaded\.text\)/, '内容必须回传（组装消息用）')

// 5. FileViewHost 接线：DispatchBar 在代码区上方（FileSheetView 统一经 FileViewHost 渲染）
const host = readFileSync(new URL('../src/sheets/file/FileViewHost.tsx', import.meta.url), 'utf8')
assert.match(host, /<DispatchBar/, 'FileViewHost 必须挂 DispatchBar')
assert.match(host, /onClearSelection=\{\(\) => setSelection\(null\)\}/, '✕ 清选区')

console.log('file dispatch UI 守卫通过')
