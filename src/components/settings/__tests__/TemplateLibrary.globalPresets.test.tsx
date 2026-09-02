// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStores } from '../../../test/resetStores.ts'
import TemplateLibrary from '../TemplateLibrary.tsx'
import { useStore } from '../../../store.ts'

vi.mock('../../SettingsPreview.tsx', () => ({
  default: () => <div data-testid="settings-preview" />,
}))

describe('TemplateLibrary global presets', () => {
  beforeEach(() => resetStores())

  it('点击自定义模板按 canonical id 应用主题，而不是展示名称', async () => {
    useStore.setState({ customPresets: [{
      id: 'custom-42', name: '我的同名模板', theme: { chatFontSize: 19 }, createdAt: 1, updatedAt: 1,
    }] })
    render(<TemplateLibrary onApply={vi.fn()} onRestore={vi.fn()} />)
    const card = screen.getByText('我的同名模板').closest('.template-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: '应用' }))
    await expect(screen.findByRole('status')).resolves.toHaveTextContent('自定义预设已应用')
    expect(useStore.getState().chatFontSize).toBe(19)
    expect(useStore.getState().appliedPreset.global).toBe('custom-42')
  })

  it('把旧版 bare id 归一化后再交给应用 transaction', async () => {
    useStore.setState({ customPresets: [{
      id: 'legacy-42', name: '旧版模板', theme: { chatFontSize: 18 }, createdAt: 1, updatedAt: 1,
    }] })
    const onCustomApply = vi.fn(async () => ({
      status: 'applied' as const, id: 'custom-legacy-42', providers: ['builtin.theme'], revision: 1,
    }))
    render(<TemplateLibrary onApply={vi.fn()} onRestore={vi.fn()} onCustomApply={onCustomApply} />)
    const card = screen.getByText('旧版模板').closest('.template-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: '应用' }))
    await expect(screen.findByRole('status')).resolves.toHaveTextContent('自定义预设已应用')
    expect(onCustomApply).toHaveBeenCalledWith('custom-legacy-42')
  })

  it('把 provider 失败结果显示为可操作的错误，而不是静默成功', async () => {
    useStore.setState({ customPresets: [{
      id: 'custom-failed', name: '失败模板', theme: { chatFontSize: 19 }, createdAt: 1, updatedAt: 1,
    }] })
    const onCustomApply = vi.fn(async () => ({
      status: 'failed' as const, id: 'custom-failed', failedProvider: 'builtin.renderer-settings',
      message: 'renderer unavailable', rolledBack: true, revision: 3,
    }))
    render(<TemplateLibrary onApply={vi.fn()} onRestore={vi.fn()} onCustomApply={onCustomApply} />)
    const card = screen.getByText('失败模板').closest('.template-card') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: '应用' }))

    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('builtin.renderer-settings')
    expect(onCustomApply).toHaveBeenCalledWith('custom-failed')
  })

  it('在官方全局预设中展示并可应用三套 Agent 工作流预设', () => {
    const onApply = vi.fn()
    render(<TemplateLibrary onApply={onApply} onRestore={vi.fn()} />)

    for (const label of ['Agent 指挥台', 'Agent 关系图', '专注流程']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }

    const commandCard = screen.getByText('Agent 指挥台').closest('.template-card')
    expect(commandCard).not.toBeNull()
    fireEvent.click(within(commandCard as HTMLElement).getByRole('button', { name: '应用' }))
    expect(onApply).toHaveBeenCalledWith('agent-command')
  })
})
