// 迁移自 scripts/test-render-decision-exhaustive.mts（P91 A1）。
// 可见性决策穷举：空 assistant skip（empty-assistant）、非空/system sender render、
// prepareRenderableMessages 过滤、未知决策 kind 抛穷举错误。
import { describe, expect, it } from 'vitest'
import { decideMessageVisibility, prepareRenderableMessages } from '../messagePipeline.ts'
import { renderDecisionKind, toRenderMessage, type Message } from '../messageTypes.ts'

const assistant: Message = { id: 'a', role: 'assistant', sender: 'peri', content: 'ok', time: '10:00' }
const emptyAssistant: Message = { ...assistant, id: 'empty', content: '' }

describe('RenderDecision 可见性穷举（原 test-render-decision-exhaustive.mts）', () => {
  it('空 assistant 内容 skip（empty-assistant）', () => {
    const emptyDecision = decideMessageVisibility(toRenderMessage(emptyAssistant))
    expect(emptyDecision).toEqual({ kind: 'skip', reason: 'empty-assistant' })
    expect(renderDecisionKind(emptyDecision)).toBe('skip')
  })

  it('非空 assistant 与 system sender 的 assistant 均 render', () => {
    expect(renderDecisionKind(decideMessageVisibility(toRenderMessage(assistant)))).toBe('render')
    expect(renderDecisionKind(decideMessageVisibility(toRenderMessage({ ...emptyAssistant, sender: 'system' })))).toBe('render')
  })

  it('prepareRenderableMessages 过滤空 assistant', () => {
    expect(prepareRenderableMessages([emptyAssistant, assistant]).length).toBe(1)
  })

  it('未知决策 kind 抛出穷举错误', () => {
    expect(() => renderDecisionKind({ kind: 'future' } as never)).toThrow(/未处理的渲染决策: \[object Object\]/)
  })
})
