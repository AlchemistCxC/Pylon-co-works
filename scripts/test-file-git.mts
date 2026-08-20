/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
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

// 2. GitPanel：git_status/git_history 完整只读信息；状态文件可展开到 diff
const panel = readFileSync(new URL('../src/sheets/file/GitPanel.tsx', import.meta.url), 'utf8')
// ISSUE-15 W4：GitPanel 经 typed client 调 gitStatusWithBranch(source)（workspaceClient 收口）
assert.match(panel, /provider\.status\(target\)/, 'GitPanel 必须经解析后的 GitProvider 读取状态')
assert.match(panel, /provider\.history\(target\)/, 'GitPanel 必须经解析后的 GitProvider 读取历史')
assert.match(panel, /entries\.filter\(entry => entry\.staged\)/, '必须分 staged/unstaged')
assert.match(panel, /onOpenDiff\(node\.path, entries\.find/, 'SCM 文件节点点击必须打开对应 diff')
assert.equal(panel.includes("invoke('git_add'"), false, '不得提供写 Git 操作')
assert.equal(panel.includes("invoke('git_commit'"), false, '不得提供写 Git 操作')
assert.match(panel, /当前工作区不是 Git 仓库/, '非 git 仓库必须明确错误态')
assert.match(panel, /if \(!target \|\| !provider\) \{[\s\S]*?setStaged\(\[\]\)[\s\S]*?setUnstaged\(\[\]\)[\s\S]*?setHistory\(\[\]\)/, 'target/provider 清空必须重置 Git 状态')

// 3. ViewsPanel（ISSUE-08 D-04）：只消费 touchedFiles，不承担 Git/diff 入口（SCM 独占 Git）；DiffView 继续复用 DiffCard
const viewsPanel = readFileSync(new URL('../src/sheets/file/ViewsPanel.tsx', import.meta.url), 'utf8')
assert.equal(viewsPanel.includes('gitStatus'), false, 'Views 不得调用 git_status')
assert.equal(viewsPanel.includes('activeDiff'), false, 'Views 不得维护 activeDiff/onOpenDiff')
assert.equal(viewsPanel.includes('onOpenDiff'), false, 'Views 不得提供 diff 入口')
assert.match(viewsPanel, /useWorkspaceStore\(s => s\.touchedFiles\)/, 'Views 只消费 touchedFiles')
assert.match(viewsPanel, /onOpenFile\(file\.path\)/, '触碰文件行点击必须进入普通文件视图')
const diffView = readFileSync(new URL('../src/sheets/file/DiffView.tsx', import.meta.url), 'utf8')
assert.match(diffView, /provider\.diff\(target, \{ path, staged \}\)/, 'git_diff 必须经 GitProvider 带显式 target/path/staged')
assert.match(diffView, /import DiffCard from '\.\.\/\.\.\/components\/chat\/DiffCard'/, '必须复用 DiffCard（不新造 diff 渲染器）')
assert.match(diffView, /<DiffCard output=\{output\} \/>/, 'diff 经 DiffPayload 统一渲染')

// 4. FileSheetView：SCM/Views 分区接线（D-08 VS Code 布局：内容在左栏）
const view = readFileSync(new URL('../src/sheets/file/FileSheetView.tsx', import.meta.url), 'utf8')
assert.match(view, /listFileActivities\(target\)/, 'activity 必须由 File Workbench Registry 解析')
assert.doesNotMatch(view, /import GitPanel/, 'FileSheet 核心不得 import GitPanel')
assert.match(view, /resolveGitProvider\(target\)/, 'Git 能力必须按显式 target 解析')

console.log('file git 分区守卫通过')
