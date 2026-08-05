import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createFileSheetState, fileSheetReducer, FILE_SHEET_SECTIONS, type FileSheetState } from '../src/sheets/file/fileSheetState.ts'

// W2-03：FileSheet 分区状态——五分区、targetSource 本地态、切 source 不串

// 1. 初始状态：activeSection 默认 files，targetSource 取初始 source
{
  assert.deepEqual(createFileSheetState('local:a'), { activeSection: 'files', targetSource: 'local:a' })
  assert.deepEqual(createFileSheetState(null), { activeSection: 'files', targetSource: null })
  assert.deepEqual([...FILE_SHEET_SECTIONS], ['sessions', 'files', 'search', 'scm', 'views'])
}

// 2. 分区切换：5 分区合法；切分区不动 targetSource
{
  let state: FileSheetState = createFileSheetState('local:a')
  for (const section of FILE_SHEET_SECTIONS) {
    state = fileSheetReducer(state, { type: 'set-section', section })
    assert.equal(state.activeSection, section, `分区 ${section} 合法`)
    assert.equal(state.targetSource, 'local:a', '切分区不得动 source')
  }
}

// 3. 切 source：只改 targetSource（本地态，不串 metadata/singletonKey 语义）
{
  const state = fileSheetReducer(createFileSheetState('local:a'), { type: 'set-source', source: 'local:b' })
  assert.deepEqual(state, { activeSection: 'files', targetSource: 'local:b' })
  // 再切回 / 切 null 都只影响 targetSource
  assert.deepEqual(fileSheetReducer(state, { type: 'set-source', source: null }).targetSource, null)
}

// 4. FileSheetView 接线：singletonKey file:{source} 作初始指向；内部改指向不写 metadata
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /singletonKey\?\.replace\(\/\^file:\/, ''\)/, 'singletonKey file:{source} 作初始 source')
assert.match(view, /useReducer\(fileSheetReducer, initialSource \?\? null, createFileSheetState\)/, '初始态必须收 initial source')
assert.equal(view.includes('patchSheetMetadata'), false, 'W2-03 targetSource 本地态（metadata patch 由 W2-04 承接）')

// 5. FileSheetSidebar 五分区 + 会话列表切 source
const sidebar = readFileSync(new URL('../src/sheets/file/FileSheetSidebar.tsx', import.meta.url), 'utf8')
assert.match(sidebar, /FILE_SHEET_SECTIONS\.map/, '五分区必须经单一真值枚举')
assert.match(sidebar, /onSelectSource\(session\.source\)/, '会话列表点击必须切 source')
assert.match(sidebar, /48px/, '分区栏必须 48px 窄条（拍板）')

// 6. registry file 条目渲染 FileSheetView
const registry = readFileSync(new URL('../src/workspace-sheets/sheetRegistry.tsx', import.meta.url), 'utf8')
assert.match(registry, /file: \{ render: \(sheet, ctx\) => <FileSheetView sheet=\{sheet\} ctx=\{ctx\} \/> \}/, 'registry file 必须渲染 FileSheetView')

console.log('file sheet state 守卫通过')
