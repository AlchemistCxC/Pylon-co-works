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

// 2. GitPanel：git_status(source) + 分列；git_diff(source, path, staged) 带 staged 参数；只读
const panel = readFileSync(new URL('../src/sheets/file/GitPanel.tsx', import.meta.url), 'utf8')
assert.match(panel, /invoke<unknown>\('git_status', \{ source \}\)/, '必须调 git_status 带 source')
assert.match(panel, /entries\.filter\(entry => entry\.staged\)/, '必须分 staged/unstaged')
assert.match(panel, /onOpenDiff\(entry\.path, stagedFlag\)/, '点击条目必须带 staged 参数')
assert.equal(panel.includes("invoke('git_add'"), false, '不得提供写 Git 操作')
assert.equal(panel.includes("invoke('git_commit'"), false, '不得提供写 Git 操作')
assert.match(panel, /非 Git 仓库（只读命令不可用）/, '非 git 仓库必须明确错误态')

// 3. DiffView：git_diff(source, path, staged) 参数 + 复用 DiffCard
const diffView = readFileSync(new URL('../src/sheets/file/DiffView.tsx', import.meta.url), 'utf8')
assert.match(diffView, /invoke<string>\('git_diff', \{ source, path, staged \}\)/, 'git_diff 必须带 source/path/staged')
assert.match(diffView, /import DiffCard from '\.\.\/\.\.\/components\/chat\/DiffCard'/, '必须复用 DiffCard（不新造 diff 渲染器）')
assert.match(diffView, /<DiffCard output=\{output\} \/>/, 'diff 经 DiffPayload 统一渲染')

// 4. FileSheetView：scm 分区接线（D-08 VS Code 布局：SCM 内容在左栏，diff 开主区）
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /state\.activeSection === 'scm' && \(/, 'scm 分区必须接线（左栏）')
assert.match(view, /<GitPanel source=\{state\.targetSource\} onOpenDiff=\{\(path, staged\) => setActiveDiff/, 'GitPanel 必须接当前 source')
assert.match(view, /<DiffView source=\{state\.targetSource\} path=\{activeDiff\.path\} staged=\{activeDiff\.staged\} onClose=\{\(\) => setActiveDiff\(null\)\} \/>/, 'diff 必须在主区渲染')

console.log('file git 分区守卫通过')
