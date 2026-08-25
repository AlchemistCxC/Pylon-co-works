// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStores } from '../../../test/resetStores.ts'
import TemplateLibrary from '../TemplateLibrary.tsx'

vi.mock('../../SettingsPreview.tsx', () => ({
  default: () => <div data-testid="settings-preview" />,
}))

describe('TemplateLibrary global presets', () => {
  beforeEach(() => resetStores())

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
