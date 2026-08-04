import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { clearSessionUiState, sessionUiStateGet, sessionUiStateSet } from '../src/components/chat/sessionUiState.ts'

// ── 注册表隔离：A 会话草稿不串到 B ──
sessionUiStateSet('sess-a', 'draft', 'A 的草稿')
sessionUiStateSet('sess-b', 'draft', 'B 的草稿')
assert.equal(sessionUiStateGet('sess-a', 'draft'), 'A 的草稿')
assert.equal(sessionUiStateGet('sess-b', 'draft'), 'B 的草稿', '会话间草稿必须隔离')
assert.equal(sessionUiStateGet('sess-c', 'draft'), undefined, '无存档会话返回 undefined')

// ── 同会话多键独立 ──
sessionUiStateSet('sess-a', 'search-query', '关键词')
assert.equal(sessionUiStateGet('sess-a', 'draft'), 'A 的草稿', '多键互不影响')
assert.equal(sessionUiStateGet('sess-a', 'search-query'), '关键词')

// ── 清除 ──
clearSessionUiState('sess-a')
assert.equal(sessionUiStateGet('sess-a', 'draft'), undefined, '清除后草稿消失')
assert.equal(sessionUiStateGet('sess-b', 'draft'), 'B 的草稿', '清除 A 不影响 B')

// ── 接线断言 ──
const inputBar = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
assert.match(inputBar, /useSessionUiState\(sessionId, 'draft', ''\)/, 'InputBar 草稿必须按会话作用域')
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.match(chatView, /useSessionUiState\(sessionId, 'search-query'/, '搜索词必须按会话作用域')
assert.match(chatView, /useSessionUiState\(sessionId, 'search-open'/, '搜索开关必须按会话作用域')
assert.doesNotMatch(chatView, /setSearchQuery\(''\)\s*\n\s*setSearchIndex\(0\)\s*\n\s*setSearchOpen\(false\)\s*\n\s*\}, \[sessionId\]\)/, '不得再在切会话时清空搜索（由注册表恢复）')
// CV-1：滚动重置/eager 相位判定收敛到 useScrollFollow
const scrollHook = readFileSync(new URL('../src/components/chat/useScrollFollow.ts', import.meta.url), 'utf8')
assert.match(scrollHook, /createScrollFollowState\(\)/, '切会话必须重置滚动跟随')
assert.match(scrollHook, /scrollBoundRef/, 'eager 相位判定必须仅首次绑定')
const identity = readFileSync(new URL('../src/identityStore.ts', import.meta.url), 'utf8')
assert.match(identity, /clearSessionUiState\(id\)/, '会话删除必须清理 UI 状态')

console.log('sessionUiState 会话级 UI 状态回归测试通过')
