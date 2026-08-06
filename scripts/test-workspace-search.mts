import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { classifyWorkspaceSearchError, normalizeWorkspaceSearchResults } from '../src/infrastructure/tauri/workspaceSearchContracts.ts'

// W2-06（桩化）：workspace 搜索——只消费正式命令、missing 明确阻塞、success/error 三路径

// 1. success：宽松 normalize 桩形状
{
  const results = normalizeWorkspaceSearchResults([
    { path: 'src/a.ts', line: 12, lineText: 'const x = 1' },
    { path: 'src/b.ts', lineText: 'no line' },
    { path: '' },
    null,
    42,
  ])
  assert.equal(results.length, 2)
  assert.deepEqual(results[0], { path: 'src/a.ts', line: 12, lineText: 'const x = 1' })
  assert.equal(results[1]?.line, 1, '缺 line 默认 1')
  assert.equal(results[1]?.lineText, 'no line')
  assert.deepEqual(normalizeWorkspaceSearchResults('not-array'), [])
}

// 2. missing：命令不存在 → blocked（待后端）；error：其余
assert.deepEqual(classifyWorkspaceSearchError(new Error('Command not found: workspace_search')), { kind: 'blocked' })
assert.deepEqual(classifyWorkspaceSearchError('workspace_search 不存在'), { kind: 'blocked' })
assert.deepEqual(classifyWorkspaceSearchError(new Error('protocol_error')), { kind: 'error', message: 'protocol_error' })
assert.deepEqual(classifyWorkspaceSearchError('[object Object]'), { kind: 'error', message: '搜索失败' })

// 3. 组件接线：只消费正式命令、missing 明确「待后端」、不以前端遍历冒充搜索
const panel = readFileSync(new URL('../src/sheets/file/WorkspaceSearchPanel.tsx', import.meta.url), 'utf8')
assert.match(panel, /invoke<unknown>\('workspace_search', \{ source, query: query\.trim\(\) \}\)/, '必须只调正式 workspace_search 命令')
assert.match(panel, /待后端：workspace_search 命令尚未提供/, '命令缺失必须明确「待后端」')
assert.match(panel, /classifyWorkspaceSearchError\(error\)/, '失败必须经分类')
assert.match(panel, /normalizeWorkspaceSearchResults\(raw\)/, '结果必须经 normalize')
assert.equal(panel.includes('readdir'), false, '不得以前端遍历文件冒充搜索')
assert.equal(panel.includes("invoke('read_workspace_text'"), false, '不得用读文件冒充搜索')

// 4. FileSheetView 搜索分区接线：结果打开 tab
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /state\.activeSection === 'search'/, '搜索分区必须接线')
assert.match(view, /<WorkspaceSearchPanel source=\{state\.targetSource\} onOpenResult=\{openTab\} \/>/, '结果点击必须打开 tab')

console.log('workspace search（桩化）守卫通过')
