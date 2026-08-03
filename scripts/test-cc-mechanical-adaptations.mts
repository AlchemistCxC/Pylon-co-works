import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { isMessageStatic } from '../src/components/chat/messagePipeline.ts'
import type { Message, RenderMessage } from '../src/components/chat/messageTypes.ts'
import { graphemeWidth, stringWidth, truncateToWidth } from '../src/utils/textWidth.ts'
import { stripHiddenUnicode } from '../src/utils/unicodeSanitizer.ts'

// ── D1 消息静态化判定 ──
const baseMessage: Message = { id: 'm1', role: 'assistant', sender: 'peri', content: 'hi', time: '12:00' }
const toRender = (message: Message): RenderMessage => ({ type: 'assistant', message })
assert.equal(isMessageStatic(toRender(baseMessage)), true, '普通 assistant 消息必须静态')
assert.equal(isMessageStatic(toRender({ ...baseMessage, running: true })), false, 'running 消息必须动态')
assert.equal(isMessageStatic({ type: 'tool_call', message: { ...baseMessage, role: 'tool' }, toolId: 't1' }), false, 'tool_call 未 settle 必须动态')
assert.equal(isMessageStatic({ type: 'tool_result', message: { ...baseMessage, role: 'tool', toolOutput: 'out' }, toolId: 't1' }), true, 'tool_result 终态必须静态')
assert.equal(isMessageStatic({ type: 'error', message: { ...baseMessage, sender: 'system' } }), true, 'error 必须静态')
assert.equal(isMessageStatic({ type: 'system', reason: 'unknown-role', message: { ...baseMessage, role: 'tool', sender: 'x' } }), true, 'system fallback 必须静态')

// ── D3 grapheme 宽度截断 ──
assert.equal(graphemeWidth('a'), 1)
assert.equal(graphemeWidth('中'), 2)
assert.equal(graphemeWidth('\u200d'), 0, 'ZWJ 组合宽度按 2')
assert.equal(graphemeWidth('👨\u200d💻'), 2, '家庭 emoji ZWJ 序列')
assert.equal(stringWidth('ab中'), 4)
const emojiText = '✅完成'
assert.equal(truncateToWidth(emojiText, 4), '✅…', '不拆 emoji，宽 2 截断')
assert.equal(truncateToWidth(emojiText, 5), '✅完…', '宽 6 文本在 5 列内截断')
assert.equal(truncateToWidth(emojiText, 6), emojiText, '宽度足够时原样返回')
assert.equal(truncateToWidth('abcdef', 3), 'ab…')
assert.equal(truncateToWidth('abcdef', 1), '…')

// ── D6 隐藏 Unicode 净化（降级方案：不 NFKC，只剥危险字符） ──
assert.equal(stripHiddenUnicode('hello\u200bworld'), 'helloworld', '零宽空格剥离')
assert.equal(stripHiddenUnicode('a\u202eb'), 'ab', 'bidi 覆盖剥离')
assert.equal(stripHiddenUnicode('正常文本'), '正常文本', '正常输入不受影响')
assert.equal(stripHiddenUnicode('ＡＢＣ'), 'ＡＢＣ', '不做 NFKC，全角字符保留')

// ── D2 useMinDisplayTime 接线断言（hook 本体纯 React，只断言接线） ──
const footer = readFileSync(new URL('../src/components/chat/GenerationFooter.tsx', import.meta.url), 'utf8')
assert.equal(footer.includes("useMinDisplayTime(verb, 1200)"), true, 'Footer 文案必须使用最小展示时长')
assert.match(footer, /const activity = resolveActivity\(idleMs\)/, 'Footer 使用状态机 activity')
assert.match(readFileSync(new URL('../src/components/chat/spinnerMachine.ts', import.meta.url), 'utf8'), /stalledMs: 3000/, 'stalled 阈值对齐 CC 3s')

// ── D4 Pet polling 接线断言（normal 不 setState、无变化不写盘） ──
const pet = readFileSync(new URL('../src/components/PetCompanion.tsx', import.meta.url), 'utf8')
assert.match(pet, /setPet\(previous => \{[\s\S]*?JSON\.stringify\(persistable\(previous\)\) === serialized\)/, 'Pet 轮询数据无变化必须返回旧引用')
assert.match(pet, /setPet\(previous => \{[\s\S]*?localStorage\.setItem\(STORAGE_KEY, serialized\)/, 'Pet 仅在有变化时写盘')
assert.match(pet, /document\.visibilityState !== 'visible'/, 'Pet 轮询必须受文档可见性门控')

// ── D1 ChatView 接线断言 ──
const chatView = readFileSync(new URL('../src/components/chat/ChatView.tsx', import.meta.url), 'utf8')
assert.equal(chatView.includes('isStatic={isMessageStatic(renderMessage)}'), true, 'MessageRow 必须接收静态判定')
assert.match(chatView, /const skipEntrance = reduceMotion \|\| isStatic === true/, '静态行必须跳过入场动画')

console.log('CC 机械变换 D1-D6 回归测试通过')
