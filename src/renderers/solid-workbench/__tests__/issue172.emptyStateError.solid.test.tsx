// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@solidjs/testing-library'
import { createPreviewWorkbenchServices } from '../__fixtures__/previewWorkbenchServices.ts'
import { mountSolidControlCenterPreview } from '../__fixtures__/mountSolidControlCenterPreview.solid.tsx'
import { createFakeWorkbenchCommandFacade } from '../../../domains/workbench/workbenchCommandFacade.ts'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function mountEmptyControlCenter(rejectWith: unknown) {
  const host = document.createElement('div')
  document.body.append(host)
  const services = createPreviewWorkbenchServices()
  services.commands = createFakeWorkbenchCommandFacade({
    createSession: async () => {
      throw rejectWith
    },
  })
  const destroy = mountSolidControlCenterPreview({ host, services })
  cleanups.push(() => {
    destroy()
    services.destroy()
    host.remove()
  })
  const textarea = host.querySelector<HTMLTextAreaElement>('.cc-input-slot textarea')
  expect(textarea).not.toBeNull()
  return textarea!
}

describe('#172 空态提交失败错误条（solid-agent-empty-error）', () => {
  it('结构化 DTO 拒绝时显示后端 message 而非 [object Object]', async () => {
    const textarea = mountEmptyControlCenter({ code: 'AgentRuntimeUnavailable', message: '运行时未就绪' })

    fireEvent.input(textarea, { target: { value: '无工作区消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      const errorBar = document.querySelector<HTMLElement>('.solid-agent-empty-error')
      expect(errorBar).not.toBeNull()
      expect(errorBar!.textContent).toBe('运行时未就绪')
      expect(errorBar!.getAttribute('role')).toBe('alert')
    })
  })

  it('无 message 的意外拒绝值回退为可读文案，不出现 [object Object]', async () => {
    const textarea = mountEmptyControlCenter({ something: 'else' })

    fireEvent.input(textarea, { target: { value: '无工作区消息' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      const errorBar = document.querySelector<HTMLElement>('.solid-agent-empty-error')
      expect(errorBar).not.toBeNull()
      expect(errorBar!.textContent).toBe('会话创建失败')
      expect(errorBar!.textContent).not.toContain('[object Object]')
    })
  })
})
