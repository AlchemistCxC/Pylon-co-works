import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const footer = readFileSync('src/components/chat/GenerationFooter.tsx', 'utf8')
const view = readFileSync('src/components/chat/ChatView.tsx', 'utf8')
const controller = readFileSync('src/components/chat/chatEventController.ts', 'utf8')
const css = readFileSync('src/components/chat/ChatView.css', 'utf8')

const requireToken = (source: string, token: string, label: string) => {
  assert.ok(source.includes(token), `缺少 ${label}: ${token}`)
}

requireToken(footer, 'export type GenerationPhase', '生成阶段类型')
requireToken(footer, "| { kind: 'thinking' }", '思考阶段')
requireToken(footer, "| { kind: 'tool'; name: string }", '工具阶段')
requireToken(footer, "| { kind: 'responding' }", '回复阶段')
requireToken(footer, "data-phase={phase?.kind || 'idle'}", 'spinner 阶段状态标记')
requireToken(footer, "? '思考中'", '思考状态文案')
requireToken(footer, '`调用 ${phase.name}`', '工具状态文案')
requireToken(footer, "? '正在回复'", '回复状态文案')
requireToken(view, 'const [generationPhase, setGenerationPhase]', 'ChatView 阶段状态')
requireToken(view, 'const MOCK_GENERATION_PHASES: GenerationPhase[]', '浏览器 mock 阶段序列')
requireToken(view, 'setMockPhaseIndex(index => (index + 1) % MOCK_GENERATION_PHASES.length)', '浏览器 mock 阶段轮换')
requireToken(view, 'running={generating || browserMockPhase !== undefined}', '浏览器 mock spinner 接线')
requireToken(view, 'phase={browserMockPhase || generationPhase || undefined}', 'Footer 阶段接线')
requireToken(controller, "refs.setGenerationPhase({ kind: 'thinking' })", 'thought 阶段切换')
requireToken(controller, "refs.setGenerationPhase({ kind: 'tool', name: upd.title || '?' })", 'tool 阶段切换')
requireToken(controller, "refs.setGenerationPhase({ kind: 'responding' })", '回复阶段切换')
requireToken(controller, 'refs.setGenerationPhase(null)', '终态清理阶段')
requireToken(css, '.term-spinner[data-phase="thinking"] .spinner-frame', '思考 spinner 样式')
requireToken(css, '.term-spinner[data-phase="tool"] .spinner-frame', '工具 spinner 样式')
requireToken(css, '@keyframes spinner-thinking-pulse', '思考动画')
requireToken(css, '@keyframes spinner-tool-pulse', '工具动画')

console.log('Generation phase 状态视觉回归测试通过')
