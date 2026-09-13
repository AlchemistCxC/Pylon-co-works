// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../../test/fakeInvoke'
import ModelWidget from '../ModelWidget.tsx'
import { useRuntimeStore } from '../../../runtimeStore.ts'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeRef.current!(cmd, args),
}))

/** 未注册命令 resolve undefined（对齐 vi.fn(async () => ({})) 之外的宽松路径） */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

let fakeInvoke: TolerantFakeInvoke

// jsdom 未实现 PointerEvent：Radix DropdownMenu 触发器依赖 pointerdown 打开。
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    pointerId: number
    pointerType: string
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 1
      this.pointerType = params.pointerType ?? 'mouse'
    }
  }
  ;(window as unknown as { PointerEvent: typeof PointerEventShim }).PointerEvent = PointerEventShim
}

const context = { agentId: 'hermes', source: 'local:session-1' }

beforeEach(() => {
  fakeInvoke = new TolerantFakeInvoke()
  invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  useRuntimeStore.getState().resetSessionRuntime()
})

describe('ModelWidget 模型宣告面（P56/D3）', () => {
  it('renders read-only badge without advertised choices and never invokes', () => {
    useRuntimeStore.getState().setSessionConfig(context, { model: 'deepseek-v4-pro' })
    const { container } = render(<ModelWidget context={context} />)

    // 无 modelChoices → 只读 badge（title 说明原因），无下拉触发器。
    const badge = container.querySelector('.cc-model-badge')
    expect(badge).not.toBeNull()
    expect(badge).toHaveTextContent('deepseek-v4-pro')
    expect(badge?.getAttribute('title')).toContain('未宣告可选模型')
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(fakeInvoke.calls).toHaveLength(0)
  })

  it('shows labels in the menu and sends machine ids on the wire', async () => {
    useRuntimeStore.getState().setSessionConfig(context, {
      model: 'nous:hermes-4',
      models: ['nous:hermes-4', 'nous:hermes-3'],
      modelChoices: [
        { id: 'nous:hermes-4', label: 'Nous · hermes-4', provider: 'nous' },
        { id: 'nous:hermes-3', label: 'Nous · hermes-3', provider: 'nous' },
      ],
    })
    render(<ModelWidget context={context} />)

    // 触发器显示 label（id/label 分离，验收 1 UI 侧）。
    const trigger = screen.getByRole('button', { name: /Nous · hermes-4/ })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    const items = await screen.findAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual(['Nous · hermes-4', 'Nous · hermes-3'])
    // 菜单项不可见处夹带 machine id：发送值必须是 id（发送不变量）。
    fireEvent.click(items[1])
    await vi.waitFor(() => {
      expect(fakeInvoke.calls).toContainEqual({
        cmd: 'set_config_option',
        args: expect.objectContaining({
          agentId: 'hermes',
          source: 'local:session-1',
          key: 'model',
          value: 'nous:hermes-3',
        }),
      })
    })
  })

  it('keeps profile.model as display-only fallback when no session config exists', () => {
    const { container } = render(<ModelWidget context={context} />)
    const badge = container.querySelector('.cc-model-badge')
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('title')).toContain('未宣告可选模型')
    expect(fakeInvoke.calls).toHaveLength(0)
  })
})
