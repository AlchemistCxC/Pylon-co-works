// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSolidWorkbench } from '../mountSolidWorkbench.solid.tsx'
import { createPreviewWorkbenchServices } from '../__fixtures__/previewWorkbenchServices.ts'

const hosts: HTMLElement[] = []
const servicesList: ReturnType<typeof createPreviewWorkbenchServices>[] = []

afterEach(() => {
  cleanup()
  for (const services of servicesList.splice(0)) services.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

function mountPreview() {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  const services = createPreviewWorkbenchServices()
  servicesList.push(services)
  const lifecycle = mountSolidWorkbench({
    host,
    input: {
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      rightInset: 24,
      reducedMotion: true,
    },
    services,
  })
  return { host, services, lifecycle }
}

describe('mountSolidWorkbench', () => {
  it('挂载完整 fixture shell，复用 Message/Tool/Task/Generation renderer', async () => {
    const { host } = mountPreview()

    expect(screen.getByLabelText('Solid Agent Workbench')).toBeTruthy()
    expect(host.querySelector('[data-renderer="solid"]')?.getAttribute('data-preview')).toBe('true')
    expect(await screen.findByRole('heading', { name: '迁移结果' })).toBeTruthy()
    expect(screen.getByText('Read')).toBeTruthy()
    expect(host.querySelector('.task-tree')).toBeTruthy()
    expect(host.querySelector('.term-spinner')).toBeTruthy()
    expect(host.querySelector('.control-center')?.getAttribute('data-fixture')).toBe('widgets')
    expect(host.querySelector('.pet-companion')?.getAttribute('data-fixture')).toBe('pending')
    await waitFor(() => expect(host.querySelectorAll('.plain-message-list__row').length).toBeGreaterThan(0))
  })

  it('update 不重挂 root，并切换 replay/Session 输入', async () => {
    const { host, lifecycle } = mountPreview()
    const root = host.firstElementChild

    lifecycle.update({
      sheetId: 'sheet-a',
      sessionId: 'preview-session',
      preview: true,
      replayReadonly: true,
      rightInset: 80,
    })

    await waitFor(() => expect(screen.getByText('历史回放 · 只读')).toBeTruthy())
    expect(host.firstElementChild).toBe(root)
    expect(host.querySelector('.control-center')).toBeNull()
    expect(host.firstElementChild?.getAttribute('style')).toContain('80px')

    lifecycle.update({ sheetId: 'sheet-a', sessionId: null, preview: true })
    await waitFor(() => expect(screen.getByText('选择或创建一个 Session')).toBeTruthy())
    expect(host.firstElementChild).toBe(root)
  })

  it('pause 冻结 runtime/appearance 推送，resume 一次收敛最新快照', async () => {
    const { host, services, lifecycle } = mountPreview()
    lifecycle.pause()
    services.runtime.update({ streamingText: '暂停期间的新文本', tokenCount: 99 })
    services.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: true })

    expect(host.querySelector('[data-paused="true"]')).toBeTruthy()
    expect(screen.queryByText('暂停期间的新文本')).toBeNull()

    lifecycle.resume()
    await waitFor(() => expect(screen.getByText('暂停期间的新文本')).toBeTruthy())
    expect(host.querySelector('[data-paused="false"]')).toBeTruthy()
  })

  it('preview 不暴露真实停止按钮，destroy 幂等并清空 DOM', () => {
    const { host, lifecycle } = mountPreview()
    expect(screen.queryByTitle('停止生成 (Esc / Ctrl+C)')).toBeNull()

    lifecycle.destroy()
    lifecycle.destroy()
    expect(host.childElementCount).toBe(0)
  })
})
