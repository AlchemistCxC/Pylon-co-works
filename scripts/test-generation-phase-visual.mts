/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolveStallProgress, ACTIVITY_THRESHOLDS, STALL_RAMP_MS } from '../src/components/chat/spinnerMachine.ts'
import { nextTokenCatchUp } from '../src/components/chat/tokenCatchUp.ts'
import { resolveActivityLine } from '../src/domains/activity/activityLine.ts'

const footer = readFileSync('src/components/chat/GenerationFooter.tsx', 'utf8')
const controller = readFileSync('src/components/chat/chatEventController.ts', 'utf8')
const css = readFileSync('src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css', 'utf8')

const requireToken = (source: string, token: string, label: string) => {
  assert.ok(source.includes(token), `缺少 ${label}: ${token}`)
}

requireToken(footer, 'export type GenerationPhase', '生成阶段类型')
requireToken(footer, "| { kind: 'thinking' }", '思考阶段')
requireToken(footer, "| { kind: 'tool'; name: string }", '工具阶段')
requireToken(footer, "| { kind: 'responding' }", '回复阶段')
requireToken(footer, "data-phase={spinnerFramePreset === 'cc' ? undefined : phase?.kind || 'idle'}", 'spinner 阶段状态标记（cc 帧恒色不设 phase）')
requireToken(controller, "currentRefs!.setGenerationPhase({ kind: 'thinking' })", 'thought 阶段切换')
requireToken(controller, "currentRefs!.setGenerationPhase({ kind: 'tool', name: upd.title || '?' })", 'tool 阶段切换')
requireToken(controller, "currentRefs!.setGenerationPhase({ kind: 'responding' })", '回复阶段切换')
requireToken(controller, 'currentRefs!.setGenerationPhase(null)', '终态清理阶段')
requireToken(css, '.term-spinner[data-phase="thinking"] .spinner-frame', '思考 spinner 样式')
requireToken(css, '.term-spinner[data-phase="tool"] .spinner-frame', '工具 spinner 样式')
requireToken(css, '@keyframes spinner-thinking-pulse', '思考动画')
requireToken(css, '@keyframes spinner-tool-pulse', '工具动画')

// ── P1-08：activityLine 覆盖链消费 + D29 stall 抑制 + D30 thinking 时长 + 热路径叶子 ──
requireToken(footer, 'resolveActivityLine(', 'Footer 必须消费 activityLine')
requireToken(footer, 'activeTask(tasks)?.content', 'plan activeTask 覆盖链最高优先')
requireToken(footer, 'stallSuppressed ? \'active\' : resolveActivity(idleMs)', 'tool 阶段必须抑制 stall（D29）')
requireToken(footer, 'useChatRuntimeSnapshot(source)', 'Footer 必须经横向订阅读 plan/thinkingStart')
requireToken(footer, 'thinkingStart', 'thinking 时长输入（D30）')
requireToken(footer, '<SpinnerFrame ', '帧动画叶子（热路径隔离）')
requireToken(footer, '<TokenCounter ', 'token 追赶叶子')
requireToken(footer, '<ThinkingDuration ', '思考时长叶子')
requireToken(footer, '<ElapsedTimer ', '总耗时叶子')
requireToken(footer, '<StallProbe ', 'stalled 强度叶子')
requireToken(css, '--stall-progress', 'stalled 渐变红插值必须消费 --stall-progress')
requireToken(footer, 'function StallProbe', 'StallProbe 持 tick 写 --stall-progress')

// 纯断言：10s 前不变红；超过 stalled 阈值后按 3s 斜坡递增。
assert.equal(resolveStallProgress(0), 0)
assert.equal(resolveStallProgress(ACTIVITY_THRESHOLDS.stalledMs), 0, 'stalledMs 边界仍为 0')
assert.equal(resolveStallProgress(4000), 0, '4s 仅为等待态，不得过早变红')
const rampMidpoint = resolveStallProgress(ACTIVITY_THRESHOLDS.stalledMs + STALL_RAMP_MS / 2)
assert.ok(rampMidpoint > 0 && rampMidpoint < 1, `超过 stalled 阈值后必须进入渐变红斜坡（${rampMidpoint}）`)
assert.ok(resolveStallProgress(ACTIVITY_THRESHOLDS.stalledMs + STALL_RAMP_MS * 0.75) > rampMidpoint, 'stalled 强度必须随 idleMs 递增')
assert.equal(resolveStallProgress(ACTIVITY_THRESHOLDS.stalledMs + STALL_RAMP_MS * 2), 1, '封顶 1')

// 纯断言：token 追赶（几何步进）不超真实值
assert.equal(nextTokenCatchUp(0, 100), 25, '余量/4 步进')
assert.equal(nextTokenCatchUp(90, 100), 93)
assert.equal(nextTokenCatchUp(98, 100), 99)
assert.equal(nextTokenCatchUp(99, 100), 100)
assert.equal(nextTokenCatchUp(100, 100), 100)
assert.equal(nextTokenCatchUp(150, 100), 100, '显示值永不超过真实值')
assert.ok(nextTokenCatchUp(0, 0) <= 0)
// 单调逼近：连续追赶最终封顶真实值
let v = 0
while (v < 100) v = nextTokenCatchUp(v, 100)
assert.equal(v, 100, '追赶必须最终达到真实值')

// 纯断言：D5 覆盖链一致性（activityLine 与 Footer 消费同源）
assert.equal(resolveActivityLine({ activeTaskContent: '重构状态机' }).activity, '正在重构状态机 …')
assert.equal(resolveActivityLine({ phase: 'tool', toolTitle: 'Grep' }).stallSuppressed, true)

console.log('Generation phase 状态视觉回归测试通过')
