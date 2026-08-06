import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeGitStatus } from '../src/infrastructure/tauri/gitContracts.ts'

// W2-05：Git 分区——staged/unstaged 分列、git_diff(staged) 参数、非 git 错误态、只读

// 1. staged 分列数据（normalize 已覆盖；此处锁定 staged 标记语义）
{
  const entries = normalizeGitStatus([
    { path: 'a.ts', status: 'M', staged: true },
    { path: 'b.ts', status: ' M', staged: false },
    { path: 'c.ts', status: '??', staged: false },
  ])
  assert.deepEqual(entries.filter(e => e.staged).map(e => e.path), ['a.ts'])
  assert.deepEqual(entries.filter(e => !e.staged).map(e => e.path), ['b.ts', 'c.ts'])
}

// 2. GitPanel：git_status/git_history 完整只读信息；diff 入口移动到 ViewsPanel
const panel = readFileSync(new URL('../src/sheets/file/GitPanel.tsx', import.meta.url), 'utf8')
assert.match(panel, /invoke<unknown>\('git_status', \{ source \}\)/, '必须调 git_status 带 source')
assert.match(panel, /invoke<unknown>\('git_history', \{ source \}\)/, '必须调 git_history 带 source')
assert.match(panel, /entries\.filter\(entry => entry\.staged\)/, '必须分 staged/unstaged')
assert.equal(panel.includes('onOpenDiff'), false, 'SCM 不得继续承担 diff 入口')
assert.equal(panel.includes("invoke('git_add'"), false, '不得提供写 Git 操作')
assert.equal(panel.includes("invoke('git_commit'"), false, '不得提供写 Git 操作')
assert.match(panel, /当前工作区不是 Git 仓库/, '非 git 仓库必须明确错误态')

// 3. ViewsPanel：change/diff 入口带 staged 参数；DiffView 继续复用 DiffCard
const viewsPanel = readFileSync(new URL('../src/sheets/file/ViewsPanel.tsx', import.meta.url), 'utf8')
assert.match(viewsPanel, /onOpenDiff\(entry\.path, entry\.staged\)/, '视图分区点击变更必须带 staged 参数')
const diffView = readFileSync(new URL('../src/sheets/file/DiffView.tsx', import.meta.url), 'utf8')
assert.match(diffView, /invoke<string>\('git_diff', \{ source, path, staged \}\)/, 'git_diff 必须带 source/path/staged')
assert.match(diffView, /import DiffCard from '\.\.\/\.\.\/components\/chat\/DiffCard'/, '必须复用 DiffCard（不新造 diff 渲染器）')
assert.match(diffView, /<DiffCard output=\{output\} \/>/, 'diff 经 DiffPayload 统一渲染')

// 4. FileSheetView：SCM/Views 分区接线（D-08 VS Code 布局：内容在左栏）
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /state\.activeSection === 'scm' && <GitPanel/, 'scm 分区必须接线（左栏）')
assert.match(view, /<GitPanel source=\{state\.targetSource\} \/>/, 'GitPanel 必须接当前 source')
assert.match(view, /<ViewsPanel/, 'diff/change 必须由视图分区承载')

console.log('file git 分区守卫通过')
