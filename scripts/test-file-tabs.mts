import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { EMPTY_FILE_TAB_STATE, fileTabKey, parseFileTabs, serializeFileTabs, languageFromPath } from '../src/sheets/file/fileSheetState.ts'

const state = { version: 3 as const, tabs: [{ path: 'src/a.ts', viewType: 'file.text' }, { path: 'src/a.ts', viewType: 'git.diff', staged: true }], activeKey: 'git.diff:src/a.ts' }
assert.deepEqual(parseFileTabs(serializeFileTabs(state)), state)
assert.deepEqual(parseFileTabs(undefined), EMPTY_FILE_TAB_STATE)
assert.deepEqual(parseFileTabs('{broken'), EMPTY_FILE_TAB_STATE)
assert.deepEqual(parseFileTabs(JSON.stringify(['a.ts', 'b.ts'])), { version: 3, tabs: [{ path: 'a.ts', viewType: 'file.text' }, { path: 'b.ts', viewType: 'file.text' }], activeKey: 'file.text:b.ts' })
assert.notEqual(fileTabKey({ path: 'x.ts', viewType: 'file.text' }), fileTabKey({ path: 'x.ts', viewType: 'git.diff' }))
assert.equal(languageFromPath('src/a.ts'), 'typescript')
assert.equal(languageFromPath('a.md'), 'markdown')

const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /serializeFileTabs\(\{ version: 3, tabs, activeKey \}\)/)
assert.match(view, /viewType: 'file\.text'/)
assert.match(view, /viewType: 'git\.diff'/)
assert.match(view, /resolveFileViewRenderer\(target, activeTab, failedRendererIds\)/)
assert.match(view, /FileViewRenderBoundary/, 'renderer 失败必须局部回退')
assert.doesNotMatch(view, /import FileViewHost/, 'FileSheet 核心不得固定 import renderer')

const host = readFileSync(new URL('../src/sheets/file/FileViewHost.tsx', import.meta.url), 'utf8')
assert.match(host, /fileTabViewType\(tab\) === 'git\.diff'/)
assert.match(host, /provider=\{gitProvider\}/)
assert.match(host, /内容不完整（truncated）/)
const tabView = readFileSync(new URL('../src/sheets/file/FileTabView.tsx', import.meta.url), 'utf8')
assert.match(tabView, /provider\.readText\(requestTarget, requestPath\)/)
assert.match(tabView, /MarkdownRenderer/)
assert.match(tabView, /sanitizeHtml\(line/)
const tree = readFileSync(new URL('../src/sheets/file/FileTree.tsx', import.meta.url), 'utf8')
assert.match(tree, /provider\.listEntries\(target, relativePath \?\? ''\)/)
assert.equal(tree.includes('readlink'), false)

console.log('file tabs v3/renderer registry 守卫通过')
