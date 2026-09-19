// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentEmptyState from '../AgentEmptyState.tsx'

describe('AgentEmptyState', () => {
  it('给出左栏入口指引，并能展开已折叠的左栏', () => {
    const onExpandSidebar = vi.fn()
    render(<AgentEmptyState sidebarCollapsed onExpandSidebar={onExpandSidebar} />)

    const emptyState = screen.getByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveTextContent('选择或创建工作区')
    expect(emptyState).toHaveTextContent('创建或选择会话')
    fireEvent.click(screen.getByRole('button', { name: '展开左栏' }))
    expect(onExpandSidebar).toHaveBeenCalledOnce()
  })

  it('左栏已展开时不渲染展开按钮', () => {
    render(<AgentEmptyState />)
    expect(screen.queryByRole('button', { name: '展开左栏' })).toBeNull()
  })
})
