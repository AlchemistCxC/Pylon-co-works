// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AgentConfigEditor from '../AgentConfigEditor'

afterEach(() => cleanup())

describe('AgentConfigEditor validation presentation', () => {
  it('keeps local validation text assertive and does not claim a missing tray entry', () => {
    render(<AgentConfigEditor agentId="peri" />)

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    expect(screen.getByRole('alert')).toHaveTextContent('配置不能为空')
    expect(screen.queryByText('保存失败，详情见右下角错误中心')).toBeNull()
  })
})
