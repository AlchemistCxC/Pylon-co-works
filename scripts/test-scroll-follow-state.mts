import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  beginProgrammaticScroll,
  createScrollFollowState,
  onUserScroll,
  shouldAutoScroll,
  STICKY_THRESHOLD_PX,
  SMOOTH_LOCK_MS,
  INSTANT_LOCK_MS,
} from '../src/components/chat/scrollFollowState.ts'

// ── 接线断言：ChatView 必须消费状态机，不得残留本地 jumping/锁 ──
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.doesNotMatch(chatView, /'jumping'/, 'jumping 死状态必须移除')
assert.doesNotMatch(chatView, /scrollLockUntilRef/, '锁必须由状态机持有')
assert.match(chatView, /onUserScroll\(scrollFollowRef\.current,/, '滚动监听必须走状态机')
assert.match(chatView, /beginProgrammaticScroll\(/, '回到底部必须走状态机')
assert.match(chatView, /shouldAutoScroll\(scrollFollowRef\.current\)/, '自动滚动判定必须走状态机')

// ── 初始态：sticky（默认跟随新消息）──
const initial = createScrollFollowState(0)
assert.equal(initial.phase, 'sticky')
assert.equal(shouldAutoScroll(initial), true, '初始必须跟随')

// ── 用户滚动：贴底 / 上翻 ──
const atBottom = onUserScroll(initial, 20, 1_000)
assert.equal(atBottom.phase, 'sticky', '距底 20px ≤ 阈值 48 → 仍 sticky')
assert.equal(atBottom, initial, '相位不变必须返回原引用（避免无谓写入）')

const scrolledUp = onUserScroll(initial, 200, 1_000)
assert.equal(scrolledUp.phase, 'user_scrolled', '距底 200px > 阈值 → user_scrolled')
assert.equal(shouldAutoScroll(scrolledUp), false, '上翻不跟随')
assert.notEqual(scrolledUp, initial)

// 回到贴底 → 恢复跟随
const back = onUserScroll(scrolledUp, 0, 2_000)
assert.equal(back.phase, 'sticky')

// ── 程序化滚动：置 sticky + 锁窗内忽略用户滚动 ──
const jumpSmooth = beginProgrammaticScroll(5_000, true)
assert.equal(jumpSmooth.phase, 'sticky')
assert.equal(jumpSmooth.lockUntil, 5_000 + SMOOTH_LOCK_MS)
// 锁内（smooth 动画中）用户滚上去不推翻 sticky
const duringSmooth = onUserScroll(jumpSmooth, 400, 5_000 + SMOOTH_LOCK_MS - 1)
assert.equal(duringSmooth.phase, 'sticky', '锁内滚动不得推翻 sticky')
// 锁外才判定
const afterSmooth = onUserScroll(jumpSmooth, 400, 5_000 + SMOOTH_LOCK_MS + 1)
assert.equal(afterSmooth.phase, 'user_scrolled', '锁外上翻才判定 user_scrolled')

const jumpInstant = beginProgrammaticScroll(6_000, false)
assert.equal(jumpInstant.lockUntil, 6_000 + INSTANT_LOCK_MS, '即时滚动锁窗更短')
assert.equal(STICKY_THRESHOLD_PX, 48, '阈值 48px 契约')

// ── 阈值边界 ──
assert.equal(onUserScroll(createScrollFollowState(0), 48, 100).phase, 'sticky', '恰好等于阈值 → sticky')
assert.equal(onUserScroll(createScrollFollowState(0), 49, 100).phase, 'user_scrolled', '超过阈值 1px → user_scrolled')

console.log('scrollFollowState 滚动跟随状态机回归测试通过')
