import { describe, expect, it } from 'vitest'
import {
  WORKBENCH_CONTROL_CENTER_FIXTURE,
  WORKBENCH_INPUT_FIXTURE,
  WORKBENCH_MESSAGE_FIXTURE,
  WORKBENCH_PET_FIXTURE,
} from '../workbenchFixtures.ts'

describe('Workbench 迁移 fixture', () => {
  it('消息矩阵覆盖 user/assistant/reasoning/tool 与 Tool 三终态', () => {
    const roles = new Set(WORKBENCH_MESSAGE_FIXTURE.messages.map(message => message.role))
    expect(roles).toEqual(new Set(['user', 'assistant', 'reasoning', 'tool']))

    const toolStatuses = new Set(WORKBENCH_MESSAGE_FIXTURE.messages
      .filter(message => message.role === 'tool')
      .map(message => message.toolStatus))
    expect(toolStatuses).toEqual(expect.objectContaining(new Set(['in_progress', 'completed', 'failed'])))
    expect(WORKBENCH_MESSAGE_FIXTURE.messages.some(message => message.contentBlocks?.some(block => block.type === 'tool_diff_content'))).toBe(true)
    expect(WORKBENCH_MESSAGE_FIXTURE.messages.some(message => message.content.includes('```ts'))).toBe(true)
  })

  it('Input fixture 覆盖 draft、command、attachment 与 queue', () => {
    expect(WORKBENCH_INPUT_FIXTURE.draft).toBeTruthy()
    expect(WORKBENCH_INPUT_FIXTURE.command.startsWith('/')).toBe(true)
    expect(WORKBENCH_INPUT_FIXTURE.attachments.length).toBeGreaterThan(0)
    expect(WORKBENCH_INPUT_FIXTURE.queue.some(item => item.editing)).toBe(true)
  })

  it('ControlCenter fixture 覆盖运行数据和可编辑布局字段', () => {
    expect(WORKBENCH_CONTROL_CENTER_FIXTURE.tokenCount).toBeGreaterThan(0)
    expect(WORKBENCH_CONTROL_CENTER_FIXTURE.hidden.length).toBeGreaterThan(0)
    expect(Object.keys(WORKBENCH_CONTROL_CENTER_FIXTURE.scale).length).toBeGreaterThan(0)
  })

  it('Pet fixture 冻结五阶段及交互视觉维度', () => {
    expect(WORKBENCH_PET_FIXTURE.stages).toHaveLength(5)
    expect(WORKBENCH_PET_FIXTURE.directions).toEqual(['left', 'right'])
    expect(WORKBENCH_PET_FIXTURE.moods.length).toBeGreaterThan(0)
    expect(WORKBENCH_PET_FIXTURE.cosmetics.length).toBeGreaterThan(0)
  })
})
