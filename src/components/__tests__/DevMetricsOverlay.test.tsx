// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import DevMetricsOverlay from '../DevMetricsOverlay'
import type { RenderMetricSnapshot } from '../chat/renderMetrics'

const fakeApi = {
  snapshot: () => ({
    counts: { 'ChatView.render': 12, 'MessageRow.render': 34 },
    measures: { 'ChatView.render': { count: 12, totalMs: 36, maxMs: 5 } },
    startedAt: 0,
  } as unknown as RenderMetricSnapshot),
  reset: () => {},
}

afterEach(() => {
  cleanup()
  delete (window as any).__PYLON_RENDER_METRICS__
})

describe('DevMetricsOverlay', () => {
  test('默认折叠为按钮，点击展开并显示埋点计数', () => {
    ;(window as any).__PYLON_RENDER_METRICS__ = fakeApi
    render(<DevMetricsOverlay />)
    // 折叠态只有切换按钮
    expect(screen.queryByText('渲染指标')).toBeNull()
    fireEvent.click(screen.getByTitle(/渲染指标/))
    // 展开态显示面板与计数
    expect(screen.getByText('渲染指标')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('ChatView.render')).toBeTruthy()
    expect(screen.getByText('3.0ms')).toBeTruthy() // 36/12 均耗
  })

  test('无埋点 API 时打开不报错', () => {
    delete (window as any).__PYLON_RENDER_METRICS__
    render(<DevMetricsOverlay />)
    fireEvent.click(screen.getByTitle(/渲染指标/))
    expect(screen.getByText('渲染指标')).toBeTruthy()
  })
})
