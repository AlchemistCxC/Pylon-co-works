/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/chat/InputBar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/chat/InputBar.css', import.meta.url), 'utf8')

assert.match(source, /historyBySourceRef/)
assert.match(source, /recordHistory\(text\)/)
assert.match(source, /historyIndex < 0/)
assert.match(source, /historyDraftRef\.current/)
assert.match(source, /历史记录 \{historyIndex \+ 1\}\/\{historyLength\}/)
assert.match(css, /\.input-history-hint/)
// 2026-08-02 修复：↑ 首次按必须从最新一条（nextIndex=0）开始，再按 ↑ 逐步变旧；
// 旧实现首次直接跳 len-1（最旧）且再次 ↑ 卡死（min(historyIndex+1, len-1) 恒等 len-1）。
assert.ok(!/Math\.min\(historyIndex < 0 \? history\.length - 1/.test(source), '旧实现（↑ 直达最旧并卡死）已移除')
assert.match(source, /Math\.min\(historyIndex \+ 1, history\.length - 1\)/)

console.log('Input history UI 接线回归测试通过')