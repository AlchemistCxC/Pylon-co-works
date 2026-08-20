import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildToolPresentationModel } from '../toolPresentationModel.ts'
import {
  clearAgentRegistriesForTests,
  registerAgentDescriptor,
  replaceAgentInstances,
} from '../../../domains/agent/agentRegistry.ts'
import type { Message } from '../messageTypes.ts'

beforeEach(() => clearAgentRegistriesForTests())
afterEach(() => clearAgentRegistriesForTests())

function toolMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 't1',
    role: 'tool',
    sender: 'tool:read_file',
    content: '',
    time: '2026-01-01T00:00:00Z',
    toolName: 'read_file',
    toolInput: '{"path":"/x"}',
    toolOutput: 'ok',
    toolStatus: 'completed',
    ...overrides,
  }
}

describe('Tool render 带真实 agent context（P0-2）', () => {
  it('同名 Tool 按 owner agent 的 provider 解析，不按注册顺序取第一个', () => {
    registerAgentDescriptor({
      provider: 'custom',
      displayName: 'Custom',
      protocol: 'acp',
      capabilities: {
        sessionUpdates: true,
        interactionEvents: true,
        permissionRequests: false,
        replay: true,
        responseMethods: [],
      },
      tools: [{ name: 'read_file', kind: 'edit', action: 'edit' }],
      interactionKinds: [],
    })
    replaceAgentInstances([{ id: 'custom-inst', name: 'Custom Inst', provider: 'custom' }])

    const model = buildToolPresentationModel(toolMessage({ agentId: 'custom-inst' }))
    expect(model).toMatchObject({
      kind: 'edit',
      action: 'edit',
      resolution: { provider: 'custom', matchedBy: 'provider-dictionary' },
      agentId: 'custom-inst',
    })
  })

  it('无 agentId 的旧消息回退名称解析（hermes read_file），不阻塞渲染', () => {
    const model = buildToolPresentationModel(toolMessage())
    expect(model).toMatchObject({
      kind: 'read',
      action: 'read',
      resolution: { provider: 'hermes', matchedBy: 'provider-dictionary' },
    })
    expect(model.agentId).toBeUndefined()
  })

  it('agentId 对应实例已删除/缺失时回退名称解析', () => {
    const model = buildToolPresentationModel(toolMessage({ agentId: 'vanished-agent' }))
    expect(model).toMatchObject({
      kind: 'read',
      resolution: { provider: 'hermes', matchedBy: 'provider-dictionary' },
    })
  })

  it('title 已包含参数时去重，保持 工具名（参数）', () => {
    const model = buildToolPresentationModel(toolMessage({
      toolName: 'Read a.txt',
      toolInput: 'a.txt',
    }))
    expect(model.name).toBe('Read')
    expect(model.summary).toBe('a.txt')
  })

  it('title 带括号参数且 input 为空时：剥掉残留右括号，参数进摘要', () => {
    const model = buildToolPresentationModel(toolMessage({
      toolName: 'Bash(npm run build)',
      toolInput: '',
    }))
    expect(model.name).toBe('Bash')
    expect(model.summary).toBe('npm run build')
  })

  it('未命中注册表的工具 title 带括号参数且 input 为空时：参数不留在工具名', () => {
    const model = buildToolPresentationModel(toolMessage({
      toolName: 'CustomTool(arg)',
      toolInput: '',
    }))
    expect(model.name).toBe('CustomTool')
    expect(model.summary).toBe('arg')
  })

  it('alias 命中的工具 title 带括号参数且 input 为空时：参数进摘要', () => {
    const model = buildToolPresentationModel(toolMessage({
      toolName: 'run_shell(x)',
      toolInput: '',
    }))
    expect(model.name).toBe('run_shell')
    expect(model.summary).toBe('x')
  })

  it('仅含 tool_diff_content 无 text/output 时仍可展开（hasOutput=true）', () => {
    const model = buildToolPresentationModel(toolMessage({
      toolName: 'Edit(a.txt)',
      toolInput: '',
      toolOutput: '',
      toolStatus: 'completed',
      contentBlocks: [{ type: 'tool_diff_content', title: 'a.txt', oldText: 'old', newText: 'new' }],
    }))
    expect(model.hasOutput).toBe(true)
    expect(model.isDiffCandidate).toBe(true)
    expect(model.diffPayload).not.toBeNull()
  })
})
