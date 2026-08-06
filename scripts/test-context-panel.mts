import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createContextPanelState, transitionContextPanel, type ContextPanelState } from '../src/components/right-panel/contextPanelTypes.ts'

// W1-04：ContextPanel 壳——状态机合法转移 + 无模式不挂载 + 默认折叠来自 workspaceStore

// 1. 状态机：创建（折叠/展开默认 search）、open/set-mode/collapse 转移
assert.deepEqual(createContextPanelState(true), { status: 'collapsed' })
assert.deepEqual(createContextPanelState(false), { status: 'open', mode: 'search' })
{
  let s: ContextPanelState = createContextPanelState(true)
  assert.deepEqual(transitionContextPanel(s, { type: 'open', mode: 'relations' }), { status: 'open', mode: 'relations' })
  s = { status: 'open', mode: 'search' }
  assert.deepEqual(transitionContextPanel(s, { type: 'set-mode', mode: 'relations' }), { status: 'open', mode: 'relations' })
  assert.deepEqual(transitionContextPanel(s, { type: 'collapse' }), { status: 'collapsed' })
  // 折叠态不接受 set-mode（无内容可切）
  assert.deepEqual(transitionContextPanel({ status: 'collapsed' }, { type: 'set-mode', mode: 'search' }), { status: 'collapsed' })
  // open 覆盖折叠（open 事件直接置 open）
  assert.deepEqual(transitionContextPanel({ status: 'collapsed' }, { type: 'open', mode: 'search' }), { status: 'open', mode: 'search' })
}

// 2. 模式集合只含搜索/关联（F2-F 定稿两模式）
const panel = readFileSync(new URL('../src/components/right-panel/ContextPanel.tsx', import.meta.url), 'utf8')
assert.match(panel, /search: '搜索'/, '必须含搜索模式')
assert.match(panel, /relations: '关联'/, '必须含关联模式')
assert.equal(panel.includes('统计'), false, '不得含统计模式（F2-F 砍详情/统计）')
assert.equal(panel.includes('详情'), false, '不得含详情模式（F2-F 砍详情/统计）')

// 3. 默认折叠来自 workspaceStore（W1-01 布局字段）
assert.match(panel, /rightPanelCollapsed = useWorkspaceStore\(s => s\.rightPanelCollapsed\)/, 'ContextPanel 必须读 workspaceStore 折叠')
assert.match(panel, /setRightPanelCollapsed\(true\)/, '折叠按钮必须写 workspaceStore')
assert.match(panel, /if \(rightPanelCollapsed\) return null/, '折叠态必须返回 null')

// 4. 模式切换经纯状态机（判别联合 + transition）
assert.match(panel, /transitionContextPanel\(previous, \{ type: 'set-mode', mode \}\)/, '模式切换必须经 transition')
assert.match(panel, /transitionContextPanel\(previous, \{ type: 'collapse' \}\)/, '折叠必须经 transition')

// 5. SheetRightSlot：无模式/折叠不挂载（entry 无 rightPanel 自然不渲染）
const slot = readFileSync(new URL('../src/workspace-sheets/SheetRightSlot.tsx', import.meta.url), 'utf8')
assert.match(slot, /if \(!rightPanel \|\| rightPanel === 'none' \|\| rightPanelCollapsed\) return null/, '无模式/折叠必须不挂载')
assert.match(slot, /rightPanelCollapsed = useWorkspaceStore\(s => s\.rightPanelCollapsed\)/, 'slot 必须读折叠状态')

console.log('context panel 壳守卫通过')
// W2-12：右栏退役——AgentContextPanel/FileContextPanel 接线 + 无旧 RightPanel 残留

// 6. AgentContextPanel：搜索经共享 sessionUiState（hook 行为不变）+ 关联读 touchedFiles
{
  const acp = readFileSync(new URL('../src/components/right-panel/AgentContextPanel.tsx', import.meta.url), 'utf8')
  assert.match(acp, /useSessionUiState\(sessionId, 'search-query'/, '搜索必须经共享 sessionUiState（ChatView hook 行为不变）')
  assert.match(acp, /getChatController\(\)\?\.getMessages\(source\)/, '消息快照必须经 handle.getMessages')
  // 2026-08-06 修复：touchedFiles 必须选整个 record（`?? []` 在 selector 内每次新数组 →
  // zustand useSyncExternalStore 快照不稳 → Maximum update depth 死循环）；派生留组件体
  assert.match(acp, /useWorkspaceStore\(s => s\.touchedFiles\)/, '关联必须读 touchedFiles（正向，稳定 record）')
  assert.match(acp, /touchedFilesRecord\[source\]/, '关联必须读 touchedFiles（正向）')
  assert.match(acp, /import MessageSearchBar/, '必须复用 MessageSearchBar')
  const fcp = readFileSync(new URL('../src/components/right-panel/FileContextPanel.tsx', import.meta.url), 'utf8')
  assert.match(fcp, /useWorkspaceStore\(s => s\.touchedFiles\)/, 'file 右栏必须反查 touchedFiles（稳定 record）')
}

// 7. 搜索定位行为不变：useMessageSearch 仍在 ChatView（匹配/滚动定位）
{
  const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
  assert.match(chatView, /useMessageSearch\(sessionId, messages\)/, 'hook 仍在 ChatView（行为不变）')
  assert.match(chatView, /searchMatches\[searchIndex\]\?\.id/, '活动命中高亮保留')
  assert.equal(chatView.includes('<MessageSearchBar'), false, '搜索 UI 已迁右栏')
}

// 8. 旧 RightPanel 整体退役：无 import/class 残留
{
  const walk = ['src/components/RightPanel.tsx', 'src/components/right-panel/LogsPanel.tsx', 'src/components/right-panel/WorkspacePanel.tsx', 'src/components/right-panel/RightPanelTabs.tsx', 'src/components/right-panel/logsApi.ts']
  for (const path of walk) {
    try {
      readFileSync(new URL('../' + path, import.meta.url), 'utf8')
      assert.fail(path + ' 不应存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.equal(app.includes('components/RightPanel'), false, 'App 不得引用旧 RightPanel')
}
