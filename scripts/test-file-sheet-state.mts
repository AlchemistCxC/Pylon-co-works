import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createFileSheetState, fileSheetReducer, resetFileSheetTransientState, type FileSheetState } from '../src/sheets/file/fileSheetState.ts'

assert.deepEqual(createFileSheetState('session-a'), { activeSection: 'builtin.file.explorer', targetSessionId: 'session-a' })
let state: FileSheetState = createFileSheetState('session-a')
state = fileSheetReducer(state, { type: 'set-section', section: 'plugin.activity' })
assert.equal(state.activeSection, 'plugin.activity')
assert.equal(state.targetSessionId, 'session-a')
state = fileSheetReducer(state, { type: 'set-target-session', sessionId: null })
assert.equal(state.targetSessionId, null)
assert.deepEqual(resetFileSheetTransientState(), { truncated: false, instruction: '', fileContent: '' })

const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /file:session:/, '新 singleton 必须以 sessionId 为稳定身份')
assert.match(view, /sessionBySource\(legacySource\)/, '旧 file:<source> 必须迁移')
assert.match(view, /workspaceTargetFromSession\(targetSession\)/, 'target 必须由真实 Session 派生')
assert.match(view, /listFileActivities\(target\)/, 'activity 不得由固定数组提供')
assert.doesNotMatch(view, /activeAgent/, 'FileSheet 不得 fallback active agent')

const sidebar = readFileSync(new URL('../src/sheets/file/FileSheetSidebar.tsx', import.meta.url), 'utf8')
assert.match(sidebar, /activities\.map/, '侧栏必须消费 registry activity snapshot')
assert.doesNotMatch(sidebar, /FILE_SHEET_SECTIONS/, '固定 section 数组不得再是生产真值')
assert.equal(sidebar.includes('onCollapse'), false)

const fileCss = readFileSync(new URL('../src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css', import.meta.url), 'utf8')
assert.match(fileCss, /\.file-sidebar\.collapsed\s*\{[^}]*flex-basis:\s*var\(--workspace-sidebar-collapsed-width, 42px\)/s, 'FileSheet 折叠必须与其他 Sheet 共用 42px 图标轨道')
const registry = readFileSync(new URL('../src/plugins/core/sheet/builtinWorkspacePlugins.ts', import.meta.url), 'utf8')
assert.match(registry, /kind: 'file'.*sidebarMode: 'sheet'.*component: lazyWorkspace\(FileSheetView\)/)
const productWorkspace = readFileSync(new URL('../src/plugins/product/builtinPylonWorkspace.ts', import.meta.url), 'utf8')
assert.match(productWorkspace, /context\.contextPanel\.register\(\{[\s\S]*workspaceKind: 'file'/, 'File 右栏必须由产品插件注册贡献')

console.log('file sheet target/registry state 守卫通过')
