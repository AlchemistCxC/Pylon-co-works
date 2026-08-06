import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { parseOpenTabs, serializeOpenTabs, languageFromPath } from '../src/sheets/file/fileSheetState.ts'

// W2-04：多 tab + metadata roundtrip + read invoke 参数 + truncated

// 1. openTabs 编解码 roundtrip；损坏 JSON → 空（不清整个 persistence）
{
  const paths = ['src/a.ts', 'src/b.md']
  const serialized = serializeOpenTabs(paths)
  assert.deepEqual(parseOpenTabs(serialized), paths)
  assert.deepEqual(parseOpenTabs(undefined), [])
  assert.deepEqual(parseOpenTabs(''), [])
  assert.deepEqual(parseOpenTabs('{broken json'), [], '损坏 JSON normalize 为空')
  assert.deepEqual(parseOpenTabs(JSON.stringify({ not: 'array' })), [])
  assert.deepEqual(parseOpenTabs(JSON.stringify(['ok', 42, null, 'x'])), ['ok', 'x'], '非字符串项丢弃')
}

// 2. 语言推断
{
  assert.equal(languageFromPath('src/a.ts'), 'typescript')
  assert.equal(languageFromPath('a.md'), 'markdown')
  assert.equal(languageFromPath('Dockerfile'), 'text')
  assert.equal(languageFromPath('x.py'), 'python')
  assert.equal(languageFromPath('x.rs'), 'rust')
}

// 3. FileSheetView：metadata openTabs/activeFile 组合 action + truncated + close 行为
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /patchSheetMetadata\(sheet\.id, \{ openTabs: serializeOpenTabs\(next\), activeFile: path \}\)/, '打开 tab 必须原子合并 metadata')
assert.match(view, /patchSheetMetadata\(sheet\.id, \{ activeFile: path \}\)/, '切 tab 必须写 activeFile')
assert.match(view, /parseOpenTabs\(sheet\.metadata\?\.openTabs\)/, 'openTabs 必须从 metadata 恢复')
assert.match(view, /内容不完整（truncated）/, 'truncated 状态必须可读')
assert.match(view, /closeTab = \(path: string\) =>/, '必须支持关闭 tab')

// 4. FileTabView：read invoke 参数带 source/relativePath；md 复用渲染器；代码 highlight+sanitize
const tabView = readFileSync(new URL('../src/sheets/file/FileTabView.tsx', import.meta.url), 'utf8')
assert.match(tabView, /invoke<unknown>\('read_workspace_text', \{ source, relativePath: path \}\)/, 'read 必须带 source/relativePath')
assert.match(tabView, /normalizeWorkspaceText\(raw\)/, 'read 响应必须经 normalize')
assert.match(tabView, /MarkdownRenderer/, 'md 必须复用导出渲染器')
assert.equal(tabView.includes('gutter'), true, '代码视图必须带行号 gutter')
assert.match(tabView, /sanitizeHtml\(line/, '高亮 HTML 必须走 sanitize 安全路径')

// 5. FileTree：list 带 source/relativePath；打开传后端相对 path（symlink 不自行 resolve）
const tree = readFileSync(new URL('../src/sheets/file/FileTree.tsx', import.meta.url), 'utf8')
assert.match(tree, /invoke\('list_workspace_entries', \{ source, relativePath \}\)/, 'list 必须带 source/relativePath')
assert.match(tree, /mergeWorkspaceEntries\(previous\.entries, relativePath, entries\)/, '目录展开必须合并子树')
assert.equal(tree.includes('readlink'), false, 'symlink 不自行 resolve')

// 6. workspaceStore patchSheetMetadata 组合 action
const store = readFileSync(new URL('../src/workspaceStore.ts', import.meta.url), 'utf8')
assert.match(store, /patchSheetMetadata: \(id, partial\) =>/, 'workspaceStore 必须提供组合 action')

console.log('file tabs 守卫通过')
