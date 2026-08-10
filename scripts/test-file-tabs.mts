/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileTabKey, parseFileTabs, serializeFileTabs, languageFromPath } from '../src/sheets/file/fileSheetState.ts'

// W2-04→v2（ISSUE-08 D-02/D-04）：统一 file/diff tab identity 版本化 schema

// 1. v2 tab 编解码 roundtrip；v1 string[] 迁移；损坏 JSON → 空（不清整个 persistence）
{
  const state = {
    version: 2 as const,
    tabs: [
      { path: 'src/a.ts', mode: 'file' as const },
      { path: 'src/a.ts', mode: 'diff' as const, staged: true },
    ],
    activeKey: 'diff:src/a.ts',
  }
  assert.deepEqual(parseFileTabs(serializeFileTabs(state)), state)
  assert.deepEqual(parseFileTabs(undefined), { version: 2, tabs: [], activeKey: null })
  assert.deepEqual(parseFileTabs(''), { version: 2, tabs: [], activeKey: null })
  assert.deepEqual(parseFileTabs('{broken json'), { version: 2, tabs: [], activeKey: null }, '损坏 JSON normalize 为空')
  assert.deepEqual(parseFileTabs(JSON.stringify({ not: 'array' })), { version: 2, tabs: [], activeKey: null })
  // v1 openTabs:string[] → file-mode tabs
  assert.deepEqual(parseFileTabs(JSON.stringify(['a.ts', 'b.ts'])), {
    version: 2,
    tabs: [
      { path: 'a.ts', mode: 'file' },
      { path: 'b.ts', mode: 'file' },
    ],
    activeKey: 'file:b.ts',
  })
  // tab 单例 key 区分 path+mode：同路径 file/diff 不互相覆盖
  assert.notEqual(fileTabKey({ path: 'x.ts', mode: 'file' }), fileTabKey({ path: 'x.ts', mode: 'diff' }))
}

// 2. 语言推断
{
  assert.equal(languageFromPath('src/a.ts'), 'typescript')
  assert.equal(languageFromPath('a.md'), 'markdown')
  assert.equal(languageFromPath('Dockerfile'), 'text')
  assert.equal(languageFromPath('x.py'), 'python')
  assert.equal(languageFromPath('x.rs'), 'rust')
}

// 3. FileSheetView：metadata openTabs（v2 版本化 tab 记录）/activeFile 组合 action + close 行为
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /parseFileTabs\(sheet\.metadata\?\.openTabs\)/, 'openTabs 必须经版本化解析从 metadata 恢复')
assert.match(view, /serializeFileTabs\(\{ version: 2, tabs, activeKey \}\)/, '打开/关闭 tab 必须写版本化 openTabs')
assert.match(view, /persistTabs\(next, fileTabKey\(\{ path, mode: 'file' \}\)\)/, '文件 tab 单例 key = file:{path}')
assert.match(view, /persistTabs\(next, fileTabKey\(\{ path, mode: 'diff' \}\)\)/, 'SCM diff tab 单例 key = diff:{path}（不覆盖同路径 file tab）')
assert.match(view, /closeTab = \(key: string\) =>/, '必须支持按 key 关闭 tab')
assert.match(view, /<FileViewHost source=\{state\.targetSource\} tab=\{activeTab\} onCloseTab=\{closeTab\} \/>/, '主区必须经 FileViewHost 统一渲染 file/diff')

// 3b. FileTabBar：key 区分 path+mode；diff 带 mode 标记；选中按 key 判定
const tabBar = readFileSync(new URL('../src/sheets/file/FileTabBar.tsx', import.meta.url), 'utf8')
assert.match(tabBar, /const key = fileTabKey\(tab\)/, 'tab React key 必须区分 path+mode')
assert.match(tabBar, /key=\{key\}/, 'tab React key 必须用 mode 区分 key')
assert.match(tabBar, /file-tab-diff/, 'diff tab 必须带 mode 标记')
assert.match(tabBar, /aria-selected=\{activeKey === key\}/, '选中态必须按 key 判定')

// 3c. FileViewHost：按 mode 统一渲染 file/diff；diff 复用 DiffView；truncated 可读
const host = readFileSync(new URL('../src/sheets/file/FileViewHost.tsx', import.meta.url), 'utf8')
assert.match(host, /tab\.mode === 'diff'/, 'diff 分支按 mode 渲染')
assert.match(host, /<DiffView\n\s+source=\{source\}\n\s+path=\{tab\.path\}\n\s+staged=\{tab\.staged \?\? false\}/, 'diff 经 DiffView 复用渲染（带 staged 兜底）')
assert.match(host, /<FileTabView/, 'file 分支复用 FileTabView')
assert.match(host, /内容不完整（truncated）/, 'truncated 状态必须可读')

// 4. FileTabView：read invoke 参数带 source/relativePath；md 复用渲染器；代码 highlight+sanitize
const tabView = readFileSync(new URL('../src/sheets/file/FileTabView.tsx', import.meta.url), 'utf8')
assert.match(tabView, /\.readText\(source, path\)/, 'read 必须经 typed client 带 source/relativePath')
assert.match(tabView, /normalizeWorkspaceText\(raw\)/, 'read 响应必须经 normalize')
assert.match(tabView, /MarkdownRenderer/, 'md 必须复用导出渲染器')
assert.equal(tabView.includes('gutter'), true, '代码视图必须带行号 gutter')
assert.match(tabView, /sanitizeHtml\(line/, '高亮 HTML 必须走 sanitize 安全路径')

// 5. FileTree：list 带 source/relativePath；打开传后端相对 path（symlink 不自行 resolve）
const tree = readFileSync(new URL('../src/sheets/file/FileTree.tsx', import.meta.url), 'utf8')
assert.match(tree, /\.listEntries\(source, relativePath \?\? ''\)/, 'list 必须经 typed client 带 source/相对路径')
assert.match(tree, /mergeWorkspaceEntries\(previous\.entries, relativePath, entries\)/, '目录展开必须合并子树')
assert.equal(tree.includes('readlink'), false, 'symlink 不自行 resolve')

// 6. workspaceStore patchSheetMetadata 组合 action
const store = readFileSync(new URL('../src/workspaceStore.ts', import.meta.url), 'utf8')
assert.match(store, /patchSheetMetadata: \(id, partial\) =>/, 'workspaceStore 必须提供组合 action')

console.log('file tabs 守卫通过')
