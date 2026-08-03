// @vitest-environment jsdom
import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import ToolConnector from '../ToolConnector'
import { useStore } from '../../../store'

describe('ToolConnector', () => {
  test('follow 模式按状态解析颜色并生成动画 class', () => {
    useStore.setState({
      toolConnectorMode: 'follow',
      toolOk: '#00ff00',
      toolRun: '#0000ff',
      toolErr: '#ff0000',
      toolConnectorColor: '#ffffff',
      toolConnectorStyle: 'solid',
      toolConnectorWidth: 2,
      toolConnectorOpacity: 1,
    })
    const { container } = render(<ToolConnector status="ok" visualState="completed" />)
    const el = container.querySelector('.term-tool-connector')
    expect(el).not.toBeNull()
    expect(el).toHaveClass('term-tool-connector--settle')
    expect(el).toHaveClass('term-tool-connector-style--solid')
    expect(el).toHaveAttribute('data-tool-state', 'completed')
  })

  test('none 模式连接线透明', () => {
    useStore.setState({ toolConnectorMode: 'none' })
    const { container } = render(<ToolConnector status="ok" visualState="completed" />)
    const el = container.querySelector('.term-tool-connector')
    expect(el).not.toBeNull()
    expect(el).toHaveStyle({ background: 'transparent' })
  })

  test('running 状态映射 breathe 动画', () => {
    useStore.setState({ toolConnectorMode: 'follow', toolRun: '#0000ff' })
    const { container } = render(<ToolConnector status="run" visualState="running" />)
    expect(container.querySelector('.term-tool-connector')).toHaveClass('term-tool-connector--breathe')
  })
})
