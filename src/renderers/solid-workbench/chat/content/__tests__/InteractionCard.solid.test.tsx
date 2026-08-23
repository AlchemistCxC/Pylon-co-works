// @vitest-environment jsdom
import { render } from '@solidjs/testing-library'
import { describe, expect, it, vi } from 'vitest'
import { SolidInteractionCard } from '../InteractionCard.solid.tsx'
import type { WorkbenchInteraction } from '../../../../../domains/workbench/workbenchProjector.ts'

/**
 * C11 RED：交互卡契约。
 * - pending 才可提交，resolved/expired 呈现终态；
 * - response 经 command port 携带 interactionId；
 * - 危险按钮 tabindex 后置；capability 缺失时禁用并说明原因。
 */

const permissionPending = {
  id: 'int-1', status: 'requested', sequence: 1,
  request: {
    kind: 'permission', prompt: 'Allow rm -rf?', danger: true, capability: 'fs.write',
    options: [
      { id: 'allow', label: '允许' },
      { id: 'deny', label: '拒绝', danger: true },
    ],
  },
} as unknown as WorkbenchInteraction

describe('C11 SolidInteractionCard', () => {
  it('renders structured request fields with danger demotion and capability-gated actions', async () => {
    const execute = vi.fn()
    const result = render(() => <SolidInteractionCard
      interaction={permissionPending}
      commands={{ execute, canExecute: type => type === 'interaction.respond' }}
    />)
    expect(result.container.textContent).toContain('Allow rm -rf?')
    expect(result.container.textContent).toContain('fs.write')
    const buttons = [...result.container.querySelectorAll('button')]
    expect(buttons.map(b => b.textContent)).toEqual(['允许', '拒绝'])
    // 危险选项 tabindex 后置
    expect(buttons[0]!.getAttribute('tabindex')).toBe('0')
    expect(buttons[1]!.getAttribute('tabindex')).toBe('2')
    await buttons[0]!.click()
    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'int-1', payload: { optionId: 'allow' },
    })
  })

  it('disables actions when the command capability is absent, explaining why', () => {
    const result = render(() => <SolidInteractionCard interaction={permissionPending} />)
    for (const button of result.container.querySelectorAll('button')) {
      expect(button.disabled).toBe(true)
      expect(button.title).toContain('能力未接入')
    }
  })

  it('shows terminal states read-only without submit affordances', () => {
    const resolved = { ...permissionPending, status: 'resolved', response: { optionId: 'deny' } } as unknown as WorkbenchInteraction
    const resolvedView = render(() => <SolidInteractionCard interaction={resolved} commands={{ execute: vi.fn(), canExecute: () => true }} />)
    expect(resolvedView.container.textContent).toContain('已响应')
    expect(resolvedView.container.textContent).toContain('"optionId":"deny"')
    expect(resolvedView.container.querySelectorAll('button')).toHaveLength(0)

    const expired = { ...permissionPending, status: 'expired', reason: 'ttl elapsed' } as unknown as WorkbenchInteraction
    const expiredView = render(() => <SolidInteractionCard interaction={expired} />)
    expect(expiredView.container.textContent).toContain('已过期')
    expect(expiredView.container.textContent).toContain('ttl elapsed')
  })

  it('renders secret prompts as password inputs that clear after submit (C12)', async () => {
    const execute = vi.fn()
    const secret = {
      id: 'sec-1', status: 'requested', sequence: 3,
      request: { kind: 'secret', prompt: 'API token' },
    } as unknown as WorkbenchInteraction
    const result = render(() => <SolidInteractionCard
      interaction={secret} commands={{ execute, canExecute: () => true }} />)
    const input = result.container.querySelector('input') as HTMLInputElement
    expect(input.type).toBe('password')
    input.value = 'sk-secret'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'sec-1', payload: { value: 'sk-secret' },
    })
    // 提交后本地输入立即清空
    expect(input.value).toBe('')
  })

  it('shows sudo command context and oauth url with capability-gated open (C12)', () => {
    const execute = vi.fn()
    const sudo = {
      id: 'sudo-1', status: 'requested', sequence: 4,
      request: { kind: 'sudo', command: 'apt install build-essential', reason: 'build deps' },
    } as unknown as WorkbenchInteraction
    const sudoView = render(() => <SolidInteractionCard interaction={sudo}
      commands={{ execute, canExecute: t => t === 'interaction.respond' }} />)
    expect(sudoView.container.textContent).toContain('apt install build-essential')
    expect(sudoView.container.textContent).toContain('原因：build deps')

    const oauth = {
      id: 'oauth-1', status: 'requested', sequence: 5,
      request: { kind: 'oauth', url: 'https://github.com/login/oauth/authorize?state=x' },
    } as unknown as WorkbenchInteraction
    const oauthView = render(() => <SolidInteractionCard interaction={oauth}
      // 打开授权页同时需要 interaction.respond（响应交互）与 resource.open（外链）两个能力位
      commands={{ execute, canExecute: t => t === 'resource.open' || t === 'interaction.respond' }} />)
    const openBtn = [...oauthView.container.querySelectorAll('button')].find(b => b.textContent === '打开授权页')!
    openBtn.click()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource.open' }))
    // 无 resource.open capability 时按钮不渲染
    const denied = render(() => <SolidInteractionCard interaction={oauth}
      commands={{ execute, canExecute: () => false }} />)
    expect([...denied.container.querySelectorAll('button')].map(b => b.textContent)).not.toContain('打开授权页')
  })

  it('falls back to a free-text answer when the request carries no options', async () => {
    const execute = vi.fn()
    const question = {
      id: 'int-2', status: 'requested', sequence: 2,
      request: { kind: 'questions', prompt: '项目代号是什么？' },
    } as unknown as WorkbenchInteraction
    const result = render(() => <SolidInteractionCard
      interaction={question}
      commands={{ execute, canExecute: () => true }}
    />)
    const input = result.container.querySelector('input') as HTMLInputElement
    input.value = 'Pylon'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith({
      type: 'interaction.respond', targetId: 'int-2', payload: { text: 'Pylon' },
    })
  })
})
