/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/components/chat/ChatView.tsx', 'utf8')
const store = readFileSync('src/components/chat/sessionRuntimeStore.ts', 'utf8')
const types = readFileSync('src/components/chat/messageTypes.ts', 'utf8')
const css = readFileSync('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', 'utf8')

const requireToken = (text: string, token: string, label: string) => {
  assert.ok(text.includes(token), `缺少 ${label}: ${token}`)
}

requireToken(types, 'thoughtStartedAt?: number', 'thought 起始时间字段')
requireToken(types, 'thoughtDurationMs?: number', 'thought耗时字段')
requireToken(store, 'const thoughtStartedAt = current\.thinkingStart \?\? now', '首个 thought chunk 起始时间记录')
requireToken(store, 'const thoughtDurationMs = thoughtStartedAt \? Math\.max\(0, now - thoughtStartedAt\) : undefined', '流式 thought 最终耗时收敛')
requireToken(store, 'message\.role === \'reasoning\' && message\.running', '后台 thought 终态收敛')
requireToken(source, "import { formatThoughtDuration } from '../../domains/rendererContent/reasoningPresentation.ts'", '统一耗时标题格式化')
// C01：四态 label（redacted → 正在思考 → duration → missing），token 覆盖 running 分支与 redacted 分支
requireToken(source, "if (state === 'redacted' || state === 'missing') {", 'C01 四态分支')
requireToken(source, "? 'Thinking…'", '运行中标签')
requireToken(source, 'formatThoughtDuration(durationMs)', '完成态时长标签')
requireToken(source, 'data-state={state}', '运行/完成状态标记（C01 四态）')
requireToken(source, '<span className="term-reasoning-label">{label}</span>', '无前缀 thought 标题')
assert.equal(source.includes('term-reasoning-mark'), false, 'thought 标题不得保留符号前缀')
assert.equal(source.includes('thought-shimmer'), false, 'thought 标题不得保留 shimmer 动画')
requireToken(css, '.term-reasoning-body { padding:var(--ui-space-1) 0 var(--ui-space-1) var(--ui-space-4); border-left:', '展开内容层级边线')

console.log('Thought block 视觉与耗时状态回归测试通过')
