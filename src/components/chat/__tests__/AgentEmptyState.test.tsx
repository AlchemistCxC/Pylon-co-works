// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AgentEmptyState from '../AgentEmptyState.tsx'

describe('AgentEmptyState', () => {
  it('聊天模式指向左栏会话入口，并能展开已折叠的左栏', () => {
    const onExpandSidebar = vi.fn()
    render(<AgentEmptyState workspaceMode="chat" sidebarCollapsed onExpandSidebar={onExpandSidebar} />)

    const emptyState = screen.getByRole('region', { name: 'Agent 工作台空态' })
    expect(emptyState).toHaveTextContent('选择已有聊天')
    expect(emptyState).toHaveTextContent('点击 + 新建聊天')
    fireEvent.click(screen.getByRole('button', { name: '展开左栏' }))
    expect(onExpandSidebar).toHaveBeenCalledOnce()
  })
})
